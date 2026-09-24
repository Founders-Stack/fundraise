// Creates one fresh demo issuance per H11 run (CHAIN_MODE=fake) and prints their ids as JSON.
// Goes through the same preview → create path as the API, so rows look exactly like launched ones.
// Run from apps/web so the dev server and this script share .fake-chain.json and dev.db:
//   cd apps/web && pnpm exec tsx ../../demo/finance/seed-h11.ts
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chain";
import { createIssuance, createPreview } from "@/lib/server/issuance";

async function main() {
  const chain = await getChain();
  if (chain.mode !== "fake") throw new Error("seed-h11 is for CHAIN_MODE=fake only");
  const out: Record<string, string> = {};
  for (const label of ["stripe", "bank", "pnl"]) {
    const preview = await createPreview({
      issuerName: "Acme SaaS, Inc.",
      symbol: `H11${label.slice(0, 2).toUpperCase()}${Date.now().toString().slice(-4)}`,
      tokenName: `Acme SaaS Cash Flow Rights (${label})`,
      poolPercentageBps: 1000,
      expectedAnnualDcf: "1600000",
      targetInitialYieldBps: 1600,
      distributionFrequency: "QUARTERLY",
    });
    const created = await createIssuance(preview.previewId);
    out[label] = created.issuanceId;
  }
  console.log(JSON.stringify(out));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
