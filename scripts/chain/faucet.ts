// Mock USDC faucet: scripts/chain/run.sh faucet.ts <wallet|alice|bob|carol|issuer> <whole USDC>
import { PublicKey } from "../../apps/web/lib/chain/devnet";
import { demoKeypair, devnetEnv, explorerTx } from "../../apps/web/lib/chain/devnet/env";
import { faucet, tokenBalance, usdcAta } from "../../apps/web/lib/chain/devnet/usdc";

async function main() {
const [who, amt] = process.argv.slice(2);
if (!who || !amt) {
  console.error("usage: faucet.ts <wallet|alice|bob|carol|issuer> <whole USDC>");
  process.exit(1);
}
const env = devnetEnv();
const owner = ["issuer", "alice", "bob", "carol"].includes(who) ? demoKeypair(who).publicKey : new PublicKey(who);
const amount = BigInt(Math.round(Number(amt) * 1e6));
const sig = await faucet(env.connection, env.quoteMint, env.fsAuthority, owner, amount);
const bal = await tokenBalance(env.connection, usdcAta(env.quoteMint, owner));
console.log(`minted ${amt} USDC to ${owner.toBase58()} (balance ${Number(bal) / 1e6})`);
console.log(explorerTx(sig));

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
