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
	yarn -s run ncc build updates.js -q -m -o .
	@mv index.js updates

publish: node_modules
	git push -u --tags origin master
	npm publish

update: node_modules build
	node updates -cu
	@$(MAKE) --no-print-directory deps
	@touch yarn.lock

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
