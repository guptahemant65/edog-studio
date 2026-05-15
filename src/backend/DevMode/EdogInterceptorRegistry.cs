// <copyright file="EdogInterceptorRegistry.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Linq;

    /// <summary>
    /// Central source of truth for which EDOG interceptors are actually active at runtime.
    /// Combines two signals:
    ///   1. <b>Probe</b> — at request time, calls <c>WireUp.Resolve&lt;T&gt;()</c> for each
    ///      DI-backed interceptor and checks whether the resolved instance is our wrapper type.
    ///   2. <b>Record</b> — the registrar (and wrapper constructors, after Phase 2) write
    ///      their attempted-registration outcome here, capturing the exception message when
    ///      a Register* call fails.
    /// The status endpoint exposes the merged view so the UI can show truth, not the
    /// false-positive "[EDOG] DevMode interceptors registered" stdout line.
    /// </summary>
    public static class EdogInterceptorRegistry
    {
        /// <summary>Outcomes recorded by the registrar / wrappers during registration.</summary>
        private static readonly ConcurrentDictionary<string, InterceptorRecord> Records =
            new ConcurrentDictionary<string, InterceptorRecord>(StringComparer.Ordinal);

        /// <summary>Catalog of DI-backed interceptors that should be wrapped at runtime.</summary>
        /// <remarks>
        /// The probe logic uses reflection on this catalog so adding a new interceptor only
        /// requires one entry here, not changes to ProbeAll().
        /// </remarks>
        private static readonly IReadOnlyList<InterceptorDescriptor> Catalog = new[]
        {
            new InterceptorDescriptor(
                "FeatureFlighter",
                typeof(Microsoft.LiveTable.Service.FeatureFlightProvider.IFeatureFlighter),
                typeof(EdogFeatureFlighterWrapper),
                InterceptorKind.DiWrap),
            new InterceptorDescriptor(
                "PerfMarker",
                typeof(Microsoft.ServicePlatform.Telemetry.IServiceMonitoringCallback),
                typeof(EdogPerfMarkerCallback),
                InterceptorKind.DiWrap),
            new InterceptorDescriptor(
                "Token",
                typeof(System.Net.Http.IHttpClientFactory),
                typeof(EdogHttpClientFactoryWrapper),
                InterceptorKind.DiWrap),
            new InterceptorDescriptor(
                "HttpPipelineHandler",
                typeof(System.Net.Http.IHttpClientFactory),
                typeof(EdogHttpClientFactoryWrapper),
                InterceptorKind.DiWrap),
            new InterceptorDescriptor(
                "FileSystemFactory",
                typeof(Microsoft.LiveTable.Service.Persistence.Fs.IFileSystemFactory),
                typeof(EdogFileSystemFactoryWrapper),
                InterceptorKind.DiWrap),
            new InterceptorDescriptor(
                "Retry",
                interfaceType: null,
                wrapperType: null,
                InterceptorKind.Static),
            new InterceptorDescriptor(
                "Cache",
                interfaceType: null,
                wrapperType: null,
                InterceptorKind.Static),
            new InterceptorDescriptor(
                "SparkSession",
                typeof(Microsoft.LiveTable.Service.SparkHttp.ISparkClientFactory),
                typeof(EdogSparkSessionInterceptor),
                InterceptorKind.DiWrap),
            new InterceptorDescriptor(
                "DiRegistryCapture",
                interfaceType: null,
                wrapperType: null,
                InterceptorKind.Static),
            new InterceptorDescriptor(
                "TokenLifecycle",
                typeof(Microsoft.LiveTable.Service.TokenManagement.ITokenManager),
                typeof(EdogTokenLifecycleInterceptor),
                InterceptorKind.DiWrap),
            new InterceptorDescriptor(
                "Catalog",
                typeof(Microsoft.LiveTable.Service.Catalog.ICatalogHandler),
                typeof(EdogCatalogInterceptor),
                InterceptorKind.DiWrap),
            new InterceptorDescriptor(
                "RefreshTriggers",
                typeof(Microsoft.LiveTable.Service.Core.RefreshTrigger.IRefreshTriggersHandler),
                typeof(EdogRefreshTriggersWrapper),
                InterceptorKind.DiWrap),
            new InterceptorDescriptor(
                "MLVDefinition",
                typeof(Microsoft.LiveTable.Service.Persistence.IMLVExecutionDefinitionPersistenceManager),
                typeof(EdogMLVDefinitionWrapper),
                InterceptorKind.DiWrap),
            new InterceptorDescriptor(
                "ReportState",
                typeof(Microsoft.LiveTable.Service.DataQuality.StateManagement.IReportStateManager),
                typeof(EdogReportStateWrapper),
                InterceptorKind.DiWrap),
            new InterceptorDescriptor(
                "TableMaintenance",
                typeof(Microsoft.LiveTable.Service.Maintenance.MaintenanceHttp.ITableMaintenanceClientFactory),
                typeof(EdogTableMaintenanceFactoryWrapper),
                InterceptorKind.DiWrap),
        };

        /// <summary>
        /// Record an attempted registration outcome. Called by the registrar after each Register*
        /// call (Phase 2c) and by wrapper constructors when they instantiate (also Phase 2c).
        /// Idempotent — last write wins per name.
        /// </summary>
        public static void Record(string name, RegistrationStatus status, string error = null)
        {
            if (string.IsNullOrEmpty(name)) return;
            Records[name] = new InterceptorRecord
            {
                Status = status,
                Error = error,
                Timestamp = DateTime.UtcNow,
            };
        }

        /// <summary>
        /// Returns the merged status of every interceptor in the catalog, combining the
        /// recorded registration outcome with a live probe of the DI container.
        /// </summary>
        public static IReadOnlyList<InterceptorStatus> GetStatus()
        {
            var result = new List<InterceptorStatus>(Catalog.Count);
            foreach (var desc in Catalog)
            {
                result.Add(ProbeOne(desc));
            }

            return result;
        }

        /// <summary>Summary counts for the topbar chip — wrapped, failed, total.</summary>
        public static InterceptorSummary GetSummary()
        {
            var all = GetStatus();
            return new InterceptorSummary
            {
                Total = all.Count,
                Wrapped = all.Count(s => s.Wrapped),
                Failed = all.Count(s => !s.Wrapped && s.Kind == InterceptorKind.DiWrap),
            };
        }

        private static InterceptorStatus ProbeOne(InterceptorDescriptor desc)
        {
            Records.TryGetValue(desc.Name, out var record);
            var status = new InterceptorStatus
            {
                Name = desc.Name,
                Kind = desc.Kind,
                InterfaceType = desc.InterfaceType?.FullName,
                ExpectedWrapper = desc.WrapperType?.FullName,
                RecordedStatus = record?.Status ?? RegistrationStatus.NotAttempted,
                RecordedError = record?.Error,
                RecordedAt = record?.Timestamp,
            };

            if (desc.Kind == InterceptorKind.Static)
            {
                // Static interceptors don't go through DI — trust the recorded status.
                // Treat NotAttempted as wrapped:false (registrar hasn't run) and Ok as wrapped:true.
                status.Wrapped = record?.Status == RegistrationStatus.Ok;
                status.ProbeMessage = "static interceptor — no DI probe";
                return status;
            }

            try
            {
                var resolved = ResolveDynamic(desc.InterfaceType);
                if (resolved == null)
                {
                    status.Wrapped = false;
                    status.ProbeMessage = "Resolve returned null";
                    return status;
                }

                status.ResolvedType = resolved.GetType().FullName;
                status.Wrapped = desc.WrapperType.IsInstanceOfType(resolved);
                status.ProbeMessage = status.Wrapped
                    ? "wrapped"
                    : $"resolved {status.ResolvedType}, expected {desc.WrapperType.FullName}";
            }
            catch (Exception ex)
            {
                // method.Invoke wraps inner exceptions in TargetInvocationException —
                // unwrap so the real root cause (Unity ResolutionFailedException, etc.)
                // shows up in the probeError field instead of the useless wrapper text.
                var root = ex is System.Reflection.TargetInvocationException tie && tie.InnerException != null
                    ? tie.InnerException
                    : ex;
                status.Wrapped = false;
                status.ProbeError = root.Message;
                status.ProbeMessage = "Resolve threw";
            }

            return status;
        }

        private static object ResolveDynamic(Type interfaceType)
        {
            // WireUp.Resolve<T>() is a generic method — invoke via reflection because the
            // interfaceType varies across our catalog. Cached MethodInfo for performance.
            var method = WireUpResolveMethod.MakeGenericMethod(interfaceType);
            return method.Invoke(null, null);
        }

        private static readonly System.Reflection.MethodInfo WireUpResolveMethod =
            typeof(Microsoft.PowerBI.ServicePlatform.WireUp.WireUp)
                .GetMethod("Resolve", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static, null, Type.EmptyTypes, null);

        // ─── Public data types ──────────────────────────────────────────

        /// <summary>How an interceptor is wired into FLT.</summary>
        public enum InterceptorKind
        {
            /// <summary>Wrapper replaces a DI registration via WireUp.RegisterInstance.</summary>
            DiWrap = 0,

            /// <summary>Static utility / log-stream parser / aggregator with no DI wrap.</summary>
            Static = 1,
        }

        /// <summary>Outcome of a Register* attempt as recorded by the registrar.</summary>
        public enum RegistrationStatus
        {
            /// <summary>Register* was never called for this interceptor.</summary>
            NotAttempted = 0,

            /// <summary>Register* succeeded and wrapper installed.</summary>
            Ok = 1,

            /// <summary>Register* threw an exception (Resolve failed or RegisterInstance rejected).</summary>
            Failed = 2,

            /// <summary>Wrapper was already installed; Register* short-circuited.</summary>
            AlreadyWrapped = 3,
        }

        /// <summary>Per-interceptor record written by the registrar / wrapper ctors.</summary>
        public sealed class InterceptorRecord
        {
            /// <summary>Registration outcome.</summary>
            public RegistrationStatus Status { get; set; }

            /// <summary>Exception message if Status == Failed.</summary>
            public string Error { get; set; }

            /// <summary>When the record was written.</summary>
            public DateTime Timestamp { get; set; }
        }

        /// <summary>Full per-interceptor status, merged from probe + recorded outcome.</summary>
        public sealed class InterceptorStatus
        {
            /// <summary>Stable identifier used by the UI and the registrar.</summary>
            public string Name { get; set; }

            /// <summary>Whether this interceptor is DI-backed or static.</summary>
            public InterceptorKind Kind { get; set; }

            /// <summary>DI interface this wrapper replaces (DiWrap kind only).</summary>
            public string InterfaceType { get; set; }

            /// <summary>The expected wrapper type (DiWrap kind only).</summary>
            public string ExpectedWrapper { get; set; }

            /// <summary>Concrete type returned by WireUp.Resolve at probe time.</summary>
            public string ResolvedType { get; set; }

            /// <summary>True iff the resolved type IS the expected wrapper.</summary>
            public bool Wrapped { get; set; }

            /// <summary>Human-readable summary of the probe outcome.</summary>
            public string ProbeMessage { get; set; }

            /// <summary>Exception from WireUp.Resolve, if any.</summary>
            public string ProbeError { get; set; }

            /// <summary>Outcome recorded by the registrar at registration time.</summary>
            public RegistrationStatus RecordedStatus { get; set; }

            /// <summary>Error recorded by the registrar at registration time.</summary>
            public string RecordedError { get; set; }

            /// <summary>When the registrar recorded its outcome.</summary>
            public DateTime? RecordedAt { get; set; }
        }

        /// <summary>Topbar chip summary.</summary>
        public sealed class InterceptorSummary
        {
            /// <summary>Total interceptors in the catalog.</summary>
            public int Total { get; set; }

            /// <summary>Count of interceptors currently wrapped (probed live).</summary>
            public int Wrapped { get; set; }

            /// <summary>Count of DiWrap interceptors that are NOT wrapped (excludes Static).</summary>
            public int Failed { get; set; }
        }

        // ─── Catalog descriptor ──────────────────────────────────────────

        private sealed class InterceptorDescriptor
        {
            public InterceptorDescriptor(string name, Type interfaceType, Type wrapperType, InterceptorKind kind)
            {
                this.Name = name;
                this.InterfaceType = interfaceType;
                this.WrapperType = wrapperType;
                this.Kind = kind;
            }

            public string Name { get; }

            public Type InterfaceType { get; }

            public Type WrapperType { get; }

            public InterceptorKind Kind { get; }
        }
    }
}
