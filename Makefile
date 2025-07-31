SOURCE_FILES := index.ts
DIST_FILES := dist/index.js

ifeq ($(shell sed --version 2>/dev/null | grep -q GNU && echo gnu),gnu)
	SED_INPLACE := sed -i
else
	SED_INPLACE := sed -i ''
endif

node_modules: package-lock.json
	npm install --no-save
	@touch node_modules

.PHONY: deps
deps: node_modules

.PHONY: lint
lint: node_modules
	npx eslint --ext js,jsx,ts,tsx --color .
	npx tsc

.PHONY: lint-fix
lint-fix: node_modules
	npx eslint --ext js,jsx,ts,tsx --color . --fix
	npx tsc

.PHONY: test
test: node_modules build
	npx vitest

.PHONY: test-update
test-update: node_modules build
	npx vitest -u

.PHONY: hashbang
hashbang:
	@$(SED_INPLACE) "1s/.*/\#\!\/usr\/bin\/env node/" dist/index.js

.PHONY: build
build: node_modules $(DIST_FILES)

$(DIST_FILES): $(SOURCE_FILES) package-lock.json vite.config.ts
	npx vite build
	@$(MAKE) --no-print-directory hashbang
	chmod +x $(DIST_FILES)

.PHONY: publish
publish: node_modules
	git push -u --tags origin master
	npm publish

.PHONY: update
update: node_modules
	npx updates -cu
	rm -rf node_modules package-lock.json
	npm install
	@touch node_modules

.PHONY: path
patch: node_modules lint test
	npx versions patch package.json package-lock.json
	@$(MAKE) --no-print-directory build publish

.PHONY: minor
minor: node_modules lint test
	npx versions minor package.json package-lock.json
	@$(MAKE) --no-print-directory build publish

.PHONY: major
major: node_modules lint test
	npx versions major package.json package-lock.json
	@$(MAKE) --no-print-directory build publish
