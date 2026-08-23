.PHONY: check house-style test typecheck build rfc

# ContractGate-shaped one command. CI runs this.
check: house-style typecheck build

house-style:
	python3 scripts/house-style-check.py

test:
	cd host && npm test

typecheck:
	cd host && npm run typecheck

build:
	cd host && npm run build

rfc:
	@test -n "$(SLUG)" || (echo "usage: make rfc SLUG=short-kebab"; exit 2)
	bash scripts/new-rfc.sh "$(SLUG)"
