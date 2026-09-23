#!/usr/bin/env bash
# Build, start a throwaway solana-test-validator with the program preloaded, run TS tests.
# (Used instead of `anchor test`, whose surfpool/legacy validator launch failed in this env.)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8999}"
LEDGER="$(mktemp -d)/ledger"
PROGRAM_ID="$(solana address -k target/deploy/fs_allowlist-keypair.json)"
[ "${SKIP_BUILD:-0}" = 1 ] || anchor build
solana-test-validator --ledger "$LEDGER" --rpc-port "$PORT" --faucet-port $((PORT+1000)) --reset --quiet \
  --bpf-program "$PROGRAM_ID" target/deploy/fs_allowlist.so >/dev/null 2>&1 &
VPID=$!
trap 'kill $VPID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do solana -u "http://127.0.0.1:$PORT" program show "$PROGRAM_ID" >/dev/null 2>&1 && break; sleep 1; done
NODE_OPTIONS=--no-experimental-strip-types \
ANCHOR_PROVIDER_URL="http://127.0.0.1:$PORT" ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}" \
  npx ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.ts'
