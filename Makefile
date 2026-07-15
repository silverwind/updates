SOURCE_FILES := index.ts api.ts cli.ts config.ts $(wildcard modes/*.ts utils/*.ts)
DIST_FILES := dist/index.js dist/api.js dist/api.d.ts dist/shared.js

node_modules: pnpm-lock.yaml
	pnpm install
	@touch node_modules

.PHONY: deps
deps: node_modules

.PHONY: lint
lint: node_modules
	pnpm exec eslint-silverwind --color .
	pnpm exec tsgo

.PHONY: lint-fix
lint-fix: node_modules
	pnpm exec eslint-silverwind --color . --fix
	pnpm exec tsgo

.PHONY: test
test: node_modules build
	pnpm exec vitest

.PHONY: test-update
test-update: node_modules build
	pnpm exec vitest -u

.PHONY: test-coverage
test-coverage: node_modules build
	pnpm exec vitest --coverage

.PHONY: bench
bench: node_modules build
	node bench/bench.ts

.PHONY: build
build: node_modules $(DIST_FILES)

$(DIST_FILES): $(SOURCE_FILES) pnpm-lock.yaml tsdown.config.ts
	pnpm exec tsdown
	chmod +x $(DIST_FILES)

.PHONY: update
update: update-js update-actions

.PHONY: update-js
update-js: node_modules
	./dist/index.js -u -f package.json
	rm -rf node_modules pnpm-lock.yaml
	pnpm install
	@touch node_modules

.PHONY: publish
publish: node_modules
	pnpm publish --no-git-checks

.PHONY: patch minor major
patch minor major: node_modules lint test
	pnpm exec versions -R $@ package.json

.PHONY: update-actions
update-actions: node_modules
	./dist/index.js -u -M actions
