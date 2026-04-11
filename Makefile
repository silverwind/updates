SOURCE_FILES := index.ts api.ts config.ts $(wildcard modes/*.ts utils/*.ts)
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

.PHONY: build
build: node_modules $(DIST_FILES)

$(DIST_FILES): $(SOURCE_FILES) pnpm-lock.yaml tsdown.config.ts
	pnpm exec tsdown
	chmod +x $(DIST_FILES)

.PHONY: update
update: node_modules
	./dist/index.js -cu
	rm -rf node_modules pnpm-lock.yaml
	pnpm install
	@touch node_modules

.PHONY: publish
publish: node_modules
	pnpm publish --no-git-checks

.PHONY: patch
patch: node_modules lint test
	pnpm exec versions -R patch package.json
	git push -u --tags origin master

.PHONY: minor
minor: node_modules lint test
	pnpm exec versions -R minor package.json
	git push -u --tags origin master

.PHONY: major
major: node_modules lint test
	pnpm exec versions -R major package.json
	git push -u --tags origin master
