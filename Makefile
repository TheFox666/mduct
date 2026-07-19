BUN ?= $(shell command -v bun 2>/dev/null || echo $(HOME)/.bun/bin/bun)
BIN_DIR ?= $(HOME)/.local/bin

test: ## Testsuite
	$(BUN) test

build: ## Self-contained Binary nach dist/mux
	$(BUN) run build

install: build ## Binary nach ~/.local/bin (stoppt ALLE laufenden Daemons fürs Ersetzen)
	-$(BIN_DIR)/mux daemon --stop 2>/dev/null
	-pkill -f '$(BIN_DIR)/mux daemon' 2>/dev/null || true
	@sleep 0.5
	@for i in 1 2 3 4 5 6; do \
		cp dist/mux $(BIN_DIR)/mux 2>/dev/null && break; \
		sleep 0.5; \
		[ $$i = 6 ] && { echo "binary busy — Daemons laufen noch? pkill -f '$(BIN_DIR)/mux daemon'"; exit 1; }; \
	done
	@echo "installed: $(BIN_DIR)/mux (daemons autostart on next call)"

clean: ## Build-Artefakte entfernen
	rm -rf dist

help: ## Targets anzeigen
	@grep -E '^[a-z]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

.PHONY: test build install clean help
