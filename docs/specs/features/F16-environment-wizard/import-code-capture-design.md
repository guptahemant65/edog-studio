# F16 — Import from Lakehouse: Code Capture

**Status:** Design (awaiting review)
**Date:** 2026-06-09
**Author:** Donna (Sana + Pixel + Vex domains)
**Depends on:** `import-lakehouse-design.md` (the import flow this extends)

## 1. Problem

Import-from-Lakehouse replicates an existing lakehouse's DAG **topology**
(node names, MLV-vs-source types, connections) but imports every MLV as a
**codeless shell**. The node data model has no field for a definition, and
`wizard-code-gen.js` always *synthesizes* boilerplate (`SELECT *` from
parents via a theme template) instead of carrying real code.

Result: an imported DAG looks structurally correct but every MLV must be
re-authored by hand before deploy. For a feature whose pitch is "replicate an
existing lakehouse," that is a hollow copy.

## 2. Goal

Carry the **real definition** of each imported MLV onto the canvas node, so a
generated/deployed DAG reproduces the source lakehouse's behavior, not just
its shape. Cover **both** SQL and PySpark MLVs. Rewrite intra-DAG source
references to the imported node names so the copied DAG is internally
consistent.

## 3. Evidence (verified against RobinLH, not assumed)

This design is grounded in live responses to avoid repeating the
speculative-contract bug that mislabeled every MLV as a source table.

- **SQL MLV definition** is free from `getTableMetadata` (OneLake
  `_metadata/table.json.gz`, no deployed FLT required):
  `viewText: "SELECT number FROM dbo.numTennew"`, plus structured
  `sourceEntities` (workspace / artifact / schema / table).
- **DAG `codeReference`** per node: `{ notebookWorkspaceID, notebookID,
  codeIndexArray, eTag }`. For RobinLH's SQL MLVs `codeIndexArray` is
  **null** (code is in `viewText`, no notebook slice needed).
- **All RobinLH MLVs share one `notebookID`** (`c8744836…`). Nodes are not
  1:1 with notebooks — dedupe notebook fetches by `notebookID`.
- **Notebook content** is fetchable via `GET /api/notebook/content?wsId&nbId`
  — but it is a **slow LRO** (`getDefinition`, polls up to ~60s).

### 3.1 Open contract risk (HARD GATE before PySpark build)

`codeIndexArray → cell` mapping for a **PySpark** MLV is **unverified** —
RobinLH has no PySpark MLVs. Implementing the PySpark extraction against an
assumed shape is exactly the trap that caused the prior bug. Therefore the
PySpark path is gated on a spike (§7) against a real PySpark MLV before any
extraction code is written.

## 4. Approach

### 4.1 Node model (`wizard-dag-canvas.js`)
Add two optional fields to `nodeData` in `addNode`:
- `viewText` — the authored SQL/PySpark body (string, empty when none).
- `sourceRefs` — normalized upstream refs `[{schema, table}]` parsed from
  `sourceEntities`, used by ref-rewrite.

Both are inert when empty: existing nodes and the existing template path are
unaffected.

### 4.2 Import capture (`wizard-import-lakehouse.js`)
The fallback path already fetches `getTableMetadata` per MLV for connections
(`_enrichDependenciesFromMetadata`). Extend it (and add an equivalent pass on
the primary DAG path) to also stash `viewText` + parsed `sourceRefs` onto the
item. Promote that onto `nodeData` in `_createNodesAndConnections`.

**Per-node source resolution order:**
1. `getTableMetadata().viewText` present → SQL body. Done.
2. Else (PySpark / empty viewText) → notebook path: group selected MLVs by
   `codeReference.notebookID`, fetch each unique notebook **once** via
   `/api/notebook/content`, slice the node's cell(s) via `codeIndexArray`
   (contract per §7 spike), join into the body.
3. Else → leave `viewText` empty; mark the node `codeImported: false`.

Notebook fetches are bounded-concurrency and deduped; a 60s LRO is shown as a
determinate "Importing definitions…" progress state, cancelable.

### 4.3 Ref-rewrite (chosen: auto-rewrite)
Before storing `viewText`, rewrite source references that match an imported
node to the imported (schema, name). Matching is name-based against the same
`idToName`/imported-set the connection wiring already builds. Unmatched refs
(cross-lakehouse, not-selected) are left verbatim. Rewrite is
**token-boundary aware** (only whole `schema.table` / `table` identifiers,
never substrings) and **logged** per substitution for review.

### 4.4 Code-gen (`wizard-code-gen.js`)
`_generateSqlMlvCell` / `_generatePySparkMlvCell`: when `node.viewText` is
non-empty, emit it **verbatim** inside the appropriate cell wrapper
(`%%sql` + `CREATE MATERIALIZED LAKE VIEW … AS <viewText>` for SQL; the
PySpark wrapper for PySpark). When empty, fall back to today's template
unchanged.

### 4.5 UI signal
Nodes whose code could not be imported (`codeImported: false`) get a visible
"code not imported" badge so the gap is explicit, never silent.

## 5. Components & boundaries

| Unit | Responsibility | Depends on |
|------|----------------|-----------|
| node model | hold `viewText` + `sourceRefs` | none |
| import capture | fetch + attach definitions | metadata + notebook endpoints |
| notebook extractor | notebookID-deduped fetch, cell slice | `/api/notebook/content`, §7 contract |
| ref-rewriter | pure: (viewText, importedSet) → viewText | none (unit-testable) |
| code-gen | prefer real body over template | node model |

The ref-rewriter is a pure function — the riskiest logic is isolated and
independently testable.

## 6. Error handling

- Metadata 404 / notebook LRO timeout / parse error → node imports codeless
  with the badge; never blocks the rest of the import.
- Notebook fetch failure for a shared notebook fails only those nodes, with a
  single toast, not per-node spam.
- Ref-rewrite never throws on unmatched refs — leaves them verbatim.

## 7. PySpark contract spike (gate)

Before writing notebook-extraction code, verify against a real PySpark MLV:
1. The `codeReference.codeIndexArray` value (indices? cell ids?).
2. The notebook `getDefinition` payload shape (base64 ipynb? cells array?).
3. How an index maps to a cell's source.

Capture findings inline here, then implement. If the contract differs from
expectation, the design (not the code) changes first.

## 8. Testing

- **ref-rewriter**: pure unit tests — matched / unmatched / substring-safety /
  schema-qualified vs bare / case-insensitivity.
- **import capture**: replay real RobinLH metadata fixtures → assert SQL
  `viewText` lands on nodes and refs rewrite to imported names.
- **code-gen**: node with `viewText` emits it verbatim; node without falls
  back to template (regression).
- **notebook extractor**: fixture-driven once §7 contract is known.
- Mutation-test the ref-rewriter (break a boundary check, watch a test fail).

## 9. Not doing (V1)

- Importing notebook-level config (Spark settings, params).
- Importing refresh schedules / FLT settings (topology + code only).
- Cross-lakehouse source resolution (left verbatim, as today).
- Editing imported code in-canvas (no SQL editor exists; code surfaces at
  code-gen/review, consistent with current behavior).
