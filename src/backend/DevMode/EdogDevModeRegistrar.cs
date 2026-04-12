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
            // TODO: Phase 2B — wrap IServiceMonitoringCallback with EdogPerfMarkerCallback
        }

        private static void RegisterTokenInterceptor()
        {
            // TODO: Phase 2B — wrap IHttpClientFactory with EdogTokenInterceptor DelegatingHandler
        }

        private static void RegisterFileSystemInterceptor()
        {
            // TODO: Phase 2B — wrap IFileSystemFactory with EdogFileSystemInterceptor
        }

        private static void RegisterHttpPipelineHandler()
        {
            // TODO: Phase 2B — add EdogHttpPipelineHandler to HttpClient pipeline
        }

        private static void RegisterRetryInterceptor()
        {
            // TODO: Phase 2B — wrap RetryPolicyProviderV2 with EdogRetryInterceptor
        }

        private static void RegisterCacheInterceptor()
        {
            // TODO: Phase 2B — wrap ISqlEndpointMetadataCache with EdogCacheInterceptor
        }

        private static void RegisterSparkSessionInterceptor()
        {
            // TODO: Phase 2B — wrap ISparkClientFactory with EdogSparkSessionInterceptor
        }

        private static void RegisterDiRegistryCapture()
        {
            // TODO: Phase 2B — enumerate WireUp registrations via EdogDiRegistryCapture
        }
    }
}
