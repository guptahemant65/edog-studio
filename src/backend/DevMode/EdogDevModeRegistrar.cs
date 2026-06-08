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
        private static bool _unobservedHandlerInstalled;
        private static int _unobservedExceptionCount;

        /// <summary>
        /// Gets the count of unobserved Task exceptions intercepted since
        /// the handler was installed. Useful as a diagnostic signal —
        /// a steadily climbing number means some fire-and-forget code path
        /// is leaking failures into the runtime.
        /// </summary>
        public static int UnobservedTaskExceptionCount => _unobservedExceptionCount;

        /// <summary>
        /// Registers all EDOG DevMode interceptors. Idempotent.
        /// Failures are non-fatal — FLT service continues normally.
        /// </summary>
        public static void RegisterAll()
        {
            if (_registered) return;

            // Install the unobserved-task-exception trap FIRST, before any
            // Register* method (some kick fire-and-forget Task.Run). On
            // legacy .NET Framework an unobserved fault terminates the
            // process at GC time; on modern .NET it's a silent log. Either
            // way, we want one place to (a) mark the exception observed,
            // (b) surface it with the [EDOG][FATAL] marker so dev-server's
            // _drain_flt_stdout elevates it to an error in the studio
            // deploy log, and (c) bump a counter for diagnostics.
            InstallUnobservedTaskExceptionHandler();

            try
            {
                // Initialize topic router (safe to call again — TryAdd is idempotent)
                EdogTopicRouter.Initialize();

                // Phase 2B interceptors — each wraps one FLT interface.
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

                // Telemetry — Additional channel
                // (ILiveTableAdditionalTelemetryReporter).  SSR is wrapped early
                // in WorkloadApp.cs via edog.py patch; Additional is wrapped
                // here because LiveTableAdditionalTelemetryReporter's
                // constructor resolves IRolloutConfigParametersProvider, which
                // is only available after MWC platform init.  Wrapping in
                // RegisterAll (post-InitializeAsync) is safe.
                RegisterAdditionalTelemetryInterceptor();

                // HTTP capture — IWorkloadCommunicationProvider wrap.
                // Closes the "only OneLake captured" gap: GTS/Spark control
                // plane, Notebook API, and Trident throttling all reach into
                // the MWC platform via IWorkloadCommunicationProvider instead
                // of IHttpClientFactory. Without this wrap they are invisible.
                // GTS + Notebook also need edog.py call-site patches because
                // they read the provider via this.workloadContext.WorkloadCommunicationProvider
                // (bypassing WireUp); LiveTableCommunicationClient picks the
                // wrap up automatically through constructor injection.
                RegisterWorkloadCommunicationProviderInterceptor();

                // DAG execution hook (EdogDagExecutionHook) is wired via edog.py
                // patch to DagExecutionHandlerV2.cs — adds our hook to the inline hook list.
                // NodeExecutor wrapping needs a patch at the creation point. See gaps-roadmap.md Gap 2.

                // QA Testing engines (F27) — singletons, initialized once
                RegisterQaServices();

                // Nexus aggregator — consumes topic events, emits dependency graph snapshots
                StartNexusAggregator();

                // Dynamic runtime discovery — reflection-based scan of FLT internals
                // (DI registrations, cache fields, code markers, EDOG wrappers).
                // Runs LAST so all interceptors are wired before we probe DI state.
                // Wrapped here defensively even though DiscoverAll has its own try/catch.
                try
                {
                    EdogRuntimeDiscovery.DiscoverAll();
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[EDOG] ✗ Runtime discovery threw (non-fatal): {ex.Message}");
                }

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

                // Guard: Unity disposes the original singleton when RegisterInstance
                // replaces it. If the inner implements IDisposable, the wrapper will
                // hold a dead reference → ObjectDisposedException at runtime.
                // Use a dedicated Register* method with a fresh inner instead.
                if (inner is IDisposable || inner is IAsyncDisposable)
                {
                    var disposableMsg = $"{inner.GetType().Name} implements IDisposable — TryWrap will cause disposal trap. Use a dedicated registration method with a fresh inner instance.";
                    Console.WriteLine($"[EDOG] ✗ {name} interceptor BLOCKED: {disposableMsg}");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, disposableMsg);
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

        /// <summary>
        /// Installs a process-wide <see cref="System.Threading.Tasks.TaskScheduler.UnobservedTaskException"/>
        /// handler. Idempotent — guarded by a static flag so repeat
        /// RegisterAll() calls don't stack handlers. The handler marks every
        /// unobserved fault observed (preventing process termination on
        /// legacy .NET Framework) and surfaces it loudly via stdout with the
        /// [EDOG][FATAL] marker so the studio deploy log shows it as an error.
        /// Covers the fire-and-forget Task.Run sites in EdogNexusAggregator,
        /// EdogPlaygroundHub, EdogRateLimiterCacheObserver, EdogRetryInterceptor,
        /// and any future _ = Task.Run(...) introduced by interceptors.
        /// </summary>
        private static void InstallUnobservedTaskExceptionHandler()
        {
            if (_unobservedHandlerInstalled) return;
            try
            {
                System.Threading.Tasks.TaskScheduler.UnobservedTaskException += (sender, args) =>
                {
                    System.Threading.Interlocked.Increment(ref _unobservedExceptionCount);
                    try
                    {
                        var baseEx = args.Exception?.GetBaseException();
                        var typeName = baseEx?.GetType().Name ?? "Unknown";
                        var message = baseEx?.Message ?? "<no message>";
                        Console.WriteLine($"[EDOG][FATAL] Unobserved Task exception #{_unobservedExceptionCount} ({typeName}): {message}");
                    }
                    catch
                    {
                        // Never let the handler itself throw — that would
                        // re-enter UnobservedTaskException and loop.
                    }
                    finally
                    {
                        // Always observe so we don't terminate the host on
                        // legacy frameworks. The fault is logged; FLT lives.
                        args.SetObserved();
                    }
                };
                _unobservedHandlerInstalled = true;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ UnobservedTaskException handler install failed (non-fatal): {ex.Message}");
            }
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
            // EdogCacheInterceptor itself is a static utility — events are published via
            // EdogCacheInterceptor.RecordCacheEvent() and need no DI wrapping. We do,
            // however, register two cache *sources* here:
            //   1. IDagExecutionStore decorator → real Get/Set/Evict events for the
            //      in-memory DAG execution cache.
            //   2. TokenBucketRateLimiterCache log-stream observer → REUSED/CREATED/
            //      EVICTED events parsed out of FLT's existing verbose logs (the
            //      cache is a static singleton and cannot be replaced via DI).
            Console.WriteLine("[EDOG] ✓ Cache interceptor ready (static utility)");
            EdogInterceptorRegistry.Record("Cache", EdogInterceptorRegistry.RegistrationStatus.Ok);

            RegisterDagExecutionStoreWrapper();
            RegisterRateLimiterCacheObserver();
        }

        private static void RegisterDagExecutionStoreWrapper()
        {
            TryWrap<Microsoft.LiveTable.Service.Store.IDagExecutionStore>(
                "DagExecutionStoreCache",
                inner => inner is EdogDagExecutionStoreWrapper,
                inner => new EdogDagExecutionStoreWrapper(inner));
        }

        private static void RegisterRateLimiterCacheObserver()
        {
            const string name = "RateLimiterCacheObserver";
            try
            {
                EdogRateLimiterCacheObserver.Start();
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Ok);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ {name} failed: {ex.Message}");
                EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.Failed, ex.Message);
            }
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
            // CRITICAL — DO NOT use TryWrap here. ──────────────────────────────
            // TokenManager : IDisposable owns a SemaphoreSlim that is disposed
            // in Dispose(). When we call WireUp.RegisterInstance<ITokenManager>
            // to install our wrapper, Unity replaces the existing
            // ContainerControlledLifetimeManager and disposes the previous one
            // — which Dispose()s the original TokenManager singleton MWC
            // resolved during InitializeAsync. The wrapper would then delegate
            // every call to a disposed instance, and the first RunDAG request
            // hits `tokenSemaphore.Wait()` in CacheToken with
            //   ObjectDisposedException: 'System.Threading.SemaphoreSlim'
            // (the StartedAt == EndedAt failure observed for runDAG).
            //
            // Fix: build a FRESH TokenManager from the same DI dependencies
            // and put it inside our wrapper. RegisterAll() runs once at
            // startup before any RunDAG request, so the original cache is
            // empty and no token state is lost. Unity is still free to
            // dispose the original singleton during the RegisterInstance
            // replacement — we just no longer depend on it.
            const string name = "TokenLifecycle";
            try
            {
                var existing = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.TokenManagement.ITokenManager>();
                if (existing is EdogTokenLifecycleInterceptor)
                {
                    Console.WriteLine($"[EDOG] ✓ {name} interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }

                var authority = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.MWC.Workload.Client.Library.Providers.IWorkloadApplicationAuthorityProvider>();
                var paramsProvider = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.MWC.Workload.Client.Library.Providers.CustomParameters.IParametersProvider>();
                var freshInner = new Microsoft.LiveTable.Service.TokenManagement.TokenManager(
                    authority, paramsProvider);
                var wrapper = new EdogTokenLifecycleInterceptor(freshInner);

                Exception regException = null;
                try
                {
                    Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                        Microsoft.LiveTable.Service.TokenManagement.ITokenManager>(wrapper);
                }
                catch (Exception ex)
                {
                    // Unity set-then-throw — instance is written even if validator throws.
                    regException = ex;
                }

                var after = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.LiveTable.Service.TokenManagement.ITokenManager>();
                if (after is EdogTokenLifecycleInterceptor)
                {
                    Console.WriteLine($"[EDOG] ✓ {name} interceptor registered (fresh inner)");
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

        /// <summary>
        /// Wraps ILiveTableAdditionalTelemetryReporter with
        /// EdogAdditionalTelemetryInterceptor so the Additional telemetry
        /// channel — NodeExecution events, DagExecutionHandlerV2 RunDag
        /// feature-usage, every controller's feature-usage emission — is
        /// captured into the same TelemetryEvent stream as SSR events
        /// (distinguished by Channel="additional").
        ///
        /// Late-DI (RegisterAll, not WorkloadApp.cs constructor) because the
        /// inner reporter's ctor resolves IRolloutConfigParametersProvider,
        /// only available after MWC platform init.
        /// </summary>
        private static void RegisterAdditionalTelemetryInterceptor()
        {
            TryWrap<Microsoft.LiveTable.Service.Telemetry.ILiveTableAdditionalTelemetryReporter>(
                "AdditionalTelemetry",
                inner => inner is EdogAdditionalTelemetryInterceptor,
                inner => new EdogAdditionalTelemetryInterceptor(
                    inner,
                    Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<EdogLogServer>()));
        }

        /// <summary>
        /// Wraps IWorkloadCommunicationProvider with
        /// EdogWorkloadCommunicationProviderWrapper so every HttpClient
        /// returned by Get*HttpClient*Async carries the EDOG handler chain.
        /// Closes the major "only OneLake captured" gap — GTS / Spark control
        /// plane, Notebook API, Trident throttling, and any other MWC-platform
        /// HTTP traffic becomes visible on the HTTP tab.
        ///
        /// Resolution: the provider is registered in FLT's WorkloadApp.cs (the
        /// initialization callback line that calls
        /// WireUp.RegisterInstance(workloadContext.WorkloadCommunicationProvider)).
        /// That registration runs during MWC platform init, BEFORE our
        /// RegisterAll() runs, so TryWrap can replace it cleanly.
        /// </summary>
        private static void RegisterWorkloadCommunicationProviderInterceptor()
        {
            // CRITICAL — DO NOT use TryWrap here. ──────────────────────────────
            // The concrete WorkloadCommunicationProvider implements IDisposable
            // (verified 2026-06-07 via a read-only MetadataLoadContext probe of
            // Microsoft.MWC.Workload.Client.Library). TryWrap's blanket
            // IDisposable guard therefore REFUSES to wrap it and records Failed,
            // so GTS / Spark control-plane / Notebook HTTP traffic never receives
            // the EDOG handler chain — which is exactly why the HTTP tab showed
            // ONLY OneLake (OneLake is captured via the separate
            // IHttpClientFactory path, not via this provider).
            //
            // Unlike RegisterTokenLifecycleInterceptor we cannot build a FRESH
            // inner: WorkloadCommunicationProvider is MWC-internal (no accessible
            // ctor) and is a process-wide singleton exposed as
            // workloadContext.WorkloadCommunicationProvider. We therefore wrap
            // the EXISTING instance via the DispatchProxy. The host keeps a
            // strong reference to that same singleton for the entire app
            // lifetime and uses it directly (bypassing WireUp), so the object
            // stays alive even if Unity drops the lifetime manager of the
            // registration we replace — our proxy's _inner remains valid.
            // If a future MWC version makes Dispose() destructive to
            // Get*HttpClientAsync, the symptom is an ObjectDisposedException on
            // the first GTS/Notebook call; fall back to call-site HttpClient
            // wrapping in that case.
            const string name = "WorkloadCommunicationProvider";
            try
            {
                var inner = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.MWC.Workload.Client.Library.Providers.IWorkloadCommunicationProvider>();

                // DispatchProxy.Create<T, TProxy>() returns an instance that
                // derives from TProxy at runtime — so `is` against our proxy
                // class works correctly.
                if (inner is EdogWorkloadCommunicationProviderWrapper)
                {
                    Console.WriteLine($"[EDOG] ✓ {name} interceptor already wrapped");
                    EdogInterceptorRegistry.Record(name, EdogInterceptorRegistry.RegistrationStatus.AlreadyWrapped);
                    return;
                }

                var wrapper = EdogWorkloadCommunicationProviderWrapper.Create(inner);

                Exception regException = null;
                try
                {
                    Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.RegisterInstance<
                        Microsoft.MWC.Workload.Client.Library.Providers.IWorkloadCommunicationProvider>(wrapper);
                }
                catch (Exception ex)
                {
                    // Unity set-then-throw — instance is written even if the
                    // registration validator throws.
                    regException = ex;
                }

                var after = Microsoft.PowerBI.ServicePlatform.WireUp.WireUp.Resolve<
                    Microsoft.MWC.Workload.Client.Library.Providers.IWorkloadCommunicationProvider>();
                if (after is EdogWorkloadCommunicationProviderWrapper)
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
                // Diagnostic: dump AZURE_OPENAI_* env vars as the FLT process sees them
                Console.WriteLine("[QA-DIAG] ═══ RegisterQaServices: env var check ═══");
                foreach (var key in new[] {
                    "AZURE_OPENAI_PRO_ENDPOINT", "AZURE_OPENAI_PRO_API_KEY", "AZURE_OPENAI_PRO_DEPLOYMENT",
                    "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_DEPLOYMENT",
                    "AZURE_OPENAI_ARCHITECT_ENDPOINT", "AZURE_OPENAI_ARCHITECT_API_KEY",
                    "AZURE_OPENAI_EDITOR_ENDPOINT", "AZURE_OPENAI_EDITOR_API_KEY",
                    "EDOG_QA_LLM_V2" })
                {
                    var val = Environment.GetEnvironmentVariable(key);
                    Console.WriteLine($"[QA-DIAG]   {key}={(val != null ? (val.Length > 15 ? val[..15] + "..." : val) : "NULL")}");
                }

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

                // Service provider that delegates to the FLT's real DI container
                // (WireUp.Resolve<T>) so DiInvocation stimuli can resolve
                // IQueryService, IInsightsQueryService, etc. The minimal
                // empty ServiceCollection was the root cause of all
                // DiInvocation "No service registered" failures.
                IServiceProvider serviceProvider;
                try
                {
                    serviceProvider = new WireUpServiceProviderAdapter();
                    Console.WriteLine("[EDOG] ✓ QA service provider: WireUp adapter (real DI container)");
                }
                catch
                {
                    serviceProvider = new ServiceCollection().BuildServiceProvider();
                    Console.WriteLine("[EDOG] ✗ QA service provider: empty fallback (WireUp not available)");
                }

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

                // P10: assemble contract catalog with available providers.
                // Non-fatal — if construction throws, the LLM pipeline simply
                // falls back to env-var-only prompt hooks.
                try
                {
                    var dagScanner = new EdogQaDagScanner();
                    var fileTimerScanner = new EdogQaFileTimerScanner();
                    EdogQaServiceLocator.ContractCatalog = new EdogQaContractCatalog(
                        diRegistryProvider,
                        omniSharpProvider,
                        dagScanner,
                        fileTimerScanner);
                    Console.WriteLine("[EDOG] ✓ QA contract catalog registered");
                }
                catch (Exception catEx)
                {
                    Console.WriteLine($"[EDOG] ✗ QA contract catalog construction failed (non-fatal): {catEx.Message}");
                }

                Console.WriteLine("[EDOG] ✓ QA Testing engines registered");

                // F27 P9 T4-D follow-up: kick the V2 capability probe so
                // EDOG_QA_LLM_V2=auto (the new default) has a probe result
                // ready by the time the first analyzer call happens. The
                // probe POSTs once to Azure OpenAI's Responses API for the
                // Architect (gpt-5.4) and Editor (gpt-5.4-mini) configs —
                // total cost ≈ $0.001 per FLT process start. Without this
                // kick, every cold-start analysis would fall to legacy
                // because WaitForResultAsync would time out at 10s.
                try
                {
                    var probeHttpClient = new System.Net.Http.HttpClient
                    {
                        Timeout = TimeSpan.FromSeconds(30),
                    };
                    var probeTask = EdogQaCapabilityProbe.EnsureStarted(probeHttpClient, System.Threading.CancellationToken.None);
                    _ = probeTask.ContinueWith(t =>
                    {
                        if (t.IsCompletedSuccessfully && t.Result != null)
                        {
                            var verdict = t.Result.IsReady ? "READY" : "DEGRADED";
                            Console.WriteLine($"[EDOG] ✓ QA V2 capability probe {verdict} — {t.Result.Reason}");
                        }
                        else if (t.IsFaulted)
                        {
                            Console.WriteLine($"[EDOG] ✗ QA V2 capability probe faulted: {t.Exception?.GetBaseException().Message}");
                        }
                    }, System.Threading.Tasks.TaskScheduler.Default);
                }
                catch (Exception probeEx)
                {
                    Console.WriteLine($"[EDOG] ✗ QA V2 capability probe kick failed: {probeEx.Message}");
                }
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

    /// <summary>
    /// IServiceProvider adapter that delegates to the FLT platform's
    /// WireUp DI container. This gives the QA stimulus dispatcher access
    /// to real FLT services (IQueryService, IInsightsQueryService, etc.)
    /// instead of the empty ServiceCollection that caused every
    /// DiInvocation stimulus to fail with "No service registered".
    /// </summary>
    internal sealed class WireUpServiceProviderAdapter : IServiceProvider
    {
        public object GetService(Type serviceType)
        {
            if (serviceType == null) return null;
            try
            {
                // WireUp.Resolve is the FLT platform's service locator.
                // It throws if the type isn't registered, so catch and
                // return null (IServiceProvider contract: null = not found).
                var resolveMethod = typeof(Microsoft.PowerBI.ServicePlatform.WireUp.WireUp)
                    .GetMethod("Resolve", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)
                    ?.MakeGenericMethod(serviceType);
                return resolveMethod?.Invoke(null, null);
            }
            catch
            {
                return null;
            }
        }
    }

    // EdogQaServiceLocator is defined in EdogPlaygroundHub.cs
}
