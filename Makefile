MAKEFLAGS += --no-print-directory --output-sync=target

VERBOSE ?= 0

define RUN
@if [ "$(VERBOSE)" = "1" ]; then $(1); else tmp="$$(mktemp)"; if ( $(1) ) >"$$tmp" 2>&1; then rm -f "$$tmp"; else cat "$$tmp"; rm -f "$$tmp"; exit 1; fi; fi
endef

.PHONY: help ensure-node build lint typecheck test smoke-dist format check-format fix check check-v check-ci

ensure-node: ## Ensure node and pnpm are available
	@command -v node >/dev/null 2>&1 || { echo "node not found in PATH"; exit 1; }
	@command -v pnpm >/dev/null 2>&1 || { echo "pnpm not found in PATH"; exit 1; }
	@if [ "$(VERBOSE)" = "1" ]; then node -v; pnpm -v; fi

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

format: ensure-node ## Apply formatting
	pnpm run format

check-format: ensure-node ## Check formatting
	$(call RUN,pnpm run format:check)

fix: ensure-node ## Auto-format and apply lint fixes
	pnpm run format
	pnpm run lint:fix

check: ensure-node ## Quiet full local gate
	@$(MAKE) -j4 check-format lint typecheck test
	@$(MAKE) smoke-dist

check-v: ## Verbose full local gate
	@VERBOSE=1 $(MAKE) check

check-ci: check ## CI gate

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "%-24s %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
