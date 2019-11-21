test:
	npx eslint --color --quiet *.js
	node --trace-deprecation --throw-deprecation test.js

publish:
	git push -u --tags origin master
	npm publish

deps:
	rm -rf node_modules
	npm i

update:
	node updates.js -cu
	$(MAKE) deps

patch:
	$(MAKE) test
	npx versions -C patch
	$(MAKE) publish

minor:
	$(MAKE) test
	npx versions -C minor
	$(MAKE) publish

major:
	$(MAKE) test
	npx versions -C major
	$(MAKE) publish

.PHONY: test publish deps update patch minor major
