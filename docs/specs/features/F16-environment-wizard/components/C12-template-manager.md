# C12-TemplateManager — P1 Component Deep Spec

> **Feature**: F16 Environment Wizard
> **Component**: C12-TemplateManager
> **Spec Level**: P1 (Component Deep Spec)
> **Status**: Draft
> **Agents**: Vex (backend persistence, Python handler) + Pixel (frontend UI, dialogs)
> **Complexity**: MEDIUM — Reuses existing file I/O patterns; new save/load/delete UI
> **Last Updated**: 2025-07-15

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Model](#2-data-model)
3. [API Surface](#3-api-surface)
4. [State Machine](#4-state-machine)
5. [Scenarios](#5-scenarios)
6. [Visual Spec](#6-visual-spec)
7. [Keyboard & Accessibility](#7-keyboard--accessibility)
8. [Error Handling](#8-error-handling)
9. [Performance](#9-performance)
10. [Implementation Notes](#10-implementation-notes)

---

## 1. Overview

### 1.1 Purpose

C12-TemplateManager is the persistence subsystem for the F16 Environment Wizard. It allows
users to **save**, **load**, and **delete** named wizard templates — complete snapshots of
the wizard state including DAG topology, workspace/lakehouse/notebook names, selected theme,
selected schemas, and node configuration.

Templates enable users to:
- **Reuse** a proven environment layout across projects without re-entering configuration
- **Share** environment blueprints by copying the template file between project directories
- **Iterate** on complex DAG topologies by saving intermediate states as named checkpoints
- **Recover** from accidental wizard closure by loading the last saved template

### 1.2 Scope

C12 owns:
- The on-disk template storage format (`edog-templates.json`)
- All backend routes for CRUD operations on templates
- The frontend `TemplateManager` class that mediates between UI and backend
- The "Save Template" naming dialog (triggered from C9-ReviewSummary)
- The "Load Template" list dialog (triggered from Page 1-InfraSetupPage)
- The "Delete Template" confirmation dialog (triggered from the template list)
- Template name validation rules
- Version compatibility checks on load

C12 does NOT own:
- The wizard state itself (owned by C1-WizardShell's state store)
- The DAG canvas rendering (owned by C4-DagCanvas)
- The review summary UI (owned by C9-ReviewSummary)
- The infrastructure setup page UI (owned by Page 1-InfraSetupPage)
- The final deploy/generate action (owned by C10-DeployManager)

### 1.3 Dependencies

| Dependency | Direction | Interface |
|-----------|-----------|-----------|
| C1-WizardShell | C12 reads/writes | `wizardShell.getState()` / `wizardShell.setState(template)` |
| C4-DagCanvas | C12 reads | `dagCanvas.exportTopology()` returns nodes + connections |
| C9-ReviewSummary | C12 triggered by | "Save as Template" button click event |
| Page 1-InfraSetupPage | C12 triggered by | "Load Template" button click event |
| Backend HTTP server | C12 calls | 4 REST-style routes on port 5555 |
| `edog-templates.json` | C12 owns | On-disk JSON file in project root |

### 1.4 Design Principles

1. **Project-local templates** — Templates live in the project directory, not globally.
   This ensures templates travel with the project and reference schemas/names that exist
   in context.

2. **Atomic writes** — All file mutations use the existing `_atomic_write()` pattern
   (tempfile + `os.replace`) to prevent corruption on crash or power loss.

3. **Separate storage file** — Templates are stored in `edog-templates.json`, NOT in
   `edog-config.json`. This separates the concern of configuration (what the project IS)
   from templates (what the project COULD BE). It also avoids bloating the config file
   with potentially large DAG snapshots.

4. **Action-based routes** — Following the existing codebase convention of action-based
   paths (`/api/templates/list`, `/api/templates/save`) rather than pure REST
   (`GET /api/templates`, `POST /api/templates`). This matches the `if/elif` routing
   pattern in `do_GET()` / `do_POST()`.

5. **No emoji** — All UI elements use Unicode symbols (●, ▸, ◆, ✕, ⋯) per project
   convention.

---
## 2. Data Model

### 2.1 Template File: `edog-templates.json`

The template file lives at `{project_root}/edog-templates.json`. It is a single JSON file
containing an array of template objects. This flat-file approach was chosen over a directory
of individual files because:
- Simpler atomic operations (one file to lock/write)
- Easier to copy/share (single file)
- Template count is expected to be small (< 50 per project)
- No need for streaming/partial reads

#### 2.1.1 Top-Level Schema

```json
{
  "$schema": "https://edog-studio.dev/schemas/templates-v1.json",
  "version": 1,
  "templates": [
    { /* ...TemplateObject... */ }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `$schema` | `string` | No | Optional schema URL for editor intellisense. Ignored by runtime. |
| `version` | `integer` | Yes | Schema version. Current: `1`. Used for forward-compatibility migration. |
| `templates` | `TemplateObject[]` | Yes | Array of saved templates. May be empty `[]`. |

#### 2.1.2 TemplateObject Schema

```json
{
  "id": "tmpl_1720000000000_a1b2c3",
  "name": "My Production Layout",
  "description": "",
  "createdAt": "2025-07-15T10:30:00.000Z",
  "updatedAt": "2025-07-15T14:22:00.000Z",
  "version": 1,
  "metadata": {
    "nodeCount": 12,
    "connectionCount": 11,
    "themeId": "midnight",
    "schemaNames": ["dbo", "bronze", "silver", "gold"],
    "wizardVersion": "0.1.0"
  },
  "state": {
    "infrastructure": {
      "workspaceName": "analytics-ws",
      "lakehouseName": "main-lakehouse",
      "notebookName": "etl-notebook"
    },
    "schemas": {
      "primary": "dbo",
      "medallion": ["bronze", "silver", "gold"]
    },
    "theme": {
      "id": "midnight",
      "customOverrides": {}
    },
    "dag": {
      "nodes": [
        {
          "id": "node_1720000000001",
          "name": "customers",
          "type": "source",
          "schema": "dbo",
          "position": { "x": 100, "y": 200 },
          "config": {
            "columns": ["id", "name", "email"],
            "primaryKey": "id"
          }
        }
      ],
      "connections": [
        {
          "id": "conn_1720000000001",
          "sourceNodeId": "node_1720000000001",
          "targetNodeId": "node_1720000000002",
          "sourcePort": "output",
          "targetPort": "input"
        }
      ],
      "viewport": {
        "x": 0,
        "y": 0,
        "zoom": 1.0
      }
    }
  }
}
```

#### 2.1.3 Field-by-Field Specification

##### Identity Fields

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `id` | `string` | Yes | Pattern: `tmpl_{timestamp}_{random6}` | Globally unique identifier. Generated on save, never changes. |
| `name` | `string` | Yes | 1-64 chars, filesystem-safe (see §2.3) | User-visible display name. Must be unique within the file. |
| `description` | `string` | No | 0-256 chars | Optional user-provided description. Defaults to empty string. |
| `createdAt` | `string` | Yes | ISO 8601 UTC | Timestamp of initial creation. Never changes after first save. |
| `updatedAt` | `string` | Yes | ISO 8601 UTC | Timestamp of most recent update. Updated on every save-over. |
| `version` | `integer` | Yes | >= 1 | Template schema version. Used for migration on load. |

##### Metadata Fields (Denormalized for List Display)

The `metadata` block contains denormalized summary data that can be displayed in the
template list without parsing the full `state` object. These fields are computed on save
and are read-only (never edited directly).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `metadata.nodeCount` | `integer` | Yes | Total number of DAG nodes. |
| `metadata.connectionCount` | `integer` | Yes | Total number of DAG connections. |
| `metadata.themeId` | `string` | Yes | ID of the selected theme. |
| `metadata.schemaNames` | `string[]` | Yes | List of schema names used (e.g., `["dbo", "bronze"]`). |
| `metadata.wizardVersion` | `string` | Yes | Version of the wizard that created this template. For migration. |

##### State Fields (Full Wizard Snapshot)

The `state` block is a complete snapshot of the wizard state at save time. On load, this
entire block is passed to `wizardShell.setState()` to restore the wizard to the saved state.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `state.infrastructure` | `object` | Yes | Workspace, lakehouse, and notebook names. |
| `state.infrastructure.workspaceName` | `string` | Yes | Fabric workspace name. |
| `state.infrastructure.lakehouseName` | `string` | Yes | Lakehouse name within workspace. |
| `state.infrastructure.notebookName` | `string` | Yes | Notebook name for generated code. |
| `state.schemas` | `object` | Yes | Selected schema configuration. |
| `state.schemas.primary` | `string` | Yes | Primary schema (always `"dbo"`). |
| `state.schemas.medallion` | `string[]` | Yes | Optional medallion schemas. May be empty `[]`. |
| `state.theme` | `object` | Yes | Theme selection and customizations. |
| `state.theme.id` | `string` | Yes | Theme identifier (e.g., `"midnight"`, `"arctic"`, `"forest"`). |
| `state.theme.customOverrides` | `object` | No | User-modified theme tokens. Defaults to `{}`. |
| `state.dag` | `object` | Yes | Complete DAG topology snapshot. |
| `state.dag.nodes` | `NodeObject[]` | Yes | Array of all DAG nodes. May be empty `[]`. |
| `state.dag.connections` | `ConnectionObject[]` | Yes | Array of all DAG connections. May be empty `[]`. |
| `state.dag.viewport` | `ViewportObject` | Yes | Canvas pan/zoom state for restoration. |

##### NodeObject Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique node identifier within the DAG. |
| `name` | `string` | Yes | User-visible node name (e.g., table name). |
| `type` | `string` | Yes | Node type: `"source"`, `"transform"`, `"sink"`, `"lookup"`. |
| `schema` | `string` | Yes | Schema this node belongs to. |
| `position` | `{x: number, y: number}` | Yes | Canvas coordinates (px). |
| `config` | `object` | No | Type-specific configuration. Shape varies by `type`. |

##### ConnectionObject Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique connection identifier. |
| `sourceNodeId` | `string` | Yes | ID of the source node. |
| `targetNodeId` | `string` | Yes | ID of the target node. |
| `sourcePort` | `string` | Yes | Output port name on source node. |
| `targetPort` | `string` | Yes | Input port name on target node. |

##### ViewportObject Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `x` | `number` | Yes | Horizontal pan offset (px). |
| `y` | `number` | Yes | Vertical pan offset (px). |
| `zoom` | `number` | Yes | Zoom level. Range: `0.25` to `4.0`. Default: `1.0`. |

### 2.2 Template ID Generation

Template IDs follow the pattern `tmpl_{timestamp}_{random6}`:

```
tmpl_1720000000000_a1b2c3
^^^^  ^^^^^^^^^^^^^  ^^^^^^
|     |              |
|     |              +-- 6 random hex chars (collision avoidance)
|     +-- Unix timestamp in milliseconds (sortable)
+-- Prefix (identifies as template)
```

**Frontend generation** (JavaScript):
```javascript
function generateTemplateId() {
  const timestamp = Date.now();
  const random = Math.random().toString(16).substring(2, 8);
  return `tmpl_${timestamp}_${random}`;
}
```

**Why not UUID?** Template IDs need to be:
- Human-scannable in JSON files (UUIDs are not)
- Sortable by creation time (UUIDs v4 are not)
- Short enough for display in lists
- Unique enough for a single project (collision probability with 6 hex chars +
  millisecond timestamp is negligible for < 10,000 templates)

### 2.3 Template Name Validation Rules

Template names are validated on the frontend before submission and re-validated on the
backend before persistence.

#### Constraints

| Rule | Constraint | Reason |
|------|-----------|--------|
| Non-empty | `name.trim().length >= 1` | Prevent blank names |
| Max length | `name.length <= 64` | Prevent absurdly long names in UI |
| Filesystem-safe | No chars from set: `/ \ : * ? " < > \|` | Names may be used in file exports |
| No leading/trailing dots | `!name.startsWith('.') && !name.endsWith('.')` | Avoid hidden files on Unix |
| No leading/trailing spaces | `name === name.trim()` | Prevent invisible-name confusion |
| Unique within file | No other template has same name (case-insensitive) | Prevent ambiguous references |

#### Validation Function (Pseudocode)

```javascript
const FORBIDDEN_CHARS = /[\/\\:*?"<>|]/;
const MAX_NAME_LENGTH = 64;

function validateTemplateName(name, existingNames, currentTemplateId = null) {
  const trimmed = name.trim();
  const errors = [];

  if (trimmed.length === 0) {
    errors.push('Template name cannot be empty');
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    errors.push(`Template name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  if (FORBIDDEN_CHARS.test(trimmed)) {
    errors.push('Template name contains invalid characters');
  }
  if (trimmed.startsWith('.') || trimmed.endsWith('.')) {
    errors.push('Template name cannot start or end with a dot');
  }

  // Case-insensitive uniqueness check (exclude self when editing)
  const duplicate = existingNames.find(
    existing => existing.name.toLowerCase() === trimmed.toLowerCase()
      && existing.id !== currentTemplateId
  );
  if (duplicate) {
    errors.push(`A template named "${duplicate.name}" already exists`);
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized: trimmed
  };
}
```

### 2.4 Version Migration Strategy

The `version` field at both the file level and template level enables forward compatibility.
When a newer version of EDOG Studio encounters an older template format, it applies
migrations in sequence:

```
v1 -> v2 -> v3 -> ... -> current
```

**Migration rules:**
- Migrations are pure functions: `(oldTemplate) => newTemplate`
- Migrations never delete user data — they only add/restructure fields
- If a template's version is higher than the running code's version, the load is
  **rejected** with a clear error message ("This template was created with a newer
  version of EDOG Studio")
- The file-level `version` is the minimum version of any template in the file
- On save, templates are always written at the current version

```javascript
const CURRENT_VERSION = 1;

const MIGRATIONS = {
  // 1 -> 2: Example future migration
  // 2: (template) => ({
  //   ...template,
  //   version: 2,
  //   state: {
  //     ...template.state,
  //     newField: defaultValue
  //   }
  // })
};

function migrateTemplate(template) {
  let current = { ...template };
  while (current.version < CURRENT_VERSION) {
    const migrator = MIGRATIONS[current.version + 1];
    if (!migrator) {
      throw new Error(
        `No migration path from v${current.version} to v${current.version + 1}`
      );
    }
    current = migrator(current);
  }
  return current;
}
```

### 2.5 File Lifecycle

| Event | File State |
|-------|------------|
| First template save (file doesn't exist) | File created with `version: 1, templates: [newTemplate]` |
| Subsequent saves (new template) | Template appended to `templates` array |
| Save-over existing template | Existing template replaced in-place, `updatedAt` updated |
| Delete last template | File remains with `templates: []` (never deleted) |
| File manually deleted by user | Next list returns empty; next save recreates file |
| File contains invalid JSON | Error surfaced to user; no silent data loss |

---
## 3. API Surface

### 3.1 Backend Routes

All routes are served by the EDOG Studio Python HTTP server on port 5555. Routes follow
the existing action-based path convention used throughout the codebase.

#### 3.1.1 List Templates

**Endpoint**: `GET /api/templates/list`

Returns all saved templates with metadata for list display. Does NOT return the full
`state` object (which can be large) — only identity and metadata fields.

**Request**:
```http
GET /api/templates/list HTTP/1.1
Host: localhost:5555
```

No query parameters. No request body.

**Response (200 OK)**:
```json
{
  "ok": true,
  "templates": [
    {
      "id": "tmpl_1720000000000_a1b2c3",
      "name": "My Production Layout",
      "description": "",
      "createdAt": "2025-07-15T10:30:00.000Z",
      "updatedAt": "2025-07-15T14:22:00.000Z",
      "version": 1,
      "metadata": {
        "nodeCount": 12,
        "connectionCount": 11,
        "themeId": "midnight",
        "schemaNames": ["dbo", "bronze", "silver", "gold"],
        "wizardVersion": "0.1.0"
      }
    }
  ]
}
```

**Response (200 OK — no templates)**:
```json
{
  "ok": true,
  "templates": []
}
```

Note: Returns `200` with empty array even if the template file doesn't exist. The file
is created lazily on first save, not on first list.

**Response (500 — file corrupt)**:
```json
{
  "ok": false,
  "error": "TEMPLATE_FILE_CORRUPT",
  "message": "The template file is corrupted and could not be parsed. A backup has been created at edog-templates.json.bak"
}
```

**Backend handler pseudocode**:
```python
def handle_templates_list(self):
    """GET /api/templates/list"""
    templates_path = self.project_root / "edog-templates.json"

    if not templates_path.exists():
        return self._json_response({"ok": True, "templates": []})

    try:
        data = json.loads(templates_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        # Create backup of corrupt file
        backup_path = templates_path.with_suffix(".json.bak")
        shutil.copy2(templates_path, backup_path)
        return self._json_response({
            "ok": False,
            "error": "TEMPLATE_FILE_CORRUPT",
            "message": f"The template file is corrupted and could not be parsed. "
                       f"A backup has been created at {backup_path.name}"
        }, status=500)

    # Strip state from list response (too large for listing)
    summaries = []
    for tmpl in data.get("templates", []):
        summary = {k: v for k, v in tmpl.items() if k != "state"}
        summaries.append(summary)

    return self._json_response({"ok": True, "templates": summaries})
```

---

#### 3.1.2 Load Template

**Endpoint**: `GET /api/templates/load?name={encodedName}`

Returns a single template by name, INCLUDING the full `state` object for wizard restoration.

**Request**:
```http
GET /api/templates/load?name=My%20Production%20Layout HTTP/1.1
Host: localhost:5555
```

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `name` | Query string | `string` | Yes | URL-encoded template name |

**Response (200 OK)**:
```json
{
  "ok": true,
  "template": {
    "id": "tmpl_1720000000000_a1b2c3",
    "name": "My Production Layout",
    "description": "",
    "createdAt": "2025-07-15T10:30:00.000Z",
    "updatedAt": "2025-07-15T14:22:00.000Z",
    "version": 1,
    "metadata": { "..." : "..." },
    "state": {
      "infrastructure": { "..." : "..." },
      "schemas": { "..." : "..." },
      "theme": { "..." : "..." },
      "dag": { "..." : "..." }
    }
  }
}
```

**Response (404 — template not found)**:
```json
{
  "ok": false,
  "error": "TEMPLATE_NOT_FOUND",
  "message": "No template named 'My Production Layout' was found"
}
```

**Response (409 — version too new)**:
```json
{
  "ok": false,
  "error": "TEMPLATE_VERSION_TOO_NEW",
  "message": "This template was created with a newer version of EDOG Studio (v3). Please update to load it.",
  "templateVersion": 3,
  "currentVersion": 1
}
```

**Backend handler pseudocode**:
```python
def handle_templates_load(self):
    """GET /api/templates/load?name=..."""
    from urllib.parse import parse_qs, urlparse
    parsed = urlparse(self.path)
    params = parse_qs(parsed.query)
    name = params.get("name", [None])[0]

    if not name:
        return self._json_response({
            "ok": False,
            "error": "MISSING_PARAMETER",
            "message": "Query parameter 'name' is required"
        }, status=400)

    templates_path = self.project_root / "edog-templates.json"
    if not templates_path.exists():
        return self._json_response({
            "ok": False,
            "error": "TEMPLATE_NOT_FOUND",
            "message": f"No template named '{name}' was found"
        }, status=404)

    data = json.loads(templates_path.read_text(encoding="utf-8"))
    template = next(
        (t for t in data.get("templates", [])
         if t["name"].lower() == name.lower()),
        None
    )

    if template is None:
        return self._json_response({
            "ok": False,
            "error": "TEMPLATE_NOT_FOUND",
            "message": f"No template named '{name}' was found"
        }, status=404)

    # Version check
    if template.get("version", 1) > CURRENT_TEMPLATE_VERSION:
        return self._json_response({
            "ok": False,
            "error": "TEMPLATE_VERSION_TOO_NEW",
            "message": (
                f"This template was created with a newer version of "
                f"EDOG Studio (v{template['version']}). Please update to load it."
            ),
            "templateVersion": template["version"],
            "currentVersion": CURRENT_TEMPLATE_VERSION
        }, status=409)

    # Apply migrations if needed
    migrated = migrate_template(template)

    return self._json_response({"ok": True, "template": migrated})
```

---

#### 3.1.3 Save Template

**Endpoint**: `POST /api/templates/save`

Saves a new template or overwrites an existing one. If a template with the same name
(case-insensitive) already exists and `overwrite` is `false`, returns a conflict error.

**Request**:
```http
POST /api/templates/save HTTP/1.1
Host: localhost:5555
Content-Type: application/json

{
  "name": "My Production Layout",
  "description": "Standard 3-tier medallion architecture",
  "overwrite": false,
  "state": {
    "infrastructure": {
      "workspaceName": "analytics-ws",
      "lakehouseName": "main-lakehouse",
      "notebookName": "etl-notebook"
    },
    "schemas": {
      "primary": "dbo",
      "medallion": ["bronze", "silver", "gold"]
    },
    "theme": {
      "id": "midnight",
      "customOverrides": {}
    },
    "dag": {
      "nodes": [ "..." ],
      "connections": [ "..." ],
      "viewport": { "x": 0, "y": 0, "zoom": 1.0 }
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Template display name. Validated per §2.3 rules. |
| `description` | `string` | No | Optional description. Max 256 chars. |
| `overwrite` | `boolean` | No | If `true`, overwrites existing template with same name. Default: `false`. |
| `state` | `object` | Yes | Complete wizard state snapshot (see §2.1.2). |

**Response (201 Created — new template)**:
```json
{
  "ok": true,
  "template": {
    "id": "tmpl_1720000000000_a1b2c3",
    "name": "My Production Layout",
    "createdAt": "2025-07-15T10:30:00.000Z",
    "updatedAt": "2025-07-15T10:30:00.000Z",
    "version": 1,
    "metadata": {
      "nodeCount": 12,
      "connectionCount": 11,
      "themeId": "midnight",
      "schemaNames": ["dbo", "bronze", "silver", "gold"],
      "wizardVersion": "0.1.0"
    }
  },
  "created": true
}
```

**Response (200 OK — overwrite)**:
```json
{
  "ok": true,
  "template": { "...same as above with updated updatedAt..." },
  "created": false
}
```

**Response (409 — name conflict, overwrite=false)**:
```json
{
  "ok": false,
  "error": "TEMPLATE_NAME_EXISTS",
  "message": "A template named 'My Production Layout' already exists. Set overwrite=true to replace it.",
  "existingTemplate": {
    "id": "tmpl_1720000000000_a1b2c3",
    "name": "My Production Layout",
    "updatedAt": "2025-07-15T10:30:00.000Z"
  }
}
```

**Response (400 — validation error)**:
```json
{
  "ok": false,
  "error": "VALIDATION_ERROR",
  "message": "Template name contains invalid characters",
  "details": [
    "Template name contains invalid characters: /"
  ]
}
```

**Backend handler pseudocode**:
```python
def handle_templates_save(self):
    """POST /api/templates/save"""
    body = self._read_json_body()

    name = body.get("name", "").strip()
    description = body.get("description", "")
    overwrite = body.get("overwrite", False)
    state = body.get("state")

    # Validate name
    errors = validate_template_name(name)
    if errors:
        return self._json_response({
            "ok": False,
            "error": "VALIDATION_ERROR",
            "message": errors[0],
            "details": errors
        }, status=400)

    if not state:
        return self._json_response({
            "ok": False,
            "error": "VALIDATION_ERROR",
            "message": "Template state is required"
        }, status=400)

    templates_path = self.project_root / "edog-templates.json"

    # Load or initialize
    if templates_path.exists():
        data = json.loads(templates_path.read_text(encoding="utf-8"))
    else:
        data = {"version": CURRENT_TEMPLATE_VERSION, "templates": []}

    templates = data.get("templates", [])

    # Check for name conflict
    existing_idx = next(
        (i for i, t in enumerate(templates)
         if t["name"].lower() == name.lower()),
        None
    )

    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")

    # Compute metadata from state
    dag = state.get("dag", {})
    metadata = {
        "nodeCount": len(dag.get("nodes", [])),
        "connectionCount": len(dag.get("connections", [])),
        "themeId": state.get("theme", {}).get("id", "default"),
        "schemaNames": _extract_schema_names(state),
        "wizardVersion": WIZARD_VERSION,
    }

    if existing_idx is not None:
        if not overwrite:
            existing = templates[existing_idx]
            return self._json_response({
                "ok": False,
                "error": "TEMPLATE_NAME_EXISTS",
                "message": f"A template named '{existing['name']}' already exists. "
                           f"Set overwrite=true to replace it.",
                "existingTemplate": {
                    "id": existing["id"],
                    "name": existing["name"],
                    "updatedAt": existing["updatedAt"],
                }
            }, status=409)

        # Overwrite: preserve id and createdAt
        existing = templates[existing_idx]
        template = {
            "id": existing["id"],
            "name": name,
            "description": description[:256],
            "createdAt": existing["createdAt"],
            "updatedAt": now,
            "version": CURRENT_TEMPLATE_VERSION,
            "metadata": metadata,
            "state": state,
        }
        templates[existing_idx] = template
        created = False
    else:
        # New template
        template_id = f"tmpl_{int(time.time() * 1000)}_{secrets.token_hex(3)}"
        template = {
            "id": template_id,
            "name": name,
            "description": description[:256],
            "createdAt": now,
            "updatedAt": now,
            "version": CURRENT_TEMPLATE_VERSION,
            "metadata": metadata,
            "state": state,
        }
        templates.append(template)
        created = True

    data["templates"] = templates
    _atomic_write(templates_path, json.dumps(data, indent=2))

    # Strip state from response (caller already has it)
    response_template = {k: v for k, v in template.items() if k != "state"}
    return self._json_response({
        "ok": True,
        "template": response_template,
        "created": created
    }, status=201 if created else 200)
```

---

#### 3.1.4 Delete Template

**Endpoint**: `POST /api/templates/delete`

Deletes a template by name. Uses POST (not DELETE) to match the existing codebase pattern
of action-based paths with POST bodies.

**Request**:
```http
POST /api/templates/delete HTTP/1.1
Host: localhost:5555
Content-Type: application/json

{
  "name": "My Production Layout"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Name of the template to delete (case-insensitive match). |

**Response (200 OK)**:
```json
{
  "ok": true,
  "deleted": true,
  "name": "My Production Layout"
}
```

**Response (404 — not found)**:
```json
{
  "ok": false,
  "error": "TEMPLATE_NOT_FOUND",
  "message": "No template named 'My Production Layout' was found"
}
```

**Backend handler pseudocode**:
```python
def handle_templates_delete(self):
    """POST /api/templates/delete"""
    body = self._read_json_body()
    name = body.get("name", "").strip()

    if not name:
        return self._json_response({
            "ok": False,
            "error": "MISSING_PARAMETER",
            "message": "Template name is required"
        }, status=400)

    templates_path = self.project_root / "edog-templates.json"
    if not templates_path.exists():
        return self._json_response({
            "ok": False,
            "error": "TEMPLATE_NOT_FOUND",
            "message": f"No template named '{name}' was found"
        }, status=404)

    data = json.loads(templates_path.read_text(encoding="utf-8"))
    templates = data.get("templates", [])

    original_count = len(templates)
    templates = [
        t for t in templates
        if t["name"].lower() != name.lower()
    ]

    if len(templates) == original_count:
        return self._json_response({
            "ok": False,
            "error": "TEMPLATE_NOT_FOUND",
            "message": f"No template named '{name}' was found"
        }, status=404)

    data["templates"] = templates
    _atomic_write(templates_path, json.dumps(data, indent=2))

    return self._json_response({
        "ok": True,
        "deleted": True,
        "name": name
    })
```

---

### 3.2 Frontend API: TemplateManager Class

The `TemplateManager` class is the frontend interface for all template operations. It
mediates between UI components and the backend HTTP API.

#### 3.2.1 Constructor

```javascript
class TemplateManager {
  /**
   * @param {object} options
   * @param {string} options.baseUrl - Backend URL (default: 'http://localhost:5555')
   * @param {WizardShell} options.wizardShell - Reference to wizard state manager
   * @param {DagCanvas} options.dagCanvas - Reference to DAG canvas component
   * @param {EventBus} options.eventBus - Application event bus
   */
  constructor({ baseUrl, wizardShell, dagCanvas, eventBus }) {
    this._baseUrl = baseUrl || 'http://localhost:5555';
    this._wizardShell = wizardShell;
    this._dagCanvas = dagCanvas;
    this._eventBus = eventBus;
    this._state = 'idle'; // See §4 State Machine
    this._templates = []; // Cached template list (metadata only)
    this._lastError = null;
  }
}
```

#### 3.2.2 Public Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `listTemplates` | `() => Promise<TemplateSummary[]>` | Array of template summaries (no state) | Fetches template list from backend. Updates internal cache. |
| `loadTemplate` | `(name: string) => Promise<TemplateObject>` | Full template with state | Loads a template by name. Does NOT apply it — caller decides. |
| `saveTemplate` | `(name: string, options?: SaveOptions) => Promise<SaveResult>` | Save result with created/updated flag | Collects current wizard state and saves as named template. |
| `deleteTemplate` | `(name: string) => Promise<void>` | void | Deletes a template by name. |
| `applyTemplate` | `(template: TemplateObject) => void` | void | Applies a loaded template to the wizard state. |
| `getState` | `() => string` | Current state machine state | Returns current state (idle, loading, saving, etc.) |
| `getCachedList` | `() => TemplateSummary[]` | Cached template list | Returns last-fetched template list without network call. |
| `validateName` | `(name: string) => ValidationResult` | Validation result | Validates a template name against §2.3 rules. |
| `destroy` | `() => void` | void | Cleans up event listeners and references. |

#### 3.2.3 SaveOptions Type

```typescript
interface SaveOptions {
  description?: string;  // Optional template description (max 256 chars)
  overwrite?: boolean;   // Overwrite existing template with same name (default: false)
}
```

#### 3.2.4 Events

The `TemplateManager` emits events through the shared `EventBus`:

| Event | Payload | When |
|-------|---------|------|
| `template:list-loaded` | `{ templates: TemplateSummary[] }` | Template list successfully fetched |
| `template:saved` | `{ template: TemplateSummary, created: boolean }` | Template successfully saved |
| `template:loaded` | `{ template: TemplateObject }` | Template data successfully loaded from backend |
| `template:applied` | `{ templateName: string }` | Template applied to wizard state |
| `template:deleted` | `{ name: string }` | Template successfully deleted |
| `template:error` | `{ error: string, code: string, context: string }` | Any operation failed |
| `template:state-changed` | `{ from: string, to: string }` | State machine transition |

#### 3.2.5 Method Implementations

```javascript
async listTemplates() {
  this._transition('loading-list');
  try {
    const response = await fetch(`${this._baseUrl}/api/templates/list`);
    const data = await response.json();
    if (!data.ok) {
      throw new TemplateError(data.error, data.message);
    }
    this._templates = data.templates;
    this._eventBus.emit('template:list-loaded', { templates: data.templates });
    this._transition('idle');
    return data.templates;
  } catch (err) {
    this._handleError(err, 'listTemplates');
    throw err;
  }
}

async loadTemplate(name) {
  this._transition('loading-template');
  try {
    const encoded = encodeURIComponent(name);
    const response = await fetch(
      `${this._baseUrl}/api/templates/load?name=${encoded}`
    );
    const data = await response.json();
    if (!data.ok) {
      throw new TemplateError(data.error, data.message);
    }
    this._eventBus.emit('template:loaded', { template: data.template });
    this._transition('idle');
    return data.template;
  } catch (err) {
    this._handleError(err, 'loadTemplate');
    throw err;
  }
}

async saveTemplate(name, options = {}) {
  this._transition('saving');
  try {
    // Collect current wizard state
    const state = this._collectWizardState();
    const response = await fetch(`${this._baseUrl}/api/templates/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: options.description || '',
        overwrite: options.overwrite || false,
        state,
      }),
    });
    const data = await response.json();
    if (!data.ok) {
      throw new TemplateError(data.error, data.message);
    }
    // Refresh cached list
    await this.listTemplates();
    this._eventBus.emit('template:saved', {
      template: data.template,
      created: data.created,
    });
    this._transition('idle');
    return data;
  } catch (err) {
    this._handleError(err, 'saveTemplate');
    throw err;
  }
}

async deleteTemplate(name) {
  this._transition('deleting');
  try {
    const response = await fetch(`${this._baseUrl}/api/templates/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await response.json();
    if (!data.ok) {
      throw new TemplateError(data.error, data.message);
    }
    // Remove from cache
    this._templates = this._templates.filter(
      t => t.name.toLowerCase() !== name.toLowerCase()
    );
    this._eventBus.emit('template:deleted', { name });
    this._transition('idle');
  } catch (err) {
    this._handleError(err, 'deleteTemplate');
    throw err;
  }
}

applyTemplate(template) {
  const { state } = template;
  this._wizardShell.setState(state);
  this._eventBus.emit('template:applied', {
    templateName: template.name,
  });
}

/** @private */
_collectWizardState() {
  return {
    infrastructure: this._wizardShell.getInfrastructureState(),
    schemas: this._wizardShell.getSchemaState(),
    theme: this._wizardShell.getThemeState(),
    dag: this._dagCanvas.exportTopology(),
  };
}
```

---
## 4. State Machine

### 4.1 States

The TemplateManager uses a finite state machine to track its current operation and
prevent concurrent operations (e.g., saving while loading).

```
                            +--------+
                            |  idle  |<-----------+----------+-----------+
                            +---+----+            |          |           |
                                |                 |          |           |
           +----------+---------+---------+       |          |           |
           |          |         |         |       |          |           |
           v          v         v         v       |          |           |
     +---------+ +--------+ +-------+ +--------+ |          |           |
     | loading | | saving | | load- | | delet- | |          |           |
     |  -list  | |        | | ing-  | |  ing   | |          |           |
     |         | |        | | tmpl  | |        | |          |           |
     +----+----+ +---+----+ +--+----+ +---+----+ |          |           |
          |          |         |           |      |          |           |
          +-----+----+---------+-----------+      |          |           |
          |     |                                 |          |           |
          v     v                                 |          |           |
        success                                   |          |           |
          |     |                                 |          |           |
          +-----+---------------------------------+          |           |
          |                                                  |           |
          v                                                  |           |
        error -----------------------------------------------+           |
          |                                                              |
          +--- (auto-recover after 3s or user dismiss) ------------------+
```

### 4.2 State Definitions

| State | Description | Allowed Transitions | UI Effect |
|-------|-------------|--------------------|----|
| `idle` | No operation in progress | `loading-list`, `saving`, `loading-template`, `deleting` | Buttons enabled |
| `loading-list` | Fetching template list from backend | `idle`, `error` | List shows skeleton/spinner |
| `saving` | Saving template to backend | `idle`, `error` | Save button disabled + spinner |
| `loading-template` | Loading full template data | `idle`, `error` | List item shows loading indicator |
| `deleting` | Deleting template from backend | `idle`, `error` | Delete button disabled + spinner |
| `error` | Operation failed | `idle` | Error message displayed; auto-clears after 3s |

### 4.3 Transition Rules

```javascript
const VALID_TRANSITIONS = {
  'idle':             ['loading-list', 'saving', 'loading-template', 'deleting'],
  'loading-list':     ['idle', 'error'],
  'saving':           ['idle', 'error'],
  'loading-template': ['idle', 'error'],
  'deleting':         ['idle', 'error'],
  'error':            ['idle'],
};

/** @private */
_transition(newState) {
  const allowed = VALID_TRANSITIONS[this._state];
  if (!allowed || !allowed.includes(newState)) {
    console.warn(
      `[TemplateManager] Invalid transition: ${this._state} -> ${newState}`
    );
    return false;
  }
  const from = this._state;
  this._state = newState;
  this._eventBus.emit('template:state-changed', { from, to: newState });
  return true;
}
```

### 4.4 Concurrency Guard

Only one operation can be in progress at a time. If a method is called while the state
machine is not `idle`, the call is rejected with a clear error:

```javascript
_ensureIdle(operation) {
  if (this._state !== 'idle') {
    throw new TemplateError(
      'OPERATION_IN_PROGRESS',
      `Cannot ${operation} while ${this._state} is in progress`
    );
  }
}
```

Each public method calls `_ensureIdle()` before transitioning:

```javascript
async saveTemplate(name, options = {}) {
  this._ensureIdle('save');
  this._transition('saving');
  // ...
}
```

### 4.5 Error Auto-Recovery

When the state machine enters `error`, it automatically returns to `idle` after 3 seconds
unless the user dismisses the error earlier:

```javascript
_handleError(err, context) {
  this._lastError = {
    error: err.code || 'UNKNOWN_ERROR',
    message: err.message || 'An unexpected error occurred',
    context,
    timestamp: Date.now(),
  };
  this._transition('error');
  this._eventBus.emit('template:error', this._lastError);

  // Auto-recover to idle after 3 seconds
  this._errorTimeout = setTimeout(() => {
    if (this._state === 'error') {
      this._state = 'idle'; // Direct set to avoid validation
      this._eventBus.emit('template:state-changed', {
        from: 'error',
        to: 'idle',
      });
    }
  }, 3000);
}

dismissError() {
  clearTimeout(this._errorTimeout);
  if (this._state === 'error') {
    this._transition('idle');
    this._lastError = null;
  }
}
```

---
## 5. Scenarios

### 5.1 Save Template Flow

**Trigger**: User clicks "Save as Template" button on the C9-ReviewSummary page.

**Preconditions**:
- Wizard is on the Review page (page 5)
- At least one DAG node exists (empty templates are not useful)
- TemplateManager state is `idle`

**Flow**:

```
User clicks "Save as Template"
    |
    v
[1] Open Save Dialog
    - Focus moves to name input
    - If templates exist, show "or overwrite existing" dropdown
    |
    v
[2] User enters template name
    - Real-time validation (§2.3 rules)
    - Show character count (N/64)
    - Show validation errors inline
    |
    v
[3] User clicks "Save" button (or presses Enter)
    |
    +--[name invalid]---> Show validation error, keep dialog open
    |
    +--[name valid, unique]---> Continue to step 4
    |
    +--[name exists, overwrite not checked]---> Show conflict dialog:
    |   "A template named 'X' already exists (saved July 15, 2025)."
    |   [Cancel] [Overwrite]
    |       |
    |       +--[Cancel]---> Return to name input
    |       +--[Overwrite]---> Continue to step 4 with overwrite=true
    |
    v
[4] Collect wizard state
    - infrastructure = wizardShell.getInfrastructureState()
    - schemas = wizardShell.getSchemaState()
    - theme = wizardShell.getThemeState()
    - dag = dagCanvas.exportTopology()
    |
    v
[5] POST /api/templates/save
    - State transitions to 'saving'
    - Save button shows spinner
    - Dialog stays open (prevents re-click)
    |
    +--[success]---> Step 6
    +--[error]---> Step 7
    |
    v
[6] Success
    - Close save dialog
    - Show success toast: "Template 'X' saved" (auto-dismiss 3s)
    - Emit 'template:saved' event
    - State returns to 'idle'
    |
    v
[7] Error
    - Show error inline in dialog (NOT a toast — user needs to retry)
    - "Could not save template: {error message}"
    - Save button re-enabled
    - State returns to 'error', then auto-recovers to 'idle'
```

**Sequence Diagram**:

```
User          SaveDialog       TemplateManager      Backend         Filesystem
 |                |                  |                 |                |
 |--click Save--->|                  |                 |                |
 |                |--show dialog---->|                 |                |
 |--enter name--->|                  |                 |                |
 |                |--validateName()-->|                |                |
 |                |<--{valid:true}---|                 |                |
 |--click Save--->|                  |                 |                |
 |                |--saveTemplate()-->|                |                |
 |                |                  |--POST /save---->|                |
 |                |                  |                 |--read file---->|
 |                |                  |                 |<--JSON---------|
 |                |                  |                 |--atomic_write->|
 |                |                  |                 |<--ok-----------|
 |                |                  |<--{ok, tmpl}----|                |
 |                |<--close dialog---|                 |                |
 |<--toast--------|                  |                 |                |
```

### 5.2 Load Template Flow

**Trigger**: User clicks "Load Template" button on Page 1-InfraSetupPage.

**Preconditions**:
- Wizard is on page 1
- TemplateManager state is `idle`

**Flow**:

```
User clicks "Load Template"
    |
    v
[1] Fetch template list
    - GET /api/templates/list
    - State transitions to 'loading-list'
    - Show skeleton loader in dialog
    |
    +--[error]---> Show error in dialog: "Could not load templates"
    |              [Retry] [Close]
    |
    +--[empty list]---> Show empty state:
    |   "No saved templates yet."
    |   "Save your first template from the Review page."
    |   [Close]
    |
    +--[templates found]---> Continue to step 2
    |
    v
[2] Display template list
    - Each item shows: name, date, node count, theme badge
    - List is sorted by updatedAt (newest first)
    - Keyboard navigable (arrow keys)
    - Each item has [Load] and [Delete] buttons
    |
    v
[3] User selects a template and clicks [Load]
    |
    v
[4] Confirmation dialog (if wizard has unsaved changes)
    - "Loading a template will replace your current configuration."
    - "You have unsaved changes that will be lost."
    - [Cancel] [Load Anyway]
    |
    +--[Cancel]---> Return to template list
    +--[Load Anyway]---> Continue to step 5
    |
    v
[5] Fetch full template
    - GET /api/templates/load?name=...
    - State transitions to 'loading-template'
    - Selected list item shows loading spinner
    |
    +--[error]---> Show error toast, return to list
    +--[version too new]---> Show version error:
    |   "This template requires EDOG Studio vN. Please update."
    |   [Close]
    |
    +--[success]---> Continue to step 6
    |
    v
[6] Apply template
    - wizardShell.setState(template.state)
    - Close load dialog
    - Show success toast: "Template 'X' loaded"
    - Emit 'template:applied' event
    - Wizard remains on page 1 (user can navigate forward)
    |
    v
[7] Post-load validation
    - Check if template references schemas that don't exist
    - Check if node types are still supported
    - If issues found, show warning (not error):
      "Some elements may need attention after loading"
```

**Sequence Diagram**:

```
User          LoadDialog      TemplateManager      Backend         WizardShell
 |                |                 |                 |                |
 |--click Load--->|                 |                 |                |
 |                |--listTemplates->|                 |                |
 |                |                 |--GET /list----->|                |
 |                |                 |<--{templates}---|                |
 |                |<--show list-----|                 |                |
 |--select item-->|                 |                 |                |
 |--click Load--->|                 |                 |                |
 |                |--confirm?------>|                 |                |
 |--click Yes---->|                 |                 |                |
 |                |--loadTemplate-->|                 |                |
 |                |                 |--GET /load?---->|                |
 |                |                 |<--{template}----|                |
 |                |--applyTemplate->|                 |                |
 |                |                 |--setState()---->|                |
 |                |                 |                 |                |--restore
 |                |<--close---------|                 |                |
 |<--toast--------|                 |                 |                |
```

### 5.3 Delete Template Flow

**Trigger**: User clicks delete button (✕) on a template list item.

**Preconditions**:
- Template list dialog is open
- TemplateManager state is `idle`

**Flow**:

```
User clicks delete (✕) on template "X"
    |
    v
[1] Confirmation dialog
    - "Delete template 'X'?"
    - "This action cannot be undone."
    - [Cancel] [Delete]
    - Focus on [Cancel] (safe default)
    |
    +--[Cancel]---> Return to template list (no change)
    |
    +--[Delete]---> Continue to step 2
    |
    v
[2] POST /api/templates/delete
    - State transitions to 'deleting'
    - Delete button shows spinner
    - Template item faded/disabled
    |
    +--[success]---> Step 3
    +--[error]---> Show error toast, re-enable item
    |
    v
[3] Success
    - Remove item from list with slide-out animation (200ms)
    - Show success toast: "Template 'X' deleted"
    - If list is now empty, show empty state
    - Emit 'template:deleted' event
    - State returns to 'idle'
```

### 5.4 Edge Case Scenarios

#### 5.4.1 Corrupt Template File

**Scenario**: User manually edits `edog-templates.json` and introduces invalid JSON.

**Behavior**:
1. `GET /api/templates/list` returns 500 with `TEMPLATE_FILE_CORRUPT` error
2. Backend automatically creates backup at `edog-templates.json.bak`
3. UI shows error state: "Template file is corrupted. A backup was created."
4. User can:
   - Fix the file manually (tech-savvy users)
   - Delete `edog-templates.json` and start fresh (the backup preserves data)
   - Save a new template (which will recreate the file, overwriting the corrupt one)

**Important**: The backend NEVER silently deletes or overwrites a corrupt file. It always
creates a backup first.

#### 5.4.2 Template References Missing Schemas

**Scenario**: User loads a template that references schema "gold", but the current project
doesn't have a "gold" schema configured.

**Behavior**:
1. Template loads successfully (schemas are names, not hard references)
2. Post-load validation detects the missing schema
3. Warning toast: "Template references schemas not in current project: gold"
4. DAG nodes assigned to "gold" are displayed but marked with a warning indicator
5. User can reassign nodes to available schemas or add the missing schema

#### 5.4.3 Concurrent Wizard Sessions

**Scenario**: Two browser tabs have the wizard open, both editing templates.

**Behavior**:
- Each tab has its own `TemplateManager` instance
- File I/O uses `_atomic_write()` (tempfile + os.replace), so writes are atomic
- Last-write-wins semantics (no locking)
- The `listTemplates()` call always reads from disk, so it reflects the latest state
- No real-time sync between tabs (acceptable for local dev tool)

#### 5.4.4 Save During Network Interruption

**Scenario**: Backend server stops responding during a save operation.

**Behavior**:
1. `fetch()` throws a `TypeError` (network error) or times out
2. TemplateManager catches the error and transitions to `error` state
3. Save dialog shows: "Could not connect to EDOG Studio server. Is it running?"
4. No data loss — the template file is unchanged (atomic writes are all-or-nothing)
5. User can retry after restarting the server

#### 5.4.5 Empty DAG Save

**Scenario**: User tries to save a template with zero DAG nodes.

**Behavior**:
- **Allowed** — The save proceeds with `metadata.nodeCount: 0`
- Rationale: Users may want to save infrastructure/schema configuration without a DAG
- The template list shows "0 nodes" in the metadata, making it clear the template
  is infrastructure-only

#### 5.4.6 Very Large DAG

**Scenario**: User saves a template with 500+ nodes and 1000+ connections.

**Behavior**:
- Save proceeds normally (JSON serialization handles it)
- Template list still shows summaries (no state in list response)
- Load may take 1-2 seconds for very large templates (acceptable)
- No hard limit on node count — the real constraint is `edog-templates.json` file size
- If file exceeds 10MB, log a warning (but don't block)

#### 5.4.7 Template Name with Unicode

**Scenario**: User names a template "Mi Plantilla Espanola" or uses CJK characters.

**Behavior**:
- **Allowed** — The only forbidden characters are filesystem-unsafe ones (§2.3)
- Unicode names are stored as UTF-8 in JSON
- URL-encoded in query parameters (`GET /api/templates/load?name=...`)
- Display correctly in template list (UTF-8 throughout)

---
## 6. Visual Spec

### 6.1 Design Tokens

All C12 UI elements use the existing design system tokens. No new tokens are introduced.

```css
/* Colors (OKLCH) — from variables.css */
--surface-0: oklch(0.15 0.01 260);       /* Dialog background */
--surface-1: oklch(0.20 0.01 260);       /* List item background */
--surface-2: oklch(0.25 0.015 260);      /* List item hover */
--text-primary: oklch(0.92 0.01 260);    /* Primary text */
--text-secondary: oklch(0.65 0.01 260);  /* Secondary text (dates, counts) */
--accent: oklch(0.70 0.15 250);          /* Primary buttons, focus rings */
--danger: oklch(0.65 0.20 25);           /* Delete buttons, error states */
--border: oklch(0.30 0.01 260);          /* Subtle borders */

/* Spacing (4px grid) */
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;

/* Z-Index */
--z-wizard: 500;           /* Wizard overlay */
--z-dialog: 600;           /* Template dialogs (above wizard) */
--z-dialog-backdrop: 599;  /* Dialog backdrop */

/* Typography */
--font-mono: 'IBM Plex Mono', monospace;
--font-sans: 'Inter', system-ui, sans-serif;
--text-sm: 0.8125rem;   /* 13px */
--text-base: 0.875rem;  /* 14px */
--text-lg: 1rem;        /* 16px */
--text-xl: 1.25rem;     /* 20px */

/* Animation */
--duration-fast: 150ms;
--duration-normal: 200ms;
--duration-slow: 300ms;
--easing-default: cubic-bezier(0.4, 0, 0.2, 1);
```

### 6.2 Save Template Dialog

```
+---------------------------------------------------------------+
|  Save as Template                                        [✕]  |
+---------------------------------------------------------------+
|                                                               |
|  Template Name                                                |
|  +----------------------------------------------------------+|
|  | My Production Layout                              42/64  ||
|  +----------------------------------------------------------+|
|                                                               |
|  Description (optional)                                       |
|  +----------------------------------------------------------+|
|  | Standard 3-tier medallion architecture            28/256  ||
|  +----------------------------------------------------------+|
|                                                               |
|  Summary                                                      |
|  +---------------------------------------------------------+ |
|  | ◆ 12 nodes  ● 11 connections  ▸ midnight theme          | |
|  | ◆ Schemas: dbo, bronze, silver, gold                     | |
|  +---------------------------------------------------------+ |
|                                                               |
|                                      [Cancel]  [Save Template]|
+---------------------------------------------------------------+
```

**Layout specifications**:
- Dialog width: `480px` (fixed)
- Dialog max-height: `80vh` (with overflow scroll)
- Padding: `var(--space-6)` (24px)
- Title font: `var(--text-xl)` weight 600
- Input height: `40px` with `var(--space-3)` padding
- Character count: right-aligned, `var(--text-sm)`, `var(--text-secondary)` color
- Summary section: `var(--surface-1)` background, `var(--space-3)` padding, rounded 6px
- Button group: right-aligned, `var(--space-3)` gap
- Cancel: ghost button
- Save: primary button, accent background
- Backdrop: `oklch(0 0 0 / 0.5)` with `backdrop-filter: blur(4px)`
- Dialog appears with `opacity 0->1` and `scale(0.95)->scale(1)` over `--duration-normal`

**States**:
- **Saving**: Save button shows inline spinner, text changes to "Saving...", button disabled
- **Error**: Red error text below the name input with `var(--danger)` color
- **Name conflict**: Error text shows existing template date, "Overwrite?" checkbox appears

### 6.3 Load Template Dialog (Template List)

```
+---------------------------------------------------------------+
|  Load Template                                           [✕]  |
+---------------------------------------------------------------+
|                                                               |
|  +----------------------------------------------------------+|
|  | [Search templates...]                               [Q]  ||
|  +----------------------------------------------------------+|
|                                                               |
|  +----------------------------------------------------------+|
|  | My Production Layout                              [Load] ||
|  | July 15, 2025  ◆ 12 nodes  ▸ midnight                   ||
|  |                                                    [✕]   ||
|  +----------------------------------------------------------+|
|  | Quick Prototype                                   [Load] ||
|  | July 14, 2025  ◆ 3 nodes   ▸ arctic                     ||
|  |                                                    [✕]   ||
|  +----------------------------------------------------------+|
|  | Medallion Standard                                [Load] ||
|  | July 10, 2025  ◆ 8 nodes   ▸ forest                     ||
|  |                                                    [✕]   ||
|  +----------------------------------------------------------+|
|                                                               |
|                                                     [Cancel]  |
+---------------------------------------------------------------+
```

**Layout specifications**:
- Dialog width: `560px` (fixed)
- Dialog max-height: `70vh`
- Search input: full width, `40px` height, search icon left
- Template list: scrollable area, max 5 visible items before scroll
- List item height: `72px` (2 lines of content + padding)
- List item padding: `var(--space-4)` horizontal, `var(--space-3)` vertical
- List item hover: `var(--surface-2)` background, `--duration-fast` transition
- List item focus: `2px solid var(--accent)` outline, `-2px` offset
- Template name: `var(--text-base)` weight 500, `var(--text-primary)` color
- Metadata line: `var(--text-sm)`, `var(--text-secondary)` color
- Theme badge: inline pill with theme color dot, `var(--text-sm)`, rounded 99px
- Load button: ghost button, appears on hover/focus
- Delete button (✕): icon button, `var(--danger)` on hover, bottom-right of item
- Separator: `1px solid var(--border)` between items

**Empty state**:
```
+---------------------------------------------------------------+
|  Load Template                                           [✕]  |
+---------------------------------------------------------------+
|                                                               |
|              No saved templates yet.                          |
|                                                               |
|              Save your first template from                    |
|              the Review page (step 5).                        |
|                                                               |
|                                                     [Close]   |
+---------------------------------------------------------------+
```

- Empty state text: centered, `var(--text-secondary)`, `var(--text-base)`
- No search box shown when empty (unnecessary)

**Loading state**:
```
+---------------------------------------------------------------+
|  Load Template                                           [✕]  |
+---------------------------------------------------------------+
|                                                               |
|  +----------------------------------------------------------+|
|  | ████████████████████                                      ||
|  | ████████████  ████████                                    ||
|  +----------------------------------------------------------+|
|  | ████████████████████████████                              ||
|  | ██████████  ██████                                        ||
|  +----------------------------------------------------------+|
|  | ████████████████████                                      ||
|  | ████████  ████████████                                    ||
|  +----------------------------------------------------------+|
|                                                               |
+---------------------------------------------------------------+
```

- Skeleton items: 3 items with pulsing animation
- Skeleton bars: `var(--surface-2)` background, `border-radius: 4px`
- Pulse animation: `opacity 0.5 -> 1.0` over `1s` infinite

### 6.4 Delete Confirmation Dialog

```
+-----------------------------------------------+
|  Delete Template                         [✕]  |
+-----------------------------------------------+
|                                               |
|  Delete "My Production Layout"?               |
|                                               |
|  This action cannot be undone.                |
|                                               |
|                      [Cancel]  [Delete]       |
+-----------------------------------------------+
```

- Dialog width: `400px` (narrower than save/load)
- Destructive action: Delete button uses `var(--danger)` background
- Focus default: Cancel button (safe default per accessibility best practices)
- Template name in quotes, `weight 600`
- Warning text: `var(--text-secondary)`, `var(--text-sm)`

### 6.5 Overwrite Confirmation Dialog

```
+-----------------------------------------------+
|  Template Exists                         [✕]  |
+-----------------------------------------------+
|                                               |
|  A template named "My Layout"                 |
|  already exists.                              |
|                                               |
|  Last updated: July 15, 2025 at 2:22 PM      |
|  Nodes: 12  Connections: 11                   |
|                                               |
|  Overwriting will replace the existing        |
|  template permanently.                        |
|                                               |
|                   [Cancel]  [Overwrite]        |
+-----------------------------------------------+
```

- Same layout specs as Delete dialog (400px wide)
- Overwrite button: `var(--danger)` background (destructive)
- Existing template metadata shown to help user decide
- Focus default: Cancel (safe default)

### 6.6 Unsaved Changes Confirmation Dialog

```
+-----------------------------------------------+
|  Load Template                           [✕]  |
+-----------------------------------------------+
|                                               |
|  Loading a template will replace your         |
|  current configuration.                       |
|                                               |
|  You have unsaved changes that will           |
|  be lost.                                     |
|                                               |
|                  [Cancel]  [Load Anyway]       |
+-----------------------------------------------+
```

- Same layout specs as Delete dialog (400px wide)
- "Load Anyway" button: primary style (not danger — loading is not destructive to disk)
- Focus default: Cancel (safe default)

### 6.7 Success Toast

```
+-----------------------------------------------+
|  ● Template "My Layout" saved                 |
+-----------------------------------------------+
```

- Toast position: bottom-right, `var(--space-6)` from edges
- Toast background: `var(--surface-1)` with `1px solid var(--border)`
- Toast text: `var(--text-base)`, `var(--text-primary)`
- Green dot (●): `oklch(0.70 0.15 145)` (success green)
- Auto-dismiss: 3 seconds
- Slide-in animation: `translateY(8px)` to `translateY(0)` over `--duration-normal`
- Slide-out animation: `opacity 1->0` over `--duration-fast`

### 6.8 Error Toast

```
+-----------------------------------------------+
|  ● Could not save template: Server error      |
+-----------------------------------------------+
```

- Same layout as success toast
- Red dot (●): `var(--danger)` color
- Auto-dismiss: 5 seconds (longer than success — user needs time to read)
- Dismiss on click

### 6.9 Animation Specifications

| Animation | Trigger | Duration | Easing | Properties |
|-----------|---------|----------|--------|------------|
| Dialog open | Show dialog | `--duration-normal` (200ms) | `--easing-default` | `opacity: 0->1`, `transform: scale(0.95)->scale(1)` |
| Dialog close | Close dialog | `--duration-fast` (150ms) | `--easing-default` | `opacity: 1->0`, `transform: scale(1)->scale(0.95)` |
| Backdrop fade | Show/hide dialog | `--duration-normal` | linear | `opacity: 0->0.5` / `opacity: 0.5->0` |
| List item hover | Mouse enter | `--duration-fast` | `--easing-default` | `background-color` transition |
| List item delete | After delete success | `--duration-normal` | `--easing-default` | `opacity: 1->0`, `height: auto->0`, `margin: auto->0` |
| Skeleton pulse | While loading | `1000ms` | `ease-in-out` | `opacity: 0.5->1.0` (infinite) |
| Toast enter | Show toast | `--duration-normal` | `--easing-default` | `translateY(8px)->0`, `opacity: 0->1` |
| Toast exit | Auto-dismiss | `--duration-fast` | `--easing-default` | `opacity: 1->0` |
| Save spinner | During save | `600ms` | linear | `rotate(0deg)->rotate(360deg)` (infinite) |

---
## 7. Keyboard & Accessibility

### 7.1 ARIA Roles and Labels

| Element | Role | ARIA Attributes | Notes |
|---------|------|-----------------|-------|
| Save dialog | `dialog` | `aria-labelledby="save-dialog-title"`, `aria-modal="true"` | Focus trapped inside |
| Load dialog | `dialog` | `aria-labelledby="load-dialog-title"`, `aria-modal="true"` | Focus trapped inside |
| Delete confirmation | `alertdialog` | `aria-labelledby="delete-dialog-title"`, `aria-describedby="delete-dialog-desc"` | `alertdialog` for destructive actions |
| Overwrite confirmation | `alertdialog` | `aria-labelledby="overwrite-dialog-title"`, `aria-describedby="overwrite-dialog-desc"` | Same as delete |
| Template list | `listbox` | `aria-label="Saved templates"` | Keyboard navigable |
| Template list item | `option` | `aria-selected="true/false"` | Announces name + metadata |
| Name input | `textbox` | `aria-label="Template name"`, `aria-describedby="name-validation"`, `aria-invalid="true/false"` | Live validation feedback |
| Character count | n/a | `aria-live="polite"` | Announces count changes |
| Validation error | `alert` | `aria-live="assertive"`, `role="alert"` | Immediately announced |
| Save button | `button` | `aria-disabled="true"` when saving, `aria-busy="true"` when saving | Not `disabled` attr (keeps focusable) |
| Delete button | `button` | `aria-label="Delete template: {name}"` | Descriptive label for screen readers |
| Close button (✕) | `button` | `aria-label="Close dialog"` | Not just "✕" for screen readers |
| Success toast | `status` | `role="status"`, `aria-live="polite"` | Non-intrusive announcement |
| Error toast | `alert` | `role="alert"`, `aria-live="assertive"` | Immediate announcement |
| Search input | `searchbox` | `role="searchbox"`, `aria-label="Search templates"` | Filters template list |
| Skeleton loader | n/a | `aria-busy="true"`, `aria-label="Loading templates"` | Announced as loading |

### 7.2 Focus Management

#### 7.2.1 Dialog Focus Trap

All dialogs implement a focus trap:
- Focus moves to the first focusable element when dialog opens
- Tab/Shift+Tab cycles through focusable elements within the dialog
- Focus does not leave the dialog until it is closed
- When dialog closes, focus returns to the element that triggered it

```javascript
class FocusTrap {
  constructor(dialogEl) {
    this._dialog = dialogEl;
    this._previousFocus = null;
  }

  activate() {
    this._previousFocus = document.activeElement;
    const focusable = this._getFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    }
    this._dialog.addEventListener('keydown', this._handleKeyDown);
  }

  deactivate() {
    this._dialog.removeEventListener('keydown', this._handleKeyDown);
    if (this._previousFocus && this._previousFocus.focus) {
      this._previousFocus.focus();
    }
  }

  _handleKeyDown = (e) => {
    if (e.key !== 'Tab') return;

    const focusable = this._getFocusableElements();
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  _getFocusableElements() {
    return [
      ...this._dialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), ' +
        '[tabindex]:not([tabindex="-1"])'
      ),
    ];
  }
}
```

#### 7.2.2 Focus Order by Dialog

**Save Dialog**:
1. Template name input (auto-focused)
2. Description input
3. Cancel button
4. Save button
5. Close (✕) button

**Load Dialog**:
1. Search input (auto-focused, if templates exist)
2. Template list items (arrow key navigation within listbox)
3. Load button on selected item
4. Delete button on selected item
5. Cancel button
6. Close (✕) button

**Delete/Overwrite/Unsaved Confirmation**:
1. Cancel button (safe default, auto-focused)
2. Delete/Overwrite/Load Anyway button
3. Close (✕) button

### 7.3 Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| `Escape` | Any dialog open | Close dialog, return focus to trigger |
| `Enter` | Save dialog, name input focused | Submit save (if valid) |
| `Enter` | Confirmation dialog, button focused | Activate focused button |
| `ArrowDown` | Template list focused | Move selection to next item |
| `ArrowUp` | Template list focused | Move selection to previous item |
| `Home` | Template list focused | Move selection to first item |
| `End` | Template list focused | Move selection to last item |
| `Enter` | Template list, item selected | Load selected template |
| `Delete` | Template list, item selected | Open delete confirmation for selected |
| `Tab` | Any dialog | Move focus to next focusable element |
| `Shift+Tab` | Any dialog | Move focus to previous focusable element |

### 7.4 Screen Reader Announcements

| Event | Announcement | ARIA Mechanism |
|-------|-------------|----------------|
| Save dialog opens | "Save as Template dialog" | Dialog `aria-labelledby` |
| Name validation error | "Error: {message}" | `role="alert"` `aria-live="assertive"` |
| Name valid | (silence — no announcement for valid state) | — |
| Character count change | "{N} of 64 characters" | `aria-live="polite"` (debounced 500ms) |
| Save in progress | "Saving template" | Button `aria-busy="true"` |
| Save success | "Template {name} saved" | `role="status"` toast |
| Save error | "Error: {message}" | `role="alert"` toast |
| Load dialog opens | "Load Template dialog. {N} templates available" | Dialog `aria-labelledby` + live region |
| Template list loaded | "{N} templates found" | `aria-live="polite"` |
| Template selected | "{name}, {date}, {nodeCount} nodes, {theme} theme" | `option` role announcement |
| Load in progress | "Loading template" | `aria-busy="true"` |
| Load success | "Template {name} loaded" | `role="status"` toast |
| Delete confirmation | "Delete template {name}? This cannot be undone." | `alertdialog` `aria-describedby` |
| Delete success | "Template {name} deleted. {N} templates remaining" | `role="status"` toast |
| Empty state | "No saved templates. Save your first template from the Review page." | Live region |
| Search results | "{N} templates match your search" | `aria-live="polite"` (debounced 300ms) |

### 7.5 Reduced Motion

All animations respect the `prefers-reduced-motion` media query:

```css
@media (prefers-reduced-motion: reduce) {
  .template-dialog,
  .template-dialog-backdrop,
  .template-list-item,
  .template-toast,
  .template-skeleton {
    animation: none !important;
    transition-duration: 0.01ms !important;
  }
}
```

When reduced motion is preferred:
- Dialog appears/disappears instantly (no scale/fade)
- Backdrop appears/disappears instantly
- List items delete instantly (no slide-out)
- Toasts appear/disappear instantly
- Skeleton loader shows static gray bars (no pulse)

### 7.6 Color Contrast Requirements

All text meets WCAG 2.1 AA contrast requirements (minimum 4.5:1 for normal text,
3:1 for large text):

| Element | Foreground | Background | Contrast Ratio | Pass? |
|---------|-----------|------------|----------------|-------|
| Dialog title | `--text-primary` (92% L) | `--surface-0` (15% L) | ~14:1 | Yes (AAA) |
| Body text | `--text-primary` (92% L) | `--surface-0` (15% L) | ~14:1 | Yes (AAA) |
| Secondary text | `--text-secondary` (65% L) | `--surface-0` (15% L) | ~6.5:1 | Yes (AA) |
| Input text | `--text-primary` (92% L) | `--surface-1` (20% L) | ~11:1 | Yes (AAA) |
| Error text | `--danger` (65% L) | `--surface-0` (15% L) | ~6.5:1 | Yes (AA) |
| Button text (primary) | white (100% L) | `--accent` (70% L) | ~4.5:1 | Yes (AA) |
| Button text (ghost) | `--text-primary` (92% L) | `--surface-1` (20% L) | ~11:1 | Yes (AAA) |
| Button text (danger) | white (100% L) | `--danger` (65% L) | ~5.5:1 | Yes (AA) |

### 7.7 High Contrast Mode

When `forced-colors: active` (Windows High Contrast):

```css
@media (forced-colors: active) {
  .template-dialog {
    border: 2px solid ButtonText;
  }
  .template-list-item:focus {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }
  .template-toast {
    border: 1px solid ButtonText;
  }
}
```

---
## 8. Error Handling

### 8.1 Error Taxonomy

All errors in C12 are categorized into one of three severity levels:

| Severity | Description | User Experience | Recovery |
|----------|-------------|-----------------|----------|
| **Blocking** | Operation cannot complete | Inline error in dialog, retry available | User retries or cancels |
| **Warning** | Operation succeeded with caveats | Warning toast, operation completes | User addresses issue manually |
| **Silent** | Non-critical issue logged | Console warning only | Automatic |

### 8.2 Error Code Reference

| Code | Severity | HTTP | Trigger | User Message | Recovery Action |
|------|----------|------|---------|-------------|-----------------|
| `TEMPLATE_FILE_CORRUPT` | Blocking | 500 | JSON parse failure on template file | "Template file is corrupted. A backup was created." | User fixes file or saves new template |
| `TEMPLATE_NOT_FOUND` | Blocking | 404 | Template name not in file | "No template named '{name}' was found" | User selects different template |
| `TEMPLATE_NAME_EXISTS` | Blocking | 409 | Save with duplicate name, overwrite=false | "A template named '{name}' already exists" | User renames or overwrites |
| `TEMPLATE_VERSION_TOO_NEW` | Blocking | 409 | Template version > current code version | "This template requires a newer version of EDOG Studio" | User updates EDOG Studio |
| `VALIDATION_ERROR` | Blocking | 400 | Name fails validation rules | Specific validation message (see §2.3) | User corrects name |
| `MISSING_PARAMETER` | Blocking | 400 | Required parameter missing | "Parameter '{name}' is required" | Frontend bug — should not reach user |
| `OPERATION_IN_PROGRESS` | Blocking | n/a | Client-side concurrency guard | "Cannot {action} while {current} is in progress" | User waits for current operation |
| `NETWORK_ERROR` | Blocking | n/a | fetch() throws TypeError | "Could not connect to EDOG Studio server" | User checks server is running |
| `FILESYSTEM_ERROR` | Blocking | 500 | Permission denied, disk full, etc. | "Could not write template file: {OS error}" | User fixes filesystem issue |
| `SCHEMA_MISMATCH` | Warning | n/a | Loaded template references missing schemas | "Template references schemas not in current project: {names}" | User adds schemas or reassigns nodes |
| `LARGE_FILE_WARNING` | Silent | n/a | Template file exceeds 10MB | Console warning only | No user action needed |
| `MIGRATION_WARNING` | Warning | n/a | Template migrated from older version | "Template was updated from format v{old} to v{new}" | Informational only |

### 8.3 Error Handling Patterns

#### 8.3.1 Backend Error Response Format

All backend error responses follow a consistent JSON format:

```json
{
  "ok": false,
  "error": "ERROR_CODE",
  "message": "Human-readable error message",
  "details": ["Optional", "array", "of", "detail", "strings"]
}
```

- `ok`: Always `false` for errors
- `error`: Machine-readable error code (SCREAMING_SNAKE_CASE)
- `message`: User-facing message (can be displayed directly in UI)
- `details`: Optional array of additional context (e.g., multiple validation errors)

#### 8.3.2 Frontend Error Class

```javascript
class TemplateError extends Error {
  /**
   * @param {string} code - Machine-readable error code
   * @param {string} message - Human-readable message
   * @param {string[]} [details] - Optional details
   */
  constructor(code, message, details = []) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
    this.details = details;
  }

  /** Is this a conflict that can be resolved with overwrite? */
  get isConflict() {
    return this.code === 'TEMPLATE_NAME_EXISTS';
  }

  /** Is this a validation error that the user can fix? */
  get isValidation() {
    return this.code === 'VALIDATION_ERROR';
  }

  /** Is this a network/server error? */
  get isNetwork() {
    return this.code === 'NETWORK_ERROR';
  }

  /** Is this a version compatibility issue? */
  get isVersionMismatch() {
    return this.code === 'TEMPLATE_VERSION_TOO_NEW';
  }
}
```

#### 8.3.3 Frontend Error Handler

```javascript
/** @private */
_handleError(err, context) {
  // Wrap non-TemplateError exceptions
  const templateErr = err instanceof TemplateError
    ? err
    : new TemplateError(
        err.name === 'TypeError' ? 'NETWORK_ERROR' : 'UNKNOWN_ERROR',
        err.message
      );

  this._lastError = {
    error: templateErr.code,
    message: templateErr.message,
    details: templateErr.details,
    context,
    timestamp: Date.now(),
  };

  this._transition('error');
  this._eventBus.emit('template:error', this._lastError);

  // Auto-recover to idle after 3 seconds
  this._errorTimeout = setTimeout(() => {
    if (this._state === 'error') {
      this._state = 'idle';
      this._eventBus.emit('template:state-changed', {
        from: 'error',
        to: 'idle',
      });
    }
  }, 3000);

  // Log for debugging
  console.error(`[TemplateManager] ${context}: ${templateErr.code}`, templateErr);
}
```

### 8.4 Filesystem Error Handling (Backend)

#### 8.4.1 Permission Denied

```python
try:
    _atomic_write(templates_path, json.dumps(data, indent=2))
except PermissionError as e:
    return self._json_response({
        "ok": False,
        "error": "FILESYSTEM_ERROR",
        "message": f"Could not write template file: Permission denied. "
                   f"Check that '{templates_path}' is writable."
    }, status=500)
```

#### 8.4.2 Disk Full

```python
except OSError as e:
    if e.errno == errno.ENOSPC:
        return self._json_response({
            "ok": False,
            "error": "FILESYSTEM_ERROR",
            "message": "Could not write template file: Disk is full."
        }, status=500)
    raise  # Re-raise unexpected OS errors
```

#### 8.4.3 Corrupt File Recovery

When a corrupt template file is detected during any read operation:

1. **Backup**: Copy corrupt file to `edog-templates.json.bak` (overwriting any previous backup)
2. **Report**: Return error response with backup path
3. **Do NOT delete**: The corrupt file remains in place — the user must explicitly delete it or save a new template (which overwrites it)

```python
def _read_templates_file(self, templates_path):
    """Read and parse templates file with corruption handling."""
    if not templates_path.exists():
        return {"version": CURRENT_TEMPLATE_VERSION, "templates": []}

    raw = templates_path.read_text(encoding="utf-8")

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # Backup corrupt file
        backup_path = templates_path.with_suffix(".json.bak")
        shutil.copy2(templates_path, backup_path)
        raise TemplateFileCorruptError(
            f"Template file is corrupted. Backup created at {backup_path.name}"
        )

    # Validate structure
    if not isinstance(data, dict):
        raise TemplateFileCorruptError("Template file has invalid structure")
    if "templates" not in data:
        raise TemplateFileCorruptError("Template file missing 'templates' array")
    if not isinstance(data["templates"], list):
        raise TemplateFileCorruptError("'templates' is not an array")

    return data
```

### 8.5 Network Error Handling (Frontend)

```javascript
async _fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    const data = await response.json();

    if (!data.ok) {
      throw new TemplateError(
        data.error || 'UNKNOWN_ERROR',
        data.message || 'An unexpected error occurred',
        data.details
      );
    }

    return data;
  } catch (err) {
    if (err instanceof TemplateError) {
      throw err; // Already wrapped
    }

    // Network errors (server down, CORS, etc.)
    if (err instanceof TypeError) {
      throw new TemplateError(
        'NETWORK_ERROR',
        'Could not connect to EDOG Studio server. Is it running?'
      );
    }

    // JSON parse errors (server returned non-JSON)
    if (err instanceof SyntaxError) {
      throw new TemplateError(
        'NETWORK_ERROR',
        'Server returned an invalid response. Check server logs.'
      );
    }

    throw new TemplateError('UNKNOWN_ERROR', err.message);
  }
}
```

### 8.6 Validation Error Display

Validation errors are shown inline below the input field, not as toasts:

```javascript
_showValidationError(inputEl, message) {
  // Remove existing error
  const existing = inputEl.parentElement.querySelector('.validation-error');
  if (existing) existing.remove();

  const errorEl = document.createElement('div');
  errorEl.className = 'validation-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.setAttribute('aria-live', 'assertive');
  errorEl.textContent = message;

  inputEl.setAttribute('aria-invalid', 'true');
  inputEl.parentElement.appendChild(errorEl);
}

_clearValidationError(inputEl) {
  const existing = inputEl.parentElement.querySelector('.validation-error');
  if (existing) existing.remove();
  inputEl.setAttribute('aria-invalid', 'false');
}
```

```css
.validation-error {
  color: var(--danger);
  font-size: var(--text-sm);
  margin-top: var(--space-1);
  animation: fadeIn var(--duration-fast) var(--easing-default);
}
```

---
## 9. Performance

### 9.1 Performance Budgets

| Operation | Target | Max Acceptable | Measurement |
|-----------|--------|----------------|-------------|
| List templates (cold) | < 50ms | < 200ms | Time from request to rendered list |
| List templates (cached) | < 5ms | < 20ms | Return cached array, no network call |
| Load template | < 100ms | < 500ms | Time from request to wizard state applied |
| Save template | < 100ms | < 500ms | Time from request to disk write confirmed |
| Delete template | < 50ms | < 200ms | Time from request to disk write confirmed |
| Name validation | < 1ms | < 5ms | Synchronous, no disk/network |
| Dialog open animation | 200ms | 200ms | Fixed animation duration |
| Template search filter | < 10ms | < 50ms | Client-side filter on cached list |

### 9.2 File I/O Optimization

#### 9.2.1 Read Strategy

Template list reads are synchronous file reads on the backend (Python's `pathlib.read_text()`).
This is acceptable because:
- The file is local (no network I/O)
- Expected file size is < 1MB for typical usage (50 templates with average DAG)
- Python's file read is fast for small files
- The backend HTTP server is single-threaded anyway (stdlib `http.server`)

**For large files (> 1MB)**: Log a performance warning but don't block.

#### 9.2.2 Write Strategy

All writes use the `_atomic_write()` pattern:

```python
def _atomic_write(path, data):
    """Write data to path atomically using tempfile + os.replace."""
    import tempfile
    dir_path = path.parent
    fd, tmp_path = tempfile.mkstemp(dir=str(dir_path), suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(data)
        os.replace(tmp_path, str(path))
    except Exception:
        # Clean up temp file on failure
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
```

This ensures:
- No partial writes (file is either fully written or unchanged)
- No corruption on crash (tempfile is written first, then atomically renamed)
- No data loss (old file exists until replace succeeds)

#### 9.2.3 Caching Strategy

The frontend caches the template list (metadata only, no state) to avoid redundant
network calls:

```javascript
// Cache is populated on listTemplates() and invalidated on save/delete
this._templates = []; // TemplateSummary[] (no state field)
this._lastFetchTime = 0;

getCachedList() {
  return [...this._templates]; // Return copy to prevent mutation
}

async listTemplates({ force = false } = {}) {
  // Use cache if fresh (< 5 seconds) and not forced
  const age = Date.now() - this._lastFetchTime;
  if (!force && age < 5000 && this._templates.length > 0) {
    return this.getCachedList();
  }
  // ... fetch from backend
}
```

Cache invalidation:
- `saveTemplate()` — refetches list after successful save
- `deleteTemplate()` — removes item from cache (no refetch needed)
- `listTemplates({ force: true })` — forces refetch regardless of cache age
- Cache expires after 5 seconds (prevents stale data from concurrent tabs)

### 9.3 Template Size Considerations

#### 9.3.1 Estimated Template Sizes

| DAG Size | Nodes | Connections | Estimated JSON Size | Notes |
|----------|-------|-------------|--------------------|-|
| Small | 5 | 4 | ~2 KB | Quick prototype |
| Medium | 20 | 25 | ~8 KB | Typical project |
| Large | 50 | 75 | ~25 KB | Complex pipeline |
| Very Large | 200 | 300 | ~100 KB | Enterprise pipeline |
| Maximum | 500 | 1000 | ~300 KB | Stress test scenario |

#### 9.3.2 File Size Limits

| Threshold | Action |
|-----------|--------|
| < 1 MB | Normal operation |
| 1-5 MB | Console warning: "Template file is large ({size}). Consider deleting unused templates." |
| 5-10 MB | Console warning + UI indicator on load dialog |
| > 10 MB | Console error + suggestion to archive old templates |

No hard limit is enforced — the file can grow as large as the filesystem allows.
The warnings help users proactively manage template count.

#### 9.3.3 List Response Optimization

The list endpoint strips `state` from each template, returning only identity and
metadata fields. This dramatically reduces response size:

| Scenario | Full Response Size | List Response Size | Reduction |
|----------|-------------------|-------------------|-----------|
| 10 medium templates | ~80 KB | ~5 KB | 94% |
| 50 medium templates | ~400 KB | ~25 KB | 94% |
| 10 very large templates | ~1 MB | ~5 KB | 99.5% |

### 9.4 Rendering Performance

#### 9.4.1 Template List Rendering

The template list uses simple DOM creation (no virtual scrolling) because:
- Expected item count is < 50 (typically < 20)
- Each item is lightweight (2 text lines + 2 buttons)
- DOM creation for 50 items takes < 5ms

```javascript
_renderTemplateList(templates) {
  const container = this._listEl;
  container.innerHTML = ''; // Clear existing

  const fragment = document.createDocumentFragment();
  for (const tmpl of templates) {
    fragment.appendChild(this._createListItem(tmpl));
  }
  container.appendChild(fragment);
}
```

**If template count exceeds 100** (unlikely but possible): Switch to a simple
windowed approach that renders only visible items + buffer. This is a future
optimization, not needed for v1.

#### 9.4.2 Search/Filter Performance

Template filtering is done client-side on the cached list:

```javascript
_filterTemplates(query) {
  if (!query) return this._templates;

  const lower = query.toLowerCase();
  return this._templates.filter(t =>
    t.name.toLowerCase().includes(lower) ||
    t.metadata.themeId.toLowerCase().includes(lower) ||
    t.metadata.schemaNames.some(s => s.toLowerCase().includes(lower))
  );
}
```

This is O(n) on the template count, which is negligible for expected sizes (< 50).
The search input is debounced at 150ms to avoid excessive re-renders during typing.

### 9.5 Memory Management

```javascript
destroy() {
  // Clear cached data
  this._templates = [];
  this._lastError = null;

  // Clear timers
  clearTimeout(this._errorTimeout);

  // Remove event listeners
  this._eventBus.off('template:*');

  // Clear references
  this._wizardShell = null;
  this._dagCanvas = null;
  this._eventBus = null;
}
```

The `destroy()` method is called when the wizard is closed to prevent memory leaks.
All references to other components are nulled, timers are cleared, and event listeners
are removed.

---
## 10. Implementation Notes

### 10.1 File Organization

```
src/
  wizard/
    template-manager.js          # TemplateManager class (frontend)
    template-dialogs.js          # Save/Load/Delete dialog UI
    template-list.js             # Template list component
    template-validation.js       # Name validation logic
    template-manager.css         # All C12-specific styles

lib/
  handlers/
    template_handler.py          # Backend HTTP handler for /api/templates/*
    template_validation.py       # Backend name validation (mirror of frontend)
    template_migration.py        # Version migration logic
```

### 10.2 Backend Implementation Guide

#### 10.2.1 Route Registration

Add routes to the existing `do_GET()` and `do_POST()` methods in the HTTP handler:

```python
# In do_GET():
elif self.path == "/api/templates/list":
    self.handle_templates_list()
elif self.path.startswith("/api/templates/load"):
    self.handle_templates_load()

# In do_POST():
elif self.path == "/api/templates/save":
    self.handle_templates_save()
elif self.path == "/api/templates/delete":
    self.handle_templates_delete()
```

#### 10.2.2 Constants

```python
CURRENT_TEMPLATE_VERSION = 1
WIZARD_VERSION = "0.1.0"
TEMPLATE_FILE_NAME = "edog-templates.json"
MAX_TEMPLATE_NAME_LENGTH = 64
FORBIDDEN_NAME_CHARS = set('/\\:*?"<>|')
FILE_SIZE_WARNING_BYTES = 1_000_000  # 1 MB
FILE_SIZE_ERROR_BYTES = 10_000_000   # 10 MB
```

#### 10.2.3 Name Validation (Backend)

```python
def validate_template_name(name: str) -> list[str]:
    """Validate a template name. Returns list of error messages (empty = valid)."""
    errors = []
    trimmed = name.strip()

    if len(trimmed) == 0:
        errors.append("Template name cannot be empty")
        return errors  # No point checking further

    if len(trimmed) > MAX_TEMPLATE_NAME_LENGTH:
        errors.append(
            f"Template name must be {MAX_TEMPLATE_NAME_LENGTH} characters or fewer"
        )

    if any(c in FORBIDDEN_NAME_CHARS for c in trimmed):
        bad_chars = [c for c in trimmed if c in FORBIDDEN_NAME_CHARS]
        errors.append(
            f"Template name contains invalid characters: {', '.join(bad_chars)}"
        )

    if trimmed.startswith(".") or trimmed.endswith("."):
        errors.append("Template name cannot start or end with a dot")

    return errors
```

#### 10.2.4 Schema Name Extraction Helper

```python
def _extract_schema_names(state: dict) -> list[str]:
    """Extract unique schema names from wizard state."""
    schemas = set()
    schema_config = state.get("schemas", {})
    if primary := schema_config.get("primary"):
        schemas.add(primary)
    for medallion in schema_config.get("medallion", []):
        schemas.add(medallion)
    return sorted(schemas)
```

#### 10.2.5 JSON Response Helper

```python
def _json_response(self, data: dict, status: int = 200):
    """Send a JSON response with appropriate headers."""
    body = json.dumps(data, indent=None, ensure_ascii=False).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    self.wfile.write(body)
```

### 10.3 Frontend Implementation Guide

#### 10.3.1 Module Structure

```javascript
// template-manager.js
export class TemplateManager {
  constructor({ baseUrl, wizardShell, dagCanvas, eventBus }) { /* ... */ }

  // Public API
  async listTemplates(options) { /* ... */ }
  async loadTemplate(name) { /* ... */ }
  async saveTemplate(name, options) { /* ... */ }
  async deleteTemplate(name) { /* ... */ }
  applyTemplate(template) { /* ... */ }
  validateName(name) { /* ... */ }
  getState() { /* ... */ }
  getCachedList() { /* ... */ }
  destroy() { /* ... */ }

  // Private
  _transition(newState) { /* ... */ }
  _ensureIdle(operation) { /* ... */ }
  _handleError(err, context) { /* ... */ }
  _collectWizardState() { /* ... */ }
  _fetchJson(url, options) { /* ... */ }
}
```

#### 10.3.2 Dialog Base Class

All three dialogs (save, load, delete confirmation) share a common base:

```javascript
class TemplateDialog {
  constructor({ title, onClose }) {
    this._title = title;
    this._onClose = onClose;
    this._el = null;
    this._backdropEl = null;
    this._focusTrap = null;
  }

  open() {
    this._render();
    this._backdropEl = this._createBackdrop();
    document.body.appendChild(this._backdropEl);
    document.body.appendChild(this._el);
    this._focusTrap = new FocusTrap(this._el);
    this._focusTrap.activate();
    // Trigger enter animation
    requestAnimationFrame(() => {
      this._el.classList.add('template-dialog--open');
      this._backdropEl.classList.add('template-backdrop--open');
    });
  }

  close() {
    this._el.classList.remove('template-dialog--open');
    this._backdropEl.classList.remove('template-backdrop--open');
    // Wait for exit animation
    setTimeout(() => {
      this._focusTrap.deactivate();
      this._el.remove();
      this._backdropEl.remove();
      this._onClose?.();
    }, 150); // --duration-fast
  }

  _createBackdrop() {
    const el = document.createElement('div');
    el.className = 'template-backdrop';
    el.addEventListener('click', () => this.close());
    return el;
  }

  /** @abstract */
  _render() {
    throw new Error('Subclasses must implement _render()');
  }
}
```

#### 10.3.3 Save Dialog Implementation

```javascript
class SaveTemplateDialog extends TemplateDialog {
  constructor({ templateManager, existingTemplates, onSave, onClose }) {
    super({ title: 'Save as Template', onClose });
    this._templateManager = templateManager;
    this._existingTemplates = existingTemplates;
    this._onSave = onSave;
  }

  _render() {
    this._el = document.createElement('div');
    this._el.className = 'template-dialog template-dialog--save';
    this._el.setAttribute('role', 'dialog');
    this._el.setAttribute('aria-modal', 'true');
    this._el.setAttribute('aria-labelledby', 'save-dialog-title');

    this._el.innerHTML = `
      <div class="template-dialog__header">
        <h2 id="save-dialog-title" class="template-dialog__title">
          Save as Template
        </h2>
        <button class="template-dialog__close" aria-label="Close dialog">
          ✕
        </button>
      </div>
      <div class="template-dialog__body">
        <label class="template-field">
          <span class="template-field__label">Template Name</span>
          <div class="template-field__input-wrap">
            <input
              type="text"
              class="template-field__input"
              id="template-name-input"
              maxlength="64"
              aria-label="Template name"
              aria-describedby="name-validation"
              autocomplete="off"
              spellcheck="false"
            />
            <span class="template-field__count" aria-live="polite">
              0/64
            </span>
          </div>
          <div id="name-validation" class="template-field__error" role="alert"
               aria-live="assertive"></div>
        </label>
        <label class="template-field">
          <span class="template-field__label">Description (optional)</span>
          <div class="template-field__input-wrap">
            <input
              type="text"
              class="template-field__input"
              id="template-desc-input"
              maxlength="256"
              aria-label="Template description"
            />
            <span class="template-field__count" aria-live="polite">
              0/256
            </span>
          </div>
        </label>
        <div class="template-summary" aria-label="Template summary">
          <!-- Populated dynamically -->
        </div>
      </div>
      <div class="template-dialog__footer">
        <button class="btn btn--ghost" data-action="cancel">Cancel</button>
        <button class="btn btn--primary" data-action="save">Save Template</button>
      </div>
    `;

    // Bind events
    this._el.querySelector('[data-action="cancel"]')
      .addEventListener('click', () => this.close());
    this._el.querySelector('.template-dialog__close')
      .addEventListener('click', () => this.close());
    this._el.querySelector('[data-action="save"]')
      .addEventListener('click', () => this._handleSave());

    const nameInput = this._el.querySelector('#template-name-input');
    nameInput.addEventListener('input', (e) => this._handleNameInput(e));
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._handleSave();
    });

    // Escape to close
    this._el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  _handleNameInput(e) {
    const name = e.target.value;
    const countEl = this._el.querySelector('.template-field__count');
    countEl.textContent = `${name.length}/64`;

    // Real-time validation
    const result = this._templateManager.validateName(name);
    const errorEl = this._el.querySelector('#name-validation');
    if (!result.valid && name.length > 0) {
      errorEl.textContent = result.errors[0];
      e.target.setAttribute('aria-invalid', 'true');
    } else {
      errorEl.textContent = '';
      e.target.setAttribute('aria-invalid', 'false');
    }
  }

  async _handleSave() {
    const nameInput = this._el.querySelector('#template-name-input');
    const descInput = this._el.querySelector('#template-desc-input');
    const name = nameInput.value.trim();
    const description = descInput.value.trim();

    const validation = this._templateManager.validateName(name);
    if (!validation.valid) {
      this._showError(validation.errors[0]);
      nameInput.focus();
      return;
    }

    const saveBtn = this._el.querySelector('[data-action="save"]');
    saveBtn.setAttribute('aria-busy', 'true');
    saveBtn.setAttribute('aria-disabled', 'true');
    saveBtn.innerHTML = '<span class="spinner"></span> Saving...';

    try {
      const result = await this._templateManager.saveTemplate(name, {
        description,
        overwrite: false,
      });
      this._onSave?.(result);
      this.close();
    } catch (err) {
      saveBtn.setAttribute('aria-busy', 'false');
      saveBtn.removeAttribute('aria-disabled');
      saveBtn.textContent = 'Save Template';

      if (err.isConflict) {
        this._showOverwritePrompt(name, description, err);
      } else {
        this._showError(err.message);
      }
    }
  }

  _showOverwritePrompt(name, description, err) {
    // Show inline overwrite option
    const errorEl = this._el.querySelector('#name-validation');
    errorEl.innerHTML = '';

    const prompt = document.createElement('div');
    prompt.className = 'template-overwrite-prompt';
    prompt.innerHTML = `
      <p>A template named "${name}" already exists.</p>
      <div class="template-overwrite-actions">
        <button class="btn btn--ghost btn--sm" data-action="rename">
          Use different name
        </button>
        <button class="btn btn--danger btn--sm" data-action="overwrite">
          Overwrite existing
        </button>
      </div>
    `;

    prompt.querySelector('[data-action="rename"]')
      .addEventListener('click', () => {
        prompt.remove();
        this._el.querySelector('#template-name-input').focus();
      });

    prompt.querySelector('[data-action="overwrite"]')
      .addEventListener('click', async () => {
        prompt.remove();
        const saveBtn = this._el.querySelector('[data-action="save"]');
        saveBtn.setAttribute('aria-busy', 'true');
        saveBtn.innerHTML = '<span class="spinner"></span> Saving...';
        try {
          const result = await this._templateManager.saveTemplate(name, {
            description,
            overwrite: true,
          });
          this._onSave?.(result);
          this.close();
        } catch (retryErr) {
          saveBtn.setAttribute('aria-busy', 'false');
          saveBtn.textContent = 'Save Template';
          this._showError(retryErr.message);
        }
      });

    errorEl.parentElement.appendChild(prompt);
  }

  _showError(message) {
    const errorEl = this._el.querySelector('#name-validation');
    errorEl.textContent = message;
  }
}
```

#### 10.3.4 Template List Item HTML

```javascript
_createListItem(template) {
  const item = document.createElement('div');
  item.className = 'template-list-item';
  item.setAttribute('role', 'option');
  item.setAttribute('tabindex', '0');
  item.setAttribute('data-template-name', template.name);
  item.setAttribute('aria-selected', 'false');

  const date = new Date(template.updatedAt);
  const dateStr = date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  item.innerHTML = `
    <div class="template-list-item__main">
      <div class="template-list-item__header">
        <span class="template-list-item__name">${this._escapeHtml(template.name)}</span>
        <button class="btn btn--ghost btn--sm template-list-item__load"
                data-action="load" data-name="${this._escapeAttr(template.name)}">
          Load
        </button>
      </div>
      <div class="template-list-item__meta">
        <span class="template-list-item__date">${dateStr}</span>
        <span class="template-list-item__sep">&#x2022;</span>
        <span class="template-list-item__nodes">
          &#x25C6; ${template.metadata.nodeCount} nodes
        </span>
        <span class="template-list-item__sep">&#x2022;</span>
        <span class="template-list-item__theme">
          &#x25B8; ${this._escapeHtml(template.metadata.themeId)}
        </span>
      </div>
    </div>
    <button class="btn btn--icon template-list-item__delete"
            data-action="delete" data-name="${this._escapeAttr(template.name)}"
            aria-label="Delete template: ${this._escapeAttr(template.name)}">
      &#x2715;
    </button>
  `;

  return item;
}
```

### 10.4 CSS Implementation

```css
/* --- Template Dialog Base --- */
.template-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) scale(0.95);
  opacity: 0;
  z-index: var(--z-dialog);
  background: var(--surface-0);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 24px 48px oklch(0 0 0 / 0.3);
  transition: transform var(--duration-normal) var(--easing-default),
              opacity var(--duration-normal) var(--easing-default);
}

.template-dialog--open {
  transform: translate(-50%, -50%) scale(1);
  opacity: 1;
}

.template-dialog--save {
  width: 480px;
  max-height: 80vh;
  overflow-y: auto;
}

.template-dialog--load {
  width: 560px;
  max-height: 70vh;
  overflow-y: auto;
}

.template-dialog--confirm {
  width: 400px;
}

/* --- Backdrop --- */
.template-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog-backdrop);
  background: oklch(0 0 0 / 0.5);
  backdrop-filter: blur(4px);
  opacity: 0;
  transition: opacity var(--duration-normal) linear;
}

.template-backdrop--open {
  opacity: 1;
}

/* --- Dialog Header --- */
.template-dialog__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-6);
  padding-bottom: var(--space-4);
}

.template-dialog__title {
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.template-dialog__close {
  appearance: none;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: var(--text-lg);
  cursor: pointer;
  padding: var(--space-2);
  border-radius: 4px;
  transition: color var(--duration-fast) var(--easing-default),
              background var(--duration-fast) var(--easing-default);
}

.template-dialog__close:hover {
  color: var(--text-primary);
  background: var(--surface-2);
}

/* --- Dialog Body --- */
.template-dialog__body {
  padding: 0 var(--space-6);
}

/* --- Dialog Footer --- */
.template-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: var(--space-6);
  padding-top: var(--space-4);
}

/* --- Form Fields --- */
.template-field {
  display: block;
  margin-bottom: var(--space-4);
}

.template-field__label {
  display: block;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
}

.template-field__input-wrap {
  position: relative;
}

.template-field__input {
  width: 100%;
  height: 40px;
  padding: 0 var(--space-3);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: var(--text-base);
  font-family: var(--font-sans);
  outline: none;
  transition: border-color var(--duration-fast) var(--easing-default);
  box-sizing: border-box;
}

.template-field__input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px oklch(0.70 0.15 250 / 0.3);
}

.template-field__input[aria-invalid="true"] {
  border-color: var(--danger);
}

.template-field__count {
  position: absolute;
  right: var(--space-3);
  top: 50%;
  transform: translateY(-50%);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  pointer-events: none;
}

.template-field__error {
  color: var(--danger);
  font-size: var(--text-sm);
  margin-top: var(--space-1);
  min-height: 1.2em;
}

/* --- Template Summary (in save dialog) --- */
.template-summary {
  background: var(--surface-1);
  padding: var(--space-3);
  border-radius: 6px;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin-bottom: var(--space-4);
}

/* --- Template List --- */
.template-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.template-list-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background var(--duration-fast) var(--easing-default);
}

.template-list-item:last-child {
  border-bottom: none;
}

.template-list-item:hover {
  background: var(--surface-2);
}

.template-list-item:focus {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.template-list-item__name {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--text-primary);
}

.template-list-item__meta {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin-top: var(--space-1);
}

.template-list-item__sep {
  margin: 0 var(--space-1);
}

.template-list-item__delete {
  opacity: 0;
  transition: opacity var(--duration-fast) var(--easing-default),
              color var(--duration-fast) var(--easing-default);
}

.template-list-item:hover .template-list-item__delete,
.template-list-item:focus-within .template-list-item__delete {
  opacity: 1;
}

.template-list-item__delete:hover {
  color: var(--danger);
}

/* --- Skeleton Loader --- */
.template-skeleton {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
}

.template-skeleton__bar {
  height: 14px;
  background: var(--surface-2);
  border-radius: 4px;
  animation: skeletonPulse 1s ease-in-out infinite;
}

.template-skeleton__bar--wide { width: 60%; }
.template-skeleton__bar--medium { width: 40%; margin-top: var(--space-2); }

@keyframes skeletonPulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

/* --- Spinner --- */
.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--text-secondary);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spinnerRotate 600ms linear infinite;
  vertical-align: middle;
  margin-right: var(--space-1);
}

@keyframes spinnerRotate {
  to { transform: rotate(360deg); }
}

/* --- Toast --- */
.template-toast {
  position: fixed;
  bottom: var(--space-6);
  right: var(--space-6);
  padding: var(--space-3) var(--space-4);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: var(--text-base);
  color: var(--text-primary);
  box-shadow: 0 4px 12px oklch(0 0 0 / 0.2);
  transform: translateY(8px);
  opacity: 0;
  transition: transform var(--duration-normal) var(--easing-default),
              opacity var(--duration-normal) var(--easing-default);
  z-index: var(--z-dialog);
}

.template-toast--visible {
  transform: translateY(0);
  opacity: 1;
}

.template-toast__dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: var(--space-2);
  vertical-align: middle;
}

.template-toast__dot--success { background: oklch(0.70 0.15 145); }
.template-toast__dot--error { background: var(--danger); }

/* --- Buttons --- */
.btn--danger {
  background: var(--danger);
  color: white;
  border: none;
}

.btn--danger:hover {
  background: oklch(0.55 0.20 25);
}

/* --- Reduced Motion --- */
@media (prefers-reduced-motion: reduce) {
  .template-dialog,
  .template-backdrop,
  .template-list-item,
  .template-toast,
  .template-skeleton__bar,
  .spinner {
    animation: none !important;
    transition-duration: 0.01ms !important;
  }
}

/* --- Forced Colors (High Contrast) --- */
@media (forced-colors: active) {
  .template-dialog {
    border: 2px solid ButtonText;
  }
  .template-list-item:focus {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }
  .template-toast {
    border: 1px solid ButtonText;
  }
  .template-field__input {
    border: 1px solid ButtonText;
  }
}
```

### 10.5 Integration Points

#### 10.5.1 C9-ReviewSummary Integration (Save Trigger)

```javascript
// In ReviewSummary component:
_onSaveAsTemplateClick() {
  const dialog = new SaveTemplateDialog({
    templateManager: this._templateManager,
    existingTemplates: this._templateManager.getCachedList(),
    onSave: (result) => {
      this._showToast(
        result.created
          ? `Template "${result.template.name}" saved`
          : `Template "${result.template.name}" updated`,
        'success'
      );
    },
  });
  dialog.open();
}
```

#### 10.5.2 Page 1 Integration (Load Trigger)

```javascript
// In InfraSetupPage component:
_onLoadTemplateClick() {
  const dialog = new LoadTemplateDialog({
    templateManager: this._templateManager,
    wizardShell: this._wizardShell,
    onLoad: (template) => {
      this._templateManager.applyTemplate(template);
      this._showToast(`Template "${template.name}" loaded`, 'success');
    },
  });
  dialog.open();
}
```

#### 10.5.3 WizardShell State Interface

The `TemplateManager` depends on these methods from `WizardShell`:

```javascript
// Expected WizardShell API:
class WizardShell {
  getInfrastructureState() { /* returns { workspaceName, lakehouseName, notebookName } */ }
  getSchemaState() { /* returns { primary, medallion } */ }
  getThemeState() { /* returns { id, customOverrides } */ }
  setState(state) { /* replaces entire wizard state and re-renders all pages */ }
  hasUnsavedChanges() { /* returns boolean — any changes since last load/save */ }
}
```

#### 10.5.4 DagCanvas Export Interface

```javascript
// Expected DagCanvas API:
class DagCanvas {
  exportTopology() {
    /* returns { nodes: NodeObject[], connections: ConnectionObject[], viewport: ViewportObject } */
  }
}
```

### 10.6 Testing Strategy

#### 10.6.1 Unit Tests (Backend)

| Test | Description |
|------|-------------|
| `test_list_empty` | List returns empty array when file doesn't exist |
| `test_list_with_templates` | List returns metadata without state |
| `test_save_new_template` | Save creates file and template |
| `test_save_overwrite` | Save with overwrite=true replaces existing |
| `test_save_conflict` | Save with duplicate name returns 409 |
| `test_save_validation_errors` | Save with invalid name returns 400 |
| `test_load_existing` | Load returns full template with state |
| `test_load_not_found` | Load returns 404 for missing template |
| `test_load_version_too_new` | Load returns 409 for newer version |
| `test_delete_existing` | Delete removes template from file |
| `test_delete_not_found` | Delete returns 404 for missing template |
| `test_corrupt_file` | List/load with corrupt JSON returns 500 + creates backup |
| `test_atomic_write` | Verify write uses temp file + rename |
| `test_name_validation_empty` | Empty name rejected |
| `test_name_validation_long` | Name > 64 chars rejected |
| `test_name_validation_special_chars` | Forbidden chars rejected |
| `test_name_validation_dots` | Leading/trailing dots rejected |
| `test_name_case_insensitive` | Duplicate check is case-insensitive |
| `test_unicode_names` | Unicode template names work correctly |
| `test_concurrent_saves` | Two rapid saves don't corrupt file |

#### 10.6.2 Unit Tests (Frontend)

| Test | Description |
|------|-------------|
| `test_state_machine_transitions` | Valid transitions succeed, invalid throw |
| `test_concurrency_guard` | Operations rejected when not idle |
| `test_cache_invalidation` | Cache updated after save/delete |
| `test_name_validation` | All §2.3 rules enforced client-side |
| `test_error_auto_recovery` | State returns to idle after 3s |
| `test_collect_wizard_state` | State correctly assembled from components |
| `test_apply_template` | Template state applied to wizard shell |
| `test_network_error_handling` | TypeError wrapped as NETWORK_ERROR |
| `test_destroy_cleanup` | All references nulled, timers cleared |

#### 10.6.3 Integration Tests

| Test | Description |
|------|-------------|
| `test_save_load_roundtrip` | Save a template, load it back, verify identical |
| `test_save_delete_list` | Save, verify in list, delete, verify gone |
| `test_load_apply_verify` | Load template, apply, verify wizard state matches |
| `test_overwrite_flow` | Save, save again with same name + overwrite, verify updated |

#### 10.6.4 E2E Tests (if Playwright available)

| Test | Description |
|------|-------------|
| `test_save_dialog_flow` | Open save dialog, enter name, save, verify toast |
| `test_load_dialog_flow` | Open load dialog, select template, load, verify state |
| `test_delete_from_list` | Open load dialog, delete template, verify removed |
| `test_keyboard_navigation` | Navigate template list with arrow keys |
| `test_accessibility_audit` | Run axe-core on each dialog |

### 10.7 Migration Path from v0 (No Templates)

When EDOG Studio first introduces templates (this feature):

1. No migration needed — there are no existing templates to migrate
2. The `edog-templates.json` file is created lazily on first save
3. The list endpoint returns empty array when file doesn't exist
4. The version field is set to `1` from the start
5. Future versions will add migration functions to the `MIGRATIONS` map

### 10.8 Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Path traversal in template names | Name validation forbids `/`, `\`, and `..` |
| XSS in template names/descriptions | All user input is escaped before HTML insertion (`_escapeHtml()`) |
| JSON injection | Standard `JSON.parse()` / `json.loads()` — no eval |
| File size DoS | Warning at 1MB, error at 10MB (but no hard rejection) |
| Concurrent write corruption | Atomic writes via tempfile + `os.replace()` |
| Template file outside project | File path is always `project_root / "edog-templates.json"` — not user-configurable |

### 10.9 Future Considerations (Out of Scope for v1)

| Feature | Description | Priority |
|---------|-------------|----------|
| Template categories/tags | Organize templates into groups | P2 |
| Template sharing (export/import) | Export as standalone `.edog-template` file | P2 |
| Template preview | Visual preview of DAG topology before loading | P2 |
| Template diff | Compare two templates side-by-side | P3 |
| Global templates | User-level templates shared across projects | P3 |
| Template locking | Prevent accidental overwrite of shared templates | P3 |
| Auto-save draft | Automatically save wizard state as "__draft__" template | P2 |
| Template history | Keep previous versions of overwritten templates | P3 |

---

## Appendix A: Complete Example `edog-templates.json`

```json
{
  "version": 1,
  "templates": [
    {
      "id": "tmpl_1720000000000_a1b2c3",
      "name": "Production Medallion",
      "description": "Full bronze-silver-gold pipeline with 12 source tables",
      "createdAt": "2025-07-15T10:30:00.000Z",
      "updatedAt": "2025-07-15T14:22:00.000Z",
      "version": 1,
      "metadata": {
        "nodeCount": 12,
        "connectionCount": 11,
        "themeId": "midnight",
        "schemaNames": ["dbo", "bronze", "silver", "gold"],
        "wizardVersion": "0.1.0"
      },
      "state": {
        "infrastructure": {
          "workspaceName": "analytics-ws",
          "lakehouseName": "main-lakehouse",
          "notebookName": "etl-pipeline"
        },
        "schemas": {
          "primary": "dbo",
          "medallion": ["bronze", "silver", "gold"]
        },
        "theme": {
          "id": "midnight",
          "customOverrides": {}
        },
        "dag": {
          "nodes": [
            {
              "id": "node_001",
              "name": "customers",
              "type": "source",
              "schema": "dbo",
              "position": { "x": 100, "y": 100 },
              "config": {
                "columns": ["id", "name", "email", "created_at"],
                "primaryKey": "id"
              }
            },
            {
              "id": "node_002",
              "name": "orders",
              "type": "source",
              "schema": "dbo",
              "position": { "x": 100, "y": 250 },
              "config": {
                "columns": ["id", "customer_id", "total", "order_date"],
                "primaryKey": "id"
              }
            },
            {
              "id": "node_003",
              "name": "bronze_customers",
              "type": "transform",
              "schema": "bronze",
              "position": { "x": 350, "y": 100 },
              "config": {
                "transformType": "passthrough",
                "addColumns": ["_load_timestamp"]
              }
            }
          ],
          "connections": [
            {
              "id": "conn_001",
              "sourceNodeId": "node_001",
              "targetNodeId": "node_003",
              "sourcePort": "output",
              "targetPort": "input"
            }
          ],
          "viewport": {
            "x": 0,
            "y": 0,
            "zoom": 1.0
          }
        }
      }
    },
    {
      "id": "tmpl_1720100000000_d4e5f6",
      "name": "Quick Prototype",
      "description": "Simple 3-table layout for rapid prototyping",
      "createdAt": "2025-07-14T09:00:00.000Z",
      "updatedAt": "2025-07-14T09:00:00.000Z",
      "version": 1,
      "metadata": {
        "nodeCount": 3,
        "connectionCount": 2,
        "themeId": "arctic",
        "schemaNames": ["dbo"],
        "wizardVersion": "0.1.0"
      },
      "state": {
        "infrastructure": {
          "workspaceName": "dev-workspace",
          "lakehouseName": "test-lakehouse",
          "notebookName": "prototype"
        },
        "schemas": {
          "primary": "dbo",
          "medallion": []
        },
        "theme": {
          "id": "arctic",
          "customOverrides": {}
        },
        "dag": {
          "nodes": [
            {
              "id": "node_101",
              "name": "users",
              "type": "source",
              "schema": "dbo",
              "position": { "x": 100, "y": 150 },
              "config": {}
            },
            {
              "id": "node_102",
              "name": "products",
              "type": "source",
              "schema": "dbo",
              "position": { "x": 100, "y": 300 },
              "config": {}
            },
            {
              "id": "node_103",
              "name": "user_products",
              "type": "transform",
              "schema": "dbo",
              "position": { "x": 350, "y": 225 },
              "config": {
                "transformType": "join",
                "joinType": "inner"
              }
            }
          ],
          "connections": [
            {
              "id": "conn_101",
              "sourceNodeId": "node_101",
              "targetNodeId": "node_103",
              "sourcePort": "output",
              "targetPort": "left"
            },
            {
              "id": "conn_102",
              "sourceNodeId": "node_102",
              "targetNodeId": "node_103",
              "sourcePort": "output",
              "targetPort": "right"
            }
          ],
          "viewport": {
            "x": -20,
            "y": -50,
            "zoom": 0.85
          }
        }
      }
    }
  ]
}
```

---

## Appendix B: Glossary

| Term | Definition |
|------|-----------|
| **Template** | A named, persistent snapshot of the complete wizard state (DAG + infrastructure + schemas + theme) |
| **Template file** | `edog-templates.json` — the on-disk storage file for all templates in a project |
| **Template ID** | Unique identifier in format `tmpl_{timestamp}_{random6}` |
| **Template metadata** | Denormalized summary fields (node count, theme, etc.) for fast list display |
| **Template state** | The full wizard state snapshot that can restore the wizard to a previous configuration |
| **Atomic write** | Write pattern using tempfile + `os.replace()` to prevent partial writes |
| **Action-based route** | URL pattern like `/api/templates/save` (verb in path) vs REST-style `/api/templates` (verb in HTTP method) |
| **Version migration** | Process of upgrading a template from an older schema version to the current version |
| **Overwrite** | Replacing an existing template with the same name, preserving its ID and creation date |

---

*End of C12-TemplateManager Component Deep Spec*