#!/usr/bin/env bash
# Run a chain script with apps/web deps and the repo .env:  scripts/chain/run.sh faucet.ts <wallet> <usdc>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$1"; shift
cd "$ROOT/apps/web"
exec pnpm exec tsx --env-file="$ROOT/.env" "$ROOT/scripts/chain/$SCRIPT" "$@"
