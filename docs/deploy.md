# Deploy (A23): Vercel + Postgres, devnet first

Code side is done. Nothing here has been deployed or published yet; the steps below are for the user (U9).

## How the database works

| Where | Schema | Provider | Migrations |
|---|---|---|---|
| Local `pnpm dev` / `pnpm test` | `apps/web/prisma/schema.prisma` | SQLite (`file:./dev.db`) | `apps/web/prisma/migrations` |
| Vercel | `apps/web/prisma/postgres/schema.prisma` | Postgres | `apps/web/prisma/postgres/migrations` |

`prisma/schema.prisma` is the source of truth. The Postgres schema is generated from it (only the
`provider` line differs) by `pnpm --filter web db:pg:sync`. A test fails if it is stale.

After you change `schema.prisma`:

1. `pnpm --filter web db:migrate` (the SQLite migration, as before)
2. `pnpm --filter web db:pg:sync`
3. Generate the Postgres migration against any throwaway Postgres (a shadow DB). Docker is fine:
   `docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=pg postgres:16`, then from `apps/web`:
   ```bash
   mkdir -p prisma/postgres/migrations/<timestamp>_<name>
   pnpm exec prisma migrate diff \
     --from-migrations prisma/postgres/migrations \
     --to-schema-datamodel prisma/postgres/schema.prisma \
     --shadow-database-url postgresql://postgres:pg@localhost:5433/postgres \
     --script -o prisma/postgres/migrations/<timestamp>_<name>/migration.sql
   ```

On Vercel the build runs `pnpm --filter web vercel-build`, which does
`prisma generate` (Postgres schema), then `prisma migrate deploy`, then `next build`.

## Serverless notes

- Custody keys come from env values (JSON byte array or base58), not `keys/` files.
- `CHAIN_MODE=fake` keeps state in memory on Vercel (no `.fake-chain.json` write). Use `devnet` there.
- API routes get `maxDuration: 60` (`apps/web/vercel.json`). Pool creation and payouts are multi-tx; if
  a call times out, re-run it. Payouts are idempotent: a retry pays only the rows still unpaid.
  On the Hobby plan the cap is 60s. Pro allows up to 300s if you need more.

## Steps for the user (U9)

### 1. Create the Vercel project

1. Vercel -> Add New -> Project -> import `Founders-Stack/fundraise`.
2. **Root Directory: `apps/web`**. Framework preset: Next.js. Leave the build and install commands
   empty. `apps/web/vercel.json` sets them to `cd ../.. && pnpm install --frozen-lockfile` and
   `cd ../.. && pnpm --filter web vercel-build`.
3. Keep "Include files outside the root directory in the Build Step" **on** (the default). The app
   imports `packages/core`.
4. Node.js version: 20.x or 22.x.

### 2. Add Postgres

Storage -> Create Database -> Neon (Postgres) -> connect it to the project, for all environments.
This injects `DATABASE_URL` (pooled). If the integration names it differently (for example
`POSTGRES_PRISMA_URL`), add `DATABASE_URL` yourself with the pooled URL, ending in `?sslmode=require`.

### 3. Set the environment variables (Production + Preview)

| Var | Devnet value |
|---|---|
| `DATABASE_URL` | from step 2 |
| `CHAIN_MODE` | `devnet` |
| `RPC_URL` | a devnet RPC (Helius/Triton recommended; the public one rate-limits) |
| `NEXT_PUBLIC_RPC_URL` | same as `RPC_URL`, or a browser-safe key |
| `PUBLIC_APP_URL` | `https://<project>.vercel.app` (fill in after the first deploy, then redeploy) |
| `FS_API_TOKEN` | `openssl rand -hex 32` |
| `FS_AUTHORITY_KEYPAIR` | contents of `keys/fs-authority.json` (the `[..]` byte array) |
| `ISSUER_KEYPAIR` | contents of `keys/issuer.json` |
| `QUOTE_MINT` | devnet mock-USDC mint |
| `FS_ALLOWLIST_PROGRAM_ID` | deployed `fs_allowlist` program id |

Mark the keypair and token vars as **Sensitive**. The full list with comments is in `.env.example`.
Current submission is devnet only: set `SOLANA_CLUSTER=devnet` and
`NEXT_PUBLIC_SOLANA_CLUSTER=devnet`, with `CHAIN_MODE=devnet` for real devnet transactions.
Use the mock-USDC mint and devnet keys. Mainnet A29 is deferred.

### 4. Deploy and verify

1. Deploy. The build log should show `prisma migrate deploy` applying `20260924120000_init`.
2. `curl -H "Authorization: Bearer $FS_API_TOKEN" https://<project>.vercel.app/api/issuances` should return `200` and `[]`-shaped JSON.
3. Set `PUBLIC_APP_URL` to the real URL if you didn't already, and redeploy.
4. Point the MCP at it and run the E2E once:
   ```bash
   FS_API_URL=https://<project>.vercel.app/api FS_API_TOKEN=... node packages/fstack-mcp/dist/index.js
   ```

### 5. Publish the MCP server to npm

The package is `fstack-mcp` (unscoped; the name was free on npm on 2026-09-24).

```bash
npm login
pnpm --filter fstack-mcp build
cd packages/fstack-mcp && npm pack --dry-run   # check: dist/*.js + README.md + package.json
npm publish                                    # prepublishOnly rebuilds dist
```

Agents then use it with no checkout:

```bash
claude mcp add fstack -e FS_API_URL=https://<project>.vercel.app/api -e FS_API_TOKEN=... -- npx -y fstack-mcp
```

After you publish, you can switch `plugins/fstack/.mcp.json` to `"command": "npx", "args": ["-y", "fstack-mcp"]`
(see `docs/agent-install.md`).

## Deployment under a URL prefix

Set `NEXT_PUBLIC_BASE_PATH=/fundraise` at build time. Set `PUBLIC_APP_URL=https://f-stack.ai`
(or `https://f-stack.ai/fundraise`; both produce the same API-generated market, onboarding and
signing links). Rebuild after changing the prefix. Set the MCP client's
`FS_API_URL=https://f-stack.ai/fundraise/api` explicitly.

The MCP request deadline defaults to 120 seconds (`FS_API_TIMEOUT_MS=120000`). It covers both
response headers and body. Requests are never automatically retried: after a timeout during
creation or payout, check the existing operation's status before sending another mutation.
