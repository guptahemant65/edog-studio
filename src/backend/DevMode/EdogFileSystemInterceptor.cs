// <copyright file="EdogFileSystemInterceptor.cs.new" company="Microsoft">
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
    using Microsoft.ServicePlatform.Telemetry;

    /// <summary>
    /// Decorator that wraps <see cref="IFileSystemFactory"/> to intercept all file system operations.
    /// Every <see cref="IFileSystem"/> created through this factory is wrapped with
    /// <see cref="EdogFileSystemWrapper"/> which publishes FileOpEvent to the "fileop" topic.
    /// Thread-safe. Zero overhead on caller — publish failures never propagate to FLT.
    /// </summary>
    public class EdogFileSystemFactoryWrapper : IFileSystemFactory
    {
        private readonly IFileSystemFactory _inner;

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
            // Bug 1 fix: this is the workspace+lakehouse artifact id, NOT
            // a DAG iteration id. The old code called it `iterationId` and
            // it lied — every file op against the same lakehouse landed in
            // the same "iteration" regardless of which RunDAG actually
            // triggered the op. The real iteration id is derived per-op at
            // publish time via the ambient MonitoredScope.RootActivityId
            // and the EdogLogInterceptor.TryGetIterationForRootActivity
            // reverse lookup (populated by SSR + Additional telemetry
            // interceptors as they observe events).
            var artifactId = $"{workspaceId:N}-{lakehouseId:N}";
            return new EdogFileSystemWrapper(inner, artifactId);
        }
    }

    /// <summary>
    /// One element of the per-file metadata array published by
    /// <c>ListFilesWithMetadataAsync</c>. Bug 6 fix: previously the
    /// interceptor discarded the (Path, LastModified, Size) tuples and
    /// published only a count — throwing away the data needed for real
    /// lock-age detection and per-file UI rendering.
    /// </summary>
    public class FileEntryMetadata
    {
        public string Path { get; set; }
        public DateTimeOffset LastModified { get; set; }
        public long Size { get; set; }
    }

    /// <summary>
    /// Decorator that wraps a single <see cref="IFileSystem"/> instance to capture all 16 operations.
    /// Publishes FileOpEvent to the "fileop" topic via <see cref="EdogTopicRouter"/>.
    ///
    /// Bug 3 fix: every wrap method uses try/catch. On exception, a fileop
    /// event tagged with success=false + errorMessage + errorType is
    /// published BEFORE the exception is rethrown. The original FLT
    /// behavior (exception propagates to caller) is preserved exactly.
    ///
    /// Bug 1+2 fix: every published event carries rootActivityId (always),
    /// iterationId (best-effort lookup, null if unknown), and artifactId
    /// (workspace+lakehouse). The old single misnamed `iterationId` field
    /// is gone.
    ///
    /// Bug 5 fix: list/metadata ops use a separate `itemCount` field for
    /// "how many items came back" — `contentSizeBytes` is reserved for
    /// actual byte counts.
    ///
    /// Bug 6 fix: ListFilesWithMetadataAsync publishes the full
    /// (Path, LastModified, Size) array as `files`.
    ///
    /// Bug 8 fix: paginated list ops publish `hasMoreContinuation` so the
    /// UI can show pagination state.
    ///
    /// Content previews are truncated to 4KB. Duration captured via Stopwatch.
    /// Thread-safe stateless decorator — _inner and _artifactId are readonly.
    /// </summary>
    public class EdogFileSystemWrapper : IFileSystem
    {
        private const int MaxContentPreviewBytes = 4096;
        private readonly IFileSystem _inner;
        private readonly string _artifactId;

        public EdogFileSystemWrapper(IFileSystem inner, string artifactId)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
            _artifactId = artifactId;
        }

        /// <inheritdoc/>
        public async Task<bool> ExistsAsync(string path, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.ExistsAsync(path, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                PublishEvent("Exists", path, sw.Elapsed.TotalMilliseconds, 0, false, null, 0);
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("Exists", path, sw.Elapsed.TotalMilliseconds, ex);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task CreateDirIfNotExistsAsync(string path, IDictionary<string, string> metadata = default, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                await _inner.CreateDirIfNotExistsAsync(path, metadata, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                PublishEvent("CreateDir", path, sw.Elapsed.TotalMilliseconds, 0, false, null, 0, metadata: metadata);
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("CreateDir", path, sw.Elapsed.TotalMilliseconds, ex, metadata: metadata);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task CreateOrUpdateFileAsync(string path, string content, TimeSpan timeToExpire = default, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var contentSize = content != null ? System.Text.Encoding.UTF8.GetByteCount(content) : 0;
            try
            {
                await _inner.CreateOrUpdateFileAsync(path, content, timeToExpire, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                var preview = TruncatePreview(content);
                var ttl = timeToExpire != default ? (long)timeToExpire.TotalSeconds : 0;
                var truncated = content != null && content.Length > MaxContentPreviewBytes;
                PublishEvent("WriteFile", path, sw.Elapsed.TotalMilliseconds, contentSize, content != null, preview, ttl, previewTruncated: truncated);
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("WriteFile", path, sw.Elapsed.TotalMilliseconds, ex, contentSizeBytes: contentSize);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<string> ReadFileAsStringAsync(string path, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.ReadFileAsStringAsync(path, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                var contentSize = result != null ? System.Text.Encoding.UTF8.GetByteCount(result) : 0;
                var preview = TruncatePreview(result);
                var truncated = result != null && result.Length > MaxContentPreviewBytes;
                PublishEvent("Read", path, sw.Elapsed.TotalMilliseconds, contentSize, result != null, preview, 0, previewTruncated: truncated);
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("Read", path, sw.Elapsed.TotalMilliseconds, ex);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<bool> CreateEmptyFileIfNotExistsAsync(string path, IDictionary<string, string> metadata = default, TimeSpan timeToExpire = default, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.CreateEmptyFileIfNotExistsAsync(path, metadata, timeToExpire, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                var ttl = timeToExpire != default ? (long)timeToExpire.TotalSeconds : 0;
                PublishEvent("CreateFile", path, sw.Elapsed.TotalMilliseconds, 0, false, null, ttl, operationResult: result, metadata: metadata);
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("CreateFile", path, sw.Elapsed.TotalMilliseconds, ex, metadata: metadata);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task RenameFileAsync(string srcPath, string destinationPath, IDictionary<string, string> metadata = default, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var displayPath = srcPath + " \u2192 " + destinationPath;
            try
            {
                await _inner.RenameFileAsync(srcPath, destinationPath, metadata, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                PublishEvent("Rename", displayPath, sw.Elapsed.TotalMilliseconds, 0, false, null, 0, metadata: metadata);
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("Rename", displayPath, sw.Elapsed.TotalMilliseconds, ex, metadata: metadata);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<bool> DeleteFileIfExistsAsync(string path, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.DeleteFileIfExistsAsync(path, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                PublishEvent("DeleteFile", path, sw.Elapsed.TotalMilliseconds, 0, false, null, 0, operationResult: result);
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("DeleteFile", path, sw.Elapsed.TotalMilliseconds, ex);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<bool> DeleteDirIfExistsAsync(string path, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.DeleteDirIfExistsAsync(path, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                PublishEvent("DeleteDir", path, sw.Elapsed.TotalMilliseconds, 0, false, null, 0, operationResult: result);
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("DeleteDir", path, sw.Elapsed.TotalMilliseconds, ex);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<List<string>> ListAsync(string path, int maxCount = default, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.ListAsync(path, maxCount, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                var count = result?.Count ?? 0;
                PublishEvent("List", path, sw.Elapsed.TotalMilliseconds, 0, false, null, 0, itemCount: count);
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("List", path, sw.Elapsed.TotalMilliseconds, ex);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<byte[]> ReadFileBytesAsync(string path, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.ReadFileBytesAsync(path, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                var contentSize = result?.Length ?? 0;
                PublishEvent("Read", path, sw.Elapsed.TotalMilliseconds, contentSize, result != null, null, 0);
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("Read", path, sw.Elapsed.TotalMilliseconds, ex);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<(List<string> Paths, string ContinuationToken)> ListWithContinuationAsync(string path, int maxCount = default, string continuationToken = null, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.ListWithContinuationAsync(path, maxCount, continuationToken, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                var count = result.Paths?.Count ?? 0;
                // Bug 5 + 8 fix: itemCount (not contentSizeBytes) for item count,
                // hasMoreContinuation so the UI can show "there's more — you're
                // paginating" without leaking the opaque token value.
                PublishEvent(
                    "List", path, sw.Elapsed.TotalMilliseconds,
                    0, false, null, 0,
                    itemCount: count,
                    hasMoreContinuation: !string.IsNullOrEmpty(result.ContinuationToken));
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("List", path, sw.Elapsed.TotalMilliseconds, ex);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<IDictionary<string, string>> GetDirMetadataAsync(string dirPath, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.GetDirMetadataAsync(dirPath, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                var count = result?.Count ?? 0;
                PublishEvent("GetDirMetadata", dirPath, sw.Elapsed.TotalMilliseconds, 0, result != null, null, 0, itemCount: count);
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("GetDirMetadata", dirPath, sw.Elapsed.TotalMilliseconds, ex);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<IDictionary<string, string>> GetFileMetadataAsync(string filePath, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.GetFileMetadataAsync(filePath, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                var count = result?.Count ?? 0;
                PublishEvent("GetFileMetadata", filePath, sw.Elapsed.TotalMilliseconds, 0, result != null, null, 0, itemCount: count);
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("GetFileMetadata", filePath, sw.Elapsed.TotalMilliseconds, ex);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<bool> CreateFileWithContentIfNotExistsAsync(string path, string content, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var contentSize = content != null ? System.Text.Encoding.UTF8.GetByteCount(content) : 0;
            try
            {
                var result = await _inner.CreateFileWithContentIfNotExistsAsync(path, content, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                var preview = TruncatePreview(content);
                var truncated = content != null && content.Length > MaxContentPreviewBytes;
                PublishEvent("CreateFile", path, sw.Elapsed.TotalMilliseconds, contentSize, content != null, preview, 0, operationResult: result, previewTruncated: truncated);
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("CreateFile", path, sw.Elapsed.TotalMilliseconds, ex, contentSizeBytes: contentSize);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task WriteFileBytesAsync(string path, byte[] bytes, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            var contentSize = bytes?.Length ?? 0;
            try
            {
                await _inner.WriteFileBytesAsync(path, bytes, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                PublishEvent("WriteFile", path, sw.Elapsed.TotalMilliseconds, contentSize, bytes != null, null, 0);
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("WriteFile", path, sw.Elapsed.TotalMilliseconds, ex, contentSizeBytes: contentSize);
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<(List<(string Path, DateTimeOffset LastModified, long Size)> Files, string ContinuationToken)> ListFilesWithMetadataAsync(string path, int maxCount = default, string continuationToken = null, CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.ListFilesWithMetadataAsync(path, maxCount, continuationToken, cancellationToken).ConfigureAwait(false);
                sw.Stop();
                // Bug 6 fix: expose the per-file (Path, LastModified, Size)
                // triples — real lock-age detection in the UI needs these.
                List<FileEntryMetadata> files = null;
                if (result.Files != null)
                {
                    files = new List<FileEntryMetadata>(result.Files.Count);
                    foreach (var (fp, lm, sz) in result.Files)
                    {
                        files.Add(new FileEntryMetadata { Path = fp, LastModified = lm, Size = sz });
                    }
                }
                PublishEvent(
                    "ListFilesWithMetadata", path, sw.Elapsed.TotalMilliseconds,
                    0, false, null, 0,
                    itemCount: result.Files?.Count ?? 0,
                    hasMoreContinuation: !string.IsNullOrEmpty(result.ContinuationToken),
                    files: files);
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                PublishFailure("ListFilesWithMetadata", path, sw.Elapsed.TotalMilliseconds, ex);
                throw;
            }
        }

        private static string TruncatePreview(string content)
        {
            if (content == null) return null;
            return content.Length <= MaxContentPreviewBytes
                ? content
                : content.Substring(0, MaxContentPreviewBytes);
        }

        /// <summary>
        /// Publishes a successful FileOpEvent to the "fileop" topic.
        /// Bug 1+2 fix: every event carries rootActivityId (always),
        /// iterationId (best-effort lookup, null if unknown), artifactId
        /// (workspace+lakehouse stamped at factory time).
        /// Bug 5+6+8 fix: itemCount / files / hasMoreContinuation surface
        /// list-shaped semantics without abusing contentSizeBytes.
        /// Never throws.
        /// </summary>
        private void PublishEvent(
            string operation,
            string path,
            double durationMs,
            long contentSizeBytes,
            bool hasContent,
            string contentPreview,
            long ttlSeconds,
            bool? operationResult = null,
            bool previewTruncated = false,
            IDictionary<string, string> metadata = null,
            long itemCount = 0,
            bool? hasMoreContinuation = null,
            IList<FileEntryMetadata> files = null,
            string errorMessage = null,
            string errorType = null,
            bool success = true)
        {
            try
            {
                // Read ambient context at publish time so the event tags
                // the actual RAID + iteration of the request that triggered
                // this file op (not the factory-construction context).
                var rootActivityId = MonitoredScope.RootActivityId.ToString();
                var iterationId = EdogLogInterceptor.TryGetIterationForRootActivity(rootActivityId);

                var eventData = new
                {
                    operation,
                    path,
                    contentSizeBytes,
                    durationMs,
                    hasContent,
                    contentPreview,
                    previewTruncated,
                    ttlSeconds,
                    operationResult,
                    metadata = metadata != null ? new Dictionary<string, string>(metadata) : null,

                    // Bug 1 + 2 fix
                    rootActivityId,
                    iterationId,
                    artifactId = _artifactId,

                    // Bug 5 + 6 + 8 fix
                    itemCount,
                    hasMoreContinuation,
                    files,

                    // Bug 3 fix
                    success,
                    errorMessage,
                    errorType,
                };

                EdogTopicRouter.Publish("fileop", eventData);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] FileSystemInterceptor publish error: {ex.Message}");
            }
        }

        /// <summary>
        /// Convenience wrapper for the catch path. Bug 3 fix: every wrap
        /// method calls this before rethrowing so failed file ops appear
        /// in the System Files tab with their error type and message.
        /// </summary>
        private void PublishFailure(
            string operation,
            string path,
            double durationMs,
            Exception ex,
            long contentSizeBytes = 0,
            IDictionary<string, string> metadata = null)
        {
            PublishEvent(
                operation, path, durationMs,
                contentSizeBytes, false, null, 0,
                metadata: metadata,
                success: false,
                errorMessage: ex?.Message,
                errorType: ex?.GetType()?.FullName);
        }
    }
}
