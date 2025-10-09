SOURCE_FILES := index.ts
DIST_FILES := dist/index.js

node_modules: package-lock.json
	npm install --no-save
	@touch node_modules

.PHONY: deps
deps: node_modules

.PHONY: lint
lint: node_modules
	npx eslint --color .
	npx tsc

.PHONY: lint-fix
lint-fix: node_modules
	npx eslint --color . --fix
	npx tsc

.PHONY: test
test: node_modules build
	npx vitest

.PHONY: test-update
test-update: node_modules build
	npx vitest -u

.PHONY: build
build: node_modules $(DIST_FILES)

$(DIST_FILES): $(SOURCE_FILES) package-lock.json tsdown.config.ts
	npx tsdown
	chmod +x $(DIST_FILES)

.PHONY: update
update: node_modules
	./dist/index.js -cu
	rm -rf node_modules package-lock.json
	npm install
	@touch node_modules

.PHONY: publish
publish: node_modules
	npm publish --provenance --access public

.PHONY: patch
patch: node_modules lint test
	npx versions patch package.json package-lock.json
	git push -u --tags origin master

.PHONY: minor
minor: node_modules lint test
	npx versions minor package.json package-lock.json
	git push -u --tags origin master

.PHONY: major
major: node_modules lint test
	npx versions major package.json package-lock.json
	git push -u --tags origin master
