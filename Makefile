# ──────────────────────────────────────────────────────────────────────────────
# edog-studio – Task runner
#
# Usage:  make <target>
# On Windows without make, run the commands directly (shown in each target).
# ──────────────────────────────────────────────────────────────────────────────
.DEFAULT_GOAL := help
PYTHON       ?= python
PIP          ?= pip

.PHONY: help install lint format test build clean all verify vendor vendor-scalar

help: ## Show available targets
	@echo.
	@echo  edog-studio Make targets
	@echo  ========================
	@echo  install  - Install project in editable mode with dev deps
	@echo  lint     - Run ruff linter and format check
	@echo  format   - Auto-format code with ruff
	@echo  test     - Run pytest with coverage
	@echo  build    - Build HTML from templates
	@echo  vendor   - Download all vendored third-party assets (Scalar, etc.)
	@echo  verify   - Run ALL quality gates (build + jscheck + lint + test + gates)
	@echo  clean    - Remove generated / cached files
	@echo  all      - lint + test + build
	@echo.

install: ## Install project with dev dependencies
	$(PIP) install -e ".[dev]"

lint: ## Check code quality (ruff lint + format check)
	ruff check .
	ruff format --check .

format: ## Auto-format Python code
	ruff format .
	ruff check --fix .

test: ## Run tests with coverage
	$(PYTHON) -m pytest --cov --cov-report=term-missing --cov-report=html

build: ## Build HTML artifacts
	$(PYTHON) scripts/build-html.py

clean: ## Remove caches and build artifacts
	$(PYTHON) -c "import shutil, pathlib; [shutil.rmtree(p, True) for p in pathlib.Path('.').rglob('__pycache__')]"
	$(PYTHON) -c "import shutil; shutil.rmtree('.pytest_cache', True); shutil.rmtree('htmlcov', True); shutil.rmtree('.mypy_cache', True); shutil.rmtree('.ruff_cache', True)"
	@echo Cleaned.

all: lint test build ## Run full pipeline: lint → test → build

verify: ## Run ALL quality gates — MANDATORY before every commit
	$(PYTHON) scripts/pre-commit.py

# ── Vendored third-party assets ─────────────────────────────────────────────
# These targets fetch CDN-hosted libraries into scripts/vendor/ so the
# dev-server can serve them locally without phoning home to any third party.
# Files are gitignored — run `make vendor` after a fresh clone.
SCALAR_VERSION ?= 1.57.2

vendor: vendor-scalar ## Download all vendored third-party assets

vendor-scalar: ## Download Scalar API Reference into scripts/vendor/scalar/
	$(PYTHON) scripts/fetch-vendor.py scalar $(SCALAR_VERSION)
