/**
 * NotebookParser — Parse and serialize Fabric notebook-content.sql format.
 *
 * Fabric notebooks stored via updateDefinition use a custom SQL-comment-based
 * format with METADATA, MARKDOWN, and CELL boundaries. This class provides
 * lossless round-trip parsing and serialization for that format.
 *
 * Usage:
 *   const nb = NotebookParser.parse(raw);
 *   const raw2 = NotebookParser.serialize(nb);
 */
class NotebookParser {
  /**
   * Parse a raw notebook-content.sql string into a structured notebook object.
   *
   * @param {string} raw — Raw notebook-content.sql text.
   * @returns {{ notebookMeta: object, cells: Array<{type: string, language: string, content: string, meta: object}> }}
   */
  static parse(raw) {
    if (!raw || typeof raw !== 'string') {
      return { notebookMeta: {}, cells: [] };
    }

    const lines = raw.split('\n');
    const notebookMeta = {};
    const cells = [];

    let state = 'header'; // 'header' | 'markdown' | 'code' | 'cell_meta'
    let currentCell = null;
    let contentLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect boundary markers
      if (NotebookParser._isMetadataBoundary(line)) {
        // If we have an open cell, finalize it before handling metadata
        if (currentCell) {
          currentCell.content = NotebookParser._trimTrailingEmpty(contentLines).join('\n');
          contentLines = [];
        }

        // Collect META lines following this boundary
        const meta = NotebookParser._collectMeta(lines, i + 1);
        i += meta.linesConsumed;

        if (state === 'header' && cells.length === 0 && !currentCell) {
          // Notebook-level metadata (before any CELL or MARKDOWN)
          Object.assign(notebookMeta, meta.data);
        } else if (currentCell) {
          // Cell-level metadata (applies to the preceding cell)
          currentCell.meta = meta.data;
          cells.push(currentCell);
          currentCell = null;
          state = 'cell_meta';
        }
        continue;
      }

      if (NotebookParser._isMarkdownBoundary(line)) {
        // Finalize any open cell that lacks trailing metadata
        if (currentCell) {
          currentCell.content = NotebookParser._trimTrailingEmpty(contentLines).join('\n');
          cells.push(currentCell);
        }
        currentCell = { type: 'markdown', language: 'markdown', content: '', meta: {} };
        contentLines = [];
        state = 'markdown';
        continue;
      }

      if (NotebookParser._isCellBoundary(line)) {
        // Finalize any open cell that lacks trailing metadata
        if (currentCell) {
          currentCell.content = NotebookParser._trimTrailingEmpty(contentLines).join('\n');
          cells.push(currentCell);
        }
        currentCell = { type: 'code', language: 'sparksql', content: '', meta: {} };
        contentLines = [];
        state = 'code';
        continue;
      }

      // Content accumulation based on state
      if (state === 'header') {
        // Skip header lines (e.g., "-- Fabric notebook source", blank lines)
        continue;
      }

      if (state === 'markdown') {
        // Markdown lines are prefixed with "-- "
        if (line.startsWith('-- ')) {
          contentLines.push(line.slice(3));
        } else if (line === '--') {
          contentLines.push('');
        } else if (line.trim() === '') {
          contentLines.push('');
        } else {
          contentLines.push(line);
        }
        continue;
      }

      if (state === 'code') {
        // First non-empty content line may set a MAGIC language override
        if (contentLines.length === 0 && line.trim() === '') {
          contentLines.push('');
          continue;
        }

        const magicLang = NotebookParser._parseMagicLanguage(line);
        if (magicLang && contentLines.every(l => l.trim() === '')) {
          // Language override on first substantive line
          currentCell.language = magicLang;
          currentCell._hasMagic = true;
          contentLines = [];
          continue;
        }

        if (currentCell._hasMagic && line.startsWith('-- MAGIC ')) {
          contentLines.push(line.slice(9));
        } else if (currentCell._hasMagic && line === '-- MAGIC') {
          contentLines.push('');
        } else {
          contentLines.push(line);
        }
        continue;
      }

      // state === 'cell_meta': between a cell's metadata and the next boundary
      // skip blank lines and stray content
    }

    // Finalize any trailing cell without metadata
    if (currentCell) {
      currentCell.content = NotebookParser._trimTrailingEmpty(contentLines).join('\n');
      cells.push(currentCell);
    }

    // Clean up internal flags
    for (const cell of cells) {
      delete cell._hasMagic;
    }

    return { notebookMeta, cells };
  }

  /**
   * Serialize a structured notebook object back to notebook-content.sql format.
   *
   * @param {{ notebookMeta: object, cells: Array<{type: string, language: string, content: string, meta: object}> }} notebook
   * @returns {string} Raw notebook-content.sql text.
   */
  static serialize(notebook) {
    if (!notebook) return '';

    const parts = [];
    const meta = notebook.notebookMeta || {};
    const cells = notebook.cells || [];

    // Header
    parts.push('-- Fabric notebook source');

    // Notebook-level metadata
    if (Object.keys(meta).length > 0) {
      parts.push('-- METADATA ********************');
      parts.push(`-- META ${JSON.stringify(meta)}`);
    }

    for (const cell of cells) {
      parts.push('');

      if (cell.type === 'markdown') {
        parts.push('-- MARKDOWN ********************');
        const contentLines = (cell.content || '').split('\n');
        for (const line of contentLines) {
          parts.push(line === '' ? '--' : `-- ${line}`);
        }
      } else {
        // Code cell
        parts.push('-- CELL ********************');
        const isMagicLang = NotebookParser._isMagicLanguage(cell.language);

        if (isMagicLang) {
          const magicTag = NotebookParser._languageToMagicTag(cell.language);
          parts.push(`-- MAGIC %%${magicTag}`);
          const contentLines = (cell.content || '').split('\n');
          for (const line of contentLines) {
            parts.push(line === '' ? '-- MAGIC' : `-- MAGIC ${line}`);
          }
        } else {
          // Default SQL — raw lines
          const contentLines = (cell.content || '').split('\n');
          for (const line of contentLines) {
            parts.push(line);
          }
        }
      }

      // Cell-level metadata
      const cellMeta = cell.meta || {};
      if (Object.keys(cellMeta).length > 0) {
        parts.push('');
        parts.push('-- METADATA ********************');
        parts.push(`-- META ${JSON.stringify(cellMeta)}`);
      }
    }

    return parts.join('\n');
  }

  // ── Private helpers ────────────────────────────────────────────

  /** @returns {boolean} True if line is a METADATA boundary. */
  static _isMetadataBoundary(line) {
    return line.startsWith('-- METADATA **');
  }

  /** @returns {boolean} True if line is a MARKDOWN boundary. */
  static _isMarkdownBoundary(line) {
    return line.startsWith('-- MARKDOWN **');
  }

  /** @returns {boolean} True if line is a CELL boundary. */
  static _isCellBoundary(line) {
    return line.startsWith('-- CELL **');
  }

  /**
   * Collect META JSON lines following a METADATA boundary.
   * Handles both single-line META (-- META {...}) and multi-line META
   * where each line is prefixed with "-- META ".
   * @param {string[]} lines — All lines of the file.
   * @param {number} startIdx — Index to begin scanning.
   * @returns {{ data: object, linesConsumed: number }}
   */
  static _collectMeta(lines, startIdx) {
    let data = {};
    let consumed = 0;
    const metaLines = [];

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('-- META ')) {
        metaLines.push(line.slice(8)); // Strip "-- META " prefix
        consumed = i - startIdx + 1;
      } else if (line.trim() === '' || line === '--') {
        consumed = i - startIdx + 1;
      } else {
        break;
      }
    }

    if (metaLines.length > 0) {
      const jsonStr = metaLines.join('\n');
      try {
        data = JSON.parse(jsonStr);
      } catch {
        // Try joining without newlines (compact format)
        try {
          data = JSON.parse(metaLines.join(''));
        } catch {
          // Malformed meta — leave as empty
        }
      }
    }

    return { data, linesConsumed: consumed };
  }

  /**
   * Parse a MAGIC language tag from a cell's first line.
   * @param {string} line
   * @returns {string|null} Language name, or null if not a magic line.
   */
  static _parseMagicLanguage(line) {
    const match = line.match(/^-- MAGIC %%(\w+)/);
    return match ? match[1] : null;
  }

  /**
   * Whether a language requires MAGIC prefix serialization.
   * SQL/sparksql are written as raw lines; everything else uses MAGIC.
   */
  static _isMagicLanguage(language) {
    const raw = (language || '').toLowerCase();
    return raw !== 'sparksql' && raw !== 'sql';
  }

  /**
   * Map a parsed language name to its MAGIC %% tag.
   * @param {string} language
   * @returns {string}
   */
  static _languageToMagicTag(language) {
    const map = {
      pyspark: 'pyspark',
      python: 'pyspark',
      scala: 'scala',
      r: 'sparkr',
      sparkr: 'sparkr',
      csharp: 'csharp',
    };
    const key = (language || '').toLowerCase();
    return map[key] || key;
  }

  /**
   * Trim trailing empty strings from an array of lines.
   * @param {string[]} lines
   * @returns {string[]}
   */
  static _trimTrailingEmpty(lines) {
    const copy = [...lines];
    while (copy.length > 0 && copy[copy.length - 1].trim() === '') {
      copy.pop();
    }
    return copy;
  }
}
