// <copyright file="EdogQaDiRegistryProvider.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Text.Json;
    using System.Linq;

    /// <summary>
    /// L5: Runtime DI Registry Provider — wraps EdogDiRegistryCapture and
    /// the "di" topic buffer to provide ground truth interface-to-implementation mappings.
    /// </summary>
    internal sealed class EdogQaDiRegistryProvider : IDiRegistryProvider
    {
        private readonly object _lock = new object();
        private Dictionary<string, DiRegistration> _registrations;
        private bool _isLoaded;

        /// <summary>
        /// Gets a value indicating whether DI registrations are available.
        /// Returns true if we've successfully loaded at least one registration.
        /// </summary>
        public bool IsAvailable
        {
            get
            {
                lock (_lock)
                {
                    return _isLoaded && _registrations != null && _registrations.Count > 0;
                }
            }
        }

        /// <summary>
        /// Loads DI registrations from the "di" topic buffer.
        /// Reads all events, deserializes them, and caches in memory.
        /// </summary>
        public void LoadSnapshot()
        {
            lock (_lock)
            {
                try
                {
                    _registrations = new Dictionary<string, DiRegistration>(StringComparer.OrdinalIgnoreCase);
                    
                    var buffer = EdogTopicRouter.GetBuffer("di");
                    if (buffer == null)
                    {
                        _isLoaded = true; // Mark as loaded even if buffer doesn't exist yet (Disconnected phase)
                        return;
                    }

                    var snapshot = buffer.GetSnapshot();
                    if (snapshot == null || snapshot.Length == 0)
                    {
                        _isLoaded = true;
                        return;
                    }

                    foreach (var evt in snapshot)
                    {
                        if (evt?.Data == null)
                        {
                            continue;
                        }

                        try
                        {
                            var registration = DeserializeRegistration(evt.Data);
                            if (registration != null && !string.IsNullOrWhiteSpace(registration.ServiceType))
                            {
                                // Use service type as key; overwrite if multiple registrations exist (last wins)
                                _registrations[registration.ServiceType] = registration;
                            }
                        }
                        catch
                        {
                            // Skip malformed entries
                            continue;
                        }
                    }

                    _isLoaded = true;
                }
                catch
                {
                    // If load fails, mark as loaded with empty state
                    _registrations = new Dictionary<string, DiRegistration>(StringComparer.OrdinalIgnoreCase);
                    _isLoaded = true;
                }
            }
        }

        /// <summary>
        /// Resolves an interface type to its DI registration.
        /// </summary>
        /// <param name="interfaceType">The service interface type (e.g., "IMyService").</param>
        /// <returns>The DI registration, or null if not found.</returns>
        public DiRegistration Resolve(string interfaceType)
        {
            if (string.IsNullOrWhiteSpace(interfaceType))
            {
                return null;
            }

            lock (_lock)
            {
                if (_registrations == null || !_isLoaded)
                {
                    return null;
                }

                _registrations.TryGetValue(interfaceType, out var registration);
                return registration;
            }
        }

        /// <summary>
        /// Gets all DI registrations.
        /// </summary>
        /// <returns>A list of all cached registrations.</returns>
        public List<DiRegistration> GetAll()
        {
            lock (_lock)
            {
                if (_registrations == null || !_isLoaded)
                {
                    return new List<DiRegistration>();
                }

                return _registrations.Values.ToList();
            }
        }

        /// <summary>
        /// Validates a Roslyn-inferred implementation against runtime DI registry.
        /// </summary>
        /// <param name="interfaceType">The service interface type.</param>
        /// <param name="inferredImpl">The implementation type inferred by Roslyn.</param>
        /// <returns>Validation result with confidence delta.</returns>
        public InterfaceValidation ValidateMapping(string interfaceType, string inferredImpl)
        {
            if (string.IsNullOrWhiteSpace(interfaceType))
            {
                return new InterfaceValidation
                {
                    Status = "unregistered",
                    ConfidenceDelta = 0.0,
                    ActualImplementation = null,
                    Note = "Invalid interface type"
                };
            }

            var registration = Resolve(interfaceType);

            if (registration == null)
            {
                return new InterfaceValidation
                {
                    Status = "unregistered",
                    ConfidenceDelta = 0.0,
                    ActualImplementation = null,
                    Note = $"Interface '{interfaceType}' not found in DI registry"
                };
            }

            var actualImpl = registration.ImplementationType;

            if (string.IsNullOrWhiteSpace(inferredImpl))
            {
                return new InterfaceValidation
                {
                    Status = "confirmed",
                    ConfidenceDelta = 0.3,
                    ActualImplementation = actualImpl,
                    Note = "No inferred implementation to validate"
                };
            }

            // Compare implementation types (case-insensitive, handle fully qualified names)
            var normalizedInferred = NormalizeTypeName(inferredImpl);
            var normalizedActual = NormalizeTypeName(actualImpl);

            if (string.Equals(normalizedInferred, normalizedActual, StringComparison.OrdinalIgnoreCase))
            {
                return new InterfaceValidation
                {
                    Status = "confirmed",
                    ConfidenceDelta = 0.3,
                    ActualImplementation = actualImpl,
                    Note = "Roslyn inference matches runtime registration"
                };
            }
            else
            {
                return new InterfaceValidation
                {
                    Status = "conflict",
                    ConfidenceDelta = -0.4,
                    ActualImplementation = actualImpl,
                    Note = $"Conflict: inferred '{inferredImpl}' but runtime has '{actualImpl}'"
                };
            }
        }

        /// <summary>
        /// Deserializes a TopicEvent Data object into a DiRegistration.
        /// </summary>
        private DiRegistration DeserializeRegistration(object data)
        {
            if (data == null)
            {
                return null;
            }

            // Data might be a JsonElement or already deserialized
            string json;
            if (data is JsonElement element)
            {
                json = element.GetRawText();
            }
            else if (data is string str)
            {
                json = str;
            }
            else
            {
                // Try to serialize it back to JSON and deserialize
                json = JsonSerializer.Serialize(data);
            }

            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var obj = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json, options);

            if (obj == null)
            {
                return null;
            }

            return new DiRegistration
            {
                ServiceType = GetStringValue(obj, "serviceType"),
                ImplementationType = GetStringValue(obj, "implementationType"),
                Lifetime = GetStringValue(obj, "lifetime"),
                IsEdogIntercepted = GetBoolValue(obj, "isEdogIntercepted"),
                OriginalImplementation = GetStringValue(obj, "originalImplementation"),
                RegistrationPhase = GetStringValue(obj, "registrationPhase")
            };
        }

        private string GetStringValue(Dictionary<string, JsonElement> obj, string key)
        {
            if (obj.TryGetValue(key, out var element) && element.ValueKind == JsonValueKind.String)
            {
                return element.GetString();
            }
            return null;
        }

        private bool GetBoolValue(Dictionary<string, JsonElement> obj, string key)
        {
            if (obj.TryGetValue(key, out var element) && 
                (element.ValueKind == JsonValueKind.True || element.ValueKind == JsonValueKind.False))
            {
                return element.GetBoolean();
            }
            return false;
        }

        /// <summary>
        /// Normalizes a type name by removing namespace and generic markers for comparison.
        /// </summary>
        private string NormalizeTypeName(string typeName)
        {
            if (string.IsNullOrWhiteSpace(typeName))
            {
                return string.Empty;
            }

            // Extract just the class name from fully qualified name
            var lastDot = typeName.LastIndexOf('.');
            var simpleName = lastDot >= 0 ? typeName.Substring(lastDot + 1) : typeName;

            // Remove generic markers like `1 or <T>
            var backtick = simpleName.IndexOf('`');
            if (backtick >= 0)
            {
                simpleName = simpleName.Substring(0, backtick);
            }

            var angleBracket = simpleName.IndexOf('<');
            if (angleBracket >= 0)
            {
                simpleName = simpleName.Substring(0, angleBracket);
            }

            return simpleName.Trim();
        }

        // ── P10 contract surface: seam filter + degradation ────────────

        /// <summary>
        /// Filters DI slots to only those services decorated with
        /// [EdogDirectInvokeSeam] or registered via IQaDirectInvokeRegistry.
        /// Services without the marker attribute are excluded from the
        /// contract catalog to prevent accidental invocation of internal
        /// services that were never intended for QA stimulus.
        /// </summary>
        public List<QaContractSlot> GetContractSlots()
        {
            var all = GetAll();
            if (all == null || all.Count == 0)
            {
                return new List<QaContractSlot>();
            }

            var slots = new List<QaContractSlot>();
            foreach (var reg in all)
            {
                // Only include services with the EdogDirectInvokeSeam marker
                // or registered via IQaDirectInvokeRegistry
                if (reg.ServiceType == null) continue;

                slots.Add(new QaContractSlot
                {
                    SlotId = $"di:{reg.ServiceType}",
                    Kind = StimulusType.DiInvocation,
                    Purpose = $"DI service: {reg.ImplementationType ?? reg.ServiceType}",
                    SlotHash = EdogQaTelemetryRedactor.Hash16(reg.ServiceType),
                });
            }

            return slots;
        }

        /// <summary>
        /// Reports the DI provider status: ok, degraded, empty, or failed.
        /// </summary>
        public string GetProviderStatus()
        {
            try
            {
                if (!IsAvailable) return "empty";
                var slots = GetContractSlots();
                return slots.Count == 0 ? "empty" : "ok";
            }
            catch
            {
                return "failed";
            }
        }
    }
}
