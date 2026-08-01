BUN ?= $(shell command -v bun 2>/dev/null || echo $(HOME)/.bun/bin/bun)
BIN_DIR ?= $(HOME)/.local/bin

test: ## Testsuite
	$(BUN) test

build: ## Self-contained Binary nach dist/mduct
	$(BUN) run build

install: build ## Binary nach ~/.local/bin (stoppt den laufenden Daemon fürs Ersetzen)
	@mkdir -p $(BIN_DIR)
	@# graceful shutdown so the daemon frees the old inode; ignore if none runs.
	@# NO pkill -f: it matches the make shell's own command line and kills us.
	-$(BIN_DIR)/mduct daemon --stop 2>/dev/null || true
	@# atomic replace: rename swaps the dir entry, so a still-running process
	@# keeps its old inode and we never hit ETXTBSY on the busy target.
	cp dist/mduct $(BIN_DIR)/mduct.new
	chmod +x $(BIN_DIR)/mduct.new
	mv -f $(BIN_DIR)/mduct.new $(BIN_DIR)/mduct
	@echo "installed: $(BIN_DIR)/mduct (daemon autostarts on next call)"

clean: ## Build-Artefakte entfernen
	rm -rf dist

help: ## Targets anzeigen
	@grep -E '^[a-z]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

.PHONY: test build install clean help
