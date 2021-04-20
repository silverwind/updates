NODE_OPTIONS=--experimental-vm-modules --no-warnings

node_modules: yarn.lock
	@yarn -s --pure-lockfile
	@touch node_modules

deps: node_modules

lint: node_modules
	yarn -s run eslint --color .

test: node_modules lint build
	yarn -s run jest --color

unittest: node_modules
	yarn -s run jest --color --watchAll

build: node_modules
	yarn -s run ncc build updates.js -q -m -o dist
	@mv dist/index.js dist/updates.cjs
	@rm -rf dist/updates
	@chmod +x dist/updates.cjs

publish: node_modules
	git push -u --tags origin master
	npm publish

update: node_modules build
	node dist/updates.cjs -cu
	@rm yarn.lock
	@yarn -s
	@touch node_modules

patch: node_modules test
	yarn -s run versions -Cc 'make build' patch
	@$(MAKE) --no-print-directory publish

minor: node_modules test
	yarn -s run versions -Cc 'make build' minor
	@$(MAKE) --no-print-directory publish

major: node_modules test
	yarn -s run versions -Cc 'make build' major
	@$(MAKE) --no-print-directory publish

.PHONY: lint test unittest build publish deps update patch minor major
