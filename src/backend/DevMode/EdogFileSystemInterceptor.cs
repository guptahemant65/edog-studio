// <copyright file="EdogFileSystemInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.Persistence.Fs;
    using Microsoft.LiveTable.Service.TokenManagement;
    using Microsoft.MWC.Workload.Client.Library.Providers.CustomParameters;

    /// <summary>
    /// Decorator that wraps <see cref="IFileSystemFactory"/> to intercept all file system operations.
    /// Every <see cref="IFileSystem"/> created through this factory is wrapped with
    /// <see cref="EdogFileSystemWrapper"/> which publishes FileOpEvent to the "fileop" topic.
    /// Thread-safe. Zero overhead on caller — publish failures never propagate to FLT.
    /// </summary>
    public class EdogFileSystemFactoryWrapper : IFileSystemFactory
    {
        private readonly IFileSystemFactory _inner;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogFileSystemFactoryWrapper"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="IFileSystemFactory"/> to delegate to.</param>
        public EdogFileSystemFactoryWrapper(IFileSystemFactory inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <inheritdoc/>
        public IFileSystem CreateFileSystem(
            Guid workspaceId,
            Guid lakehouseId,
            IParametersProvider parametersProvider,
            string dagExecMetricsBaseDir,
            ITokenProvider tokenProvider)
        {
            var inner = _inner.CreateFileSystem(workspaceId, lakehouseId, parametersProvider, dagExecMetricsBaseDir, tokenProvider);
            var iterationId = $"{workspaceId:N}-{lakehouseId:N}";
            return new EdogFileSystemWrapper(inner, iterationId);
        }
    }

    /// <summary>
    /// Decorator that wraps a single <see cref="IFileSystem"/> instance to capture all 13 operations.
    /// Publishes FileOpEvent to the "fileop" topic via <see cref="EdogTopicRouter"/>.
    /// Thread-safe stateless decorator — _inner and _iterationId are readonly.
    /// Content previews are truncated to 4KB. Duration captured via <see cref="Stopwatch"/>.
    /// </summary>
    public class EdogFileSystemWrapper : IFileSystem
    {
        private const int MaxContentPreviewBytes = 4096;
        private readonly IFileSystem _inner;
        private readonly string _iterationId;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogFileSystemWrapper"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="IFileSystem"/> to delegate to.</param>
        /// <param name="iterationId">Iteration context identifier for event tagging.</param>
        public EdogFileSystemWrapper(IFileSystem inner, string iterationId)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
            _iterationId = iterationId;
        }

        /// <inheritdoc/>
        public async Task<bool> ExistsAsync(string path, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var result = await _inner.ExistsAsync(path, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            PublishEvent("Exists", path, sw.Elapsed.TotalMilliseconds, contentSizeBytes: 0, hasContent: false, contentPreview: null, ttlSeconds: 0);
            return result;
        }

        /// <inheritdoc/>
        public async Task CreateDirIfNotExistsAsync(string path, IDictionary<string, string> metadata = default, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            await _inner.CreateDirIfNotExistsAsync(path, metadata, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            PublishEvent("Write", path, sw.Elapsed.TotalMilliseconds, contentSizeBytes: 0, hasContent: false, contentPreview: null, ttlSeconds: 0);
        }

        /// <inheritdoc/>
        public async Task CreateOrUpdateFileAsync(string path, string content, TimeSpan timeToExpire = default, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            await _inner.CreateOrUpdateFileAsync(path, content, timeToExpire, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            var contentSize = content != null ? System.Text.Encoding.UTF8.GetByteCount(content) : 0;
            var preview = TruncatePreview(content);
            var ttl = timeToExpire != default ? (long)timeToExpire.TotalSeconds : 0;

            PublishEvent("Write", path, sw.Elapsed.TotalMilliseconds, contentSizeBytes: contentSize, hasContent: content != null, contentPreview: preview, ttlSeconds: ttl);
        }

        /// <inheritdoc/>
        public async Task<string> ReadFileAsStringAsync(string path, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var result = await _inner.ReadFileAsStringAsync(path, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            var contentSize = result != null ? System.Text.Encoding.UTF8.GetByteCount(result) : 0;
            var preview = TruncatePreview(result);

            PublishEvent("Read", path, sw.Elapsed.TotalMilliseconds, contentSizeBytes: contentSize, hasContent: result != null, contentPreview: preview, ttlSeconds: 0);
            return result;
        }

        /// <inheritdoc/>
        public async Task<bool> CreateEmptyFileIfNotExistsAsync(string path, IDictionary<string, string> metadata = default, TimeSpan timeToExpire = default, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var result = await _inner.CreateEmptyFileIfNotExistsAsync(path, metadata, timeToExpire, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            var ttl = timeToExpire != default ? (long)timeToExpire.TotalSeconds : 0;

            PublishEvent("Write", path, sw.Elapsed.TotalMilliseconds, contentSizeBytes: 0, hasContent: false, contentPreview: null, ttlSeconds: ttl);
            return result;
        }

        /// <inheritdoc/>
        public async Task RenameFileAsync(string srcPath, string destinationPath, IDictionary<string, string> metadata = default, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            await _inner.RenameFileAsync(srcPath, destinationPath, metadata, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            PublishEvent("Write", srcPath + " → " + destinationPath, sw.Elapsed.TotalMilliseconds, contentSizeBytes: 0, hasContent: false, contentPreview: null, ttlSeconds: 0);
        }

        /// <inheritdoc/>
        public async Task<bool> DeleteFileIfExistsAsync(string path, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var result = await _inner.DeleteFileIfExistsAsync(path, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            PublishEvent("Delete", path, sw.Elapsed.TotalMilliseconds, contentSizeBytes: 0, hasContent: false, contentPreview: null, ttlSeconds: 0);
            return result;
        }

        /// <inheritdoc/>
        public async Task<bool> DeleteDirIfExistsAsync(string path, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var result = await _inner.DeleteDirIfExistsAsync(path, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            PublishEvent("Delete", path, sw.Elapsed.TotalMilliseconds, contentSizeBytes: 0, hasContent: false, contentPreview: null, ttlSeconds: 0);
            return result;
        }

        /// <inheritdoc/>
        public async Task<List<string>> ListAsync(string path, int maxCount = default, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var result = await _inner.ListAsync(path, maxCount, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            var count = result?.Count ?? 0;

            PublishEvent("List", path, sw.Elapsed.TotalMilliseconds, contentSizeBytes: count, hasContent: false, contentPreview: null, ttlSeconds: 0);
            return result;
        }

        /// <inheritdoc/>
        public async Task<byte[]> ReadFileBytesAsync(string path, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var result = await _inner.ReadFileBytesAsync(path, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            var contentSize = result?.Length ?? 0;

            PublishEvent("Read", path, sw.Elapsed.TotalMilliseconds, contentSizeBytes: contentSize, hasContent: result != null, contentPreview: null, ttlSeconds: 0);
            return result;
        }

        /// <inheritdoc/>
        public async Task<(List<string> Paths, string ContinuationToken)> ListWithContinuationAsync(string path, int maxCount = default, string continuationToken = null, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var result = await _inner.ListWithContinuationAsync(path, maxCount, continuationToken, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            var count = result.Paths?.Count ?? 0;

            PublishEvent("List", path, sw.Elapsed.TotalMilliseconds, contentSizeBytes: count, hasContent: false, contentPreview: null, ttlSeconds: 0);
            return result;
        }

        /// <inheritdoc/>
        public async Task<IDictionary<string, string>> GetDirMetadataAsync(string dirPath, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var result = await _inner.GetDirMetadataAsync(dirPath, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            var count = result?.Count ?? 0;

            PublishEvent("Read", dirPath, sw.Elapsed.TotalMilliseconds, contentSizeBytes: count, hasContent: result != null, contentPreview: null, ttlSeconds: 0);
            return result;
        }

        /// <inheritdoc/>
        public async Task<IDictionary<string, string>> GetFileMetadataAsync(string filePath, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var result = await _inner.GetFileMetadataAsync(filePath, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            var count = result?.Count ?? 0;

            PublishEvent("Read", filePath, sw.Elapsed.TotalMilliseconds, contentSizeBytes: count, hasContent: result != null, contentPreview: null, ttlSeconds: 0);
            return result;
        }

        /// <summary>
        /// Truncates a string preview to 4KB. Returns null if input is null.
        /// </summary>
        private static string TruncatePreview(string content)
        {
            if (content == null) return null;
            return content.Length <= MaxContentPreviewBytes
                ? content
                : content.Substring(0, MaxContentPreviewBytes);
        }

        /// <summary>
        /// Publishes a FileOpEvent to the "fileop" topic. Never throws.
        /// </summary>
        private void PublishEvent(string operation, string path, double durationMs, long contentSizeBytes, bool hasContent, string contentPreview, long ttlSeconds)
        {
            try
            {
                var eventData = new
                {
                    operation,
                    path,
                    contentSizeBytes,
                    durationMs,
                    hasContent,
                    contentPreview,
                    ttlSeconds,
                    iterationId = _iterationId,
                };

                EdogTopicRouter.Publish("fileop", eventData);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] FileSystemInterceptor publish error: {ex.Message}");
            }
        }
    }
}
