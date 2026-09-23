// Issuance preview → create (SPEC sections 0.3, 5, 8). The API is the brain: every
// number a skill shows comes from here, as base units + human-readable strings.
import type { Issuance } from "@prisma/client";
import {
  AGREEMENT_VERSION,
  COPY,
  DEMO_PROTOCOL_CONFIG,
  agreementHash,
  deriveLaunchPricing,
  describeFees,
  makeCashFlowTerms,
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
import { getChain } from "@/lib/chain";
import { HttpError, appUrl } from "./http";
import { isqrt, parseUnits, pctDisplay, tokenDisplay, usdc, usdDisplay } from "./money";

export const DEFAULT_GRADUATION_MULTIPLE = 3;
export const DEFAULT_TOKEN_SUPPLY = 1_000_000n;
/**
 * Preview-only assumption for the graduation economics before a pool exists: the share of
 * supply sold along the curve. With a constant-product segment from p0 to p1 the quote raised
 * is sold × √(p0·p1), i.e. soldFraction × √(startingMarketCap × graduationMarketCap).
 * After creation, the market endpoint uses the pool's real migrationQuoteThreshold.
 */
export const ILLUSTRATIVE_SOLD_FRACTION_BPS = 8000n;

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
      expectedAnnualDcf = parseUnits(dcfRaw);
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

// ---------------------------------------------------------------- dates

/** End of the current calendar quarter / month (UTC, last millisecond). */
export function endOfPeriod(now: Date, freq: DistributionFrequency): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const nextStartMonth = freq === "MONTHLY" ? m + 1 : Math.floor(m / 3) * 3 + 3;
  return new Date(Date.UTC(y, nextStartMonth, 1) - 1);
}

export const periodsPerYear = (freq: string) => (freq === "MONTHLY" ? 12 : 4);

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
  const poolPct = pctDisplay(terms.poolPercentageBps)!;
  const yieldPct = pctDisplay(terms.targetInitialYieldBps)!;
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
    nextRecordDateIfLaunchedNow: endOfPeriod(now, terms.distributionFrequency),
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
    const issuance = await prisma.issuance.create({
      data: {
        issuerName: terms.issuerName,
        poolPercentageBps: terms.poolPercentageBps,
        tokenSupply: terms.tokenSupply,
        symbol: terms.symbol,
        name: terms.tokenName,
        distributionFrequency: terms.distributionFrequency,
        nextRecordDate: endOfPeriod(new Date(), terms.distributionFrequency),
        expectedAnnualDcf: terms.expectedAnnualDcf,
        targetInitialYieldBps: terms.targetInitialYieldBps,
        graduationMultiple,
        agreementVersion: terms.agreementVersion,
        agreementHash: agreementHash(agreementText),
        agreementText,
        startingMarketCap: pricing.startingMarketCap,
        graduationMarketCap: pricing.graduationMarketCap,
        monetization: JSON.stringify(monetization),
      },
    });
    await prisma.issuancePreview.update({ where: { id: previewId }, data: { issuanceId: issuance.id } });
    return { issuance, input };
  } catch (e) {
    await prisma.issuancePreview.update({ where: { id: previewId }, data: { usedAt: null } });
    throw e;
  }
}

/** Step 2 (slow, on-chain): mint + hook + DBC pool. On failure the row is removed and the preview released. */
export async function completeIssuanceCreation(issuance: Issuance, input: PreviewInput, previewId: string) {
  const chain = await getChain();
  try {
    const res = await chain.market.createIssuancePool({
      name: input.terms.tokenName,
      symbol: input.terms.symbol,
      uri: `${appUrl()}/api/issuances/${issuance.id}`,
      tokenSupply: input.terms.tokenSupply,
      tokenDecimals: input.terms.tokenDecimals,
      startingMarketCap: issuance.startingMarketCap,
      graduationMarketCap: issuance.graduationMarketCap,
      fees: toDbcFeeParams(input.monetization),
      creatorLockedLiquidityPercentage: 100,
    });
    return await prisma.issuance.update({
      where: { id: issuance.id },
      data: {
        baseMint: res.baseMint,
        dbcPool: res.dbcPool,
        quoteMint: chain.payout.quoteMint(),
        dbcConfig: JSON.stringify({
          address: res.dbcConfig,
          poolOwners: res.poolOwners,
          dbcParams: res.dbcParams,
          signatures: res.signatures,
          chainMode: chain.mode,
        }),
      },
    });
  } catch (e) {
    await prisma.issuance.delete({ where: { id: issuance.id } }).catch(() => {});
    await prisma.issuancePreview.update({ where: { id: previewId }, data: { usedAt: null, issuanceId: null } });
    throw new HttpError(502, "chain_error", `Creating the market failed; the preview can be retried: ${(e as Error).message}`);
  }
}

export async function createIssuance(previewId: unknown) {
  const { issuance, input } = await startIssuanceCreation(previewId);
  const done = await completeIssuanceCreation(issuance, input, previewId as string);
  const cfg = parseJson<{ address?: string; signatures?: string[] }>(done.dbcConfig) ?? {};
  return {
    issuanceId: done.id,
    status: "LIVE",
    symbol: done.symbol,
    baseMint: done.baseMint,
    quoteMint: done.quoteMint,
    dbcConfig: cfg.address,
    dbcPool: done.dbcPool,
    signatures: cfg.signatures ?? [],
    chainMode: (await getChain()).mode,
    agreementHash: done.agreementHash,
    nextRecordDate: done.nextRecordDate,
    marketUrl: `${appUrl()}/market/${done.id}`,
    onboardUrl: `${appUrl()}/onboard/${done.id}`,
    custody: COPY.demoCustody,
  };
}

// ---------------------------------------------------------------- views

export function parseJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export async function getIssuanceOr404(id: string) {
  const issuance = await prisma.issuance.findUnique({ where: { id } });
  if (!issuance) throw new HttpError(404, "issuance_not_found", `No issuance ${id}`);
  return issuance;
}

/** Public, secret-free view (GET /api/issuances/:id). Also serves as the token metadata URI. */
export function publicIssuanceView(i: Issuance) {
  const monetization = parseJson<MonetizationConfig>(i.monetization) ?? DEMO_PROTOCOL_CONFIG;
  const cfg = parseJson<{ address?: string; poolOwners?: string[]; signatures?: string[]; dbcParams?: unknown }>(i.dbcConfig);
  return {
    id: i.id,
    // metadata-style fields (the token's uri points here)
    name: i.name,
    symbol: i.symbol,
    description: `${COPY.positioning.claim} ${i.issuerName}: ${pctDisplay(i.poolPercentageBps)} of ${i.distributionFrequency.toLowerCase()} Distributable Cash Flow.`,
    issuerName: i.issuerName,
    rightsType: i.rightsType,
    status: i.baseMint ? "LIVE" : "PENDING",
    terms: {
      poolPercentageBps: i.poolPercentageBps,
      poolPercentage: pctDisplay(i.poolPercentageBps),
      tokenSupply: i.tokenSupply,
      tokenSupplyDisplay: tokenDisplay(i.tokenSupply, 0),
      distributionFrequency: i.distributionFrequency,
      expectedAnnualDcf: usdc(i.expectedAnnualDcf),
      targetInitialYieldBps: i.targetInitialYieldBps,
      targetInitialYield: pctDisplay(i.targetInitialYieldBps),
      graduationMultiple: i.graduationMultiple,
      startingMarketCap: usdc(i.startingMarketCap),
      graduationMarketCap: usdc(i.graduationMarketCap),
      startingPricePerToken: usdc(i.startingMarketCap / i.tokenSupply),
      marketCapLabel: COPY.marketCap,
    },
    agreement: { version: i.agreementVersion, hash: i.agreementHash, text: i.agreementText },
    chain: {
      baseMint: i.baseMint,
      quoteMint: i.quoteMint,
      dbcConfig: cfg?.address ?? null,
      dbcPool: i.dbcPool,
      dammPool: i.dammPool,
      poolOwners: cfg?.poolOwners ?? [],
      signatures: cfg?.signatures ?? [],
    },
    fees: { mode: monetization.mode, description: describeFees(monetization) },
    nextRecordDate: i.nextRecordDate,
    marketUrl: `${appUrl()}/market/${i.id}`,
    onboardUrl: `${appUrl()}/onboard/${i.id}`,
    custody: COPY.demoCustody,
    createdAt: i.createdAt,
  };
}
