// Mock USDC (plain SPL Token, 6 dp, mint authority = FS authority) + payouts.
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
  type Signer,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToCheckedInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import { computeBudgetIxs, sendTx, withRetry } from "./env";

export const USDC_DECIMALS = 6;

export async function createMockUsdcMint(connection: Connection, payer: Signer, mintAuthority: PublicKey) {
  const mint = Keypair.generate();
  const lamports = await getMinimumBalanceForRentExemptMint(connection);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint.publicKey, USDC_DECIMALS, mintAuthority, null, TOKEN_PROGRAM_ID),
  );
  const sig = await sendTx(connection, tx, [payer, mint], "create mock USDC mint");
  return { mint: mint.publicKey, signature: sig };
}

export const usdcAta = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);

/** Faucet: mint `amount` base units of mock USDC to `owner` (creates the ATA idempotently). */
export async function faucet(connection: Connection, mint: PublicKey, mintAuthority: Signer, owner: PublicKey, amount: bigint) {
  const ata = usdcAta(mint, owner);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(mintAuthority.publicKey, ata, owner, mint, TOKEN_PROGRAM_ID),
    createMintToCheckedInstruction(mint, ata, mintAuthority.publicKey, amount, USDC_DECIMALS, [], TOKEN_PROGRAM_ID),
  );
  return sendTx(connection, tx, [mintAuthority], "faucet");
}

export async function tokenBalance(connection: Connection, account: PublicKey): Promise<bigint> {
  const info = await withRetry(() => connection.getAccountInfo(account));
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

/**
 * Unsigned tx (fee payer = `from`, the founder's wallet) that creates missing recipient ATAs
 * idempotently and transfers USDC to each row. Callers keep batches ≤ 5 so it fits one tx.
 */
export async function buildTransferTx(
  connection: Connection,
  mint: PublicKey,
  from: PublicKey,
  rows: { wallet: string; amount: bigint }[],
): Promise<{ tx: Transaction; lastValidBlockHeight: number }> {
  if (rows.length === 0) throw new Error("buildTransferTx: no rows");
  if (rows.length > 5) throw new Error("buildTransferTx: max 5 rows per wallet-signed transaction");
  const src = usdcAta(mint, from);
  const tx = new Transaction().add(...computeBudgetIxs(200_000, 10_000));
  for (const r of rows) {
    const owner = new PublicKey(r.wallet);
    const ata = usdcAta(mint, owner);
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(from, ata, owner, mint, TOKEN_PROGRAM_ID),
      createTransferCheckedInstruction(src, mint, ata, from, r.amount, USDC_DECIMALS, [], TOKEN_PROGRAM_ID),
    );
  }
  tx.feePayer = from;
  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash("confirmed"));
  tx.recentBlockhash = blockhash;
  return { tx, lastValidBlockHeight };
}

/**
 * Sends ≤ 10 USDC transfers from `from` in ONE transaction and returns its signature.
 * Recipient ATAs that don't exist yet are created first (idempotent, separate tx, paid by `from`)
 * so the transfer tx stays under the size limit.
 */
export async function transferBatch(
  connection: Connection,
  mint: PublicKey,
  from: Signer,
  rows: { wallet: string; amount: bigint }[],
  memo?: string,
): Promise<{ signature: string; ataSignatures: string[] }> {
  if (memo !== undefined && Buffer.byteLength(memo, "utf8") > 200) throw new Error("transferBatch: memo longer than 200 bytes");
  if (rows.length === 0) throw new Error("transferBatch: no rows");
  if (rows.length > 10) throw new Error("transferBatch: max 10 rows per transaction");
  const src = usdcAta(mint, from.publicKey);
  const owners = rows.map((r) => new PublicKey(r.wallet));
  const atas = owners.map((o) => usdcAta(mint, o));
  const infos = await withRetry(() => connection.getMultipleAccountsInfo(atas));
  const missing = owners.map((o, i) => ({ o, ata: atas[i] })).filter((_, i) => !infos[i]);
  const ataSignatures: string[] = [];
  for (let i = 0; i < missing.length; i += 5) {
    const tx = new Transaction().add(
      ...computeBudgetIxs(200_000, 10_000),
      ...missing
        .slice(i, i + 5)
        .map(({ o, ata }) =>
          createAssociatedTokenAccountIdempotentInstruction(from.publicKey, ata, o, mint, TOKEN_PROGRAM_ID),
        ),
    );
    ataSignatures.push(await sendTx(connection, tx, [from], "create payout ATAs"));
  }
  const tx = new Transaction().add(
    ...computeBudgetIxs(100_000, 10_000),
    ...rows.map((r, i) =>
      createTransferCheckedInstruction(src, mint, atas[i], from.publicKey, r.amount, USDC_DECIMALS, [], TOKEN_PROGRAM_ID),
    ),
  );
  if (memo) tx.add(memoInstruction(memo, from.publicKey));
  // No internal re-sign: the caller retries the batch; TxError.landed=false means it definitely did not pay.
  const signature = await sendTx(connection, tx, [from], "payout transferBatch", { retryOnExpiry: false });
  return { signature, ataSignatures };
}

/** SPL Memo v2 program (same address on devnet and mainnet). */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** SPL Memo instruction signed by `signer`, built by hand to avoid the @solana/spl-memo dependency. */
export function memoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, "utf8"),
  });
}
