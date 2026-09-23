// Creates the mock USDC mint (SPL Token, 6 dp, mint authority = FS authority).
// Prints the address; put it in .env as QUOTE_MINT.
import { devnetEnv, explorerTx } from "../../apps/web/lib/chain/devnet/env";
import { createMockUsdcMint } from "../../apps/web/lib/chain/devnet/usdc";

async function main() {
const env = devnetEnv({ requireQuoteMint: false });
if (process.env.QUOTE_MINT) {
  console.log(`QUOTE_MINT already set: ${process.env.QUOTE_MINT} (unset it to create a new one)`);
  return;
}
const { mint, signature } = await createMockUsdcMint(env.connection, env.fsAuthority, env.fsAuthority.publicKey);
console.log(`QUOTE_MINT=${mint.toBase58()}`);
console.log(explorerTx(signature));

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
