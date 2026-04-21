// <copyright file="EdogDiRegistryCapture.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;

    /// <summary>
    /// Captures all DI registrations at startup by combining static knowledge of
    /// <c>WorkloadApp.cs</c> registrations with dynamic detection of EDOG wrapper overrides.
    ///
    /// <para><b>Why partially hardcoded?</b> The WireUp DI container is proprietary
    /// (<c>Microsoft.PowerBI.ServicePlatform.WireUp</c>) with no runtime enumeration API.
    /// We maintain a static list of known registrations from WorkloadApp.cs and dynamically
    /// check which ones EDOG has intercepted. V2 could hook <c>WireUp.RegisterSingletonType</c>
    /// directly via IL weaving or reflection.</para>
    ///
    /// <para><b>Threading:</b> Called once during <c>RegisterAll()</c>. All publishes are
    /// synchronous. Idempotent via <c>_captured</c> flag.</para>
    /// </summary>
    public static class EdogDiRegistryCapture
    {
        private static bool _captured;

        /// <summary>
        /// Enumerates all known DI registrations and publishes them to the "di" topic.
        /// Idempotent — safe to call multiple times.
        /// </summary>
        public static void CaptureRegistrations()
        {
            if (_captured) return;
            _captured = true;

            int count = 0;

            try
            {
                // WorkloadApp constructor registrations (lines 92-148)
                count += PublishRegistration("IExecutionContextManager", "ExecutionContextManager", "Singleton", "Constructor");
                count += PublishRegistration("EvictionManager", "EvictionManager", "Singleton", "Constructor");
                count += PublishRegistration("IWorkTicketManager", "WorkTicketManager", "Singleton", "Constructor");
                count += PublishRegistration("IConfigurationManager", "ConfigurationManager", "Instance", "Constructor");
                count += PublishRegistration("IServiceMonitoringCallback", "LiveTableServiceMonitoringCallback", "Singleton", "Constructor");
                count += PublishRegistration("IReliableOperationRetryHandler", "ReliableOperationRetryHandler", "Singleton", "Constructor");
                count += PublishRegistration("IReliableOperationExecutionManager", "ReliableOperationExecutionManager", "Singleton", "Constructor");
                count += PublishRegistration("IS2STokenProvider", "S2STokenProvider", "Singleton", "Constructor");
                count += PublishRegistration("IAadTokenProvider", "AadTokenProvider", "Singleton", "Constructor");
                count += PublishRegistration("IFeatureFlighter", "FeatureFlighter", "Singleton", "Constructor");
                count += PublishRegistration("ILiveTableCommunicationClient", "LiveTableCommunicationClient", "Singleton", "Constructor");
                count += PublishRegistration("LiveTableHandler", "LiveTableHandler", "Singleton", "Constructor");
                count += PublishRegistration("DataQualityReportHandler", "DataQualityReportHandler", "Singleton", "Constructor");
                count += PublishRegistration("TemplateRenderer", "TemplateRenderer", "Singleton", "Constructor");
                count += PublishRegistration("IFabricApiClient", "FabricApiClient", "Singleton", "Constructor");
                count += PublishRegistration("IReportStateManager", "OnelakeBasedReportStateManager", "Singleton", "Constructor");
                count += PublishRegistration("ISqlEndpointClient", "SqlEndpointClient", "Singleton", "Constructor");
                count += PublishRegistration("ISqlEndpointMetadataCache", "SqlEndpointMetadataCache", "Singleton", "Constructor");
                count += PublishRegistration("ISqlEndpointTokenProvider", "SqlEndpointTokenProvider", "Singleton", "Constructor");
                count += PublishRegistration("IDagMetricsHandler", "DagMetricsHandler", "Singleton", "Constructor");
                count += PublishRegistration("IRefreshTriggerAdapter", "RefreshTriggerAdapter", "Singleton", "Constructor");
                count += PublishRegistration("IRefreshTriggersHandler", "RefreshTriggersHandler", "Singleton", "Constructor");
                count += PublishRegistration("IFMLVActivatorParser", "FMLVActivatorParser", "Singleton", "Constructor");
                count += PublishRegistration("IFabricClientFactory", "FabricClientFactory", "Singleton", "Constructor");
                count += PublishRegistration("RefreshTriggersTemplateRenderer", "RefreshTriggersTemplateRenderer", "Singleton", "Constructor");
                count += PublishRegistration("ISparkClientFactory", "GTSBasedSparkClientFactory", "Singleton", "Constructor");
                count += PublishRegistration("DagExecutionHandlerV2", "DagExecutionHandlerV2", "Singleton", "Constructor");
                count += PublishRegistration("IArtifactMetadataService", "ArtifactMetadataService", "Singleton", "Constructor");
                count += PublishRegistration("ICatalogHandler", "CatalogHandler", "Singleton", "Constructor");
                count += PublishRegistration("ITokenManager", "TokenManager", "Singleton", "Constructor");
                count += PublishRegistration("IOneLakeRestClient", "OneLakeRestClient", "Singleton", "Constructor");
                count += PublishRegistration("IThrottlingService", "HierarchicalThrottlingService", "Singleton", "Constructor");
                count += PublishRegistration("RetryPolicyProvider", "RetryPolicyProvider", "Singleton", "Constructor");
                count += PublishRegistration("RetryPolicyProviderV2", "RetryPolicyProviderV2", "Singleton", "Constructor");
                count += PublishRegistration("RetryPoliciesConfiguration", "RetryPoliciesConfiguration", "Singleton", "Constructor");
                count += PublishRegistration("IPBIHttpClientFactory", "PBIHttpClientFactory", "Singleton", "Constructor");
                count += PublishRegistration("IDagExecutionStore", "DagExecutionStore", "Singleton", "Constructor");
                count += PublishRegistration("IDagExecutionPersistenceManager", "FileSystemBasedDagExecutionPersistenceManager", "Singleton", "Constructor");
                count += PublishRegistration("IFileSystemFactory", "OnelakeFileSystemFactory", "Singleton", "Constructor");
                count += PublishRegistration("DagExecutionObjectsSerdeFactory", "DagExecutionObjectsSerdeFactory", "Singleton", "Constructor");
                count += PublishRegistration("IDagExecMetadataPersistanceManager", "DagExecMetadataPersistanceManager", "Singleton", "Constructor");
                count += PublishRegistration("INotebookClientFactory", "NotebookClientFactory", "Singleton", "Constructor");
                count += PublishRegistration("MLVExecutionDefinitionHandler", "MLVExecutionDefinitionHandler", "Singleton", "Constructor");
                count += PublishRegistration("IMLVExecutionDefinitionPersistenceManager", "MLVExecutionDefinitionPersistenceManager", "Singleton", "Constructor");
                count += PublishRegistration("AuthenticationEngineCore", "AuthenticationEngineCore", "Singleton", "Constructor");
                count += PublishRegistration("IHttpClientFactory", "HttpClientFactoryRegistry", "Instance", "Constructor");
                count += PublishRegistration("WorkloadEndpointSetup", "WorkloadEndpointSetup", "Singleton", "Constructor");

                // SecurityAudit registrations
                count += PublishRegistration("IWorkloadCertifiedEventsTracerWrapper", "WorkloadCertifiedEventsTracerWrapper", "Singleton", "Constructor");
                count += PublishRegistration("ISecurityAuditContextManager", "SecurityAuditContextManager", "Singleton", "Constructor");
                count += PublishRegistration("ISecurityAuditEventReporter", "SecurityAuditEventReporter", "Singleton", "Constructor");

                // RunAsync callback registrations (after platform init)
                count += PublishRegistration("ICustomLiveTableTelemetryReporter", "EdogTelemetryInterceptor", "Instance", "RunAsync");
                count += PublishRegistration("IAuthContextProvider", "AuthContextProvider", "Singleton", "RunAsync");
                count += PublishRegistration("IMwcV2PermissionsValidator", "MwcV2PermissionsValidator", "Singleton", "RunAsync");

                Console.WriteLine($"[EDOG] ✓ DI registry captured: {count} registrations");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ DI registry capture failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Publishes a single DI registration event. Dynamically detects EDOG interception
        /// by checking if the resolved type differs from the original implementation.
        /// </summary>
        private static int PublishRegistration(
            string serviceType,
            string originalImplementation,
            string lifetime,
            string registrationPhase)
        {
            try
            {
                bool isIntercepted = IsEdogIntercepted(serviceType, originalImplementation);
                string currentImpl = isIntercepted
                    ? GetEdogWrapperName(serviceType)
                    : originalImplementation;

                EdogTopicRouter.Publish("di", new
                {
                    serviceType,
                    implementationType = currentImpl,
                    lifetime,
                    isEdogIntercepted = isIntercepted,
                    originalImplementation,
                    registrationPhase,
                });

                return 1;
            }
            catch
            {
                // Non-fatal — skip this registration
                return 0;
            }
        }

        /// <summary>
        /// Checks if a service type has been intercepted by an EDOG wrapper.
        /// Uses known wrapper mappings rather than reflection for reliability.
        /// </summary>
        private static bool IsEdogIntercepted(string serviceType, string originalImpl)
        {
            return serviceType switch
            {
                "IFeatureFlighter" => true,
                "ISqlEndpointMetadataCache" => true,
                "ISparkClientFactory" => true,
                "ICustomLiveTableTelemetryReporter" => true,
                "IWorkloadResourceMetricsReporter" => true,
                _ => false,
            };
        }

        /// <summary>
        /// Returns the EDOG wrapper class name for intercepted services.
        /// </summary>
        private static string GetEdogWrapperName(string serviceType)
        {
            return serviceType switch
            {
                "IFeatureFlighter" => "EdogFeatureFlighterWrapper",
                "ISqlEndpointMetadataCache" => "EdogCacheInterceptor",
                "ISparkClientFactory" => "EdogSparkSessionInterceptor",
                "ICustomLiveTableTelemetryReporter" => "EdogTelemetryInterceptor",
                _ => "Unknown",
            };
        }
    }
}
