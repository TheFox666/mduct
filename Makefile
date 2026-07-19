BUN ?= $(shell command -v bun 2>/dev/null || echo $(HOME)/.bun/bin/bun)
BIN_DIR ?= $(HOME)/.local/bin

test: ## Testsuite
	$(BUN) test

build: ## Self-contained Binary nach dist/mux
	$(BUN) run build

install: build ## Binary nach ~/.local/bin (stoppt laufenden Daemon fürs Ersetzen)
	-$(BIN_DIR)/mux daemon --stop 2>/dev/null
	cp dist/mux $(BIN_DIR)/mux
	@echo "installed: $(BIN_DIR)/mux"

clean: ## Build-Artefakte entfernen
	rm -rf dist

help: ## Targets anzeigen
	@grep -E '^[a-z]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

.PHONY: test build install clean help
