// <copyright file="EdogDevModeRegistrar.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;

    using Microsoft.Extensions.DependencyInjection;
    using Microsoft.Extensions.Logging.Abstractions;

    /// <summary>
    /// Single entry point for registering all EDOG DevMode runtime interceptors.
    /// Called from WorkloadApp.cs RunAsync callback. Idempotent — safe to call multiple times.
    /// </summary>
    public static class EdogDevModeRegistrar
    {
        private static bool _registered;
        private static bool _httpClientFactoryWrapped;

        /// <summary>
        /// Registers all EDOG DevMode interceptors. Idempotent.
        /// Failures are non-fatal — FLT service continues normally.
        /// </summary>
        public static void RegisterAll()
        {
            if (_registered) return;

            try
            {
                // Initialize topic router (safe to call again — TryAdd is idempotent)
                EdogTopicRouter.Initialize();

                // Phase 2B interceptors — each wraps one FLT interface
                RegisterFeatureFlighterWrapper();
                RegisterPerfMarkerCallback();
                RegisterTokenInterceptor();
                RegisterFileSystemInterceptor();
                RegisterHttpPipelineHandler();
                RegisterRetryInterceptor();
                RegisterCacheInterceptor();
                RegisterSparkSessionInterceptor();
                RegisterDiRegistryCapture();
                RegisterTokenLifecycleInterceptor();
                RegisterCatalogInterceptor();
                RegisterFltOpsInterceptors();

                // DAG execution hook (EdogDagExecutionHook) is wired via edog.py
                // patch to DagExecutionHandlerV2.cs — adds our hook to the inline hook list.
                // NodeExecutor wrapping needs a patch at the creation point. See gaps-roadmap.md Gap 2.

                // QA Testing engines (F27) — singletons, initialized once
                RegisterQaServices();

                // Nexus aggregator — consumes topic events, emits dependency graph snapshots
                StartNexusAggregator();

                // Set the flag only AFTER all work completes. If an exception bubbled out of
                // the inner Register* methods (each has its own try/catch, so unlikely), we
                // want RegisterAll() to be retryable on the next invocation rather than
                // silently no-op'ing forever.
                _registered = true;

                Console.WriteLine("[EDOG] DevMode interceptors registered");
            }
            catch (Exception ex)
            {
                // Non-fatal — FLT service continues normally without devmode interceptors.
                // _registered remains false so the next call can attempt registration again.
                Console.WriteLine($"[EDOG] DevMode registration failed (non-fatal): {ex.Message}");
            }
        }

        // ── TryWrap helper ──────────────────────────────────────────────────────
        // Generic "resolve → check → register → re-resolve verify → record" for
        // DI interceptors that wrap a singleton interface. Critical detail: MWC's
        // Unity wrapper exposes a "set-then-throw" behavior — once the platform has
        // resolved a singleton with `PerContainer` lifetime, calling RegisterInstance
        // again throws `ValidateRegistrationStrategy` BUT the instance is still
        // written into the LifetimeManager. So a thrown RegisterInstance does NOT
        // necessarily mean the wrap failed. We must re-Resolve and check the
        // returned type. The wrapper-presence test is the source of truth, not the
        // exception. If the wrapper IS present after the call, record Ok; otherwise
        // record Failed with the original exception message.
        private static void TryWrap<T>(
            string name,
            Func<T, bool> isWrapper,
            Func<T, T> wrap) where T : class
        {
            Exception regException = null;
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<T>();
                if (isWrapper(inner))
                {
                    Console.WriteLine($"[EDOG] ✓ {name} interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }

                try
                {
                    var wrapper = wrap(inner);
                    Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<T>(wrapper);
                }
                catch (Exception ex)
                {
                    // Capture but don't propagate yet — Unity may have written the
                    // instance into the LifetimeManager before the validator threw.
                    regException = ex;
                }

                var after = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<T>();
                if (isWrapper(after))
                {
                    Console.WriteLine($"[EDOG] ✓ {name} interceptor registered");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
                    return;
                }

                var msg = regException?.Message ?? "wrapper not present after RegisterInstance";
                Console.WriteLine($"[EDOG] ✗ {name} interceptor failed: {msg}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, msg);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ {name} interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
        }

        private static void RegisterFeatureFlighterWrapper()
        {
            TryWrap<Microsoft.LiveTable.Service.FeatureFlightProvider.IFeatureFlighter>(
                "FeatureFlighter",
                inner => inner is EdogFeatureFlighterWrapper,
                inner => new EdogFeatureFlighterWrapper(inner));
        }

        private static void RegisterPerfMarkerCallback()
        {
            TryWrap<Microsoft.ServicePlatform.Telemetry.IServiceMonitoringCallback>(
                "PerfMarker",
                inner => inner is EdogPerfMarkerCallback,
                inner => new EdogPerfMarkerCallback(inner));
        }

        private static void RegisterTokenInterceptor()
        {
            const string name = "Token";
            try
            {
                var newlyWrapped = EnsureHttpClientFactoryWrapped();
                EdogInterceptorRegistry.Record(
                    name,
                    newlyWrapped
                        ? EdogInterceptorRegistry.RegistrationStatus.Ok
                        : EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Token interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
        }

        private static void RegisterFileSystemInterceptor()
        {
            TryWrap<Microsoft.LiveTable.Service.Persistence.Fs.IFileSystemFactory>(
                "FileSystemFactory",
                inner => inner is EdogFileSystemFactoryWrapper,
                inner => new EdogFileSystemFactoryWrapper(inner));
        }

        private static void RegisterHttpPipelineHandler()
        {
            const string name = "HttpPipelineHandler";
            try
            {
                var newlyWrapped = EnsureHttpClientFactoryWrapped();
                EdogInterceptorRegistry.Record(
                    name,
                    newlyWrapped
                        ? EdogInterceptorRegistry.RegistrationStatus.Ok
                        : EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ HTTP pipeline handler failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
        }

        /// <summary>
        /// Shared registration for both EdogTokenInterceptor and EdogHttpPipelineHandler.
        /// Wraps IHttpClientFactory with EdogHttpClientFactoryWrapper which injects both
        /// DelegatingHandlers into every HttpClient pipeline. Idempotent.
        /// Uses the same set-then-throw verification as TryWrap — re-resolves after
        /// RegisterInstance and treats wrapper-present as success regardless of any
        /// exception thrown.
        /// </summary>
        /// <returns>
        /// <c>true</c> if this call performed the wrap (newly registered and verified);
        /// <c>false</c> if the wrap was already in place (idempotent no-op).
        /// </returns>
        private static bool EnsureHttpClientFactoryWrapped()
        {
            if (_httpClientFactoryWrapped) return false;

            var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                System.Net.Http.IHttpClientFactory>();
            if (inner is EdogHttpClientFactoryWrapper)
            {
                _httpClientFactoryWrapped = true;
                return false;
            }

            Exception regException = null;
            try
            {
                var wrapper = new EdogHttpClientFactoryWrapper(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    System.Net.Http.IHttpClientFactory>(wrapper);
            }
            catch (Exception ex)
            {
                regException = ex;
            }

            // Verify by re-resolving — Unity may have set-then-thrown.
            var after = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                System.Net.Http.IHttpClientFactory>();
            if (after is EdogHttpClientFactoryWrapper)
            {
                _httpClientFactoryWrapped = true;
                Console.WriteLine("[EDOG] ✓ HttpClientFactory interceptors registered (Token + HTTP pipeline)");
                return true;
            }

            // Wrapper not present after registration attempt — propagate failure to caller.
            throw regException ?? new InvalidOperationException(
                "EdogHttpClientFactoryWrapper not present after RegisterInstance");
        }

        private static void RegisterRetryInterceptor()
        {
            const string name = "Retry";
            try
            {
                EdogRetryInterceptor.Start();
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Retry interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
        }

        private static void RegisterCacheInterceptor()
        {
            // EdogCacheInterceptor is now a static utility class.
            // Cache events are published via EdogCacheInterceptor.RecordCacheEvent()
            // which can be called from any component. No DI wrapping needed.
            Console.WriteLine("[EDOG] ✓ Cache interceptor ready (static utility)");
            EdogInterceptorRegistry.Record("Cache", EdogInterceptorRegistry.RegistrationStatus.Ok);
        }

        private static void RegisterSparkSessionInterceptor()
        {
            TryWrap<Microsoft.LiveTable.Service.SparkHttp.ISparkClientFactory>(
                "SparkSession",
                inner => inner is EdogSparkSessionInterceptor,
                inner => new EdogSparkSessionInterceptor(inner));
        }

        private static void RegisterDiRegistryCapture()
        {
            const string name = "DiRegistryCapture";
            try
            {
                EdogDiRegistryCapture.CaptureRegistrations();
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ DI registry capture failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
        }

        private static void RegisterTokenLifecycleInterceptor()
        {
            TryWrap<Microsoft.LiveTable.Service.TokenManagement.ITokenManager>(
                "TokenLifecycle",
                inner => inner is EdogTokenLifecycleInterceptor,
                inner => new EdogTokenLifecycleInterceptor(inner));
        }

        private static void RegisterCatalogInterceptor()
        {
            TryWrap<Microsoft.LiveTable.Service.Catalog.ICatalogHandler>(
                "Catalog",
                inner => inner is EdogCatalogInterceptor,
                inner => new EdogCatalogInterceptor(inner));
        }

        // ── RegisterFltOpsInterceptors ──────────────────────────────────────────
        // Each sub-interceptor lives in its own method so a `return` inside one
        // does not short-circuit the others. The previous shape bundled all four
        // in one method with early `return` for the "already wrapped" path —
        // when RefreshTriggers came back already-wrapped, MLV / ReportState /
        // TableMaintenance silently never even attempted registration.

        private static void RegisterFltOpsInterceptors()
        {
            RegisterRefreshTriggersInterceptor();
            RegisterMlvDefinitionInterceptor();
            RegisterReportStateInterceptor();
            RegisterTableMaintenanceInterceptor();
        }

        private static void RegisterRefreshTriggersInterceptor()
        {
            TryWrap<Microsoft.LiveTable.Service.Core.RefreshTrigger.IRefreshTriggersHandler>(
                "RefreshTriggers",
                inner => inner is EdogRefreshTriggersWrapper,
                inner => new EdogRefreshTriggersWrapper(inner));
        }

        private static void RegisterMlvDefinitionInterceptor()
        {
            TryWrap<Microsoft.LiveTable.Service.Persistence.IMLVExecutionDefinitionPersistenceManager>(
                "MLVDefinition",
                inner => inner is EdogMLVDefinitionWrapper,
                inner => new EdogMLVDefinitionWrapper(inner));
        }

        private static void RegisterReportStateInterceptor()
        {
            TryWrap<Microsoft.LiveTable.Service.DataQuality.StateManagement.IReportStateManager>(
                "ReportState",
                inner => inner is EdogReportStateWrapper,
                inner => new EdogReportStateWrapper(inner));
        }

        private static void RegisterTableMaintenanceInterceptor()
        {
            TryWrap<Microsoft.LiveTable.Service.Maintenance.MaintenanceHttp.ITableMaintenanceClientFactory>(
                "TableMaintenance",
                inner => inner is EdogTableMaintenanceFactoryWrapper,
                inner => new EdogTableMaintenanceFactoryWrapper(inner));
        }

        private static void StartNexusAggregator()
        {
            try
            {
                EdogNexusAggregator.Start();
                Console.WriteLine("[EDOG] ✓ Nexus aggregator started");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Nexus aggregator failed: {ex.Message}");
            }
        }

        private static void RegisterQaServices()
        {
            try
            {
                // Register the "qa" topic buffer for QA engine status/progress events
                EdogTopicRouter.RegisterTopic("qa", 500);

                // Real provider implementations for the five-layer code understanding engine
                var graphProvider = new EdogQaGraphProvider();
                var omniSharpProvider = new EdogQaOmniSharpProvider();
                var llmProvider = new EdogQaLlmProvider();
                var diRegistryProvider = new EdogQaDiRegistryProvider();

                var codeAnalyzer = new EdogQaCodeAnalyzer(
                    graphProvider,
                    omniSharpProvider,
                    llmProvider,
                    diRegistryProvider);

                // Minimal service provider for engines that require IServiceProvider
                var serviceProvider = new ServiceCollection()
                    .BuildServiceProvider();

                // Resolve IHttpClientFactory if already registered, otherwise null
                System.Net.Http.IHttpClientFactory httpClientFactory = null;
                try
                {
                    httpClientFactory = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                        System.Net.Http.IHttpClientFactory>();
                }
                catch { /* Not yet registered — handlers degrade gracefully */ }

                var loggerFactory = Microsoft.Extensions.Logging.Abstractions.NullLoggerFactory.Instance;

                var stimulusDispatcher = new EdogQaStimulusDispatcher(
                    httpClientFactory,
                    serviceProvider,
                    5555,
                    loggerFactory.CreateLogger("EdogQaStimulusDispatcher"));

                var executionEngine = new EdogQaExecutionEngine(
                    stimulusDispatcher,
                    null,  // ResultAggregator is per-run — created at execution time
                    codeAnalyzer,
                    NullLogger<EdogQaExecutionEngine>.Instance,
                    serviceProvider);

                // Populate service locator for hub access
                EdogQaServiceLocator.ExecutionEngine = executionEngine;
                EdogQaServiceLocator.CodeAnalyzer = codeAnalyzer;

                Console.WriteLine("[EDOG] ✓ QA Testing engines registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ QA Testing engines failed: {ex.Message}");
            }
        }

        // ─── (F27 P4) Null* providers were here and never wired ───
        // The pre-Connected codepath now uses the real providers (which
        // throw a typed LlmProviderException when LLM isn't configured),
        // so the Null* stubs are dead weight. Removed in P4 along with
        // the silent synthetic fallback. The Stub* providers in
        // EdogQaCodeAnalyzer.cs remain as test-only utilities.
    }

    // EdogQaServiceLocator is defined in EdogPlaygroundHub.cs
}
