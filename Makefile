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
	NODE_OPTIONS="--experimental-vm-modules --no-warnings" npx jest --color

.PHONY: unittest
unittest: node_modules
	NODE_OPTIONS="--experimental-vm-modules --no-warnings" npx jest --color --watchAll

.PHONY: build
build: node_modules
# workaround for https://github.com/evanw/esbuild/issues/1921
	npx esbuild --log-level=warning --platform=node --format=esm --bundle --minify --outdir=bin --legal-comments=none --banner:js="import {createRequire} from 'module';const require = createRequire(import.meta.url);" ./updates.js
	cat package.json | jq -r tostring > bin/package.json
	chmod +x bin/updates.js

.PHONY: publish
publish: node_modules
	git push -u --tags origin master
	npm publish

.PHONY: update
update: node_modules build
	node bin/updates.js -cu -e registry-auth-token
	rm package-lock.json
	npm install
	@touch node_modules

.PHONY: patch
patch: node_modules test
	npx versions -Cc 'make --no-print-directory build' patch
	@$(MAKE) --no-print-directory publish

.PHONY: minor
minor: node_modules test
	npx versions -Cc 'make --no-print-directory build' minor
	@$(MAKE) --no-print-directory publish

.PHONY: major
major: node_modules test
	npx versions -Cc 'make --no-print-directory build' major
	@$(MAKE) --no-print-directory publish
