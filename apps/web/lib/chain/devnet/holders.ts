// Holder listing for a Token-2022 mint (SPEC 6 / H6).
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { COMMITMENT, withRetry } from "./env";

export interface RawHolder {
  owner: string;
  tokenAccount: string;
  amount: bigint;
}

/** Token account layout (same prefix for SPL and Token-2022): mint 0..32 | owner 32..64 | amount 64..72. */
function parse(pubkey: PublicKey, data: Buffer): RawHolder {
  return {
    owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    tokenAccount: pubkey.toBase58(),
    amount: data.readBigUInt64LE(64),
  };
}

/** Primary: getProgramAccounts(Token-2022, memcmp mint @0). Returns all accounts (incl. zero balance). */
export async function holdersByProgramAccounts(connection: Connection, mint: PublicKey) {
  const res = await withRetry(() =>
    connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
      commitment: "confirmed",
      withContext: true,
      filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
    }),
  );
  // Keep token accounts only: base length 165, or extended with AccountType byte (index 165) = 2 (Account).
  const isTokenAccount = (d: Buffer) => d.length === 165 || (d.length > 165 && d[165] === 2);
  const accounts = res.value.filter((a) => isTokenAccount(a.account.data)).map((a) => parse(a.pubkey, a.account.data));
  return { slot: res.context.slot, accounts };
}

/** Fallback: getTokenLargestAccounts (top 20) + owners via getMultipleAccountsInfo. */
export async function holdersByLargestAccounts(connection: Connection, mint: PublicKey) {
  const largest = await withRetry(() => connection.getTokenLargestAccounts(mint, "confirmed"));
  const keys = largest.value.map((v) => v.address);
  const infos = await withRetry(() => connection.getMultipleAccountsInfoAndContext(keys, "confirmed"));
  const accounts: RawHolder[] = [];
  infos.value.forEach((info, i) => {
    if (info) accounts.push(parse(keys[i], info.data));
  });
  return { slot: infos.context.slot, accounts };
}

/**
 * Public-RPC fallback (api.devnet.solana.com excludes Token-2022 from getProgramAccounts):
 * with the fs_allowlist hook only allowlisted wallets can receive the token, so enumerate
 * AllowEntry PDAs (gPA on our small program works), read their Token-2022 ATAs, and add the
 * DBC base vault (found via the DBC pool for this mint). Misses non-ATA token accounts and
 * post-graduation holders (the hook is revoked at migration).
 */
export async function holdersByAllowlist(
  connection: Connection,
  allowlistProgram: PublicKey,
  mint: PublicKey,
  extraOwners: string[] = [],
) {
  const entries = await withRetry(() =>
    connection.getProgramAccounts(allowlistProgram, {
      commitment: "confirmed",
      filters: [{ dataSize: 74 }, { memcmp: { offset: 8, bytes: mint.toBase58() } }],
    }),
  );
  const owners = new Set<string>(extraOwners);
  for (const e of entries) owners.add(new PublicKey(e.account.data.subarray(40, 72)).toBase58());
  const keys = [...owners].map((o) => getAssociatedTokenAddressSync(mint, new PublicKey(o), true, TOKEN_2022_PROGRAM_ID));
  try {
    const client = new DynamicBondingCurveClient(connection, COMMITMENT);
    const pool = await client.state.getPoolByBaseMint(mint);
    const ps = (pool?.account as unknown as { poolState?: { baseVault: PublicKey } })?.poolState ??
      (pool?.account as unknown as { baseVault: PublicKey } | undefined);
    if (ps?.baseVault) keys.push(ps.baseVault);
  } catch {
    /* pool vault optional */
  }
  const accounts: RawHolder[] = [];
  let slot = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const infos = await withRetry(() => connection.getMultipleAccountsInfoAndContext(chunk, "confirmed"));
    slot = Math.max(slot, infos.context.slot);
    infos.value.forEach((info, j) => {
      if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) accounts.push(parse(chunk[j], info.data));
    });
  }
  return { slot, accounts };
}

export type HolderMethod = "getProgramAccounts" | "allowlist" | "getTokenLargestAccounts";

export async function listHolders(
  connection: Connection,
  mint: PublicKey,
  opts: { allowlistProgram?: PublicKey; extraOwners?: string[] } = {},
) {
  let r: { slot: number; accounts: RawHolder[] } | null = null;
  let method: HolderMethod = "getProgramAccounts";
  const errors: string[] = [];
  try {
    r = await holdersByProgramAccounts(connection, mint);
  } catch (e) {
    errors.push(String((e as Error).message).slice(0, 120));
  }
  if (!r && opts.allowlistProgram) {
    method = "allowlist";
    try {
      r = await holdersByAllowlist(connection, opts.allowlistProgram, mint, opts.extraOwners);
    } catch (e) {
      errors.push(String((e as Error).message).slice(0, 120));
    }
  }
  if (!r) {
    method = "getTokenLargestAccounts";
    try {
      r = await holdersByLargestAccounts(connection, mint);
    } catch (e) {
      errors.push(String((e as Error).message).slice(0, 120));
      throw new Error(`getHolders failed: ${errors.join(" | ")}`);
    }
  }
  // merge by owner, drop zero balances
  const byOwner = new Map<string, RawHolder>();
  for (const a of r.accounts) {
    if (a.amount === 0n) continue;
    const prev = byOwner.get(a.owner);
    if (prev) prev.amount += a.amount;
    else byOwner.set(a.owner, { ...a });
  }
  return { slot: r.slot, method, holders: [...byOwner.values()] };
}
