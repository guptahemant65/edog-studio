# ADR-005: Late DI Registration for IFeatureFlighter Wrapper

## Status
ACCEPTED

**Date**: 2026-04-08
**Deciders**: Sana Reeves (Tech Lead), Arjun Mehta (Sr. C#), Dev Patel (FLT Expert), Hemant Gupta (CEO)

## Context

EDOG Studio's Feature Flag Override feature allows developers to toggle feature flags locally without changing the FeatureManagement repo or redeploying. The FLT service uses the `IFeatureFlighter` interface to query feature flag states. We need to wrap this with a version that checks for local overrides before delegating to the real implementation.

The challenge: FLT registers its `IFeatureFlighter` implementation during normal DI setup. We need to wrap (not replace) it — our wrapper must delegate to the original when no override is set.

Standard DI registration happens at startup, but we need the original registration to exist before we can wrap it. This is a chicken-and-egg problem.

## Decision

We will use **late DI registration** in the FLT service's `RunAsync()` callback to wrap the existing `IFeatureFlighter` registration.

```csharp
// In the RunAsync callback (runs after initial DI setup)
public override async Task RunAsync(CancellationToken cancellationToken)
{
    // Get the original IFeatureFlighter that FLT registered
    var original = serviceProvider.GetRequiredService<IFeatureFlighter>();

    // Replace with our wrapper that checks local overrides first
    services.AddSingleton<IFeatureFlighter>(sp =>
        new EdogFeatureFlighter(original));

    await base.RunAsync(cancellationToken);
}
```

The `EdogFeatureFlighter` wrapper:
```csharp
public class EdogFeatureFlighter : IFeatureFlighter
{
    private readonly IFeatureFlighter _inner;
    private readonly Dictionary<string, bool> _overrides = new();

    public EdogFeatureFlighter(IFeatureFlighter inner)
    {
        _inner = inner;
    }

    public bool IsEnabled(string featureName)
    {
        // Check local overrides first
        if (_overrides.TryGetValue(featureName, out var overrideValue))
            return overrideValue;

        // Delegate to original
        return _inner.IsEnabled(featureName);
    }

    public void SetOverride(string featureName, bool enabled)
    {
        _overrides[featureName] = enabled;
    }

    public void ClearOverride(string featureName)
    {
        _overrides.Remove(featureName);
    }
}
```

## Consequences

### Positive
- Wraps the real implementation — overrides are local, defaults are production-accurate
- No modification to FLT's DI setup code — we hook in after it runs
- Override state is in-memory — fast lookup, no persistence complexity
- Can be toggled from the edog UI via HTTP API to the interceptor
- Completely transparent: when no overrides are set, behavior is identical to production

### Negative
- Late DI registration is unconventional — future maintainers may not expect it
- Depends on `RunAsync()` running after DI setup — if FLT changes initialization order, this breaks
- The replaced registration is not visible in the DI container's standard inspection tools
- Thread safety: `_overrides` dictionary needs concurrent access protection if flags are toggled while FLT is processing requests

### Neutral
- Override state is per-session (in-memory) — restarting FLT clears all overrides
- This pattern is the same one used for the Spark interceptor (ADR-004)

## Alternatives Considered

### Replace at Startup (Before FLT Registers)
**Summary**: Register our `EdogFeatureFlighter` before FLT registers its implementation, so FLT's registration is overridden.
**Why rejected**: We need FLT's real implementation as the delegate. If we register first, we can't get a reference to the real one. If we register after, standard DI gives us our own wrapper back, creating a circular reference.

### AOP / Interception via Castle.DynamicProxy
**Summary**: Use Castle DynamicProxy to create a runtime proxy around `IFeatureFlighter`.
**Why rejected**: Adds a NuGet dependency (Castle.Core) that isn't in the FLT project. Over-engineered for wrapping a single interface with a simple override check.

### Configuration-Based Override (appsettings.json)
**Summary**: Override feature flags through FLT's standard configuration system.
**Why rejected**: Requires restarting the FLT service to apply changes. We want instant toggle from the edog UI without restart. Configuration-based override also doesn't support the "show me what production would do" use case — it replaces the value entirely.

### Environment Variable Override
**Summary**: Set environment variables that the flag system reads.
**Why rejected**: Same restart problem. Also, environment variable names would need to match FLT's internal flag naming convention, creating a fragile coupling.

## Related
- ADR-004: Subclass GTSBasedSparkClient (same late DI pattern)
- ADR-001: Two-Phase Lifecycle (flag overrides are a Phase 2 feature)
- Design spec Section 9: Feature Flags
- Arjun Mehta owns implementation
- Dev Patel owns IFeatureFlighter domain knowledge
