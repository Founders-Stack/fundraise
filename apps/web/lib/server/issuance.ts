// Issuance preview → create (SPEC sections 0.3, 5, 8). The API is the brain: every
// number a skill shows comes from here, as base units + human-readable strings.
import {
  AGREEMENT_VERSION,
  COPY,
  DEMO_PROTOCOL_CONFIG,
  agreementHash,
  deriveLaunchPricing,
  describeFees,
  makeCashFlowTerms,
  periodContaining,
  projectEconomics,
  renderAgreement,
  toDbcFeeParams,
  validateCashFlowTerms,
  validateMonetizationConfig,
  type CashFlowTerms,
  type DistributionFrequency,
  type MonetizationConfig,
} from "@fstack/core";
import { prisma } from "@/lib/db";
import { getChain, type CreatePoolInput, type WalletPool } from "@/lib/chain";
import { HttpError, appUrl } from "./http";
import { awaitingSignature, openSignRequest, signingMode, type SignPayload } from "./signing";
import {
  attachMarket,
  deleteIssuance,
  insertPendingIssuance,
  loadIssuance,
  onboardUrl,
  requireMarket,
  type IssuanceRecord,
} from "./issuance-record";
import { parseUsdc, pctDisplay, tokenDisplay, usdc, usdDisplay } from "./money";

export const DEFAULT_GRADUATION_MULTIPLE = 3;
export const DEFAULT_TOKEN_SUPPLY = 1_000_000n;
/**
 * Preview-only assumption for the graduation economics before a pool exists: the share of
 * supply sold along the curve. With a constant-product segment from p0 to p1 the quote raised
 * is sold × √(p0·p1), i.e. soldFraction × √(startingMarketCap × graduationMarketCap).
 * After creation, the market endpoint uses the pool's real migrationQuoteThreshold.
 */
export const ILLUSTRATIVE_SOLD_FRACTION_BPS = 8000n;

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// ---------------------------------------------------------------- input

export interface PreviewInput {
  terms: CashFlowTerms;
  graduationMultiple: number;
  monetization: MonetizationConfig;
}

function int(v: unknown, field: string, errors: string[]): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) {
    errors.push(`${field} must be an integer`);
    return NaN;
  }
  return n;
}

/**
 * Body of POST /api/issuances/preview.
 * - expectedAnnualDcf: USDC as a DECIMAL STRING (e.g. "1600000" = $1.6M). Not base units.
 * - poolPercentageBps / targetInitialYieldBps: basis points (1000 = 10%, 1600 = 16%).
 * - tokenSupply: whole tokens (default 1,000,000). graduationMultiple default 3.
 */
export function parsePreviewInput(body: Record<string, unknown>): PreviewInput {
  const errors: string[] = [];
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const issuerName = str(body.issuerName);
  const symbol = str(body.symbol).toUpperCase();
  const tokenName = str(body.tokenName) || `${issuerName} Cash Flow Participation Unit`.slice(0, 64);
  const poolPercentageBps = int(body.poolPercentageBps, "poolPercentageBps", errors);
  const targetInitialYieldBps = int(body.targetInitialYieldBps, "targetInitialYieldBps", errors);

  let expectedAnnualDcf = 0n;
  const dcfRaw = typeof body.expectedAnnualDcf === "number" ? String(body.expectedAnnualDcf) : body.expectedAnnualDcf;
  if (typeof dcfRaw !== "string") errors.push('expectedAnnualDcf must be a USDC decimal string, e.g. "1600000"');
  else {
    try {
      expectedAnnualDcf = parseUsdc(dcfRaw);
    } catch (e) {
      errors.push(`expectedAnnualDcf: ${(e as Error).message}`);
    }
  }

  let tokenSupply = DEFAULT_TOKEN_SUPPLY;
  if (body.tokenSupply !== undefined && body.tokenSupply !== null) {
    const s = String(body.tokenSupply).replace(/[,_]/g, "");
    if (!/^\d+$/.test(s)) errors.push("tokenSupply must be a whole number of tokens");
    else tokenSupply = BigInt(s);
  }

  const graduationMultiple =
    body.graduationMultiple === undefined || body.graduationMultiple === null
      ? DEFAULT_GRADUATION_MULTIPLE
      : Number(body.graduationMultiple);
  if (!Number.isFinite(graduationMultiple) || graduationMultiple <= 1 || graduationMultiple > 100) {
    errors.push("graduationMultiple must be a number > 1 (default 3)");
  }

  const freqRaw = str(body.distributionFrequency).toUpperCase() || "QUARTERLY";
  const distributionFrequency = freqRaw as DistributionFrequency;

  const terms = makeCashFlowTerms({
    issuerName,
    symbol,
    tokenName,
    poolPercentageBps,
    expectedAnnualDcf,
    targetInitialYieldBps,
    tokenSupply,
    distributionFrequency,
    ...(str(body.issuerJurisdiction) ? { issuerJurisdiction: str(body.issuerJurisdiction) } : {}),
  });
  errors.push(...validateCashFlowTerms(terms));

  const monetization = DEMO_PROTOCOL_CONFIG;
  errors.push(...validateMonetizationConfig(monetization));

  if (errors.length) throw new HttpError(400, "invalid_terms", "Issuance terms are invalid", { errors: [...new Set(errors)] });
  return { terms, graduationMultiple, monetization };
}

// ---------------------------------------------------------------- derivation

function serializeTerms(i: PreviewInput) {
  return JSON.stringify(
    { terms: i.terms, graduationMultiple: i.graduationMultiple, monetization: i.monetization },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
  );
}

function deserializeTerms(s: string): PreviewInput {
  const raw = JSON.parse(s);
  return {
    terms: {
      ...raw.terms,
      tokenSupply: BigInt(raw.terms.tokenSupply),
      expectedAnnualDcf: BigInt(raw.terms.expectedAnnualDcf),
    },
    graduationMultiple: raw.graduationMultiple,
    monetization: raw.monetization,
  };
}

/** Everything a skill needs to show the founder before they say "yes". Pure given input + now. */
export function buildPreview(input: PreviewInput, now = new Date()) {
  const { terms, graduationMultiple, monetization } = input;
  const pricing = deriveLaunchPricing(terms, graduationMultiple);
  const feeParams = toDbcFeeParams(monetization);
  const agreementText = renderAgreement(terms);
  const hash = agreementHash(agreementText);
  const graduationPricePerToken = pricing.graduationMarketCap / terms.tokenSupply;

  const estimatedThreshold =
    (isqrt(pricing.startingMarketCap * pricing.graduationMarketCap) * ILLUSTRATIVE_SOLD_FRACTION_BPS) / 10_000n;
  const econ = projectEconomics(monetization, estimatedThreshold);
  const { issuerPct, platformPct, liquidityPct } = monetization.graduation;
  const { creatorPct, partnerPct } = monetization.dbcTradingFees;
  const poolPct = pctDisplay(terms.poolPercentageBps);
  const yieldPct = pctDisplay(terms.targetInitialYieldBps);
  const freqWord = terms.distributionFrequency === "MONTHLY" ? "monthly" : "quarterly";

  return {
    terms: {
      issuerName: terms.issuerName,
      issuerJurisdiction: terms.issuerJurisdiction,
      symbol: terms.symbol,
      tokenName: terms.tokenName,
      tokenSupply: terms.tokenSupply,
      tokenSupplyDisplay: tokenDisplay(terms.tokenSupply, 0),
      tokenDecimals: terms.tokenDecimals,
      poolPercentageBps: terms.poolPercentageBps,
      poolPercentage: poolPct,
      distributionFrequency: terms.distributionFrequency,
      expectedAnnualDcf: usdc(terms.expectedAnnualDcf),
      targetInitialYieldBps: terms.targetInitialYieldBps,
      targetInitialYield: yieldPct,
      graduationMultiple,
    },
    pricing: {
      expectedAnnualRightsPool: usdc(pricing.expectedAnnualRightsPool),
      startingMarketCap: usdc(pricing.startingMarketCap),
      graduationMarketCap: usdc(pricing.graduationMarketCap),
      startingPricePerToken: usdc(pricing.startingPricePerToken),
      graduationPricePerToken: usdc(graduationPricePerToken),
      marketCapLabel: COPY.marketCap,
      derivation: [
        {
          step: "Expected annual rights pool",
          formula: `${usdDisplay(terms.expectedAnnualDcf)} expected annual DCF × ${poolPct}`,
          result: usdDisplay(pricing.expectedAnnualRightsPool),
        },
        {
          step: "Starting token market cap",
          formula: `${usdDisplay(pricing.expectedAnnualRightsPool)} ÷ ${yieldPct} target initial yield`,
          result: usdDisplay(pricing.startingMarketCap),
        },
        {
          step: "Starting price per token",
          formula: `${usdDisplay(pricing.startingMarketCap)} ÷ ${tokenDisplay(terms.tokenSupply, 0)} tokens`,
          result: usdDisplay(pricing.startingPricePerToken),
        },
        {
          step: "Graduation token market cap",
          formula: `${usdDisplay(pricing.startingMarketCap)} × ${graduationMultiple}`,
          result: usdDisplay(pricing.graduationMarketCap),
        },
      ],
    },
    fees: {
      mode: monetization.mode,
      description: describeFees(monetization),
      dbcFeeParams: feeParams,
      tradingFeeSplit: { startupPct: creatorPct, founderStackPct: partnerPct },
    },
    projectedGraduation: {
      label: COPY.illustrativeEconomics,
      split: { issuerPct, platformPct, liquidityPct },
      estimatedMigrationQuoteThreshold: usdc(estimatedThreshold),
      issuer: usdc(econ.issuer),
      founderStack: usdc(econ.platform),
      liquidity: usdc(econ.liquidity),
      note:
        "Estimate before the pool exists. After launch, amounts are read from the pool's migration quote threshold. " +
        COPY.positioning.economics,
    },
    agreement: {
      version: AGREEMENT_VERSION,
      hash,
      summary: [
        `${terms.issuerName} shares ${poolPct} of each ${freqWord} period's issuer-reported Distributable Cash Flow with holders.`,
        `1 ${terms.symbol} = 1/${tokenDisplay(terms.tokenSupply, 0)} of each period's rights pool, paid in USDC to registered wallets at the record date.`,
        "Units in the market pool or in unregistered wallets are unallocated (retained by issuer).",
        "Transfers only to verified wallets that accepted the agreement (Token-2022 transfer hook).",
        "Contractual cash-flow participation, not equity. No guaranteed returns.",
      ],
      text: agreementText,
    },
    custody: COPY.demoCustody,
    positioning: [COPY.positioning.claim, COPY.positioning.reported, COPY.positioning.meteora],
    nextRecordDateIfLaunchedNow: periodContaining(now, terms.distributionFrequency).recordDate,
  };
}

export async function createPreview(body: Record<string, unknown>) {
  const input = parsePreviewInput(body);
  const preview = buildPreview(input);
  const row = await prisma.issuancePreview.create({
    data: {
      termsJson: serializeTerms(input),
      derivedJson: JSON.stringify(preview, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    },
  });
  return {
    previewId: row.id,
    nextStep:
      "Show this preview to the founder. Only after an explicit yes, call POST /api/issuances with { previewId } (creates on-chain state). A previewId can be used once.",
    ...preview,
  };
}

// ---------------------------------------------------------------- create

/**
 * Step 1 (fast, DB only): claims the preview atomically and inserts a pending Issuance row
 * (baseMint = null). Split from step 2 so creation can move to a background job (H10).
 */
export async function startIssuanceCreation(previewId: unknown) {
  if (typeof previewId !== "string" || previewId.trim() === "") {
    throw new HttpError(400, "preview_required", "previewId is required: call POST /api/issuances/preview first");
  }
  const preview = await prisma.issuancePreview.findUnique({ where: { id: previewId } });
  if (!preview) throw new HttpError(400, "preview_not_found", `No preview ${previewId}: call POST /api/issuances/preview first`);
  if (preview.usedAt) {
    throw new HttpError(409, "preview_already_used", `Preview ${previewId} was already used`, { issuanceId: preview.issuanceId });
  }
  const claimed = await prisma.issuancePreview.updateMany({
    where: { id: previewId, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) throw new HttpError(409, "preview_already_used", `Preview ${previewId} was already used`);

  const input = deserializeTerms(preview.termsJson);
  const { terms, graduationMultiple, monetization } = input;
  const pricing = deriveLaunchPricing(terms, graduationMultiple);
  const agreementText = renderAgreement(terms);
  try {
    const issuance = await insertPendingIssuance({
      terms,
      graduationMultiple,
      startingMarketCap: pricing.startingMarketCap,
      graduationMarketCap: pricing.graduationMarketCap,
      agreement: { hash: agreementHash(agreementText), text: agreementText },
      monetization,
      nextRecordDate: periodContaining(new Date(), terms.distributionFrequency).recordDate,
    });
    await prisma.issuancePreview.update({ where: { id: previewId }, data: { issuanceId: issuance.id } });
    return issuance;
  } catch (e) {
    await prisma.issuancePreview.update({ where: { id: previewId }, data: { usedAt: null } });
    throw e;
  }
}

/** Step 2 (slow, on-chain): mint + hook + DBC pool. On failure the row is removed and the preview released. */
export async function completeIssuanceCreation(issuance: IssuanceRecord, previewId: string): Promise<IssuanceRecord> {
  const chain = await getChain();
  try {
    const res = await chain.market.createIssuancePool(poolInput(issuance));
    return await attachMarket(issuance.id, {
      baseMint: res.baseMint,
      quoteMint: chain.payout.quoteMint(),
      dbcPool: res.dbcPool,
      dbcConfig: res.dbcConfig,
      poolOwners: res.poolOwners,
      signatures: res.signatures,
      dbcParams: res.dbcParams,
      chainMode: chain.mode,
    });
  } catch (e) {
    await deleteIssuance(issuance.id);
    await prisma.issuancePreview.update({ where: { id: previewId }, data: { usedAt: null, issuanceId: null } });
    throw new HttpError(502, "chain_error", `Creating the market failed; the preview can be retried: ${(e as Error).message}`);
  }
}

function poolInput(issuance: IssuanceRecord): CreatePoolInput {
  const { terms } = issuance;
  return {
    name: terms.tokenName,
    symbol: terms.symbol,
    uri: `${appUrl()}/api/issuances/${issuance.id}`,
    tokenSupply: terms.tokenSupply,
    tokenDecimals: terms.tokenDecimals,
    startingMarketCap: issuance.startingMarketCap,
    graduationMarketCap: issuance.graduationMarketCap,
    fees: toDbcFeeParams(issuance.monetization),
    creatorLockedLiquidityPercentage: 100,
  };
}

/**
 * POST /api/issuances. Custody mode (default) creates the market now with server keys; wallet mode
 * (SPEC 0.4 P1) leaves the issuance PENDING and returns a signUrl for the founder's wallet.
 */
export async function createIssuance(previewId: unknown, opts: { signingMode?: unknown } = {}) {
  const mode = signingMode(opts.signingMode);
  const pending = await startIssuanceCreation(previewId);
  if (mode === "wallet") return requestIssuanceSignature(pending);
  const done = await completeIssuanceCreation(pending, previewId as string);
  return liveIssuanceResult(done, COPY.demoCustody);
}

function liveIssuanceResult(done: IssuanceRecord, custody: string) {
  const market = requireMarket(done);
  return {
    issuanceId: done.id,
    status: "LIVE",
    symbol: done.terms.symbol,
    baseMint: market.baseMint,
    quoteMint: market.quoteMint,
    dbcConfig: market.dbcConfig,
    dbcPool: market.dbcPool,
    signatures: market.signatures,
    chainMode: market.chainMode,
    agreementHash: done.agreement.hash,
    nextRecordDate: done.nextRecordDate,
    marketUrl: `${appUrl()}/market/${done.id}`,
    /** Share this with investors: it carries the invite code onboarding requires. */
    onboardUrl: onboardUrl(done, true),
    inviteCode: done.inviteCode,
    custody,
  };
}

// ---------------------------------------------------------------- wallet signing (SPEC 0.4 P1)

export const WALLET_CUSTODY_LABEL = "Founder wallet (signed via sign link)";

/** Wallet mode: the pending issuance waits for the founder's wallet to sign the create-pool tx. */
async function requestIssuanceSignature(pending: IssuanceRecord) {
  const { terms } = pending;
  const row = await openSignRequest("ISSUANCE_CREATE", pending.id, {
    title: `Launch ${terms.symbol}`,
    action: `Create the ${terms.symbol} Token-2022 mint and its Meteora DBC market, with your wallet as the pool creator.`,
    lines: [
      { label: "Issuer", value: terms.issuerName },
      { label: "Token", value: `${terms.tokenName} (${terms.symbol})` },
      { label: "Supply", value: `${tokenDisplay(terms.tokenSupply, 0)} tokens` },
      {
        label: "Rights pool",
        value: `${pctDisplay(terms.poolPercentageBps)} of ${terms.distributionFrequency.toLowerCase()} Distributable Cash Flow`,
      },
      { label: "Starting token market cap", value: usdDisplay(pending.startingMarketCap) },
      { label: "Graduation token market cap", value: usdDisplay(pending.graduationMarketCap) },
      { label: "Agreement hash", value: pending.agreement.hash },
    ],
    warning: "Your wallet pays the network fees and rent for the new accounts (a few hundredths of a SOL).",
    doneUrl: `${appUrl()}/market/${pending.id}`,
  });
  return awaitingSignature(row, { issuanceId: pending.id, symbol: terms.symbol });
}

/** Builds the create-pool tx for the founder's wallet. */
export async function buildIssuanceSignTxs(issuanceId: string, wallet: string): Promise<SignPayload> {
  const rec = await loadIssuance(issuanceId);
  if (rec.market) throw new HttpError(409, "already_live", "this issuance already has a market");
  const chain = await getChain();
  const { tx, pool } = await chain.wallet.buildCreatePoolTx(poolInput(rec), wallet);
  return { txs: [tx], data: { pool } };
}

/** After the founder's create tx confirmed: server allowlist setup, then attach the market. */
export async function applyIssuanceSigned(
  issuanceId: string,
  wallet: string,
  payload: SignPayload,
  signedTxs: string[],
  onSignature: (sig: string) => Promise<void>,
) {
  const chain = await getChain();
  const pool = payload.data.pool as WalletPool;
  const rec = await loadIssuance(issuanceId);
  if (rec.market) throw new HttpError(409, "already_live", "this issuance already has a market");
  let signature: string;
  try {
    ({ signature } = await chain.wallet.submitSigned(payload.txs[0], signedTxs[0], wallet));
  } catch (e) {
    throw new HttpError(502, "chain_error", `Creating the market failed; reload the sign page to try again: ${(e as Error).message}`);
  }
  await onSignature(signature);
  const signatures = [signature];
  const followUp = await chain.wallet.finalizeCreatePool(pool);
  const done = await attachMarket(issuanceId, {
    baseMint: pool.baseMint,
    quoteMint: chain.payout.quoteMint(),
    dbcPool: pool.dbcPool,
    dbcConfig: pool.dbcConfig,
    poolOwners: pool.poolOwners,
    signatures: [...signatures, ...followUp.signatures],
    dbcParams: { ...pool.dbcParams, creator: wallet, signingMode: "wallet" },
    chainMode: chain.mode,
  });
  return liveIssuanceResult(done, WALLET_CUSTODY_LABEL);
}

// ---------------------------------------------------------------- views

/** Public, secret-free view (GET /api/issuances/:id). Also serves as the token metadata URI. */
export function publicIssuanceView(rec: IssuanceRecord) {
  const { terms, market } = rec;
  const dcfDefinition = terms.distributableCashFlowDefinition;
  return {
    id: rec.id,
    // metadata-style fields (the token's uri points here)
    name: terms.tokenName,
    symbol: terms.symbol,
    description: `${COPY.positioning.claim} ${terms.issuerName}: ${pctDisplay(terms.poolPercentageBps)} of ${terms.distributionFrequency.toLowerCase()} Distributable Cash Flow.`,
    issuerName: terms.issuerName,
    rightsType: rec.rightsType,
    status: market ? "LIVE" : "PENDING",
    dcfDefinition,
    terms: {
      tokenName: terms.tokenName,
      issuerJurisdiction: terms.issuerJurisdiction,
      distributableCashFlowDefinition: dcfDefinition,
      recordDateRule: terms.recordDateRule,
      poolPercentageBps: terms.poolPercentageBps,
      poolPercentage: pctDisplay(terms.poolPercentageBps),
      tokenSupply: terms.tokenSupply,
      tokenSupplyDisplay: tokenDisplay(terms.tokenSupply, 0),
      tokenDecimals: terms.tokenDecimals,
      distributionFrequency: terms.distributionFrequency,
      expectedAnnualDcf: usdc(terms.expectedAnnualDcf),
      targetInitialYieldBps: terms.targetInitialYieldBps,
      targetInitialYield: pctDisplay(terms.targetInitialYieldBps),
      graduationMultiple: rec.graduationMultiple,
      startingMarketCap: usdc(rec.startingMarketCap),
      graduationMarketCap: usdc(rec.graduationMarketCap),
      startingPricePerToken: usdc(rec.startingMarketCap / terms.tokenSupply),
      marketCapLabel: COPY.marketCap,
    },
    agreement: rec.agreement,
    chain: {
      baseMint: market?.baseMint ?? null,
      quoteMint: market?.quoteMint ?? null,
      dbcConfig: market?.dbcConfig ?? null,
      dbcPool: market?.dbcPool ?? null,
      dammPool: market?.dammPool ?? null,
      poolOwners: market?.poolOwners ?? [],
      signatures: market?.signatures ?? [],
    },
    fees: { mode: rec.monetization.mode, description: describeFees(rec.monetization) },
    nextRecordDate: rec.nextRecordDate,
    marketUrl: `${appUrl()}/market/${rec.id}`,
    onboardUrl: onboardUrl(rec, false),
    custody: COPY.demoCustody,
    createdAt: rec.createdAt,
  };
}
