// <copyright file="EdogWorkloadCommunicationProviderWrapper.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Net.Http;
    using System.Reflection;
    using System.Threading.Tasks;
    using Microsoft.MWC.Workload.Client.Library.Providers;

    /// <summary>
    /// Runtime-generated transparent proxy that wraps
    /// <see cref="IWorkloadCommunicationProvider"/> so every HttpClient
    /// returned by Get*HttpClient*Async carries
    /// <see cref="EdogTokenInterceptor"/> + <see cref="EdogHttpPipelineHandler"/>
    /// in its handler chain.
    ///
    /// # Why DispatchProxy (and not a hand-rolled `class : IWorkloadCommunicationProvider`)
    ///
    /// <c>IWorkloadCommunicationProvider</c> declares some members
    /// (notably <c>GetWorkloadCapacityHttpClientAsync</c>) with
    /// <c>internal</c> accessibility within the MWC assembly. The FLT
    /// assembly is NOT in MWC's <c>InternalsVisibleTo</c>, so a hand-rolled
    /// implementation hits a C# Catch-22:
    ///
    ///   * Leave the internal member unimplemented → CS0535 (interface
    ///     contract not satisfied).
    ///   * Implement it implicitly with a <c>public</c> method → CS9044
    ///     (public method cannot implicitly implement an inaccessible
    ///     interface member).
    ///   * Implement it explicitly with
    ///     <c>Task&lt;HttpClient&gt; IWorkloadCommunicationProvider.GetWorkloadCapacityHttpClientAsync(...)</c>
    ///     → CS0122 (the interface member name is inaccessible at this
    ///     declaration scope).
    ///
    /// <see cref="System.Reflection.DispatchProxy"/> sidesteps the
    /// accessibility problem entirely. The runtime emits IL that
    /// implements every interface member (public AND internal) at JIT
    /// time, then routes each call into our <see cref="Invoke"/>
    /// override. We never name an individual method in C# source — the
    /// compiler doesn't enforce accessibility on method names that
    /// don't appear in our code.
    ///
    /// # What we intercept
    ///
    /// Only methods whose return is <c>Task&lt;HttpClient&gt;</c>: we
    /// await the inner result and wrap the HttpClient with the EDOG
    /// handler chain. Everything else is forwarded verbatim.
    ///
    /// # Factory contract
    ///
    /// Use <see cref="Create"/> — NOT <c>new</c>. DispatchProxy
    /// requires the runtime factory to construct the IL-generated
    /// concrete type; <c>new EdogWorkloadCommunicationProviderWrapper()</c>
    /// would produce an instance that doesn't implement the interface.
    /// </summary>
    public class EdogWorkloadCommunicationProviderWrapper : DispatchProxy
    {
        // Cached MethodInfo for HttpMessageInvoker._handler — used by
        // WrapHttpClient to splice EDOG handlers into the chain. Same
        // pattern as EdogHttpClientFactoryWrapper.
        private static readonly FieldInfo s_handlerField =
            typeof(HttpMessageInvoker).GetField(
                "_handler",
                BindingFlags.Instance | BindingFlags.NonPublic);

        private IWorkloadCommunicationProvider _inner;

        // Parameterless ctor is required by DispatchProxy. Use Create()
        // to construct a working instance.
        public EdogWorkloadCommunicationProviderWrapper() { }

        /// <summary>
        /// Construct a wrapped <see cref="IWorkloadCommunicationProvider"/>.
        /// The returned object implements the interface (via runtime-
        /// generated IL) AND carries our <see cref="Invoke"/> hook for
        /// HttpClient wrapping.
        /// </summary>
        public static IWorkloadCommunicationProvider Create(IWorkloadCommunicationProvider inner)
        {
            if (inner == null) throw new ArgumentNullException(nameof(inner));
            var proxy = DispatchProxy.Create<IWorkloadCommunicationProvider, EdogWorkloadCommunicationProviderWrapper>();
            ((EdogWorkloadCommunicationProviderWrapper)(object)proxy)._inner = inner;
            return proxy;
        }

        /// <inheritdoc/>
        protected override object Invoke(MethodInfo targetMethod, object[] args)
        {
            if (targetMethod == null) throw new ArgumentNullException(nameof(targetMethod));

            object result;
            try
            {
                result = targetMethod.Invoke(_inner, args);
            }
            catch (TargetInvocationException tie)
            {
                // Unwrap so the caller sees the real exception (preserving
                // FLT's existing error-handling contract). Without this,
                // every exception from MWC would bubble up wrapped.
                throw tie.InnerException ?? tie;
            }

            // Only HttpClient-returning Get* methods need wrapping. Other
            // methods (CallWorkloadActionAsync, GetWorkloadEndpointsAsync,
            // RegisterForAction, etc.) pass through verbatim.
            if (result is Task<HttpClient> httpClientTask)
            {
                return WrapHttpClientTaskAsync(httpClientTask, targetMethod.Name);
            }

            return result;
        }

        private static async Task<HttpClient> WrapHttpClientTaskAsync(Task<HttpClient> inner, string methodName)
        {
            var client = await inner.ConfigureAwait(false);
            return WrapHttpClient(client, methodName);
        }

        /// <summary>
        /// Reflectively re-handlers an HttpClient so its message-handler
        /// chain begins with EdogTokenInterceptor + EdogHttpPipelineHandler.
        /// Falls back to the original client when reflection fails —
        /// instrumentation failures must never break FLT's HTTP flow.
        /// </summary>
        private static HttpClient WrapHttpClient(HttpClient original, string methodName)
        {
            if (original == null) return null;
            try
            {
                var innerHandler = s_handlerField?.GetValue(original) as HttpMessageHandler;
                if (innerHandler == null) return original;

                var clientName = "WCP:" + methodName;
                var httpPipeline = new EdogHttpPipelineHandler(clientName) { InnerHandler = innerHandler };
                var tokenInterceptor = new EdogTokenInterceptor(clientName) { InnerHandler = httpPipeline };
                var wrapped = new HttpClient(tokenInterceptor, disposeHandler: false);

                if (original.BaseAddress != null) wrapped.BaseAddress = original.BaseAddress;
                wrapped.Timeout = original.Timeout;
                // Preserve DefaultRequestHeaders — MWC sometimes bakes auth
                // tokens onto the HttpClient instance rather than into a
                // DelegatingHandler. Without this copy, GTS/Notebook would
                // appear authenticated in the original but unauthenticated
                // in the wrapped client.
                foreach (var h in original.DefaultRequestHeaders)
                {
                    wrapped.DefaultRequestHeaders.TryAddWithoutValidation(h.Key, h.Value);
                }

                return wrapped;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[EDOG] WorkloadCommunicationProviderWrapper.WrapHttpClient failed for '{methodName}': {ex.Message}");
                return original;
            }
        }
    }
}
