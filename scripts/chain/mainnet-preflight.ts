// A29 mainnet preflight (SPEC section 14). READ-ONLY: this script never signs, simulates or sends
// a transaction. It only reads config and account state, then prints PASS / WARN / FAIL per check.
//
//   SOLANA_CLUSTER=mainnet-beta scripts/chain/run.sh mainnet-preflight.ts            # full check
//   SOLANA_CLUSTER=mainnet-beta scripts/chain/run.sh mainnet-preflight.ts --pre-deploy
//       (before A23: the fs_allowlist program may be missing; FS authority needs deploy rent)
//
// Env it reads (same names as the app): SOLANA_CLUSTER, RPC_URL, QUOTE_MINT, FS_ALLOWLIST_PROGRAM_ID,
// FS_AUTHORITY_KEYPAIR, ISSUER_KEYPAIR, CHAIN_MODE, DATABASE_URL.
// Investor wallets: ALICE_PUBKEY / BOB_PUBKEY (or alice.json / bob.json next to FS_AUTHORITY_KEYPAIR).
// Exit code 0 = no FAIL, 1 = at least one FAIL.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CLUSTERS, clusterQuoteMint, clusterRpcUrl, currentCluster, parseClusterName } from "../../packages/core/src/cluster";

const PRE_DEPLOY = process.argv.includes("--pre-deploy");

// ---- SPEC section 14 caps / constants
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const BPF_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const ISSUER_USDC_CAP = 200_000_000n; // <= $200 USDC
const FS_AUTH_SOL_CAP_AFTER_DEPLOY = 1 * LAMPORTS_PER_SOL; // <= 1 SOL after deploy
const DEPLOY_RENT_MIN = 2 * LAMPORTS_PER_SOL; // 2-4 SOL program rent estimate
const MIN_FEE_SOL = 0.02 * LAMPORTS_PER_SOL; // enough for a handful of txs + ATA rent
// Pilot (SPEC section 10, DEMO_SCALE=0.001): Alice buys ~100, Bob ~40 ACME-CF at ~$1 + impact.
const ALICE_USDC_NEED = 110_000_000n;
const BOB_USDC_NEED = 45_000_000n;
// Payouts are funded by the issuer: $4.00 + $2.70 + $1.80 = $8.50.
const ISSUER_PAYOUT_NEED = 8_500_000n;

type Level = "PASS" | "WARN" | "FAIL";
const results: { level: Level; label: string; detail?: string }[] = [];
function report(level: Level, label: string, detail?: string) {
  results.push({ level, label, detail });
  console.log(`  ${level.padEnd(4)}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const section = (t: string) => console.log(`\n== ${t}`);
const sol = (l: number | bigint) => `${(Number(l) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
const usd = (b: bigint) => `$${(Number(b) / 1e6).toFixed(2)}`;

function pubkeyFromKeypairFile(p: string | undefined): PublicKey | null {
  if (!p || !existsSync(p)) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")))).publicKey;
  } catch {
    return null;
  }
}

function walletPubkey(envName: string, file: string): PublicKey | null {
  const v = process.env[envName];
  if (v) return new PublicKey(v);
  const dir = process.env.FS_AUTHORITY_KEYPAIR ? dirname(process.env.FS_AUTHORITY_KEYPAIR) : null;
  return dir ? pubkeyFromKeypairFile(join(dir, file)) : null;
}

async function usdcBalance(conn: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint | null> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
  try {
    const b = await conn.getTokenAccountBalance(ata, "confirmed");
    return BigInt(b.value.amount);
  } catch {
    return null; // ATA missing
  }
}

/** Upgradeable program: returns programdata account + upgrade authority (null = immutable). */
async function readUpgradeable(conn: Connection, programId: PublicKey) {
  const acc = await conn.getAccountInfo(programId, "confirmed");
  if (!acc) return { exists: false as const };
  const owner = acc.owner.toBase58();
  if (owner !== BPF_UPGRADEABLE) return { exists: true as const, executable: acc.executable, owner, programData: null, authority: undefined, data: null };
  const programData = new PublicKey(acc.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(programData, "confirmed");
  if (!pd) return { exists: true as const, executable: acc.executable, owner, programData, authority: undefined, data: null };
  // ProgramData: u32 tag(3) | u64 slot | Option<Pubkey> (1 + 32) | ELF...
  const hasAuth = pd.data[12] === 1;
  const authority = hasAuth ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
  return { exists: true as const, executable: acc.executable, owner, programData, authority, data: pd.data.subarray(45) };
}

const anchorDisc = (ixName: string) => createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);

async function main() {
  console.log(`A29 mainnet preflight (read-only, no transactions)${PRE_DEPLOY ? " [--pre-deploy]" : ""}`);

  // ---------------------------------------------------------------- config
  section("Config (lib/cluster)");
  let clusterName: string;
  try {
    clusterName = parseClusterName(process.env.SOLANA_CLUSTER);
  } catch (e) {
    report("FAIL", "SOLANA_CLUSTER parses", (e as Error).message);
    clusterName = "invalid";
  }
  if (clusterName === "mainnet-beta") report("PASS", "SOLANA_CLUSTER=mainnet-beta");
  else report("FAIL", "SOLANA_CLUSTER=mainnet-beta", `got ${process.env.SOLANA_CLUSTER ?? "(unset -> devnet)"}`);
  if (process.env.NEXT_PUBLIC_SOLANA_CLUSTER && parseClusterName(process.env.NEXT_PUBLIC_SOLANA_CLUSTER) !== clusterName)
    report("FAIL", "NEXT_PUBLIC_SOLANA_CLUSTER matches SOLANA_CLUSTER", process.env.NEXT_PUBLIC_SOLANA_CLUSTER);

  const cluster = clusterName === "invalid" ? CLUSTERS["mainnet-beta"] : currentCluster();
  const copy = Object.values(cluster.copy).join(" ");
  if (cluster.name === "mainnet-beta" && /devnet/i.test(copy)) report("FAIL", "mainnet copy has no 'devnet' string", copy);
  else if (cluster.name === "mainnet-beta") report("PASS", "mainnet copy has no 'devnet' string", `banner: "${cluster.copy.banner}"`);

  if (process.env.CHAIN_MODE === "devnet") report("PASS", "CHAIN_MODE=devnet (the real-chain adapter; cluster comes from SOLANA_CLUSTER)");
  else report("FAIL", "CHAIN_MODE=devnet (real chain)", `got ${process.env.CHAIN_MODE ?? "(unset -> fake)"}`);

  const quote = clusterQuoteMint(cluster);
  if (quote === MAINNET_USDC) report("PASS", "quote mint = mainnet USDC", quote);
  else report("FAIL", "quote mint = mainnet USDC", `got ${quote} (unset QUOTE_MINT or set it to ${MAINNET_USDC})`);

  const programIdStr = process.env.FS_ALLOWLIST_PROGRAM_ID || cluster.programs.fsAllowlist;
  if (programIdStr) report("PASS", "FS_ALLOWLIST_PROGRAM_ID set", programIdStr);
  else report(PRE_DEPLOY ? "WARN" : "FAIL", "FS_ALLOWLIST_PROGRAM_ID set", "fill in after A23 deploy");
  if (programIdStr && programIdStr === CLUSTERS.devnet.programs.fsAllowlist)
    report("WARN", "FS_ALLOWLIST_PROGRAM_ID is the devnet ID", "fine only if you deployed the same keypair to mainnet on purpose");

  const rpcUrl = clusterRpcUrl(cluster);
  if (rpcUrl === CLUSTERS["mainnet-beta"].defaultRpcUrl)
    report("WARN", "paid RPC configured", "RPC_URL is the public endpoint (rate-limited, no by-mint Token-2022 index; H6)");
  else report("PASS", "RPC_URL set", rpcUrl.replace(/(api[-_]?key=)[^&]+/i, "$1***"));
  if (/devnet/i.test(rpcUrl)) report("FAIL", "RPC_URL is not a devnet URL", "RPC_URL contains 'devnet'");
  if (/devnet/i.test(process.env.NEXT_PUBLIC_RPC_URL ?? "")) report("FAIL", "NEXT_PUBLIC_RPC_URL is not a devnet URL");

  const db = process.env.DATABASE_URL ?? "";
  if (/^postgres/i.test(db)) report("PASS", "DATABASE_URL is Postgres");
  else report("WARN", "DATABASE_URL is Postgres (SPEC 14)", `got ${db.split(":")[0] || "(unset)"}`);

  // ---------------------------------------------------------------- RPC
  section("RPC");
  const conn = new Connection(rpcUrl, "confirmed");
  try {
    const [genesis, version, slot] = await Promise.all([conn.getGenesisHash(), conn.getVersion(), conn.getSlot()]);
    if (genesis === MAINNET_GENESIS) report("PASS", "RPC reachable and on mainnet-beta", `slot ${slot}, solana-core ${version["solana-core"]}`);
    else report("FAIL", "RPC genesis = mainnet-beta", `genesis ${genesis} (slot ${slot}) — this RPC is not mainnet`);
  } catch (e) {
    report("FAIL", "RPC reachable", (e as Error).message);
    return;
  }

  // ---------------------------------------------------------------- mints / programs
  section("USDC mint");
  const quoteMint = new PublicKey(quote ?? MAINNET_USDC);
  const mintAcc = await conn.getAccountInfo(quoteMint);
  if (!mintAcc) report("FAIL", "quote mint exists", quoteMint.toBase58());
  else {
    const decimals = mintAcc.data[44];
    const ok = mintAcc.owner.equals(TOKEN_PROGRAM_ID) && decimals === 6;
    report(ok ? "PASS" : "FAIL", "quote mint is SPL Token, 6 decimals", `owner ${mintAcc.owner.toBase58()}, decimals ${decimals}`);
  }

  section("Meteora DBC");
  const dbc = await readUpgradeable(conn, new PublicKey(DBC_PROGRAM_ID));
  if (!dbc.exists || !dbc.executable) report("FAIL", "DBC program deployed", DBC_PROGRAM_ID);
  else {
    report("PASS", "DBC program deployed", `${DBC_PROGRAM_ID} (upgrade authority ${dbc.authority})`);
    if (dbc.data) {
      const hasName = dbc.data.includes(Buffer.from("CreateConfigWithTransferHook"));
      const hasDisc = dbc.data.includes(anchorDisc("create_config_with_transfer_hook"));
      if (hasName || hasDisc)
        report("PASS", "DBC binary has create_config_with_transfer_hook", `${hasName ? "instruction name" : ""}${hasName && hasDisc ? " + " : ""}${hasDisc ? "discriminator" : ""} found`);
      else report("FAIL", "DBC binary has create_config_with_transfer_hook", "not found — hook pools are not supported by this deploy (H1)");
    } else report("WARN", "DBC programdata readable", "could not inspect the binary");
  }

  section("fs_allowlist program");
  const fsAuthority = pubkeyFromKeypairFile(process.env.FS_AUTHORITY_KEYPAIR);
  if (!programIdStr) report(PRE_DEPLOY ? "WARN" : "FAIL", "fs_allowlist deployed", "no program ID yet");
  else {
    const prog = await readUpgradeable(conn, new PublicKey(programIdStr));
    if (!prog.exists) report(PRE_DEPLOY ? "WARN" : "FAIL", "fs_allowlist deployed", `${programIdStr} has no account on this cluster`);
    else if (!prog.executable) report("FAIL", "fs_allowlist executable", programIdStr);
    else {
      report("PASS", "fs_allowlist deployed", `${programIdStr}, ${prog.data ? prog.data.length : "?"} bytes`);
      if (prog.authority === null) report("WARN", "fs_allowlist upgrade authority", "immutable (no upgrades or close possible; rent is not recoverable)");
      else if (fsAuthority && prog.authority === fsAuthority.toBase58()) report("PASS", "fs_allowlist upgrade authority = FS authority", prog.authority);
      else report("WARN", "fs_allowlist upgrade authority", `${prog.authority} (FS authority is ${fsAuthority?.toBase58() ?? "unknown"})`);
      if (prog.data) {
        // Anchor logs "Instruction: <Name>" per handler, so the names are in the binary.
        const ixs = ["Initialize", "AddAllow", "RemoveAllow", "Execute"];
        const missing = ixs.filter((n) => !prog.data!.includes(Buffer.from(`Instruction: ${n}`)));
        report(missing.length ? "WARN" : "PASS", "fs_allowlist has initialize / add_allow / remove_allow / execute", missing.length ? `missing ${missing.join(", ")}; confirm this is the gated build (H12)` : "confirm it is the gated build (H12) by the deploy commit");
      }
    }
  }

  // ---------------------------------------------------------------- wallets vs caps
  section("Wallets vs SPEC 14 caps");
  const issuer = pubkeyFromKeypairFile(process.env.ISSUER_KEYPAIR);
  if (!fsAuthority) report("FAIL", "FS_AUTHORITY_KEYPAIR readable", process.env.FS_AUTHORITY_KEYPAIR ?? "(unset)");
  else {
    const l = await conn.getBalance(fsAuthority);
    if (PRE_DEPLOY) {
      report(l >= DEPLOY_RENT_MIN ? "PASS" : "FAIL", "FS authority holds deploy rent (>= 2 SOL, budget 2-4)", `${fsAuthority.toBase58()}: ${sol(l)}`);
    } else {
      if (l < MIN_FEE_SOL) report("FAIL", "FS authority can pay fees (>= 0.02 SOL)", `${fsAuthority.toBase58()}: ${sol(l)}`);
      else if (l > FS_AUTH_SOL_CAP_AFTER_DEPLOY) report("FAIL", "FS authority <= 1 SOL after deploy", `${fsAuthority.toBase58()}: ${sol(l)} — sweep the excess to cold storage`);
      else report("PASS", "FS authority within cap (0.02-1 SOL)", `${fsAuthority.toBase58()}: ${sol(l)}`);
    }
  }
  if (!issuer) report("FAIL", "ISSUER_KEYPAIR readable", process.env.ISSUER_KEYPAIR ?? "(unset)");
  else {
    const l = await conn.getBalance(issuer);
    report(l >= MIN_FEE_SOL ? "PASS" : "FAIL", "issuer can pay fees (>= 0.02 SOL)", `${issuer.toBase58()}: ${sol(l)}`);
    const u = await usdcBalance(conn, quoteMint, issuer);
    if (u === null) report("FAIL", "issuer USDC account exists", "no USDC ATA");
    else if (u > ISSUER_USDC_CAP) report("FAIL", "issuer USDC <= $200 cap", usd(u));
    else if (u < ISSUER_PAYOUT_NEED) report("FAIL", "issuer USDC covers pilot payouts ($8.50)", usd(u));
    else report("PASS", "issuer USDC within cap and covers payouts", usd(u));
  }
  for (const [name, envName, file, need] of [
    ["Alice", "ALICE_PUBKEY", "alice.json", ALICE_USDC_NEED],
    ["Bob", "BOB_PUBKEY", "bob.json", BOB_USDC_NEED],
  ] as const) {
    const pk = walletPubkey(envName, file);
    if (!pk) {
      report("WARN", `${name} wallet known`, `set ${envName} to check it`);
      continue;
    }
    const l = await conn.getBalance(pk);
    const u = (await usdcBalance(conn, quoteMint, pk)) ?? 0n;
    report(l >= MIN_FEE_SOL ? "PASS" : "FAIL", `${name} can pay fees + ATA rent (>= 0.02 SOL)`, `${pk.toBase58()}: ${sol(l)}`);
    report(u >= need ? "PASS" : "FAIL", `${name} USDC >= ${usd(need)} for the pilot buy`, usd(u));
  }

  // ---------------------------------------------------------------- summary
  const fails = results.filter((r) => r.level === "FAIL").length;
  const warns = results.filter((r) => r.level === "WARN").length;
  console.log(`\nPREFLIGHT: ${fails ? "FAIL" : "PASS"} — ${results.length - fails - warns} pass, ${warns} warn, ${fails} fail. No transactions were sent.`);
  process.exitCode = fails ? 1 : 0;
}

main().catch((e) => {
  console.error("PREFLIGHT: FAIL (unhandled)", e);
  process.exitCode = 1;
});
