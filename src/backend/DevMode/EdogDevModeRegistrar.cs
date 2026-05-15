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

        private static void RegisterFeatureFlighterWrapper()
        {
            const string name = "FeatureFlighter";
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.FeatureFlightProvider.IFeatureFlighter>();
                if (inner is EdogFeatureFlighterWrapper)
                {
                    Console.WriteLine("[EDOG] ✓ FeatureFlighter interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }
                var wrapper = new EdogFeatureFlighterWrapper(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.FeatureFlightProvider.IFeatureFlighter>(wrapper);
                Console.WriteLine("[EDOG] ✓ FeatureFlighter interceptor registered");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ FeatureFlighter interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
        }

        private static void RegisterPerfMarkerCallback()
        {
            const string name = "PerfMarker";
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<Microsoft.ServicePlatform.Telemetry.IServiceMonitoringCallback>();
                if (inner is EdogPerfMarkerCallback)
                {
                    Console.WriteLine("[EDOG] ✓ PerfMarker interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }
                var wrapper = new EdogPerfMarkerCallback(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<Microsoft.ServicePlatform.Telemetry.IServiceMonitoringCallback>(wrapper);
                Console.WriteLine("[EDOG] ✓ PerfMarker interceptor registered");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ PerfMarker interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
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
            const string name = "FileSystemFactory";
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.Persistence.Fs.IFileSystemFactory>();
                if (inner is EdogFileSystemFactoryWrapper)
                {
                    Console.WriteLine("[EDOG] ✓ FileSystemFactory interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }
                var wrapper = new EdogFileSystemFactoryWrapper(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.Persistence.Fs.IFileSystemFactory>(wrapper);
                Console.WriteLine("[EDOG] ✓ FileSystemFactory interceptor registered");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ FileSystemFactory interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
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
        /// </summary>
        /// <returns>
        /// <c>true</c> if this call performed the wrap (newly registered);
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
            var wrapper = new EdogHttpClientFactoryWrapper(inner);
            Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                System.Net.Http.IHttpClientFactory>(wrapper);
            _httpClientFactoryWrapped = true;
            Console.WriteLine("[EDOG] ✓ HttpClientFactory interceptors registered (Token + HTTP pipeline)");
            return true;
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
            const string name = "SparkSession";
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.SparkHttp.ISparkClientFactory>();
                if (inner is EdogSparkSessionInterceptor)
                {
                    Console.WriteLine("[EDOG] ✓ Spark session interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }
                var wrapper = new EdogSparkSessionInterceptor(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.SparkHttp.ISparkClientFactory>(wrapper);
                Console.WriteLine("[EDOG] ✓ Spark session interceptor registered");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Spark session interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
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
            const string name = "TokenLifecycle";
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.TokenManagement.ITokenManager>();
                if (inner is EdogTokenLifecycleInterceptor)
                {
                    Console.WriteLine("[EDOG] ✓ TokenLifecycle interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }
                var wrapper = new EdogTokenLifecycleInterceptor(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.TokenManagement.ITokenManager>(wrapper);
                Console.WriteLine("[EDOG] ✓ TokenLifecycle interceptor registered");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ TokenLifecycle interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
        }

        private static void RegisterCatalogInterceptor()
        {
            const string name = "Catalog";
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.Catalog.ICatalogHandler>();
                if (inner is EdogCatalogInterceptor)
                {
                    Console.WriteLine("[EDOG] ✓ Catalog interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }
                var wrapper = new EdogCatalogInterceptor(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.Catalog.ICatalogHandler>(wrapper);
                Console.WriteLine("[EDOG] ✓ Catalog interceptor registered");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Catalog interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
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
            const string name = "RefreshTriggers";
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.Core.RefreshTrigger.IRefreshTriggersHandler>();
                if (inner is EdogRefreshTriggersWrapper)
                {
                    Console.WriteLine("[EDOG] ✓ RefreshTriggers interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }
                var wrapper = new EdogRefreshTriggersWrapper(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.Core.RefreshTrigger.IRefreshTriggersHandler>(wrapper);
                Console.WriteLine("[EDOG] ✓ RefreshTriggers interceptor registered");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ RefreshTriggers interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
        }

        private static void RegisterMlvDefinitionInterceptor()
        {
            const string name = "MLVDefinition";
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.Persistence.IMLVExecutionDefinitionPersistenceManager>();
                if (inner is EdogMLVDefinitionWrapper)
                {
                    Console.WriteLine("[EDOG] ✓ MLV Definition interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }
                var wrapper = new EdogMLVDefinitionWrapper(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.Persistence.IMLVExecutionDefinitionPersistenceManager>(wrapper);
                Console.WriteLine("[EDOG] ✓ MLV Definition interceptor registered");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ MLV Definition interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
        }

        private static void RegisterReportStateInterceptor()
        {
            const string name = "ReportState";
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.DataQuality.StateManagement.IReportStateManager>();
                if (inner is EdogReportStateWrapper)
                {
                    Console.WriteLine("[EDOG] ✓ ReportState interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }
                var wrapper = new EdogReportStateWrapper(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.DataQuality.StateManagement.IReportStateManager>(wrapper);
                Console.WriteLine("[EDOG] ✓ ReportState interceptor registered");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ ReportState interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
        }

        private static void RegisterTableMaintenanceInterceptor()
        {
            const string name = "TableMaintenance";
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.Maintenance.MaintenanceHttp.ITableMaintenanceClientFactory>();
                if (inner is EdogTableMaintenanceFactoryWrapper)
                {
                    Console.WriteLine("[EDOG] ✓ TableMaintenance interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }
                var wrapper = new EdogTableMaintenanceFactoryWrapper(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.Maintenance.MaintenanceHttp.ITableMaintenanceClientFactory>(wrapper);
                Console.WriteLine("[EDOG] ✓ TableMaintenance interceptor registered");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ TableMaintenance interceptor failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
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

        // ─── Stub providers for QA CodeAnalyzer (pre-Connected phase) ───

        private sealed class NullGraphProvider : IGraphProvider
        {
            public System.Threading.Tasks.Task<CodeGraph> BuildStructuralGraphAsync(
                System.Collections.Generic.List<ChangedSymbol> changedSymbols,
                int maxDepth = 4,
                System.Threading.CancellationToken cancellationToken = default)
                => System.Threading.Tasks.Task.FromResult(new CodeGraph());
        }

        private sealed class NullOmniSharpProvider : IOmniSharpProvider
        {
            public bool IsReady => false;

            public System.Threading.Tasks.Task WarmUpAsync(
                string solutionPath,
                System.Threading.CancellationToken cancellationToken = default)
                => System.Threading.Tasks.Task.CompletedTask;

            public System.Threading.Tasks.Task EnrichGraphAsync(
                CodeGraph graph,
                System.Collections.Generic.List<ChangedSymbol> changedSymbols,
                int maxConcurrentQueries = 4,
                System.Threading.CancellationToken cancellationToken = default)
                => System.Threading.Tasks.Task.CompletedTask;

            public System.Threading.Tasks.Task<System.Collections.Generic.List<string>> FindImplementationsAsync(
                string interfaceType,
                System.Threading.CancellationToken cancellationToken = default)
                => System.Threading.Tasks.Task.FromResult(new System.Collections.Generic.List<string>());

            public System.Threading.Tasks.Task<System.Collections.Generic.List<CallerInfo>> GetIncomingCallsAsync(
                string filePath,
                string methodName,
                int maxDepth = 4,
                System.Threading.CancellationToken cancellationToken = default)
                => System.Threading.Tasks.Task.FromResult(new System.Collections.Generic.List<CallerInfo>());
        }

        private sealed class NullLlmProvider : ILlmProvider
        {
            public System.Threading.Tasks.Task<System.Collections.Generic.List<Scenario>> GenerateScenariosAsync(
                LlmPromptRequest request,
                System.Threading.CancellationToken cancellationToken = default)
                => System.Threading.Tasks.Task.FromResult(new System.Collections.Generic.List<Scenario>());
        }

        private sealed class NullDiRegistryProvider : IDiRegistryProvider
        {
            public bool IsAvailable => false;
            public void LoadSnapshot() { }
            public DiRegistration Resolve(string interfaceType) => null;
            public System.Collections.Generic.List<DiRegistration> GetAll()
                => new System.Collections.Generic.List<DiRegistration>();
            public InterfaceValidation ValidateMapping(string interfaceType, string inferredImpl)
                => new InterfaceValidation { Status = "unregistered", ConfidenceDelta = 0.0 };
        }
    }

    // EdogQaServiceLocator is defined in EdogPlaygroundHub.cs
}
