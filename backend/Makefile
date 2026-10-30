PNPM ?= pnpm
.PHONY: build-Handler build-Cleanup
build-Handler build-Cleanup:
	mkdir -p "$(ARTIFACTS_DIR)/src"
	cp src/*.mjs "$(ARTIFACTS_DIR)/src/"
	cp package.json pnpm-lock.yaml "$(ARTIFACTS_DIR)/"
	$(PNPM) --dir "$(ARTIFACTS_DIR)" install --prod --frozen-lockfile --node-linker=hoisted --ignore-scripts
