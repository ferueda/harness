MAKEFLAGS += --no-print-directory --output-sync=target

VERBOSE ?= 0

define RUN
@# Commands with single quotes need an explicit RUN transport update before wrapping.
@VERBOSE="$(VERBOSE)" GATE_STEP_NAME="$(if $(2),$(2),$@)" GATE_STEP_RERUN="$(if $(3),$(3),VERBOSE=1 make $@)" GATE_STEP_COMMAND='$(1)' node scripts/run-gate-step.ts
endef

.PHONY: help ensure-node setup-worktree build lint typecheck test smoke-dist smoke-factory format check-format fix fix-plan check-plan check check-v check-ci

ensure-node: ## Ensure node and pnpm are available
	@command -v node >/dev/null 2>&1 || { echo "node not found in PATH"; exit 1; }
	@command -v pnpm >/dev/null 2>&1 || { echo "pnpm not found in PATH"; exit 1; }
	@if [ "$(VERBOSE)" = "1" ]; then node -v; pnpm -v; fi

setup-worktree: ensure-node ## Prepare a fresh isolated worktree from the shared offline cache
	SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 pnpm install --frozen-lockfile --offline

build: ensure-node ## Build installable JavaScript into dist/
	$(call RUN,pnpm run build)

lint: ensure-node ## Lint source, test, and config files
	$(call RUN,pnpm run lint)

typecheck: ensure-node ## Run strict TypeScript checks
	$(call RUN,pnpm run typecheck)

test: ensure-node ## Run unit tests
	$(call RUN,pnpm run test)

smoke-dist: ensure-node build ## Smoke test the built CLI entrypoint
	$(call RUN,pnpm run smoke:dist)

smoke-factory: ensure-node ## Smoke test the offline Factory system journey
	$(call RUN,pnpm run smoke:factory)

format: ensure-node ## Apply formatting
	pnpm run format

check-format: ensure-node ## Check formatting
	$(call RUN,pnpm run format:check)

fix: ensure-node ## Auto-format and apply lint fixes
	pnpm run format
	pnpm run lint:fix

fix-plan: ensure-node ## Format approved plan-only changes
	pnpm run fix:plan

check-plan: ensure-node ## Run the focused gate for approved plan-only changes
	$(call RUN,pnpm run check:plan)

check: ensure-node ## Quiet full local gate
	@$(MAKE) -j4 check-format lint typecheck test
	@$(MAKE) smoke-dist

check-v: ## Verbose full local gate
	@VERBOSE=1 $(MAKE) check

check-ci: check ## CI gate
	@$(MAKE) smoke-factory

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "%-24s %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
