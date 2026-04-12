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
            // TODO: Phase 2B — wrap IHttpClientFactory with EdogTokenInterceptor DelegatingHandler
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
            // TODO: Phase 2B — add EdogHttpPipelineHandler to HttpClient pipeline
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
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.SqlEndpoint.ISqlEndpointMetadataCache>();
                if (inner is EdogCacheInterceptor) return;
                var wrapper = new EdogCacheInterceptor(inner);
                Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                    Microsoft.LiveTable.Service.SqlEndpoint.ISqlEndpointMetadataCache>(wrapper);
                Console.WriteLine("[EDOG] ✓ Cache interceptor registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Cache interceptor failed: {ex.Message}");
            }
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
    }
}
