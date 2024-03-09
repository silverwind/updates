SRC := updates.js
DST := dist/updates.js

node_modules: package-lock.json
	npm install --no-save
	@touch node_modules

.PHONY: deps
deps: node_modules

.PHONY: lint
lint: node_modules
	npx eslint --color .

.PHONY: lint-fix
lint-fix: node_modules
	npx eslint --color . --fix

.PHONY: test
test: node_modules build
	npx vitest

.PHONY: test-update
test-update: node_modules build
	npx vitest -u

.PHONY: build
build: $(DST)

$(DST): $(SRC) node_modules
# workaround for https://github.com/evanw/esbuild/issues/1921
	npx esbuild --log-level=warning --platform=node --target=node18 --format=esm --bundle --minify --legal-comments=none --banner:js="import {createRequire} from 'module';const require = createRequire(import.meta.url);" --define:import.meta.VERSION=\"$(shell jq .version package.json)\" --outfile=$(DST) $(SRC) --external:undici
	chmod +x $(DST)

.PHONY: publish
publish: node_modules
	git push -u --tags origin master
	npm publish

.PHONY: update
update: node_modules build
	node $(DST) -u
	rm -rf node_modules package-lock.json
	npm install
	@touch node_modules

.PHONY: patch
patch: node_modules lint test
	npx versions -c 'make --no-print-directory build' patch package.json package-lock.json
	@$(MAKE) --no-print-directory publish

.PHONY: minor
minor: node_modules lint test
	npx versions -c 'make --no-print-directory build' minor package.json package-lock.json
	@$(MAKE) --no-print-directory publish

.PHONY: major
major: node_modules lint test
	npx versions -c 'make --no-print-directory build' major package.json package-lock.json
	@$(MAKE) --no-print-directory publish
