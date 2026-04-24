// <copyright file="EdogDevModeRegistrar.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;

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
            _registered = true;

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

                // Nexus aggregator — consumes topic events, emits dependency graph snapshots
                StartNexusAggregator();

                Console.WriteLine("[EDOG] DevMode interceptors registered");
            }
            catch (Exception ex)
            {
                // Non-fatal — FLT service continues normally without devmode interceptors
                Console.WriteLine($"[EDOG] DevMode registration failed (non-fatal): {ex.Message}");
            }
        }

        private static void RegisterFeatureFlighterWrapper()
        {
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.FeatureFlightProvider.IFeatureFlighter>();
                if (inner is EdogFeatureFlighterWrapper) return;
                var wrapper = new EdogFeatureFlighterWrapper(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.FeatureFlightProvider.IFeatureFlighter>(wrapper);
                Console.WriteLine("[EDOG] ✓ FeatureFlighter interceptor registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ FeatureFlighter interceptor failed: {ex.Message}");
            }
        }

        private static void RegisterPerfMarkerCallback()
        {
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<Microsoft.ServicePlatform.Telemetry.IServiceMonitoringCallback>();
                if (inner is EdogPerfMarkerCallback) return;
                var wrapper = new EdogPerfMarkerCallback(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<Microsoft.ServicePlatform.Telemetry.IServiceMonitoringCallback>(wrapper);
                Console.WriteLine("[EDOG] ✓ PerfMarker interceptor registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ PerfMarker interceptor failed: {ex.Message}");
            }
        }

        private static void RegisterTokenInterceptor()
        {
            try
            {
                EnsureHttpClientFactoryWrapped();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Token interceptor failed: {ex.Message}");
            }
        }

        private static void RegisterFileSystemInterceptor()
        {
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.Persistence.Fs.IFileSystemFactory>();
                if (inner is EdogFileSystemFactoryWrapper) return;
                var wrapper = new EdogFileSystemFactoryWrapper(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.Persistence.Fs.IFileSystemFactory>(wrapper);
                Console.WriteLine("[EDOG] ✓ FileSystemFactory interceptor registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ FileSystemFactory interceptor failed: {ex.Message}");
            }
        }

        private static void RegisterHttpPipelineHandler()
        {
            try
            {
                EnsureHttpClientFactoryWrapped();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ HTTP pipeline handler failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Shared registration for both EdogTokenInterceptor and EdogHttpPipelineHandler.
        /// Wraps IHttpClientFactory with EdogHttpClientFactoryWrapper which injects both
        /// DelegatingHandlers into every HttpClient pipeline. Idempotent.
        /// </summary>
        private static void EnsureHttpClientFactoryWrapped()
        {
            if (_httpClientFactoryWrapped) return;

            var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                System.Net.Http.IHttpClientFactory>();
            if (inner is EdogHttpClientFactoryWrapper) return;
            var wrapper = new EdogHttpClientFactoryWrapper(inner);
            Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                System.Net.Http.IHttpClientFactory>(wrapper);
            _httpClientFactoryWrapped = true;
            Console.WriteLine("[EDOG] ✓ HttpClientFactory interceptors registered (Token + HTTP pipeline)");
        }

        private static void RegisterRetryInterceptor()
        {
            try
            {
                EdogRetryInterceptor.Start();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Retry interceptor failed: {ex.Message}");
            }
        }

        private static void RegisterCacheInterceptor()
        {
            // EdogCacheInterceptor is now a static utility class.
            // Cache events are published via EdogCacheInterceptor.RecordCacheEvent()
            // which can be called from any component. No DI wrapping needed.
            Console.WriteLine("[EDOG] ✓ Cache interceptor ready (static utility)");
        }

        private static void RegisterSparkSessionInterceptor()
        {
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.SparkHttp.ISparkClientFactory>();
                if (inner is EdogSparkSessionInterceptor) return;
                var wrapper = new EdogSparkSessionInterceptor(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.SparkHttp.ISparkClientFactory>(wrapper);
                Console.WriteLine("[EDOG] ✓ Spark session interceptor registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Spark session interceptor failed: {ex.Message}");
            }
        }

        private static void RegisterDiRegistryCapture()
        {
            try
            {
                EdogDiRegistryCapture.CaptureRegistrations();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ DI registry capture failed: {ex.Message}");
            }
        }

        private static void RegisterTokenLifecycleInterceptor()
        {
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.TokenManagement.ITokenManager>();
                if (inner is EdogTokenLifecycleInterceptor) return;
                var wrapper = new EdogTokenLifecycleInterceptor(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.TokenManagement.ITokenManager>(wrapper);
                Console.WriteLine("[EDOG] ✓ TokenLifecycle interceptor registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ TokenLifecycle interceptor failed: {ex.Message}");
            }
        }

        private static void RegisterCatalogInterceptor()
        {
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.Catalog.ICatalogHandler>();
                if (inner is EdogCatalogInterceptor) return;
                var wrapper = new EdogCatalogInterceptor(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.Catalog.ICatalogHandler>(wrapper);
                Console.WriteLine("[EDOG] ✓ Catalog interceptor registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Catalog interceptor failed: {ex.Message}");
            }
        }

        private static void RegisterFltOpsInterceptors()
        {
            // 1. RefreshTriggers
            try
            {
                var refreshInner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.Core.RefreshTrigger.IRefreshTriggersHandler>();
                if (refreshInner is EdogRefreshTriggersWrapper) return;
                var refreshWrapper = new EdogRefreshTriggersWrapper(refreshInner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.Core.RefreshTrigger.IRefreshTriggersHandler>(refreshWrapper);
                Console.WriteLine("[EDOG] ✓ RefreshTriggers interceptor registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ RefreshTriggers interceptor failed: {ex.Message}");
            }

            // 2. MLV Definition Persistence
            try
            {
                var mlvInner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.Persistence.IMLVExecutionDefinitionPersistenceManager>();
                if (mlvInner is EdogMLVDefinitionWrapper) return;
                var mlvWrapper = new EdogMLVDefinitionWrapper(mlvInner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.Persistence.IMLVExecutionDefinitionPersistenceManager>(mlvWrapper);
                Console.WriteLine("[EDOG] ✓ MLV Definition interceptor registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ MLV Definition interceptor failed: {ex.Message}");
            }

            // 3. Report State (Data Quality)
            try
            {
                var dqInner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.DataQuality.StateManagement.IReportStateManager>();
                if (dqInner is EdogReportStateWrapper) return;
                var dqWrapper = new EdogReportStateWrapper(dqInner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.DataQuality.StateManagement.IReportStateManager>(dqWrapper);
                Console.WriteLine("[EDOG] ✓ ReportState interceptor registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ ReportState interceptor failed: {ex.Message}");
            }

            // 4. Table Maintenance Factory
            try
            {
                var maintInner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.Maintenance.MaintenanceHttp.ITableMaintenanceClientFactory>();
                if (maintInner is EdogTableMaintenanceFactoryWrapper) return;
                var maintWrapper = new EdogTableMaintenanceFactoryWrapper(maintInner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.Maintenance.MaintenanceHttp.ITableMaintenanceClientFactory>(maintWrapper);
                Console.WriteLine("[EDOG] ✓ TableMaintenance interceptor registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ TableMaintenance interceptor failed: {ex.Message}");
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
    }
}
