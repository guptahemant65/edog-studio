# Contributing to edog-studio

Thanks for your interest in improving **edog-studio**! This guide covers everything you need to get started.

---

## Dev Environment Setup

```bash
# 1. Clone the repo
git clone <repo-url>
cd edog-studio

# 2. Create a virtual environment
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux

# 3. Install in editable mode with dev dependencies
pip install -e ".[dev]"

# 4. (Optional) Install pre-commit hooks
pip install pre-commit
pre-commit install
```

## Running Tasks

| Task                | Command                            |
| ------------------- | ---------------------------------- |
| Lint                | `ruff check .`                     |
| Format check        | `ruff format --check .`            |
| Auto-format         | `ruff format .`                    |
| Run tests           | `pytest`                           |
| Tests with coverage | `pytest --cov --cov-report=term`   |
| Build HTML          | `python scripts/build-html.py`     |
| Type check          | `mypy edog.py`                     |
| Full pipeline       | `make all`  *(lint → test → build)*|

## Branch Naming

Use a descriptive prefix:

- `feature/<short-description>` — new functionality
- `fix/<short-description>` — bug fixes
- `cleanup/<short-description>` — refactoring, tech debt
- `docs/<short-description>` — documentation only

Examples: `feature/hivemind-orchestration`, `fix/log-rotation-race`, `cleanup/remove-legacy-endpoints`.

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>

[optional body]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `build`, `ci`, `chore`.

**Examples:**

```
feat(edog): add --watch flag for live reload
fix(build): handle missing template files gracefully
docs(readme): add architecture diagram
test(revert): cover edge case with empty diff
```

## Pull Request Process

1. **Create a branch** from `master` using the naming convention above.
2. **Make your changes** — keep PRs focused on a single concern.
3. **Run the full pipeline** before pushing:
   ```bash
   make all   # or: ruff check . && ruff format --check . && pytest && python scripts/build-html.py
   ```
4. **Open a PR** with a clear description:
   - **What** — concise summary of the change.
   - **Why** — motivation, issue link, or design doc reference.
   - **How** — implementation approach and key decisions.
5. **Address review feedback** — push fixup commits, then squash before merge.
6. **Merge** — use *Squash and merge* to keep a clean history.

## Code Style

- **Python** — enforced by [Ruff](https://docs.astral.sh/ruff/). Line length: 120. Target: Python 3.10+.
- **C#** — follow existing patterns in `src/backend/DevMode/`. CRLF line endings.
- **JS/CSS** — 2-space indent. Keep modules small and focused.

## Questions?

Open an issue or reach out to the team. We're happy to help!
