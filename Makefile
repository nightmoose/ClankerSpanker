.PHONY: check house-style test typecheck build rfc test-swift

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

# RFC-046: Swift unit tests (macOS only; hosted by the Mac app). Not in `check` — CI is Linux.
test-swift:
	cd ios/ClankerSpanker && xcodebuild test -project ClankerSpanker.xcodeproj -scheme ClankerSpanker \
		-destination 'platform=macOS' -derivedDataPath /tmp/ClankerSpanker-tests -quiet
