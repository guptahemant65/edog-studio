// <copyright file="EdogRuntimeDiscovery.cs" company="Microsoft">
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
    using System.Reflection;

    /// <summary>
    /// Dynamic runtime discovery of FLT internals. Runs once at the end of
    /// <see cref="EdogDevModeRegistrar.RegisterAll"/>, after all interceptors are wired.
    ///
    /// <para>Replaces the hardcoded lists in <see cref="EdogDiRegistryCapture"/> and
    /// <see cref="EdogInterceptorRegistry"/> with reflection over the live AppDomain.
    /// Discovers four things:</para>
    /// <list type="number">
    ///   <item>DI registrations resolvable through <c>WireUp.Resolve&lt;T&gt;()</c></item>
    ///   <item>Cache-shaped fields (<c>ConcurrentDictionary</c>, <c>MemoryCache</c>, *cache* names) on resolved singletons</item>
    ///   <item>MonitoredCodeMarker static field catalog from <c>*CodeMarkers*</c> / <c>*Monitoring*</c> classes</item>
    ///   <item>EDOG wrapper types in this namespace and whether each is currently active in DI</item>
    /// </list>
    ///
    /// <para><b>Failure model:</b> every operation is wrapped in try/catch. A failed
    /// scan is logged and skipped — the discovery process never throws to the caller.
    /// Reflection over assemblies that fail to load (ReflectionTypeLoadException) yields
    /// the partial Types array via <c>ex.Types.Where(t =&gt; t != null)</c>.</para>
    ///
    /// <para><b>Threading:</b> single-shot, called once during registrar startup.
    /// Idempotent via <see cref="_ran"/> flag. No background work, no shared state.</para>
    ///
    /// <para><b>Scope:</b> only scans assemblies whose name starts with
    /// <c>Microsoft.LiveTable.Service</c>. System/Microsoft.Extensions/etc. are skipped
    /// to keep startup fast and avoid noisy false-positives.</para>
    /// </summary>
    public static class EdogRuntimeDiscovery
    {
        private const string FltAssemblyPrefix = "Microsoft.LiveTable.Service";
        private const string FltServiceNamespace = "Microsoft.LiveTable.Service";
        private const string EdogTypePrefix = "Edog";
        private const string DevModeNamespace = "Microsoft.LiveTable.Service.DevMode";

        private static bool _ran;
        private static readonly object _runLock = new object();

        // Cached resolved instances so the cache-field scan reuses the DI singletons
        // discovered during the DI scan rather than calling WireUp.Resolve twice.
        private static readonly ConcurrentDictionary<Type, object> _resolvedCache =
            new ConcurrentDictionary<Type, object>();

        private static MethodInfo _wireUpResolveMethod;

        /// <summary>
        /// Runs all four discovery passes. Idempotent — safe to call multiple times.
        /// Never throws; failures are logged to stdout and discovery continues.
        /// </summary>
        public static void DiscoverAll()
        {
            lock (_runLock)
            {
                if (_ran) return;
                _ran = true;
            }

            try
            {
                var fltAssemblies = GetFltAssemblies();
                _wireUpResolveMethod = ResolveWireUpResolveMethod();

                int diCount = DiscoverDiRegistrations(fltAssemblies);
                int cacheCount = DiscoverCaches();
                int markerCount = DiscoverMonitoredCodeMarkers(fltAssemblies);
                int wrapperCount = DiscoverEdogWrappers();

                Console.WriteLine(
                    $"[EDOG] ✓ Runtime discovery complete: " +
                    $"{diCount} DI, {cacheCount} caches, {markerCount} markers, {wrapperCount} wrappers");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Runtime discovery failed: {ex.GetType().Name}: {ex.Message}");
            }
        }

        // ── DI registrations ────────────────────────────────────────────────────

        /// <summary>
        /// Enumerates public interfaces in FLT assemblies, attempts WireUp.Resolve&lt;T&gt;()
        /// for each, and publishes a record to the <c>di</c> topic for any that resolve.
        /// </summary>
        private static int DiscoverDiRegistrations(IReadOnlyList<Assembly> fltAssemblies)
        {
            if (_wireUpResolveMethod == null)
            {
                Console.WriteLine("[EDOG] ✗ DI discovery skipped: WireUp.Resolve<T> reflection lookup failed");
                return 0;
            }

            int published = 0;
            foreach (var asm in fltAssemblies)
            {
                Type[] types;
                try
                {
                    types = SafeGetTypes(asm);
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[EDOG] ✗ DI discovery: GetTypes failed for {asm.FullName}: {ex.Message}");
                    continue;
                }

                foreach (var iface in types)
                {
                    if (iface == null) continue;
                    if (!iface.IsInterface) continue;
                    if (!iface.IsPublic) continue;
                    if (iface.IsGenericTypeDefinition) continue;
                    if (iface.ContainsGenericParameters) continue;
                    if (iface.Namespace == null) continue;
                    if (!iface.Namespace.StartsWith(FltServiceNamespace, StringComparison.Ordinal)) continue;

                    object resolved;
                    try
                    {
                        var generic = _wireUpResolveMethod.MakeGenericMethod(iface);
                        resolved = generic.Invoke(null, null);
                    }
                    catch
                    {
                        // Not registered — expected for most interfaces. Skip silently.
                        continue;
                    }

                    if (resolved == null) continue;

                    try
                    {
                        var implType = resolved.GetType();
                        var implName = implType.FullName ?? implType.Name;
                        bool isEdog = implType.Name.StartsWith(EdogTypePrefix, StringComparison.Ordinal);

                        EdogTopicRouter.Publish("di", new
                        {
                            kind = "DynamicDiRegistration",
                            serviceType = iface.FullName ?? iface.Name,
                            implementationType = implName,
                            implementationAssembly = SafeAssemblyName(implType),
                            isEdogIntercepted = isEdog,
                            lifetime = "Singleton",
                            registrationPhase = "RuntimeDiscovery",
                        });

                        _resolvedCache[iface] = resolved;
                        published++;
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine(
                            $"[EDOG] ✗ DI publish failed for {iface.FullName}: {ex.Message}");
                    }
                }
            }

            return published;
        }

        // ── Cache field discovery ───────────────────────────────────────────────

        /// <summary>
        /// Scans every resolved singleton (from the DI pass) for fields that look like
        /// caches: <c>ConcurrentDictionary&lt;,&gt;</c>, <c>MemoryCache</c>,
        /// <c>SharedMemoryCache</c>, or any field with "cache" in its name.
        /// Publishes a single <c>CacheDiscovery</c> event to the <c>cache</c> topic.
        /// </summary>
        private static int DiscoverCaches()
        {
            var caches = new List<object>();

            foreach (var kvp in _resolvedCache)
            {
                var ownerType = kvp.Value?.GetType();
                if (ownerType == null) continue;

                Type cursor = ownerType;
                while (cursor != null && cursor != typeof(object))
                {
                    FieldInfo[] fields;
                    try
                    {
                        fields = cursor.GetFields(
                            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
                    }
                    catch
                    {
                        break;
                    }

                    foreach (var field in fields)
                    {
                        try
                        {
                            var fieldType = field.FieldType;
                            if (!IsCacheShaped(fieldType, field.Name)) continue;

                            string keyType = null;
                            string valueType = null;
                            if (fieldType.IsGenericType)
                            {
                                var args = fieldType.GetGenericArguments();
                                if (args.Length >= 1) keyType = args[0].FullName ?? args[0].Name;
                                if (args.Length >= 2) valueType = args[1].FullName ?? args[1].Name;
                            }

                            caches.Add(new
                            {
                                ownerType = ownerType.FullName ?? ownerType.Name,
                                declaringType = cursor.FullName ?? cursor.Name,
                                fieldName = field.Name,
                                cacheType = fieldType.FullName ?? fieldType.Name,
                                keyType,
                                valueType,
                                isStatic = field.IsStatic,
                            });
                        }
                        catch
                        {
                            // Per-field failure — skip and continue scanning.
                        }
                    }

                    cursor = cursor.BaseType;
                }
            }

            try
            {
                EdogTopicRouter.Publish("cache", new
                {
                    kind = "CacheDiscovery",
                    count = caches.Count,
                    caches = caches.ToArray(),
                });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Cache discovery publish failed: {ex.Message}");
            }

            return caches.Count;
        }

        private static bool IsCacheShaped(Type fieldType, string fieldName)
        {
            if (fieldType == null) return false;

            if (!string.IsNullOrEmpty(fieldName) &&
                fieldName.IndexOf("cache", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return true;
            }

            var name = fieldType.Name ?? string.Empty;
            if (name.StartsWith("ConcurrentDictionary", StringComparison.Ordinal)) return true;
            if (name == "MemoryCache" || name == "SharedMemoryCache") return true;
            if (name.IndexOf("Cache", StringComparison.Ordinal) >= 0 &&
                fieldType.Namespace != null &&
                fieldType.Namespace.StartsWith(FltServiceNamespace, StringComparison.Ordinal))
            {
                return true;
            }

            return false;
        }

        // ── MonitoredCodeMarker catalog ─────────────────────────────────────────

        /// <summary>
        /// Builds a catalog of MonitoredCodeMarker static fields by scanning
        /// <c>*CodeMarkers*</c> and <c>*Monitoring*</c> classes. Also captures types
        /// exposing an <c>ExecuteAsync(Func&lt;...&gt;)</c> method (the marker pattern).
        /// Publishes a single <c>MarkerCatalog</c> event to the <c>perf</c> topic.
        /// </summary>
        private static int DiscoverMonitoredCodeMarkers(IReadOnlyList<Assembly> fltAssemblies)
        {
            var markers = new List<object>();
            var markerTypeNames = new HashSet<string>(StringComparer.Ordinal);

            foreach (var asm in fltAssemblies)
            {
                Type[] types;
                try
                {
                    types = SafeGetTypes(asm);
                }
                catch
                {
                    continue;
                }

                foreach (var type in types)
                {
                    if (type == null) continue;
                    if (type.Namespace == null) continue;
                    if (!type.Namespace.StartsWith(FltServiceNamespace, StringComparison.Ordinal)) continue;

                    try
                    {
                        // Type-level: marker-pattern types with ExecuteAsync(delegate)
                        if (HasExecuteAsyncDelegateMethod(type))
                        {
                            markerTypeNames.Add(type.FullName ?? type.Name);
                        }

                        var typeName = type.Name ?? string.Empty;
                        bool isMarkerHost =
                            typeName.IndexOf("CodeMarkers", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            typeName.IndexOf("Monitoring", StringComparison.OrdinalIgnoreCase) >= 0;
                        if (!isMarkerHost) continue;

                        FieldInfo[] fields;
                        try
                        {
                            fields = type.GetFields(
                                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
                        }
                        catch
                        {
                            continue;
                        }

                        foreach (var field in fields)
                        {
                            try
                            {
                                var ftName = field.FieldType?.Name ?? string.Empty;
                                // MonitoredCodeMarker-like: name contains "Marker" or matches the ExecuteAsync pattern.
                                bool looksLikeMarker =
                                    ftName.IndexOf("Marker", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                    HasExecuteAsyncDelegateMethod(field.FieldType);

                                if (!looksLikeMarker) continue;

                                markers.Add(new
                                {
                                    name = field.Name,
                                    owningClass = type.FullName ?? type.Name,
                                    @namespace = type.Namespace,
                                    fieldType = field.FieldType?.FullName ?? ftName,
                                });
                            }
                            catch
                            {
                                // Per-field failure — skip.
                            }
                        }
                    }
                    catch
                    {
                        // Per-type failure — skip.
                    }
                }
            }

            try
            {
                EdogTopicRouter.Publish("perf", new
                {
                    kind = "MarkerCatalog",
                    count = markers.Count,
                    markers = markers.ToArray(),
                    markerHostTypes = markerTypeNames.ToArray(),
                });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Marker catalog publish failed: {ex.Message}");
            }

            return markers.Count;
        }

        private static bool HasExecuteAsyncDelegateMethod(Type type)
        {
            if (type == null) return false;
            try
            {
                var methods = type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static);
                foreach (var m in methods)
                {
                    if (m.Name != "ExecuteAsync") continue;
                    var ps = m.GetParameters();
                    if (ps.Length == 0) continue;
                    var p0 = ps[0].ParameterType;
                    // Delegate-shaped: typeof(Delegate).IsAssignableFrom catches Func/Action/etc.
                    if (typeof(Delegate).IsAssignableFrom(p0)) return true;
                }
            }
            catch
            {
                // Reflection failure — assume not a marker.
            }

            return false;
        }

        // ── EDOG wrapper detection ──────────────────────────────────────────────

        /// <summary>
        /// Walks types in <c>Microsoft.LiveTable.Service.DevMode</c> matching
        /// <c>Edog*Wrapper</c> or <c>Edog*Interceptor</c>, identifies the FLT interface
        /// each implements, and probes whether the current DI resolution is that wrapper.
        /// Publishes one event per wrapper to the <c>di</c> topic.
        /// </summary>
        private static int DiscoverEdogWrappers()
        {
            int count = 0;
            Type[] devModeTypes;
            try
            {
                var devModeAsm = typeof(EdogRuntimeDiscovery).Assembly;
                devModeTypes = SafeGetTypes(devModeAsm);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ Wrapper discovery: GetTypes failed: {ex.Message}");
                return 0;
            }

            foreach (var type in devModeTypes)
            {
                if (type == null) continue;
                if (type.Namespace != DevModeNamespace) continue;
                if (!type.IsClass || type.IsAbstract) continue;

                var name = type.Name ?? string.Empty;
                if (!name.StartsWith(EdogTypePrefix, StringComparison.Ordinal)) continue;
                if (!(name.EndsWith("Wrapper", StringComparison.Ordinal) ||
                      name.EndsWith("Interceptor", StringComparison.Ordinal)))
                {
                    continue;
                }

                try
                {
                    Type fltInterface = FindWrappedInterface(type);
                    bool currentlyActive = false;
                    string resolvedTypeName = null;
                    string probeError = null;

                    if (fltInterface != null && _wireUpResolveMethod != null)
                    {
                        try
                        {
                            var generic = _wireUpResolveMethod.MakeGenericMethod(fltInterface);
                            var resolved = generic.Invoke(null, null);
                            if (resolved != null)
                            {
                                resolvedTypeName = resolved.GetType().FullName;
                                currentlyActive = type.IsInstanceOfType(resolved);
                            }
                        }
                        catch (Exception ex)
                        {
                            var root = ex is TargetInvocationException tie && tie.InnerException != null
                                ? tie.InnerException
                                : ex;
                            probeError = root.Message;
                        }
                    }

                    EdogTopicRouter.Publish("di", new
                    {
                        kind = "EdogWrapperDiscovery",
                        wrapperType = type.FullName ?? type.Name,
                        fltInterface = fltInterface?.FullName,
                        currentlyActive,
                        resolvedType = resolvedTypeName,
                        probeError,
                    });

                    count++;
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[EDOG] ✗ Wrapper publish failed for {type.FullName}: {ex.Message}");
                }
            }

            return count;
        }

        /// <summary>
        /// Picks the most likely FLT interface a wrapper implements. Prefers interfaces
        /// whose namespace starts with <c>Microsoft.LiveTable.Service</c>; falls back to
        /// the first non-system interface.
        /// </summary>
        private static Type FindWrappedInterface(Type wrapperType)
        {
            Type[] interfaces;
            try
            {
                interfaces = wrapperType.GetInterfaces();
            }
            catch
            {
                return null;
            }

            Type fltMatch = null;
            Type anyMatch = null;
            foreach (var iface in interfaces)
            {
                if (iface == null) continue;
                if (iface.IsGenericTypeDefinition) continue;
                var ns = iface.Namespace ?? string.Empty;
                if (ns.StartsWith("System", StringComparison.Ordinal)) continue;

                if (ns.StartsWith(FltServiceNamespace, StringComparison.Ordinal))
                {
                    if (fltMatch == null) fltMatch = iface;
                }
                else if (anyMatch == null)
                {
                    anyMatch = iface;
                }
            }

            return fltMatch ?? anyMatch;
        }

        // ── Helpers ─────────────────────────────────────────────────────────────

        private static IReadOnlyList<Assembly> GetFltAssemblies()
        {
            var result = new List<Assembly>();
            Assembly[] loaded;
            try
            {
                loaded = AppDomain.CurrentDomain.GetAssemblies();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ AppDomain.GetAssemblies failed: {ex.Message}");
                return result;
            }

            foreach (var asm in loaded)
            {
                if (asm == null) continue;
                string name;
                try
                {
                    name = asm.GetName()?.Name ?? string.Empty;
                }
                catch
                {
                    continue;
                }

                if (name.StartsWith(FltAssemblyPrefix, StringComparison.Ordinal))
                {
                    result.Add(asm);
                }
            }

            return result;
        }

        /// <summary>
        /// Returns the loadable subset of an assembly's types. ReflectionTypeLoadException
        /// is unwrapped to its <c>Types</c> array (nulls filtered) so a single broken type
        /// doesn't poison the entire scan.
        /// </summary>
        private static Type[] SafeGetTypes(Assembly asm)
        {
            try
            {
                return asm.GetTypes();
            }
            catch (ReflectionTypeLoadException rtle)
            {
                if (rtle.Types == null) return Array.Empty<Type>();
                return rtle.Types.Where(t => t != null).ToArray();
            }
        }

        private static string SafeAssemblyName(Type t)
        {
            try
            {
                return t.Assembly.GetName().Name;
            }
            catch
            {
                return null;
            }
        }

        private static MethodInfo ResolveWireUpResolveMethod()
        {
            try
            {
                var wireUpType = Type.GetType(
                    "Microsoft.PowerBI.ServicePlatform.WireUp.WireUp, Microsoft.PowerBI.ServicePlatform",
                    throwOnError: false);

                if (wireUpType == null)
                {
                    // Fallback — walk loaded assemblies for the type.
                    foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                    {
                        try
                        {
                            var t = asm.GetType("Microsoft.PowerBI.ServicePlatform.WireUp.WireUp", throwOnError: false);
                            if (t != null) { wireUpType = t; break; }
                        }
                        catch
                        {
                            // Skip this assembly.
                        }
                    }
                }

                if (wireUpType == null) return null;

                return wireUpType.GetMethod(
                    "Resolve",
                    BindingFlags.Public | BindingFlags.Static,
                    binder: null,
                    types: Type.EmptyTypes,
                    modifiers: null);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ✗ WireUp.Resolve<T> lookup failed: {ex.Message}");
                return null;
            }
        }
    }
}
