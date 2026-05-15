# Feature 11: Environment Panel

> **Phase:** V1.1
> **Status:** Not Started
> **Owner:** Elena Voronova (Python) + Zara Okonkwo (JS)
> **Spec:** docs/specs/features/F11-environment-panel.md
> **Design Ref:** docs/specs/design-spec-v2.md §11

### Problem

Feature flags are managed through a separate PowerShell tool (FeatureTool.ps1), lock state requires manual API calls, and orphaned resources accumulate silently. Three separate workflows that should be in one place.

### Objective

A unified Environment view with three sections: Feature Flags (rollout visibility + local override + PR creation), Lock Monitor, and Orphaned Resources.

### Owner

**Primary:** Elena Voronova (Python flag parsing + git/PR), Zara Okonkwo (JS UI)
**Reviewers:** Dev Patel (flag behavior), Arjun Mehta (C# IFeatureFlighter wrapper), Sana Reeves (architecture)

### Inputs

- **Feature Flags:** 28 FLT flag JSON files from local FeatureManagement repo clone
- **Lock Monitor:** `GET /liveTableMaintenance/getLockedDAGExecutionIteration`, `POST /liveTableMaintenance/forceUnlockDAGExecution`
- **Orphaned Resources:** `GET /liveTableMaintenance/listOrphanedIndexFolders`, `POST /liveTableMaintenance/deleteOrphanedIndexFolders`
- **C# Interceptor:** `EdogFeatureFlighterWrapper.cs` (new) for local overrides

### Outputs

- **Files created:**
  - `src/backend/DevMode/EdogFeatureFlighterWrapper.cs` — IFeatureFlighter decorator with override + logging
  - `src/frontend/js/feature-flags.js` — Flag table renderer, override toggles, PR wizard
- **Files modified:**
  - `src/frontend/js/workspace-explorer.js` (or new module) — Environment view content
  - `src/frontend/css/environment.css` — Flag table, lock monitor, orphaned resources styles
  - `edog.py` — Flag file parsing, git operations for PR creation
  - `src/backend/DevMode/EdogLogServer.cs` — Feature override endpoints, flag data serving

### Technical Design

**C# — `EdogFeatureFlighterWrapper.cs`:**

```csharp
public class EdogFeatureFlighterWrapper : IFeatureFlighter
{
    private readonly IFeatureFlighter _inner;
    private readonly EdogLogServer _logServer;
    private Dictionary<string, bool> _overrides;

    // Registered in RunAsync() callback (~line 196) where workloadContext exists
    public bool IsEnabled(string featureName, Guid? tenantId, Guid? capacityId, Guid? workspaceId)
    {
        if (_overrides.TryGetValue(featureName, out var overrideValue))
        {
            _logServer.AddLog($"Feature '{featureName}' → {overrideValue} (OVERRIDE)");
            return overrideValue;
        }
        var result = _inner.IsEnabled(featureName, tenantId, capacityId, workspaceId);
        _logServer.AddLog($"Feature '{featureName}' → {result}");
        return result;
    }
}
```

### Acceptance Criteria

- [ ] Feature flags table shows all 28 FLT flags with per-ring rollout state
- [ ] Cells show: ✓ (enabled), ✕ (disabled), ◐ (conditional) with tooltip on hover
- [ ] Click a flag row → expands to show full JSON definition
- [ ] Search/filter by flag name works
- [ ] Group by rollout state: "Fully rolled out", "Partially rolled out", "Not enabled"
- [ ] Override toggle shown per flag (connected mode only)
- [ ] Override changes take effect immediately via IFeatureFlighter wrapper
- [ ] "Create PR" button opens inline editor with rollout controls per environment
- [ ] Lock monitor shows current lock state with age timer
- [ ] "Force Unlock" button with confirmation dialog
- [ ] Orphaned resources list with individual and bulk delete buttons
- [ ] Connected-only sections (overrides, lock, orphaned) show appropriate empty states when disconnected

### Dependencies

- **Feature 2 (Deploy):** Connected mode needed for overrides, lock monitor, orphaned resources
- **Feature 2 (Deploy):** IPC channel needed for feature override updates

### Risks

| Risk | Mitigation |
|------|------------|
| IFeatureFlighter timing — late DI registration at RunAsync | Pattern confirmed in feasibility research (Appendix D). Test thoroughly. |
| FeatureManagement repo path not auto-detected | Configurable in edog-config.json. Default: search sibling directories. |

### Moonshot Vision

V2+: Flag experiment mode (A/B testing locally). Flag dependency graph (which flags affect which code paths). Automatic PR templates with approval chains.

