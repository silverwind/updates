GOLANGCI_PACKAGE ?= github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2
AIR_PACKAGE := github.com/air-verse/air@v1.65.1
GOVULNCHECK_PACKAGE := golang.org/x/vuln/cmd/govulncheck@v1.2.0
MISSPELL_PACKAGE ?= github.com/golangci/misspell/cmd/misspell@v0.8.0  # spell checker
# DISABLED_PACKAGE := github.com/foo/bar@v9.9.9
SOURCE_FILES := $(wildcard *.go)

.PHONY: lint
lint:
	go run $(GOLANGCI_PACKAGE) run
