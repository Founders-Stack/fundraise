import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { renderPostgresSchema } from "../scripts/sync-postgres-schema.mjs";
import { loadKeypair } from "@/lib/chain/devnet/env";

describe("deploy readiness", () => {
  it("prisma/postgres/schema.prisma is in sync with prisma/schema.prisma", () => {
    const cur = readFileSync(join(__dirname, "../prisma/postgres/schema.prisma"), "utf8");
    expect(cur, "run: pnpm --filter web db:pg:sync").toBe(renderPostgresSchema());
    expect(cur).toContain('provider = "postgresql"');
  });

  it("loads custody keypairs from env values (JSON array or base58), no keys/ files", () => {
    const kp = Keypair.generate();
    expect(loadKeypair(JSON.stringify(Array.from(kp.secretKey))).publicKey.equals(kp.publicKey)).toBe(true);
    expect(loadKeypair(bs58.encode(kp.secretKey)).publicKey.equals(kp.publicKey)).toBe(true);
  });
});
