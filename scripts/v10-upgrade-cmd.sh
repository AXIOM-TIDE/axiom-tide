#!/usr/bin/env bash
# v10 upgrade — single command. Run only after sui keytool import
# of the deploy wallet (0x4c320500...) and `sui client switch --address 0x4c320500...`
set -euo pipefail
cd "$(dirname "$0")/../protocol"

UPGRADE_CAP=0x45ac8ab33db324f1f6a5cb7fdf726b132846a3ee5fd35c8ec3d2795d747784b2
DEPLOY_ADDR=0x4c320500126014a2c1048ecca47bcd8e4d8c252c85257398239a7c8da0e2ea26

echo "→ verifying active sender..."
ADDR=$(sui client active-address)
if [ "$ADDR" != "$DEPLOY_ADDR" ]; then
  echo "❌ active address is $ADDR — must switch to deploy wallet first:"
  echo "   sui client switch --address $DEPLOY_ADDR"
  exit 1
fi

echo "→ verifying Move.toml published-at = v9..."
grep -q 'published-at = "0x7bc8f81b' Move.toml || { echo "❌ Move.toml not pointing at v9"; exit 1; }

echo "→ publishing v10 upgrade..."
sui client upgrade \
  --upgrade-capability "$UPGRADE_CAP" \
  --gas-budget 500000000 \
  --json | tee /tmp/v10-upgrade-result.json

NEW_PKG=$(jq -r '.objectChanges[] | select(.type=="published") | .packageId' /tmp/v10-upgrade-result.json)
echo ""
echo "✅ v10 published"
echo "   new package: $NEW_PKG"
echo "   add this to MEMORY.md as CONK Package v10"
