// H6: list holders of a Token-2022 mint.  scripts/chain/run.sh holders.ts <mint>
import { DBC_POOL_AUTHORITY, PublicKey, devnetEnv, holdersByAllowlist, holdersByLargestAccounts, holdersByProgramAccounts } from "../../apps/web/lib/chain/devnet";

async function main() {
  const mint = new PublicKey(process.argv[2]);
  const { connection, allowlistProgram } = devnetEnv();
  for (const [name, fn] of [
    ["getProgramAccounts", holdersByProgramAccounts],
    ["allowlist", (c: typeof connection, m: PublicKey) => holdersByAllowlist(c, allowlistProgram, m, [DBC_POOL_AUTHORITY.toBase58()])],
    ["getTokenLargestAccounts", holdersByLargestAccounts],
  ] as const) {
    const t = Date.now();
    try {
      const r = await fn(connection, mint);
      console.log(name, `${Date.now() - t}ms`, "slot", r.slot, r.accounts.map((a) => `${a.owner}:${a.amount}`));
    } catch (e) {
      console.log(name, `${Date.now() - t}ms`, "ERR", String((e as Error).message).slice(0, 160));
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
