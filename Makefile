SRC := updates.js
DST := bin/updates.js

node_modules: package-lock.json
	npm install --no-save
	@touch node_modules

.PHONY: deps
deps: node_modules

.PHONY: lint
lint: node_modules
	npx eslint --color .

.PHONY: test
test: node_modules lint build
	npx vitest

.PHONY: build
build: $(DST)

$(DST): $(SRC) node_modules
# workaround for https://github.com/evanw/esbuild/issues/1921
	npx esbuild --log-level=warning --platform=node --target=node14 --format=esm --bundle --minify --legal-comments=none --banner:js="import {createRequire} from 'module';const require = createRequire(import.meta.url);" --define:import.meta.VERSION=\"$(shell jq .version package.json)\" --outfile=$(DST) $(SRC) --external:undici
	chmod +x $(DST)

.PHONY: publish
publish: node_modules
	git push -u --tags origin master
	npm publish

.PHONY: update
update: node_modules build
	node $(DST) -cu -e registry-auth-token
	rm package-lock.json
	npm install
	@touch node_modules

.PHONY: patch
patch: node_modules test
	npx versions -c 'make --no-print-directory build' patch package.json package-lock.json
	@$(MAKE) --no-print-directory publish

.PHONY: minor
minor: node_modules test
	npx versions -c 'make --no-print-directory build' minor package.json package-lock.json
	@$(MAKE) --no-print-directory publish

.PHONY: major
major: node_modules test
	npx versions -c 'make --no-print-directory build' major package.json package-lock.json
	@$(MAKE) --no-print-directory publish
