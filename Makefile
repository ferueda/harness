MAKEFLAGS += --no-print-directory --output-sync=target

VERBOSE ?= 0

RECORDED_PNPM_STORE := $(shell node -e 'const { readFileSync } = require("node:fs"); const { resolve } = require("node:path"); try { const value = JSON.parse(readFileSync("node_modules/.modules.yaml", "utf8")).storeDir; if (typeof value === "string" && value) process.stdout.write(resolve(value)); } catch {}' 2>/dev/null)

unexport PNPM_CONFIG_STORE_DIR
unexport pnpm_config_store_dir
unexport NPM_CONFIG_STORE_DIR
unexport npm_config_store_dir
unexport PNPM_CONFIG_FROZEN_STORE
unexport pnpm_config_frozen_store
unexport NPM_CONFIG_FROZEN_STORE
unexport npm_config_frozen_store
ifneq ($(RECORDED_PNPM_STORE),)
override PNPM_CONFIG_STORE_DIR := $(RECORDED_PNPM_STORE)
override PNPM_CONFIG_FROZEN_STORE := true
export PNPM_CONFIG_STORE_DIR
export PNPM_CONFIG_FROZEN_STORE
endif

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
	@store_dir="$(RECORDED_PNPM_STORE)"; \
	if [ -z "$$store_dir" ]; then \
		store_dir="$$(env -u PNPM_CONFIG_STORE_DIR -u pnpm_config_store_dir -u NPM_CONFIG_STORE_DIR -u npm_config_store_dir pnpm store path)"; \
	fi; \
	CI=1 SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 pnpm install --frozen-lockfile --offline --store-dir "$$store_dir"

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
