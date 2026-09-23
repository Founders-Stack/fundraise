// fs_allowlist (Token-2022 transfer hook) client: PDAs + raw Anchor instructions.
// No IDL dependency: discriminators are sha256("global:<name>")[..8].
import { createHash } from "node:crypto";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
  type Connection,
} from "@solana/web3.js";

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

export const configPda = (program: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer()], program)[0];
export const extraMetasPda = (program: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], program)[0];
export const allowPda = (program: PublicKey, mint: PublicKey, wallet: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("allow"), mint.toBuffer(), wallet.toBuffer()], program)[0];

/** initialize(admin): creates Config + ExtraAccountMetaList. `authority` must be FS_AUTHORITY. */
export function initializeIx(p: {
  program: PublicKey;
  payer: PublicKey;
  authority: PublicKey;
  mint: PublicKey;
  admin: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.program,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: p.authority, isSigner: true, isWritable: false },
      { pubkey: p.mint, isSigner: false, isWritable: false },
      { pubkey: configPda(p.program, p.mint), isSigner: false, isWritable: true },
      { pubkey: extraMetasPda(p.program, p.mint), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("initialize"), p.admin.toBuffer()]),
  });
}

/** add_allow(wallet): admin-only, idempotent on-chain (init_if_needed + active = true). */
export function addAllowIx(p: {
  program: PublicKey;
  admin: PublicKey;
  mint: PublicKey;
  wallet: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.program,
    keys: [
      { pubkey: p.admin, isSigner: true, isWritable: true },
      { pubkey: configPda(p.program, p.mint), isSigner: false, isWritable: false },
      { pubkey: allowPda(p.program, p.mint, p.wallet), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("add_allow"), p.wallet.toBuffer()]),
  });
}

/** True if an AllowEntry exists and is active. Layout: 8 disc | mint 32 | wallet 32 | active u8 | bump u8. */
export async function isAllowed(
  connection: Connection,
  program: PublicKey,
  mint: PublicKey,
  wallet: PublicKey,
): Promise<boolean> {
  const info = await connection.getAccountInfo(allowPda(program, mint, wallet));
  return !!info && info.owner.equals(program) && info.data.length >= 74 && info.data[72] === 1;
}

/**
 * Extra accounts Token-2022 needs for our hook's `execute`, in the order
 * `createTransferCheckedWithTransferHookInstruction` would append them:
 * [AllowEntry(destination owner), hook program, ExtraAccountMetaList].
 * The DBC SDK's resolver can't compute these (it resolves with PublicKey.default as
 * destination, but our seed reads destination account data), so we pass them explicitly.
 */
export function hookAccounts(program: PublicKey, mint: PublicKey, destinationOwner: PublicKey): AccountMeta[] {
  return [
    { pubkey: allowPda(program, mint, destinationOwner), isSigner: false, isWritable: false },
    { pubkey: program, isSigner: false, isWritable: false },
    { pubkey: extraMetasPda(program, mint), isSigner: false, isWritable: false },
  ];
}
