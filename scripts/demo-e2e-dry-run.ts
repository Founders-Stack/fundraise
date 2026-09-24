// `scripts/demo-e2e.ts --dry-run` (A29): build and SIMULATE the pilot pool creation against the
// configured cluster. Never sends: the Connection's send methods are replaced with throwing stubs,
// and the simulation runs with sigVerify=false (throwaway config / mint keypairs only).
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveLaunchPricing, makeCashFlowTerms } from "../packages/core/src/rights/terms";
import { DEMO_PROTOCOL_CONFIG, toDbcFeeParams } from "../packages/core/src/monetization";
import { clusterAllowlistProgramId, clusterQuoteMint, clusterRpcUrl, currentCluster } from "../packages/core/src/cluster";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.join(ROOT, "apps", "web");
const webRequire = createRequire(path.join(WEB_DIR, "package.json"));

/** Same knob as the preview API's `graduationMultiple` (default 3). Pass the same value to the real preview. */
const GRADUATION_MULTIPLE = Number(process.env.GRADUATION_MULTIPLE ?? "3");
/** The graduation threshold must be at least this many times the planned pilot buys, which already
 * carry a 1.5x price-impact margin (SPEC 14: the pilot never graduates). */
const THRESHOLD_SAFETY_FACTOR = 5n;

export async function dryRun(opts: { scale: number; supply: bigint; sc: (pitch: bigint) => bigint }) {
  const web3 = webRequire("@solana/web3.js") as typeof import("@solana/web3.js");
  const { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } = web3;
  const dbc = await import(pathToFileURL(path.join(WEB_DIR, "lib/chain/devnet/dbc.ts")).href);
  const allowlist = await import(pathToFileURL(path.join(WEB_DIR, "lib/chain/devnet/allowlist.ts")).href);
  const envMod = await import(pathToFileURL(path.join(WEB_DIR, "lib/chain/devnet/env.ts")).href);
  const { DynamicBondingCurveClient, deriveDbcPoolAddress } = webRequire("@meteora-ag/dynamic-bonding-curve-sdk");

  const cluster = currentCluster();
  let failed = false;
  const ok = (label: string, extra?: string) => console.log(`  PASS  ${label}${extra ? ` — ${extra}` : ""}`);
  const warn = (label: string, extra?: string) => console.log(`  WARN  ${label}${extra ? ` — ${extra}` : ""}`);
  const bad = (label: string, extra?: string) => {
    failed = true;
    console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  };

  console.log(`DRY RUN (A29): cluster ${cluster.name}, DEMO_SCALE=${opts.scale}. Builds + simulates only; nothing is sent.`);

  // ---- 1. terms -> pricing (the same derivation POST /api/issuances/preview uses)
  console.log("\n== 1. Pilot terms and pricing");
  const terms = makeCashFlowTerms({
    issuerName: "Acme SaaS, Inc.",
    symbol: "ACME-CF",
    tokenName: "Acme SaaS Cash Flow Participation Unit",
    poolPercentageBps: 1000,
    expectedAnnualDcf: opts.sc(1_600_000n) * 1_000_000n,
    targetInitialYieldBps: 1600,
    tokenSupply: opts.supply,
  });
  const pricing = deriveLaunchPricing(terms, GRADUATION_MULTIPLE);
  const usd = (b: bigint) => `$${(Number(b) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
  console.log(`  graduationMultiple ${GRADUATION_MULTIPLE}, supply ${terms.tokenSupply} ACME-CF, start price ${usd(pricing.startingPricePerToken)}, start cap ${usd(pricing.startingMarketCap)}, graduation cap ${usd(pricing.graduationMarketCap)}`);
  if (pricing.startingPricePerToken === 1_000_000n) ok("start price is $1.00 at every scale");
  else bad("start price is $1.00", usd(pricing.startingPricePerToken));

  // ---- 2. DBC curve + graduation threshold vs pilot buys
  console.log("\n== 2. DBC curve (buildCurveParams, same as createIssuancePool)");
  const curve = {
    tokenSupply: terms.tokenSupply,
    tokenDecimals: terms.tokenDecimals,
    startingMarketCap: pricing.startingMarketCap,
    graduationMarketCap: pricing.graduationMarketCap,
    fees: toDbcFeeParams(DEMO_PROTOCOL_CONFIG),
    creatorLockedLiquidityPercentage: 100,
  };
  const { params, config } = dbc.buildCurveParams(curve);
  const threshold = BigInt(config.migrationQuoteThreshold.toString());
  // Alice buys 100k x scale, Bob 40k x scale, at ~$1 plus price impact / fees (x1.5 margin).
  const plannedBuys = (opts.sc(140_000n) * 1_000_000n * 3n) / 2n;
  console.log(`  migrationQuoteThreshold ${usd(threshold)} vs planned pilot buys <= ${usd(plannedBuys)}`);
  if (threshold >= plannedBuys * THRESHOLD_SAFETY_FACTOR) ok(`threshold >= ${THRESHOLD_SAFETY_FACTOR}x pilot buys (no graduation)`, `${(Number(threshold) / Number(plannedBuys)).toFixed(1)}x`);
  else bad(`threshold >= ${THRESHOLD_SAFETY_FACTOR}x pilot buys`, "raise GRADUATION_MULTIPLE (and pass the same graduationMultiple to the preview) or reduce the buys");

  // ---- 3. Build the two creation transactions
  console.log("\n== 3. Build createConfigAndPoolWithTransferHook + fs_allowlist init");
  const rpcUrl = clusterRpcUrl(cluster);
  const connection = new Connection(rpcUrl, "confirmed");
  const refuse = () => {
    throw new Error("--dry-run: sending is disabled");
  };
  // Hard guard: nothing below can broadcast.
  Object.assign(connection, { sendRawTransaction: refuse, sendTransaction: refuse, sendEncodedTransaction: refuse });

  const quote = clusterQuoteMint(cluster);
  if (!quote) {
    bad("quote mint configured", "QUOTE_MINT is not set");
    return finish();
  }
  const quoteMint = new PublicKey(quote);
  let allowlistProgram: InstanceType<typeof PublicKey>;
  try {
    allowlistProgram = new PublicKey(clusterAllowlistProgramId(cluster));
  } catch (e) {
    bad("FS_ALLOWLIST_PROGRAM_ID set", (e as Error).message);
    return finish();
  }
  const pk = (envName: string) => {
    const p = process.env[envName];
    if (!p) return null;
    try {
      return envMod.loadKeypair(p).publicKey as InstanceType<typeof PublicKey>;
    } catch {
      return null;
    }
  };
  const fsAuthority = pk("FS_AUTHORITY_KEYPAIR");
  const issuer = pk("ISSUER_KEYPAIR");
  if (!fsAuthority || !issuer) warn("custody keypairs", "FS_AUTHORITY_KEYPAIR / ISSUER_KEYPAIR not readable; using throwaway keys (simulation will fail on fees)");
  const payer = fsAuthority ?? Keypair.generate().publicKey;
  const creator = issuer ?? Keypair.generate().publicKey;
  const configKp = Keypair.generate();
  const baseMintKp = Keypair.generate();

  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const tx1 = await client.partner.createConfigAndPoolWithTransferHook({
    ...config,
    config: configKp.publicKey,
    feeClaimer: payer,
    leftoverReceiver: payer,
    quoteMint,
    transferHookProgram: allowlistProgram,
    payer,
    preCreatePoolParam: {
      name: terms.tokenName.slice(0, 32),
      symbol: terms.symbol.slice(0, 10),
      uri: "https://example.invalid/dry-run",
      poolCreator: creator,
      baseMint: baseMintKp.publicKey,
    },
  });
  const ixs1 = [...envMod.computeBudgetIxs(600_000), ...tx1.instructions];
  const ixs2 = [
    ...envMod.computeBudgetIxs(200_000),
    allowlist.initializeIx({ program: allowlistProgram, payer, authority: payer, mint: baseMintKp.publicKey, admin: payer }),
    allowlist.addAllowIx({ program: allowlistProgram, admin: payer, mint: baseMintKp.publicKey, wallet: dbc.DBC_POOL_AUTHORITY }),
  ];
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const v0 = (ixs: typeof ixs1) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const vtx1 = v0(ixs1);
  const vtx2 = v0(ixs2);
  ok("tx1 built", `${ixs1.length} ixs, ${vtx1.serialize().length} bytes (limit 1232)`);
  ok("tx2 built", `${ixs2.length} ixs, ${vtx2.serialize().length} bytes`);
  const pool = deriveDbcPoolAddress(quoteMint, baseMintKp.publicKey, configKp.publicKey);
  console.log(`  would create: config ${configKp.publicKey.toBase58()}, mint ${baseMintKp.publicKey.toBase58()}${pool ? `, pool ${pool.toBase58()}` : ""}`);
  console.log(`  quote ${quoteMint.toBase58()}, hook ${allowlistProgram.toBase58()}, payer/partner ${payer.toBase58()}, creator ${creator.toBase58()}`);
  console.log(`  curve: ${JSON.stringify({ migrationQuoteThreshold: threshold.toString(), sqrtStartPrice: config.sqrtStartPrice.toString(), totalTokenSupply: params.token.totalTokenSupply })}`);

  // ---- 4. Simulate tx1 (tx2 depends on the mint tx1 creates, so it can only be built here)
  console.log("\n== 4. Simulate tx1 (sigVerify=false, nothing sent)");
  const sim = await connection.simulateTransaction(vtx1, { sigVerify: false, replaceRecentBlockhash: true });
  const logs = sim.value.logs ?? [];
  if (sim.value.err) {
    bad("tx1 simulation", `${JSON.stringify(sim.value.err)}`);
    for (const l of logs.slice(-15)) console.log(`        ${l}`);
    if (!fsAuthority || JSON.stringify(sim.value.err).includes("AccountNotFound"))
      console.log("        (AccountNotFound = the payer / FS authority has no SOL on this cluster yet: fund it (U12) and re-run)");
  } else {
    ok("tx1 simulation succeeded", `${sim.value.unitsConsumed ?? "?"} CU`);
    const hookIx = logs.find((l) => /Instruction: CreateConfigWithTransferHook/.test(l));
    if (hookIx) ok("DBC ran create_config_with_transfer_hook", hookIx.trim());
  }
  warn("tx2 (fs_allowlist initialize + add_allow) not simulated", "it needs the mint that tx1 creates");
  return finish();

  function finish() {
    console.log(`\nDRY RUN: ${failed ? "FAIL" : "PASS"} — no transaction was sent.`);
    process.exitCode = failed ? 1 : 0;
  }
}
