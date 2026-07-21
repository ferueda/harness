MAKEFLAGS += --no-print-directory --output-sync=target

VERBOSE ?= 0

PNPM_STORE_PATH = env -u PNPM_CONFIG_STORE_DIR -u pnpm_config_store_dir pnpm store path
PNPM = env -u pnpm_config_store_dir PNPM_CONFIG_STORE_DIR="$$($(PNPM_STORE_PATH))" pnpm

define RUN
@# Commands with single quotes need an explicit RUN transport update before wrapping.
@VERBOSE="$(VERBOSE)" GATE_STEP_NAME="$(if $(2),$(2),$@)" GATE_STEP_RERUN="$(if $(3),$(3),VERBOSE=1 make $@)" GATE_STEP_COMMAND='$(1)' node scripts/run-gate-step.ts
endef

.PHONY: help ensure-node setup-worktree build lint typecheck test smoke-dist smoke-linear-automation smoke-linear-automation-compose format check-format fix fix-plan check-plan check check-v check-ci

ensure-node: ## Ensure node and pnpm are available
	@command -v node >/dev/null 2>&1 || { echo "node not found in PATH"; exit 1; }
	@command -v pnpm >/dev/null 2>&1 || { echo "pnpm not found in PATH"; exit 1; }
	@if [ "$(VERBOSE)" = "1" ]; then node -v; pnpm -v; fi

setup-worktree: ensure-node ## Prepare a fresh isolated worktree from the shared offline cache
	CI=1 SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 $(PNPM) install --frozen-lockfile --offline

build: ensure-node ## Build installable JavaScript into dist/
	$(call RUN,$(PNPM) run build)

lint: ensure-node ## Lint source, test, and config files
	$(call RUN,$(PNPM) run lint)

typecheck: ensure-node ## Run strict TypeScript checks
	$(call RUN,$(PNPM) run typecheck)

test: ensure-node ## Run unit tests
	$(call RUN,$(PNPM) run test)

smoke-dist: ensure-node build ## Smoke test the built CLI entrypoint
	$(call RUN,$(PNPM) run smoke:dist)

smoke-linear-automation: ensure-node ## Smoke test the offline Linear automation journey
	$(call RUN,$(PNPM) run smoke:linear-automation)

smoke-linear-automation-compose: ensure-node ## Smoke test the Docker Compose packaging boundary
	$(call RUN,$(PNPM) run smoke:linear-automation-compose)

format: ensure-node ## Apply formatting
	$(PNPM) run format

check-format: ensure-node ## Check formatting
	$(call RUN,$(PNPM) run format:check)

fix: ensure-node ## Auto-format and apply lint fixes
	$(PNPM) run format
	$(PNPM) run lint:fix

fix-plan: ensure-node ## Format approved plan-only changes
	$(PNPM) run fix:plan

check-plan: ensure-node ## Run the focused gate for approved plan-only changes
	$(call RUN,$(PNPM) run check:plan)

check: ensure-node ## Quiet full local gate
	@$(MAKE) -j4 check-format lint typecheck test
	@$(MAKE) smoke-dist

check-v: ## Verbose full local gate
	@VERBOSE=1 $(MAKE) check

check-ci: check ## CI gate
	@$(MAKE) smoke-linear-automation

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "%-24s %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
