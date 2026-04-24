# C04: Nexus Session Store — P1 Component Deep Spec

> **Component:** `EdogNexusSessionStore.cs`  
> **Feature:** F26 — Nexus Real-Time Dependency Graph  
> **Priority:** P1  
> **Author:** Sana (Architecture Agent)  
> **Status:** DRAFT  
> **Parent spec:** `docs/superpowers/specs/2026-04-24-nexus-design.md` section 7  
> **Source path:** `src/backend/DevMode/EdogNexusSessionStore.cs`

---

## 0. Executive Summary

First persistence layer in EDOG DevMode. Today, ALL runtime data lives in
in-memory `ConcurrentQueue` buffers (`EdogLogServer.cs:40-41`) and ring buffers
(`EdogTopicRouter.cs:20`). Service restart means total data loss. The session
store solves exactly one problem: **Nexus aggregator state survives restarts**
so triage context is not destroyed when the FLT process recycles.

This is NOT a database. It is a bounded rolling state file that periodically
serializes the aggregator's derived graph state (edge stats, snapshots,
baselines) to disk using `System.Text.Json` async file I/O.

### Design Principles

1. **Never block the aggregator** — flush is fire-and-forget on a timer; reads happen only at startup.
2. **Corruption is expected** — quarantine and restart clean; never crash.
3. **Bounded by design** — age + count caps enforced on every flush cycle.
4. **Schema-versioned** — envelope carries version number; unknown versions are quarantined, not parsed.
5. **Single writer** — no concurrent file access; atomic swap via temp-file rename.

---

## 1. Scenario: Periodic Flush

### 1.1 Trigger

A background `System.Threading.Timer` fires every 5 seconds (configurable via
`EDOG_NEXUS_FLUSH_INTERVAL_MS`, default `5000`).

### 1.2 Expected Behavior

1. Timer callback requests a read-consistent snapshot from the aggregator.
2. Snapshot is serialized to a temp file adjacent to the target path.
3. Temp file is atomically renamed over the target file.
4. If serialization or write fails, the existing file is untouched and a
   warning is emitted to `Console.WriteLine`.

### 1.3 Technical Mechanism

```csharp
// EdogNexusSessionStore.cs — periodic flush

internal sealed class EdogNexusSessionStore : IDisposable
{
    private const int DefaultFlushIntervalMs = 5000;
    private const int MaxSnapshots = 720;        // ~1 hour at 5s intervals
    private const int MaxAgeMinutes = 60;
    private const int SchemaVersion = 1;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };

    private readonly string _filePath;
    private readonly string _quarantinePath;
    private readonly Timer _flushTimer;
    private readonly Func<NexusPersistedState> _snapshotProvider;
    private readonly object _flushLock = new();
    private volatile bool _disposed;

    public EdogNexusSessionStore(
        string dataDirectory,
        Func<NexusPersistedState> snapshotProvider)
    {
        _filePath = Path.Combine(dataDirectory, "nexus-session.json");
        _quarantinePath = Path.Combine(dataDirectory, "nexus-session.quarantined.json");
        _snapshotProvider = snapshotProvider;

        Directory.CreateDirectory(dataDirectory);

        var intervalMs = ParseEnvInt("EDOG_NEXUS_FLUSH_INTERVAL_MS", DefaultFlushIntervalMs);
        _flushTimer = new Timer(_ => FlushAsync().ConfigureAwait(false),
                                null, intervalMs, intervalMs);
    }

    private async Task FlushAsync()
    {
        if (_disposed) return;

        // Single writer — skip if previous flush still running
        if (!Monitor.TryEnter(_flushLock)) return;
        try
        {
            var state = _snapshotProvider();
            if (state == null) return;

            ApplyRetention(state);

            var envelope = new NexusStoreEnvelope
            {
                SchemaVersion = SchemaVersion,
                FlushedAtUtc = DateTimeOffset.UtcNow,
                State = state
            };

            var tempPath = _filePath + ".tmp";
            await using (var fs = new FileStream(tempPath, FileMode.Create,
                             FileAccess.Write, FileShare.None, 4096,
                             FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                await JsonSerializer.SerializeAsync(fs, envelope, JsonOpts);
            }

            File.Move(tempPath, _filePath, overwrite: true);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[EDOG] Nexus flush failed (non-fatal): {ex.Message}");
        }
        finally
        {
            Monitor.Exit(_flushLock);
        }
    }
}
```

### 1.4 Source Code Path

`src/backend/DevMode/EdogNexusSessionStore.cs` — `FlushAsync()` method.

### 1.5 Edge Cases

| Case | Behavior |
|------|----------|
| Aggregator returns null (no data yet) | Skip flush silently |
| Disk full / write fails | Catch, log warning, existing file preserved |
| Timer fires while previous flush in-flight | `Monitor.TryEnter` skips — no queue buildup |
| Process crash mid-write | Only temp file is corrupted; main file intact |
| Data directory does not exist | Created in constructor via `Directory.CreateDirectory` |

### 1.6 Interactions

- **EdogNexusAggregator** — provides `Func<NexusPersistedState>` snapshot delegate.
- **EdogDevModeRegistrar** — wires store lifetime (start timer / dispose).

### 1.7 Revert Mechanism

Delete `nexus-session.json` to force clean start. No config change needed.

### 1.8 Priority

**P1** — Core persistence mechanism. All other scenarios depend on this.

---

## 2. Scenario: Graceful Shutdown Flush

### 2.1 Trigger

`Dispose()` is called during `EdogLogServer.Stop()` → aggregator teardown
chain (`EdogLogServer.cs:138-158`).

### 2.2 Expected Behavior

1. Cancel the periodic timer.
2. Execute one final synchronous flush (bounded by 3-second timeout).
3. If flush times out, log a warning but do NOT block shutdown.

### 2.3 Technical Mechanism

```csharp
public void Dispose()
{
    if (_disposed) return;
    _disposed = true;

    _flushTimer.Dispose();

    // Final flush with bounded timeout — never block shutdown
    try
    {
        var flushTask = FlushAsync();
        flushTask.Wait(TimeSpan.FromSeconds(3));
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[EDOG] Nexus shutdown flush failed (non-fatal): {ex.Message}");
    }
}
```

### 2.4 Source Code Path

`src/backend/DevMode/EdogNexusSessionStore.cs` — `Dispose()` method.

### 2.5 Edge Cases

| Case | Behavior |
|------|----------|
| FlushAsync takes > 3 seconds (large state, slow disk) | Timeout; partial temp file left behind (cleaned at next startup) |
| Dispose called multiple times | `_disposed` flag gates idempotent execution |
| FlushAsync throws | Caught, logged, process exits cleanly |
| Abrupt kill (SIGKILL / TerminateProcess) | No flush — startup will use last periodic flush |

### 2.6 Interactions

- **EdogLogServer.Stop()** — triggers dispose chain (`EdogLogServer.cs:138-158`).
- **EdogDevModeRegistrar** — must register store in dispose order after aggregator.

### 2.7 Revert Mechanism

N/A — graceful shutdown is always attempted. Worst case, last periodic flush
file is used.

### 2.8 Priority

**P1** — Prevents up to 5 seconds of data loss on clean shutdown.

---

## 3. Scenario: Startup Restore

### 3.1 Trigger

`EdogNexusSessionStore` constructor or explicit `RestoreAsync()` called
during `EdogDevModeRegistrar.RegisterAll()` before the aggregator starts
processing live events.

### 3.2 Expected Behavior

1. Check if `nexus-session.json` exists.
2. If present, deserialize the envelope.
3. Validate `SchemaVersion` — if unknown, quarantine and start clean.
4. Apply retention policy to prune stale data.
5. Return `NexusPersistedState` to the aggregator for hydration.
6. Clean up any leftover `.tmp` files from interrupted flushes.

### 3.3 Technical Mechanism

```csharp
public async Task<NexusPersistedState> RestoreAsync()
{
    // Clean up any orphaned temp files from interrupted flushes
    var tempPath = _filePath + ".tmp";
    if (File.Exists(tempPath))
    {
        try { File.Delete(tempPath); }
        catch { /* best effort */ }
    }

    if (!File.Exists(_filePath))
        return null;

    try
    {
        await using var fs = new FileStream(_filePath, FileMode.Open,
                                 FileAccess.Read, FileShare.Read, 4096,
                                 FileOptions.Asynchronous | FileOptions.SequentialScan);
        var envelope = await JsonSerializer.DeserializeAsync<NexusStoreEnvelope>(fs, JsonOpts);

        if (envelope == null)
        {
            QuarantineFile("null envelope");
            return null;
        }

        if (envelope.SchemaVersion != SchemaVersion)
        {
            QuarantineFile($"schema v{envelope.SchemaVersion} != expected v{SchemaVersion}");
            return null;
        }

        ApplyRetention(envelope.State);

        Console.WriteLine($"[EDOG] Nexus session restored ({envelope.State?.Snapshots?.Count ?? 0} snapshots)");
        return envelope.State;
    }
    catch (JsonException ex)
    {
        QuarantineFile($"JSON parse error: {ex.Message}");
        return null;
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[EDOG] Nexus restore failed (starting clean): {ex.Message}");
        return null;
    }
}
```

### 3.4 Source Code Path

`src/backend/DevMode/EdogNexusSessionStore.cs` — `RestoreAsync()` method.

### 3.5 Edge Cases

| Case | Behavior |
|------|----------|
| File does not exist (fresh install) | Return null; aggregator starts with empty state |
| File is zero bytes | `JsonException` caught → quarantine + clean start |
| File has future SchemaVersion | Quarantine + clean start + warning |
| File has stale data (> MaxAgeMinutes old) | Retention prunes all entries; effectively clean start |
| File locked by antivirus/backup tool | IOException caught → log warning, start clean |
| Orphaned `.tmp` file from crash | Deleted at start of restore |

### 3.6 Interactions

- **EdogNexusAggregator** — receives restored state via `HydrateFrom(NexusPersistedState)`.
- **EdogDevModeRegistrar** — calls restore BEFORE starting aggregator's live subscriptions.

### 3.7 Revert Mechanism

Delete `nexus-session.json` to force clean start from empty state.

### 3.8 Priority

**P1** — Core value proposition: triage context survives restart.

---

## 4. Scenario: File Format

### 4.1 Trigger

Any read or write of the persistence file.

### 4.2 Expected Behavior

The file is a single JSON document with a versioned envelope. The codebase
already uses `System.Text.Json` exclusively for serialization
(`EdogLogServer.cs:37`, `EdogApiProxy.cs` passim) — no MessagePack,
no Newtonsoft.

### 4.3 Technical Mechanism

```csharp
// --- Envelope (top-level) ---
internal sealed class NexusStoreEnvelope
{
    public int SchemaVersion { get; set; }
    public DateTimeOffset FlushedAtUtc { get; set; }
    public NexusPersistedState State { get; set; }
}

// --- Persisted state (what the aggregator produces) ---
internal sealed class NexusPersistedState
{
    public List<NexusEdgeStats> Edges { get; set; } = new();
    public List<NexusGraphSnapshot> Snapshots { get; set; } = new();
    public Dictionary<string, NexusBaseline> Baselines { get; set; } = new();
}

// --- Per-edge rolling stats ---
internal sealed class NexusEdgeStats
{
    public string DependencyId { get; set; }    // e.g., "spark-gts"
    public long TotalRequests { get; set; }
    public long TotalErrors { get; set; }
    public long TotalRetries { get; set; }
    public double P50Ms { get; set; }
    public double P95Ms { get; set; }
    public double P99Ms { get; set; }
    public double ErrorRate { get; set; }
    public DateTimeOffset WindowStart { get; set; }
    public DateTimeOffset WindowEnd { get; set; }
}

// --- Point-in-time graph snapshot ---
internal sealed class NexusGraphSnapshot
{
    public DateTimeOffset Timestamp { get; set; }
    public int WindowSec { get; set; }
    // Compact: node list + edge list matching design spec section 5.3
    public List<NexusNodeDto> Nodes { get; set; } = new();
    public List<NexusEdgeDto> Edges { get; set; } = new();
}

// --- Baseline for anomaly detection ---
internal sealed class NexusBaseline
{
    public string DependencyId { get; set; }
    public double BaselineP50Ms { get; set; }
    public double BaselineP95Ms { get; set; }
    public double BaselineErrorRate { get; set; }
    public long SampleCount { get; set; }
    public DateTimeOffset LastUpdatedUtc { get; set; }
}
```

**What is NOT persisted** (by design):

| Excluded | Reason |
|----------|--------|
| Raw topic events | Unbounded; already in ring buffers for live view |
| Request/response bodies | Privacy (SAS, tokens); too large |
| Correlation IDs for individual calls | Bounded store must stay compact |
| Frontend rendering state | Client-side only |

### 4.4 Source Code Path

`src/backend/DevMode/EdogNexusModels.cs` — DTOs.  
`src/backend/DevMode/EdogNexusSessionStore.cs` — serialization calls.

### 4.5 Edge Cases

| Case | Behavior |
|------|----------|
| Very large snapshot list (> 720 entries) | Retention prunes before serialization |
| Empty state (no edges yet) | Valid JSON with empty arrays — not skipped |
| Non-ASCII dependency IDs | Handled natively by `System.Text.Json` UTF-8 |

### 4.6 Interactions

- **EdogNexusModels.cs** — defines all DTOs; session store references them.
- **EdogNexusAggregator.cs** — produces the `NexusPersistedState` snapshot.

### 4.7 Revert Mechanism

Schema is forward-compatible by version check. Old versions of EDOG simply
quarantine files from newer versions and start clean.

### 4.8 Priority

**P1** — Format decision gates all other scenarios.

---

## 5. Scenario: Retention Policy

### 5.1 Trigger

Called during every `FlushAsync()` and during `RestoreAsync()`, BEFORE
serialization or hydration.

### 5.2 Expected Behavior

1. **Snapshot count cap:** keep at most `MaxSnapshots` (720) entries — most
   recent wins. At 5-second flush interval, this is ~1 hour of history.
2. **Age cap:** discard any snapshot or edge stat window older than
   `MaxAgeMinutes` (60).
3. **Baseline retention:** baselines are never aged out (they are small and
   represent long-lived learned behavior). They ARE pruned if their
   `DependencyId` is no longer present in any snapshot.

### 5.3 Technical Mechanism

```csharp
private void ApplyRetention(NexusPersistedState state)
{
    if (state == null) return;

    var cutoff = DateTimeOffset.UtcNow.AddMinutes(-MaxAgeMinutes);

    // Prune snapshots by age, then cap by count
    state.Snapshots.RemoveAll(s => s.Timestamp < cutoff);
    if (state.Snapshots.Count > MaxSnapshots)
    {
        state.Snapshots.RemoveRange(0, state.Snapshots.Count - MaxSnapshots);
    }

    // Prune edge stats by window age
    state.Edges.RemoveAll(e => e.WindowEnd < cutoff);

    // Prune orphaned baselines (dependency no longer appears in any snapshot)
    var activeDeps = new HashSet<string>(
        state.Snapshots.SelectMany(s => s.Edges.Select(e => e.To)));
    var orphanKeys = state.Baselines.Keys
        .Where(k => !activeDeps.Contains(k)).ToList();
    foreach (var key in orphanKeys)
        state.Baselines.Remove(key);
}
```

### 5.4 Source Code Path

`src/backend/DevMode/EdogNexusSessionStore.cs` — `ApplyRetention()` method.

### 5.5 Edge Cases

| Case | Behavior |
|------|----------|
| All data older than MaxAgeMinutes | All pruned; effectively clean state |
| Clock skew (system time jumps backward) | Some entries may linger longer; benign |
| Single-dependency session (only spark-gts) | Baselines for other deps pruned on next flush |

### 5.6 Interactions

- Called in both the write path (`FlushAsync`) and the read path (`RestoreAsync`).
- Retention constants may be elevated to env vars in a future iteration.

### 5.7 Revert Mechanism

Lowering `MaxSnapshots` or `MaxAgeMinutes` auto-prunes on next flush.
Raising them only takes effect for future data.

### 5.8 Priority

**P1** — Prevents unbounded disk growth in a DevMode tool.

---

## 6. Scenario: Corruption Handling

### 6.1 Trigger

`RestoreAsync()` encounters any of:
- `JsonException` (malformed JSON)
- `SchemaVersion` mismatch
- Null envelope after deserialization
- File I/O error during read

### 6.2 Expected Behavior

1. Move the corrupt file to `nexus-session.quarantined.json` (overwriting any
   previously quarantined file).
2. Emit a `Console.WriteLine` warning with reason.
3. Return null — aggregator starts clean.
4. **Never** block service startup. **Never** throw.

### 6.3 Technical Mechanism

```csharp
private void QuarantineFile(string reason)
{
    try
    {
        if (File.Exists(_filePath))
        {
            File.Move(_filePath, _quarantinePath, overwrite: true);
        }
        Console.WriteLine($"[EDOG] Nexus session file quarantined ({reason}). Starting clean.");
    }
    catch (Exception ex)
    {
        // Even quarantine can fail (permissions, locks) — just log and move on
        Console.WriteLine($"[EDOG] Nexus quarantine failed: {ex.Message}. Starting clean.");
        try { File.Delete(_filePath); } catch { /* abandon */ }
    }
}
```

### 6.4 Source Code Path

`src/backend/DevMode/EdogNexusSessionStore.cs` — `QuarantineFile()` method,
called from `RestoreAsync()`.

### 6.5 Edge Cases

| Case | Behavior |
|------|----------|
| File is corrupt AND quarantine path is locked | Delete original; log warning; start clean |
| File is truncated (partial write from crash) | `JsonException` → quarantine |
| File is valid JSON but wrong shape (e.g., `[]`) | Deserialization returns null → quarantine |
| Binary garbage (not JSON at all) | `JsonException` → quarantine |
| Previous quarantined file exists | Overwritten — we keep only the most recent quarantine |

### 6.6 Interactions

- **Startup sequence** — quarantine happens BEFORE aggregator starts; no race.
- **Operator visibility** — `[EDOG]` prefix on console makes it grep-able in FLT output.

### 6.7 Revert Mechanism

Manually rename `nexus-session.quarantined.json` back to `nexus-session.json`
to attempt re-load (e.g., after fixing a version mismatch by upgrading EDOG).

### 6.8 Priority

**P1** — Corruption must never prevent DevMode startup.

---

## 7. Scenario: File Location

### 7.1 Trigger

Constructor of `EdogNexusSessionStore` — must resolve a writable directory.

### 7.2 Expected Behavior

The store writes to a local DevMode data directory, resolved in priority order:

1. `EDOG_DATA_DIR` environment variable (if set and non-empty).
2. Sibling `edog-data/` directory next to `edog-config.json` (mirrors the
   existing config discovery pattern in `EdogLogServer.cs:398-430`).
3. Fallback: `{user-home}/.edog/data/`.

The subdirectory `nexus/` is created under the resolved root.

### 7.3 Technical Mechanism

```csharp
// Called by EdogDevModeRegistrar when wiring the session store
internal static string ResolveNexusDataDir()
{
    // 1. Explicit override
    var envDir = Environment.GetEnvironmentVariable("EDOG_DATA_DIR");
    if (!string.IsNullOrEmpty(envDir))
        return Path.Combine(envDir, "nexus");

    // 2. Adjacent to edog-config.json (same walk-up logic as EdogLogServer)
    var configDir = FindEdogConfigDir();
    if (configDir != null)
        return Path.Combine(configDir, "edog-data", "nexus");

    // 3. User home fallback
    var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    return Path.Combine(home, ".edog", "data", "nexus");
}
```

### 7.4 Source Code Path

`src/backend/DevMode/EdogNexusSessionStore.cs` — `ResolveNexusDataDir()`.  
Discovery pattern mirrors `EdogLogServer.cs:398-430` (`FindEdogConfigDir`).

### 7.5 Edge Cases

| Case | Behavior |
|------|----------|
| Directory does not exist | Created by constructor (`Directory.CreateDirectory`) |
| Directory is read-only | Flush fails silently; store operates in memory-only mode |
| Multiple FLT instances share same directory | Addressed in Scenario 8 (concurrent access) |
| Path contains spaces or Unicode | `Path.Combine` handles natively |

### 7.6 Interactions

- **EdogLogServer.FindEdogConfigDir()** — reuses same config discovery walk-up.
- **edog-config.json** — proximity anchor for data directory resolution.

### 7.7 Revert Mechanism

Set `EDOG_DATA_DIR` to redirect, or delete the `nexus/` subdirectory.

### 7.8 Priority

**P1** — File location must be deterministic and discoverable.

---

## 8. Scenario: Concurrent Access (Flush vs Aggregator Reads)

### 8.1 Trigger

Flush timer fires while the aggregator is actively processing events and
updating its in-memory state.

### 8.2 Expected Behavior

1. The aggregator exposes a snapshot delegate (`Func<NexusPersistedState>`)
   that produces a **consistent, deep-copied** snapshot of current state.
2. The flush path never holds a lock that the aggregator's hot path contends on.
3. The file is single-writer: only one flush in-flight at a time via
   `Monitor.TryEnter`.

### 8.3 Technical Mechanism

**Aggregator side** (in `EdogNexusAggregator.cs`):

```csharp
// Thread-safe snapshot — called by session store's flush timer
public NexusPersistedState TakeSnapshot()
{
    lock (_stateLock)
    {
        // Deep copy: serialize + deserialize is simple and correct.
        // State is small (<100 KB typically) so copy cost is negligible
        // vs the complexity of lock-free snapshot readers.
        var json = JsonSerializer.Serialize(_state, JsonOpts);
        return JsonSerializer.Deserialize<NexusPersistedState>(json, JsonOpts);
    }
}
```

**Store side** (already shown in Scenario 1):
- `Monitor.TryEnter(_flushLock)` — non-blocking skip if flush in progress.
- Flush runs on `Timer` thread, NOT on the aggregator's event-processing thread.

### 8.4 Source Code Path

`src/backend/DevMode/EdogNexusAggregator.cs` — `TakeSnapshot()`.  
`src/backend/DevMode/EdogNexusSessionStore.cs` — `FlushAsync()`.

### 8.5 Edge Cases

| Case | Behavior |
|------|----------|
| Aggregator lock held during burst processing | Snapshot waits briefly; flush timer is fire-and-forget so small delay is acceptable |
| Two flush timers somehow created | `Monitor.TryEnter` prevents concurrent writes |
| Snapshot taken between edge updates | Consistent within lock boundary; may miss the latest event (acceptable — 5s stale window) |

### 8.6 Interactions

- **EdogNexusAggregator** — owns `_stateLock`; snapshot is the only
  read contention point.
- **EdogTopicRouter** — publishes to aggregator on separate threads; no
  direct interaction with store.

### 8.7 Revert Mechanism

N/A — concurrency model is structural.

### 8.8 Priority

**P1** — Correctness of concurrent flush is non-negotiable.

---

## 9. Scenario: Schema Evolution

### 9.1 Trigger

A new version of EDOG ships with changes to `NexusPersistedState`,
`NexusEdgeStats`, `NexusGraphSnapshot`, or `NexusBaseline` DTOs.

### 9.2 Expected Behavior

1. Bump `SchemaVersion` constant in `EdogNexusSessionStore`.
2. On restore, if file version != expected version → **quarantine and start
   clean** (Scenario 6).
3. No migration code. Rationale: this is a 1-hour rolling window of derived
   DevMode data, not a user document. Losing it on upgrade is acceptable
   and vastly simpler than maintaining migration paths.

### 9.3 Technical Mechanism

```csharp
// In RestoreAsync():
if (envelope.SchemaVersion != SchemaVersion)
{
    QuarantineFile($"schema v{envelope.SchemaVersion} != expected v{SchemaVersion}");
    return null;
}
```

**Schema change checklist:**

1. Modify DTO(s) in `EdogNexusModels.cs`.
2. Increment `SchemaVersion` in `EdogNexusSessionStore.cs`.
3. No migration needed — old file is quarantined, new state builds from live data.
4. Update this spec's models section (Scenario 4) to reflect new shape.

### 9.4 Source Code Path

`src/backend/DevMode/EdogNexusSessionStore.cs` — `SchemaVersion` constant and
restore version check.

### 9.5 Edge Cases

| Case | Behavior |
|------|----------|
| Downgrade EDOG to older version | Older version sees future SchemaVersion → quarantine + clean |
| SchemaVersion accidentally not bumped | Deserialization may succeed with default values for new properties; old properties silently ignored by `System.Text.Json` — degraded but not corrupt |
| Two schema changes in one release | Single version bump is sufficient |

### 9.6 Interactions

- **EdogNexusModels.cs** — DTO changes trigger version bump.
- **Quarantine flow** — reused from Scenario 6.

### 9.7 Revert Mechanism

Downgrade is automatic: old version quarantines new file and starts clean.

### 9.8 Priority

**P2** — Not needed until the first schema change, but the mechanism must be
designed in P1 so the version field is present from day one.

---

## 10. Scenario: Disk Failure Resilience

### 10.1 Trigger

Any file I/O operation fails due to disk errors, permission issues, full disk,
or the data directory becoming unavailable.

### 10.2 Expected Behavior

1. **Flush fails:** catch exception, log `[EDOG]` warning, continue operating
   with in-memory-only state. Next timer tick retries automatically.
2. **Restore fails:** catch exception, log warning, return null — start clean.
3. **Directory creation fails:** constructor logs warning; store operates in
   degraded (no-persist) mode.
4. **Never throw from any public method.** DevMode tools are non-fatal to FLT.

### 10.3 Technical Mechanism

```csharp
// Degraded mode flag — set if directory creation or first write fails
private volatile bool _degraded;

public EdogNexusSessionStore(string dataDirectory, Func<NexusPersistedState> snapshotProvider)
{
    // ...existing init...
    try
    {
        Directory.CreateDirectory(dataDirectory);
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[EDOG] Nexus data dir unavailable ({ex.Message}). Running memory-only.");
        _degraded = true;
    }
}

private async Task FlushAsync()
{
    if (_disposed || _degraded) return;
    // ...rest of flush logic with try/catch...
}
```

### 10.4 Source Code Path

`src/backend/DevMode/EdogNexusSessionStore.cs` — exception handlers in
constructor, `FlushAsync()`, and `RestoreAsync()`.

### 10.5 Edge Cases

| Case | Behavior |
|------|----------|
| Disk fills up mid-write | Temp file write fails; main file preserved; retried next tick |
| Network drive disconnects | IOException on write; same handling as disk failure |
| File locked by another process | IOException; logged and skipped |
| Permissions change after startup | Next flush fails gracefully; retried each tick |
| Disk recovers after transient failure | Next flush tick succeeds automatically (no manual intervention) |

### 10.6 Interactions

- All file I/O is confined to this class — no other EDOG component writes to
  the Nexus data directory.
- Aggregator and frontend are unaffected by persistence failures.

### 10.7 Revert Mechanism

Fix the disk issue. Next periodic flush tick automatically resumes persistence.

### 10.8 Priority

**P1** — DevMode must NEVER crash due to disk issues.

---

## Appendix A: Registration Sequence

```
EdogDevModeRegistrar.RegisterAll()                 // EdogDevModeRegistrar.cs:25
  ├─ EdogTopicRouter.Initialize()                  // registers nexus topic
  ├─ ...existing interceptor registrations...
  ├─ var dataDir = EdogNexusSessionStore.ResolveNexusDataDir()
  ├─ var aggregator = new EdogNexusAggregator(...)
  ├─ var store = new EdogNexusSessionStore(dataDir, aggregator.TakeSnapshot)
  ├─ var restored = await store.RestoreAsync()
  ├─ if (restored != null) aggregator.HydrateFrom(restored)
  ├─ aggregator.Start()                            // subscribe to source topics
  └─ // store timer is already running from constructor
```

Teardown (reverse order):
```
EdogLogServer.Stop()
  ├─ aggregator.Stop()     // stop consuming topics
  ├─ store.Dispose()       // final flush + timer dispose
  └─ ...existing teardown...
```

## Appendix B: File Layout on Disk

```
{resolved-data-dir}/
  nexus/
    nexus-session.json               # active state file (~10-100 KB)
    nexus-session.json.tmp           # transient; exists only during flush
    nexus-session.quarantined.json   # most recent corrupt file (if any)
```

## Appendix C: Configuration Summary

| Control | Source | Default |
|---------|--------|---------|
| Flush interval (ms) | `EDOG_NEXUS_FLUSH_INTERVAL_MS` env var | `5000` |
| Max snapshot count | `MaxSnapshots` constant | `720` (~1 hour) |
| Max data age (minutes) | `MaxAgeMinutes` constant | `60` |
| Data directory | `EDOG_DATA_DIR` env var / config proximity / user home | See Scenario 7 |
| Shutdown flush timeout | Hardcoded | `3` seconds |
| Schema version | `SchemaVersion` constant | `1` |

## Appendix D: Decision Log

| Decision | Rationale | Alternative Rejected |
|----------|-----------|---------------------|
| `System.Text.Json` (not MessagePack) | Codebase consistency — all existing serialization uses STJ (`EdogLogServer.cs:37`) | MessagePack would be faster but adds a dependency and breaks debuggability |
| Single file (not SQLite) | Simplicity; state is small (<100 KB); no query need | SQLite adds complexity and a native dependency |
| No migration on schema change | Data is a 1-hour rolling window of derived metrics, not a user document | Migration code adds indefinite maintenance burden for negligible user value |
| Quarantine (not delete) on corruption | Preserves evidence for debugging; only 1 quarantine file so bounded disk use | Deleting is simpler but loses diagnostic evidence |
| Atomic rename via temp file | Prevents corruption if process dies mid-write; standard pattern | Direct overwrite risks truncated file on crash |
| `Monitor.TryEnter` (not SemaphoreSlim) | Simpler for single-writer skip-if-busy pattern; no async lock needed because the lock scope is just the `FlushAsync` gate, not the I/O itself | `SemaphoreSlim` would work but is heavier for this use case |
