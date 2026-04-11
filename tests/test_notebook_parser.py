"""Specification tests for the Fabric notebook-content.sql parser.

This module provides:
1. A Python reference implementation of the NotebookParser logic
   (mirrors the JS class in src/frontend/js/notebook-parser.js).
2. Comprehensive tests that define expected parsing behaviour,
   acting as a regression guard if the format changes.

Format overview (notebook-content.sql):
    -- Fabric notebook source
    -- METADATA **  (notebook-level when before any CELL/MARKDOWN)
    -- META { json }
    -- MARKDOWN **  (markdown cell boundary)
    -- content lines prefixed with "-- "
    -- CELL **      (code cell boundary)
    -- raw code (SQL default) or "-- MAGIC %%lang" prefixed
    -- METADATA **  (cell-level, attached to preceding cell)
    -- META { json }
"""

from __future__ import annotations

import json
import re
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Reference implementation
# ---------------------------------------------------------------------------


def _flush_cell(
    block_type: str,
    content_lines: list[str],
    meta: dict[str, Any],
) -> dict[str, Any]:
    """Convert accumulated lines into a cell dict.

    Args:
        block_type: Either ``'markdown'`` or ``'cell'``.
        content_lines: Raw lines collected for this block.
        meta: Pre-existing metadata dict (may be empty).

    Returns:
        Cell dict with keys ``type``, ``language``, ``content``, ``meta``.
    """
    cell_type = "markdown" if block_type == "markdown" else "code"
    language = "sparksql"
    content = ""

    if cell_type == "code":
        lines = list(content_lines)
        if lines and lines[0].startswith("-- MAGIC %%"):
            lang_line = lines.pop(0)
            language = lang_line.replace("-- MAGIC %%", "").strip()
            content = "\n".join(ln[len("-- MAGIC ") :] if ln.startswith("-- MAGIC ") else ln for ln in lines)
        else:
            content = "\n".join(lines)
    else:
        content = "\n".join(content_lines)

    # Trim trailing empty lines
    content = re.sub(r"\n+$", "", content)

    return {"type": cell_type, "language": language, "content": content, "meta": meta or {}}


def parse_notebook_content(raw: str) -> dict[str, Any]:
    """Parse ``notebook-content.sql`` text into a structured dict.

    Args:
        raw: Full text of a ``notebook-content.sql`` file.

    Returns:
        Dict with ``notebookMeta`` (object) and ``cells`` (list of cell
        dicts each having ``type``, ``language``, ``content``, ``meta``).
    """
    if not raw or not raw.strip():
        return {"notebookMeta": {}, "cells": []}

    lines = raw.split("\n")
    result: dict[str, Any] = {"notebookMeta": {}, "cells": []}

    current_block: str | None = None
    current_content: list[str] = []
    current_meta: dict[str, Any] = {}
    pending_cell_for_meta: dict[str, Any] | None = None

    for line in lines:
        # --- section boundaries ---
        if line.startswith("-- METADATA **"):
            if current_block in ("markdown", "cell"):
                cell = _flush_cell(current_block, current_content, current_meta)
                result["cells"].append(cell)
                pending_cell_for_meta = cell
                current_content = []
                current_meta = {}
            current_block = "notebook-meta" if (not result["cells"] and pending_cell_for_meta is None) else "cell-meta"
            continue

        if line.startswith("-- MARKDOWN **"):
            if current_block in ("markdown", "cell"):
                cell = _flush_cell(current_block, current_content, current_meta)
                result["cells"].append(cell)
                pending_cell_for_meta = None
            current_block = "markdown"
            current_content = []
            current_meta = {}
            continue

        if line.startswith("-- CELL **"):
            if current_block in ("markdown", "cell"):
                cell = _flush_cell(current_block, current_content, current_meta)
                result["cells"].append(cell)
                pending_cell_for_meta = None
            current_block = "cell"
            current_content = []
            current_meta = {}
            continue

        # --- collect content ---
        if current_block in ("notebook-meta", "cell-meta"):
            if line.startswith("-- META "):
                json_str = line[len("-- META ") :]
                try:
                    meta = json.loads(json_str)
                except (json.JSONDecodeError, ValueError):
                    # Malformed meta — skip
                    continue
                if current_block == "notebook-meta":
                    result["notebookMeta"] = meta
                elif pending_cell_for_meta is not None:
                    pending_cell_for_meta["meta"] = meta
                    if "language" in meta:
                        pending_cell_for_meta["language"] = meta["language"]
            continue

        if current_block == "markdown":
            current_content.append(line[3:] if line.startswith("-- ") else line)
        elif current_block == "cell":
            current_content.append(line)

    # Flush final block
    if current_block in ("markdown", "cell"):
        result["cells"].append(_flush_cell(current_block, current_content, current_meta))

    return result


def serialize_notebook(notebook: dict[str, Any]) -> str:
    """Serialize a parsed notebook dict back to ``notebook-content.sql``.

    Args:
        notebook: Dict with ``notebookMeta`` and ``cells`` as returned by
            :func:`parse_notebook_content`.

    Returns:
        Raw ``notebook-content.sql`` text.
    """
    lines: list[str] = ["-- Fabric notebook source"]

    # Notebook-level metadata
    lines.append("-- METADATA ********************")
    lines.append(f"-- META {json.dumps(notebook['notebookMeta'])}")
    lines.append("")

    for cell in notebook["cells"]:
        if cell["type"] == "markdown":
            lines.append("-- MARKDOWN ********************")
            for ln in cell["content"].split("\n"):
                lines.append(f"-- {ln}")
        else:
            lines.append("-- CELL ********************")
            if cell.get("language") and cell["language"] != "sparksql":
                lines.append(f"-- MAGIC %%{cell['language']}")
                for ln in cell["content"].split("\n"):
                    lines.append(f"-- MAGIC {ln}")
            else:
                lines.append(cell["content"])

        # Cell metadata
        if cell.get("meta") and len(cell["meta"]) > 0:
            lines.append("")
            lines.append("-- METADATA ********************")
            lines.append(f"-- META {json.dumps(cell['meta'])}")

        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SAMPLE_NOTEBOOK = """\
-- Fabric notebook source
-- METADATA ********************
-- META {"kernel_info":{"name":"synapse_pyspark"},"dependencies":{"lakehouse":{"default_lakehouse":"a96fdc44"}}}

-- MARKDOWN ********************
-- # Create materialized lake views
-- 1. Use this notebook to create materialized lake views.
-- 2. Select Run all to run the notebook.

-- CELL ********************
CREATE MATERIALIZED lake VIEW dbo.mvFromOne
AS SELECT * from dbo.numTen;

-- METADATA ********************
-- META {"language":"sparksql","language_group":"synapse_pyspark"}

-- CELL ********************
-- MAGIC %%pyspark
-- MAGIC from notebookutils import mssparkutils
-- MAGIC import zlib, json

-- METADATA ********************
-- META {"language":"python","language_group":"synapse_pyspark"}

-- CELL ********************
-- MAGIC %%pyspark
-- MAGIC # Empty cell with just a comment

-- METADATA ********************
-- META {"language":"python","language_group":"synapse_pyspark"}"""


@pytest.fixture()
def sample_parsed() -> dict[str, Any]:
    """Return the parsed sample notebook for reuse across tests."""
    return parse_notebook_content(SAMPLE_NOTEBOOK)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestCellCount:
    """Verify cell boundary detection and total count."""

    def test_parse_cell_count(self, sample_parsed: dict[str, Any]) -> None:
        """Sample has 4 cells: 1 markdown + 3 code."""
        assert len(sample_parsed["cells"]) == 4

    def test_parse_cell_types(self, sample_parsed: dict[str, Any]) -> None:
        """First cell is markdown, remaining three are code."""
        types = [c["type"] for c in sample_parsed["cells"]]
        assert types == ["markdown", "code", "code", "code"]


class TestNotebookMeta:
    """Verify notebook-level metadata extraction."""

    def test_parse_notebook_meta(self, sample_parsed: dict[str, Any]) -> None:
        """Notebook meta has kernel_info and dependencies."""
        meta = sample_parsed["notebookMeta"]
        assert "kernel_info" in meta
        assert meta["kernel_info"]["name"] == "synapse_pyspark"
        assert "dependencies" in meta
        assert meta["dependencies"]["lakehouse"]["default_lakehouse"] == "a96fdc44"


class TestMarkdownCell:
    """Verify markdown cell parsing."""

    def test_parse_markdown_cell(self, sample_parsed: dict[str, Any]) -> None:
        """Markdown cell has type=markdown, '-- ' prefix stripped."""
        md = sample_parsed["cells"][0]
        assert md["type"] == "markdown"
        assert md["content"].startswith("# Create materialized lake views")
        assert "-- " not in md["content"]

    def test_markdown_content_multiline(self, sample_parsed: dict[str, Any]) -> None:
        """Markdown cell preserves all content lines."""
        md = sample_parsed["cells"][0]
        lines = md["content"].split("\n")
        assert len(lines) == 3
        assert lines[1].startswith("1. Use this notebook")


class TestSQLCell:
    """Verify plain SQL code cell parsing."""

    def test_parse_sql_cell(self, sample_parsed: dict[str, Any]) -> None:
        """SQL cell: type=code, language=sparksql, no MAGIC prefix in content."""
        sql = sample_parsed["cells"][1]
        assert sql["type"] == "code"
        assert sql["language"] == "sparksql"
        assert "CREATE MATERIALIZED" in sql["content"]
        assert "-- MAGIC" not in sql["content"]


class TestPythonCell:
    """Verify MAGIC-prefixed code cells."""

    def test_parse_python_cell(self, sample_parsed: dict[str, Any]) -> None:
        """Python cell: type=code, language=python (from meta), MAGIC stripped."""
        py = sample_parsed["cells"][2]
        assert py["type"] == "code"
        # Language is set to 'python' by cell-level meta override
        assert py["language"] == "python"
        assert "from notebookutils import mssparkutils" in py["content"]
        assert "-- MAGIC" not in py["content"]

    def test_python_cell_magic_stripped(self, sample_parsed: dict[str, Any]) -> None:
        """All '-- MAGIC ' prefixes are removed from content."""
        py = sample_parsed["cells"][2]
        for line in py["content"].split("\n"):
            assert not line.startswith("-- MAGIC")


class TestCellMetadata:
    """Verify cell-level META attachment."""

    def test_parse_cell_metadata(self, sample_parsed: dict[str, Any]) -> None:
        """Cell-level META is attached to preceding cell."""
        sql = sample_parsed["cells"][1]
        assert sql["meta"]["language"] == "sparksql"
        assert sql["meta"]["language_group"] == "synapse_pyspark"

    def test_python_cell_metadata(self, sample_parsed: dict[str, Any]) -> None:
        """Python cell has language and language_group in meta."""
        py = sample_parsed["cells"][2]
        assert py["meta"]["language"] == "python"
        assert py["meta"]["language_group"] == "synapse_pyspark"


class TestEdgeCases:
    """Edge cases and error handling."""

    def test_parse_empty_content(self) -> None:
        """Empty string returns empty cells array."""
        result = parse_notebook_content("")
        assert result == {"notebookMeta": {}, "cells": []}

    def test_parse_whitespace_only(self) -> None:
        """Whitespace-only returns empty cells array."""
        result = parse_notebook_content("   \n\n  ")
        assert result == {"notebookMeta": {}, "cells": []}

    def test_parse_malformed_meta(self) -> None:
        """Invalid JSON in META line does not crash."""
        raw = (
            "-- Fabric notebook source\n"
            "-- METADATA ********************\n"
            "-- META {not valid json!}\n"
            "\n"
            "-- CELL ********************\n"
            "SELECT 1"
        )
        result = parse_notebook_content(raw)
        # Notebook meta stays empty (JSON parse failed)
        assert result["notebookMeta"] == {}
        # Cell still parsed
        assert len(result["cells"]) == 1
        assert result["cells"][0]["content"] == "SELECT 1"

    def test_parse_no_metadata_sections(self) -> None:
        """Content with only CELL blocks (no META sections)."""
        raw = "-- CELL ********************\nSELECT 1\n\n-- CELL ********************\nSELECT 2"
        result = parse_notebook_content(raw)
        assert len(result["cells"]) == 2
        assert result["notebookMeta"] == {}
        assert result["cells"][0]["content"] == "SELECT 1"
        assert result["cells"][1]["content"] == "SELECT 2"


class TestMultipleMagicLanguages:
    """Cells with different MAGIC language overrides."""

    def test_parse_multiple_magic_languages(self) -> None:
        """Different cells with %%pyspark and %%sql get correct languages."""
        raw = (
            "-- CELL ********************\n"
            "-- MAGIC %%pyspark\n"
            "-- MAGIC print('hello')\n"
            "\n"
            "-- CELL ********************\n"
            "-- MAGIC %%sql\n"
            "-- MAGIC SELECT 1"
        )
        result = parse_notebook_content(raw)
        assert len(result["cells"]) == 2
        assert result["cells"][0]["language"] == "pyspark"
        assert "print('hello')" in result["cells"][0]["content"]
        assert result["cells"][1]["language"] == "sql"
        assert "SELECT 1" in result["cells"][1]["content"]


class TestBlankLines:
    """Cells with blank lines preserve them."""

    def test_parse_cell_with_empty_lines(self) -> None:
        """Blank lines inside a cell are preserved."""
        raw = "-- CELL ********************\nSELECT 1\n\nSELECT 2\n\n\nSELECT 3"
        result = parse_notebook_content(raw)
        cell = result["cells"][0]
        assert cell["content"] == "SELECT 1\n\nSELECT 2\n\n\nSELECT 3"

    def test_trailing_blank_lines_trimmed(self) -> None:
        """Trailing blank lines in a cell are trimmed."""
        raw = "-- CELL ********************\nSELECT 1\n\n\n"
        result = parse_notebook_content(raw)
        assert result["cells"][0]["content"] == "SELECT 1"


class TestRoundtrip:
    """Serialize → parse roundtrip stability."""

    def test_roundtrip_serialize(self, sample_parsed: dict[str, Any]) -> None:
        """parse(serialize(parse(raw))) == parse(raw)."""
        serialized = serialize_notebook(sample_parsed)
        reparsed = parse_notebook_content(serialized)

        assert reparsed["notebookMeta"] == sample_parsed["notebookMeta"]
        assert len(reparsed["cells"]) == len(sample_parsed["cells"])

        for orig, rp in zip(sample_parsed["cells"], reparsed["cells"], strict=True):
            assert rp["type"] == orig["type"]
            assert rp["content"] == orig["content"]

    def test_roundtrip_preserves_cell_count(self) -> None:
        """Roundtrip of minimal notebook keeps cell count."""
        raw = (
            "-- Fabric notebook source\n"
            "-- METADATA ********************\n"
            "-- META {}\n"
            "\n"
            "-- CELL ********************\n"
            "SELECT 1\n"
            "\n"
            "-- MARKDOWN ********************\n"
            "-- hello"
        )
        first = parse_notebook_content(raw)
        second = parse_notebook_content(serialize_notebook(first))
        assert len(second["cells"]) == len(first["cells"])
        assert [c["type"] for c in second["cells"]] == [c["type"] for c in first["cells"]]


class TestDefaultLanguage:
    """Verify default language assignment."""

    def test_default_language_is_sparksql(self) -> None:
        """Code cells without MAGIC default to sparksql."""
        raw = "-- CELL ********************\nSELECT 42"
        result = parse_notebook_content(raw)
        assert result["cells"][0]["language"] == "sparksql"

    def test_markdown_language_is_sparksql(self) -> None:
        """Markdown cells also get sparksql as language (from _flush_cell default)."""
        raw = "-- MARKDOWN ********************\n-- hello"
        result = parse_notebook_content(raw)
        assert result["cells"][0]["language"] == "sparksql"


class TestMetaOverridesLanguage:
    """Cell-level META language overrides the MAGIC-detected language."""

    def test_cell_meta_overrides_magic_language(self) -> None:
        """META language field takes precedence after flush."""
        raw = (
            "-- CELL ********************\n"
            "-- MAGIC %%pyspark\n"
            "-- MAGIC x = 1\n"
            "\n"
            "-- METADATA ********************\n"
            '-- META {"language":"python","language_group":"synapse_pyspark"}'
        )
        result = parse_notebook_content(raw)
        cell = result["cells"][0]
        # META says 'python', overriding the %%pyspark MAGIC
        assert cell["language"] == "python"
        assert cell["meta"]["language"] == "python"
