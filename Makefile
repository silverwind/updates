lint:
	yarn -s run eslint --color .

test: lint build
	yarn -s run jest --color

unittest:
	yarn -s run jest --color --watchAll

build:
	yarn -s run ncc build updates.js -q -m -o .
	@mv index.js updates

publish:
	git push -u --tags origin master
	npm publish

deps:
	rm -rf node_modules
	yarn

update: build
	node updates -cu
	@$(MAKE) --no-print-directory deps

patch: test
	yarn -s run versions -Cc 'make build' patch
	@$(MAKE) --no-print-directory publish

minor: test
	yarn -s run versions -Cc 'make build' minor
	@$(MAKE) --no-print-directory publish

major: test
	yarn -s run versions -Cc 'make build' major
	@$(MAKE) --no-print-directory publish

.PHONY: lint test unittest build publish deps update patch minor major
