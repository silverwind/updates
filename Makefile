test: rollup
	yarn -s run eslint --color .
	yarn -s run jest --color

rollup:
	yarn -s run rollup --silent --compact -c rollup.config.js

publish:
	git push -u --tags origin master
	npm publish

deps:
	rm -rf node_modules
	yarn

update:
	node updates.js -cu
	$(MAKE) deps

patch: test
	yarn -s run versions -Cc 'make rollup' patch
	$(MAKE) publish

minor: test
	yarn -s run versions -Cc 'make rollup' minor
	$(MAKE) publish

major: test
	yarn -s run versions -Cc 'make rollup' major
	$(MAKE) publish

.PHONY: test rollup publish deps update patch minor major
