# Feature 3: Favorites / Named Environments

> **Phase:** MVP
> **Status:** Not Started
> **Owner:** Zara Okonkwo (JS) + Elena Voronova (Python)
> **Spec:** docs/specs/features/F03-favorites-named-environments.md
> **Design Ref:** docs/specs/design-spec-v2.md §3

### Problem

Engineers work with 3-5 lakehouses regularly (dev, staging, team-shared, experiment-specific). Each lakehouse requires remembering workspace IDs, artifact IDs, and capacity IDs. Switching between them means navigating the full tree every time.

### Objective

Persistent named-environment bookmarks with one-click deploy. Favorites survive session restarts, stored as JSON on disk.

### Owner

**Primary:** Zara Okonkwo (JS) + Elena Voronova (Python persistence)
**Reviewers:** Kael Andersen (UX placement), Sana Reeves (config schema)

### Inputs

- Lakehouse selection from Workspace Explorer (workspaceId, artifactId, capacityId, displayName)
- Persistence file: `~/.edog/favorites.json` (or `edog-favorites.json` alongside edog-config.json)
- EdogApiProxy serves favorites via `/api/flt/config` or new `/api/favorites` endpoint

### Outputs

- **Files modified:**
  - `src/frontend/js/workspace-explorer.js` — "Save as Favorite" in context menu, favorites section in tree
  - `src/frontend/js/api-client.js` — Add `getFavorites()`, `saveFavorite()`, `deleteFavorite()` methods
  - `src/backend/DevMode/EdogLogServer.cs` — Add `GET /api/favorites`, `POST /api/favorites`, `DELETE /api/favorites/{name}` endpoints
  - `src/frontend/css/workspace.css` — Favorites section styles (star icon, one-click deploy pill)
- **Files created:**
  - `edog-favorites.json` — Persisted favorites (gitignored)

### Technical Design

**Favorites data model:**

```json
{
  "favorites": [
    {
      "name": "My Dev Lakehouse",
      "workspaceId": "guid",
      "workspaceName": "EDOG-Dev-Workspace",
      "artifactId": "guid",
      "artifactName": "TestLakehouse-01",
      "capacityId": "guid",
      "tenantId": "guid",
      "createdAt": "2026-04-09T14:00:00Z"
    }
  ]
}
```

**Frontend — Tree panel favorites section:**

```
// In workspace-explorer.js
renderFavorites(favorites)           // Render FAVORITES section at top of tree
handleSaveAsFavorite(lakehouse)      // Prompt for name → POST /api/favorites
handleRemoveFavorite(name)           // DELETE /api/favorites/{name}
handleDeployFavorite(favorite)       // One-click deploy (same as Feature 2)
```

**Backend — `EdogLogServer.cs`:**

```csharp
GET  /api/favorites                  // Read edog-favorites.json
POST /api/favorites                  // Append to favorites array
DELETE /api/favorites/{name}         // Remove by name
```

File location: same directory as `edog-config.json`. EdogLogServer reads config path on startup.

### Acceptance Criteria

- [ ] Right-click context menu on lakehouses shows "Save as Favorite"
- [ ] Saving prompts for a display name (pre-filled with lakehouse name)
- [ ] FAVORITES section appears at top of the workspace tree with star (★) icon
- [ ] Each favorite shows: name, workspace name (dimmed), one-click Deploy button
- [ ] Clicking Deploy on a favorite triggers the full deploy flow (Feature 2)
- [ ] Favorites persist across browser refreshes and service restarts
- [ ] Favorites stored in `edog-favorites.json` on disk (not localStorage)
- [ ] Duplicate names are rejected with inline validation message
- [ ] Delete favorite with right-click → "Remove from Favorites" (no confirmation needed)
- [ ] Maximum 20 favorites (UI shows message if limit reached)

### Dependencies

- **Feature 1 (Workspace Explorer):** Tree panel must exist
- **Feature 2 (Deploy to Lakehouse):** Deploy flow must work for one-click deploy from favorites

### Risks

| Risk | Mitigation |
|------|------------|
| Favorites file gets corrupted | Validate JSON on read. If corrupt, rename to `.bak` and start fresh. |
| Stale favorites (lakehouse deleted) | Graceful error on deploy attempt. Offer to remove the favorite. |

### Moonshot Vision

V2+: Shared team favorites via git-tracked file. Favorite groups (dev / staging / prod). Auto-detect most-used lakehouses and suggest saving as favorite.

