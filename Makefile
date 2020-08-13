test:
	yarn -s run eslint --color .
	@$(MAKE) --no-print-directory bundle
	yarn -s run jest --color

bundle:
	yarn -s run ncc build updates.js -q -m -o . -e cacache -e socks-proxy-agent -e ssri -e stripJsonComments -e encoding -e depd -e debug --no-source-map-register
	@mv index.js updates

publish:
	git push -u --tags origin master
	npm publish

deps:
	rm -rf node_modules
	yarn

update: bundle
	node updates -cu
	@$(MAKE) --no-print-directory deps

patch: test
	yarn -s run versions -Cc 'make bundle' patch
	@$(MAKE) --no-print-directory publish

minor: test
	yarn -s run versions -Cc 'make bundle' minor
	@$(MAKE) --no-print-directory publish

major: test
	yarn -s run versions -Cc 'make bundle' major
	@$(MAKE) --no-print-directory publish

.PHONY: test bundle publish deps update patch minor major
