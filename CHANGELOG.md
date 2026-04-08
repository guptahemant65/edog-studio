# Changelog

All notable changes to **edog-studio** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] — 2026-04-08

### Added

- **edog-studio** — forked from `flt-edog-devmode` as a standalone engineering tool.
- Hivemind team integration for multi-agent orchestration.
- Design spec v2 (`edog-design-spec-v2.md`) defining the architecture and extension points.
- Modern project structure with `src/frontend/` (JS + CSS modules) and `src/backend/` (C# DevMode).
- Build pipeline (`scripts/build-html.py`) to assemble frontend assets.
- Configuration layer (`config/`) for edog runtime settings.
- Comprehensive documentation (`docs/`) covering setup, usage, and design.

### Changed

- CLI (`edog.py`) rewritten for modular command dispatch.

### Removed

- Legacy single-file HTML build process.

---

*For earlier history, see the `flt-edog-devmode` repository.*
