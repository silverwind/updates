node_modules: package-lock.json
	npm install --no-save
	@touch node_modules

deps: node_modules

lint: node_modules
	npx eslint --color .

test: node_modules lint build
	NODE_OPTIONS="--experimental-vm-modules --no-warnings" npx jest --color

unittest: node_modules
	NODE_OPTIONS="--experimental-vm-modules --no-warnings" npx jest --color --watchAll

build: node_modules
	npx ncc build updates.js -q -m -o bin
	mv bin/index.js bin/updates.js
	perl -0777 -p -i -e 's#\n?\/\*![\s\S]*?\*\/\n?##g' bin/updates.js
	chmod +x bin/updates.js

publish: node_modules
	git push -u --tags origin master
	npm publish

update: node_modules build
	node bin/updates.js -cu -e registry-auth-token
	rm package-lock.json
	npm install
	@touch node_modules

patch: node_modules test
	npx versions -Cc 'make --no-print-directory build' patch
	@$(MAKE) --no-print-directory publish

minor: node_modules test
	npx versions -Cc 'make --no-print-directory build' minor
	@$(MAKE) --no-print-directory publish

major: node_modules test
	npx versions -Cc 'make --no-print-directory build' major
	@$(MAKE) --no-print-directory publish

.PHONY: lint test unittest build publish deps update patch minor major
