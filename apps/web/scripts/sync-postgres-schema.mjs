// Derives prisma/postgres/schema.prisma (production, Vercel) from prisma/schema.prisma (local SQLite).
// The models are identical; only the datasource provider differs. After editing schema.prisma:
//   pnpm --filter web db:pg:sync
//   pnpm --filter web exec prisma migrate diff --from-migrations prisma/postgres/migrations \
//     --to-schema-datamodel prisma/postgres/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --script
// `--check` exits 1 if the Postgres schema is stale (run by the test suite).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function renderPostgresSchema() {
  const src = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
  return (
    "// GENERATED from ../schema.prisma by scripts/sync-postgres-schema.mjs. Do not edit by hand.\n" +
    src.replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"')
  );
}

const target = join(root, "prisma/postgres/schema.prisma");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = renderPostgresSchema();
  if (process.argv.includes("--check")) {
    let cur = "";
    try {
      cur = readFileSync(target, "utf8");
    } catch {}
    if (cur !== out) {
      console.error("prisma/postgres/schema.prisma is stale: run pnpm --filter web db:pg:sync");
      process.exit(1);
    }
  } else {
    writeFileSync(target, out);
    console.log("wrote", target);
  }
}
