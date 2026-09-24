// Tops up the demo wallets (idempotent: only sends the shortfall). SOL comes from the FS authority
// (no airdrops), mock USDC from the faucet (mint authority = FS authority).
//   scripts/chain/run.sh fund-demo.ts            # fund to the targets below
//   scripts/chain/run.sh fund-demo.ts --check    # print balances only
import { SystemProgram, Transaction } from "@solana/web3.js";
import { demoKeypair, devnetEnv, explorerTx, sendTx, withRetry } from "../../apps/web/lib/chain/devnet/env";
import { faucet, tokenBalance, usdcAta } from "../../apps/web/lib/chain/devnet/usdc";

const TARGETS: Record<string, { sol: number; usdc: number }> = {
  issuer: { sol: 0.3, usdc: 150_000 },
  alice: { sol: 0.3, usdc: 200_000 },
  bob: { sol: 0.3, usdc: 200_000 },
  carol: { sol: 0.3, usdc: 1_000 },
};

async function main() {
  const check = process.argv.includes("--check");
  const env = devnetEnv();
  const { connection, fsAuthority, quoteMint } = env;
  const fsSol = await withRetry(() => connection.getBalance(fsAuthority.publicKey));
  console.log(`fs-authority ${fsAuthority.publicKey.toBase58()} ${(fsSol / 1e9).toFixed(4)} SOL`);
  for (const [name, t] of Object.entries(TARGETS)) {
    const kp = name === "issuer" ? env.issuer : demoKeypair(name);
    const lamports = await withRetry(() => connection.getBalance(kp.publicKey));
    const usdc = await tokenBalance(connection, usdcAta(quoteMint, kp.publicKey));
    console.log(`${name.padEnd(7)} ${kp.publicKey.toBase58()} ${(lamports / 1e9).toFixed(4)} SOL  ${(Number(usdc) / 1e6).toLocaleString()} USDC`);
    if (check) continue;
    const wantLamports = Math.round(t.sol * 1e9);
    if (lamports < wantLamports * 0.9) {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: fsAuthority.publicKey, toPubkey: kp.publicKey, lamports: wantLamports - lamports }),
      );
      const sig = await sendTx(connection, tx, [fsAuthority], `fund SOL ${name}`);
      console.log(`  + ${((wantLamports - lamports) / 1e9).toFixed(4)} SOL ${explorerTx(sig)}`);
    }
    const wantUsdc = BigInt(t.usdc) * 1_000_000n;
    if (usdc < wantUsdc) {
      const sig = await faucet(connection, quoteMint, fsAuthority, kp.publicKey, wantUsdc - usdc);
      console.log(`  + ${(Number(wantUsdc - usdc) / 1e6).toLocaleString()} USDC ${explorerTx(sig)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
