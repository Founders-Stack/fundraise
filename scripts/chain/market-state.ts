// Print MarketState for a DBC pool via createDevnetPorts().  scripts/chain/run.sh market-state.ts <pool>
import { createDevnetPorts } from "../../apps/web/lib/chain/real";

async function main() {
  const ports = await createDevnetPorts();
  const s = await ports.market.getMarketState(process.argv[2]);
  console.log(JSON.stringify(s, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
