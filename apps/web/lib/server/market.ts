// Market, holders, quote/swap and participant onboarding views (SPEC sections 6, 9, R7).
import { timingSafeEqual } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  COPY,
  describeFees,
  periodToReport,
  periodsPerYear,
  perTokenBaseUnits,
  projectEconomics,
  yieldMetrics,
} from "@fstack/core";
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chain";
import { getClassifiedHolders } from "@/lib/server/holders";
import { HttpError, appUrl, parseBaseUnits } from "./http";
import { loadIssuance, onboardUrl, requireMarket, type IssuanceRecord } from "./issuance-record";
import { formatUnits, pctDisplay, pctOfSupply, tokenAmount, usdc } from "./money";
import { ELIGIBILITY_STATEMENT, agreementAcceptanceMessage } from "./agreement-message";

export function progressBar(bps: number, width = 20): string {
  const clamped = Math.max(0, Math.min(10_000, bps));
  const filled = Math.round((clamped / 10_000) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${pctDisplay(clamped)}`;
}

// ---------------------------------------------------------------- market

/** `isIssuer`: the caller holds the API token, so `onboardUrl` carries the invite code (the link to share). */
export async function getMarketView(id: string, opts: { isIssuer?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const issuance = await loadIssuance(id);
  const { dbcPool } = requireMarket(issuance);
  const { terms, monetization } = issuance;
  const chain = await getChain();
  const state = await chain.market.getMarketState(dbcPool);

  const executed = await prisma.distribution.findMany({
    where: { issuanceId: id, status: "EXECUTED" },
    orderBy: { executedAt: "asc" },
  });
  const supplyBase = issuance.supplyBaseUnits;
  const history = executed
    .filter((d) => d.executedAt)
    .map((d) => ({ periodLabel: d.periodLabel, executedAt: d.executedAt!, rightsPool: d.rightsPool, tokenSupply: supplyBase }));
  const ppy = periodsPerYear(terms.distributionFrequency);
  const y = yieldMetrics(history, state.price, ppy, now, terms.tokenDecimals);

  const holders = await getClassifiedHolders(issuance);
  const nonPool = holders.holders.filter((h) => h.kind !== "POOL");
  const econ = projectEconomics(monetization, state.migrationQuoteThreshold);
  const { issuerPct, platformPct, liquidityPct } = monetization.graduation;
  const marketCap = state.price * terms.tokenSupply;

  const pending = await prisma.distribution.findMany({
    where: { issuanceId: id, status: { in: ["DRAFT", "SNAPSHOTTED"] } },
    select: { id: true, periodLabel: true, status: true },
  });

  return {
    issuanceId: id,
    issuerName: terms.issuerName,
    symbol: terms.symbol,
    chainMode: chain.mode,
    price: usdc(state.price),
    tokenMarketCap: { ...usdc(marketCap), label: COPY.marketCap },
    progress: {
      bps: state.progressBps,
      pct: pctDisplay(state.progressBps),
      bar: progressBar(state.progressBps),
      quoteReserve: usdc(state.quoteReserve),
      migrationQuoteThreshold: usdc(state.migrationQuoteThreshold),
      isMigrated: state.isMigrated,
    },
    accruedTradingFees: {
      startup: usdc(state.accruedFees.creator),
      founderStack: usdc(state.accruedFees.partner),
    },
    yield: {
      label: COPY.trailingYield,
      periodsExecuted: history.length,
      periodsPerYear: ppy,
      lastDistributionPerToken: usdc(y.lastPerToken),
      ttmPerToken: usdc(y.ttmPerToken),
      trailingYieldBps: y.trailingYieldBps,
      trailingYield: pctDisplay(y.trailingYieldBps),
      annualizedRunRatePerToken: usdc(y.annualizedRunRatePerToken),
      annualizedYieldBps: y.annualizedYieldBps,
      annualizedYield: pctDisplay(y.annualizedYieldBps),
      isAnnualized: y.isAnnualized,
      annualizedNote: y.isAnnualized && history.length > 0 ? COPY.annualizedFromPeriods(y.periodsCounted) : null,
      history: executed.map((d) => ({
        distributionId: d.id,
        periodLabel: d.periodLabel,
        executedAt: d.executedAt,
        rightsPool: usdc(d.rightsPool),
        perToken: usdc(perTokenBaseUnits(d.rightsPool, supplyBase, terms.tokenDecimals)),
        totalAllocated: d.totalAllocated === null ? null : usdc(d.totalAllocated),
      })),
    },
    holders: {
      count: nonPool.length,
      participants: nonPool.filter((h) => h.kind === "PARTICIPANT").length,
      unregistered: holders.unregisteredCount,
    },
    pendingDistributions: pending,
    nextRecordDate: issuance.nextRecordDate,
    /** The period the next report is for; its label is what fundraise_report_period expects. */
    nextPeriod: periodToReport(issuance.nextRecordDate, terms.distributionFrequency, now),
    distributionDue: issuance.nextRecordDate ? issuance.nextRecordDate.getTime() <= now.getTime() : false,
    economics: {
      label: COPY.illustrativeEconomics,
      split: { issuerPct, platformPct, liquidityPct },
      atGraduation: { issuer: usdc(econ.issuer), founderStack: usdc(econ.platform), liquidity: usdc(econ.liquidity) },
      fees: describeFees(monetization),
      note: COPY.positioning.economics,
    },
    marketUrl: `${appUrl()}/market/${id}`,
    onboardUrl: onboardUrl(issuance, opts.isIssuer === true),
  };
}

// ---------------------------------------------------------------- holders

const KIND_LABEL = {
  POOL: "Market (DBC pool)",
  PARTICIPANT: "Registered participant",
  UNREGISTERED: "Unregistered (excluded from distributions)",
} as const;

export async function getHoldersView(id: string, isIssuer: boolean) {
  const issuance = await loadIssuance(id);
  requireMarket(issuance);
  const participants = await prisma.participant.findMany({ where: { issuanceId: id }, orderBy: { createdAt: "asc" } });
  const classified = await getClassifiedHolders(issuance, participants);
  const byId = new Map(participants.map((p) => [p.id, p]));
  const supply = classified.tokenSupply;
  const holders = [...classified.holders]
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
    .map((h) => {
      const p = h.participantId ? byId.get(h.participantId) : undefined;
      return {
        wallet: h.owner,
        kind: h.kind,
        label: KIND_LABEL[h.kind],
        displayName: isIssuer ? (p?.displayName ?? null) : undefined,
        participantId: h.participantId ?? null,
        tokens: tokenAmount(h.amount, issuance.terms.tokenDecimals),
        pctOfSupply: pctOfSupply(h.amount, supply),
        flag: h.kind === "UNREGISTERED" ? "Holder is not a registered participant; counts as unallocated" : null,
      };
    });
  const holding = new Set(classified.holders.map((h) => h.owner));

  return {
    issuanceId: id,
    symbol: issuance.terms.symbol,
    slot: classified.slot,
    tokenSupply: supply,
    holders,
    unregisteredCount: classified.unregisteredCount,
    participants: isIssuer
      ? participants.map((p) => ({
          id: p.id,
          wallet: p.wallet,
          displayName: p.displayName,
          verifiedAt: p.verifiedAt,
          eligibleAt: p.eligibleAt,
          agreementAcceptedAt: p.agreementAcceptedAt,
          allowlistTx: p.allowlistTx,
          holdsTokens: holding.has(p.wallet),
        }))
      : undefined,
    participantCount: participants.length,
  };
}

// ---------------------------------------------------------------- participants

function decodeSignature(sig: string): Uint8Array | null {
  try {
    const b = bs58.decode(sig);
    if (b.length === 64) return b;
  } catch {
    /* not base58 */
  }
  try {
    const b = Buffer.from(sig, "base64");
    if (b.length === 64) return new Uint8Array(b);
  } catch {
    /* not base64 */
  }
  return null;
}

export function verifyAcceptanceSignature(wallet: string, message: string, signature: string): boolean {
  let pub: Uint8Array;
  try {
    pub = bs58.decode(wallet);
  } catch {
    return false;
  }
  const sig = decodeSignature(signature);
  if (pub.length !== 32 || !sig) return false;
  return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
}

function inviteMatches(issuance: IssuanceRecord, invite: unknown): boolean {
  if (!issuance.inviteCode) return true; // issuances from before invite codes
  if (typeof invite !== "string") return false;
  const a = Buffer.from(invite.trim());
  const b = Buffer.from(issuance.inviteCode);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One-signature onboarding (SPEC section 6): invite code + checkbox (`eligible: true`) + one
 * signMessage over { issuanceId, wallet, agreementHash, eligibilityStatement }. On success the
 * verified/eligible/accepted timestamps are set together ("Self-attested (pilot)") and the wallet
 * is allowlisted on the transfer hook. No simulated identity step.
 */
export async function registerParticipant(id: string, body: Record<string, unknown>) {
  const issuance = await loadIssuance(id);
  const { baseMint } = requireMarket(issuance);
  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 64) || null : null;

  if (!wallet || !signature) throw new HttpError(400, "invalid_input", "wallet and signature are required");
  if (!inviteMatches(issuance, body.invite)) {
    throw new HttpError(403, "invalid_invite", "This is a closed pilot: onboarding needs the invite link from the issuer");
  }
  if (body.eligible !== true) throw new HttpError(400, "not_eligible", `Tick "${ELIGIBILITY_STATEMENT}": eligible: true`);
  if (body.agreementHash !== issuance.agreement.hash) {
    throw new HttpError(400, "agreement_mismatch", "agreementHash does not match this issuance's agreement", {
      expected: issuance.agreement.hash,
    });
  }
  const message = agreementAcceptanceMessage({ issuanceId: issuance.id, wallet, agreementHash: issuance.agreement.hash });
  if (!verifyAcceptanceSignature(wallet, message, signature)) {
    throw new HttpError(400, "invalid_signature", "Signature does not verify for this wallet and message", { message });
  }

  const now = new Date();
  const existing = await prisma.participant.findUnique({ where: { issuanceId_wallet: { issuanceId: id, wallet } } });
  let participant = await prisma.participant.upsert({
    where: { issuanceId_wallet: { issuanceId: id, wallet } },
    create: {
      issuanceId: id,
      wallet,
      displayName,
      verifiedAt: now,
      eligibleAt: now,
      agreementAcceptedAt: now,
      agreementSig: signature,
    },
    update: {
      ...(displayName ? { displayName } : {}),
      verifiedAt: existing?.verifiedAt ?? now,
      eligibleAt: existing?.eligibleAt ?? now,
      agreementAcceptedAt: existing?.agreementAcceptedAt ?? now,
      agreementSig: signature,
    },
  });

  if (!participant.allowlistTx) {
    const chain = await getChain();
    try {
      const { signature: tx } = await chain.registry.allowWallet(baseMint, wallet);
      participant = await prisma.participant.update({ where: { id: participant.id }, data: { allowlistTx: tx } });
    } catch (e) {
      throw new HttpError(502, "allowlist_failed", `Agreement recorded, but allowlisting failed: ${(e as Error).message}`);
    }
  }

  return {
    status: COPY.onboardingSteps.tradingEnabled,
    participant: {
      id: participant.id,
      wallet: participant.wallet,
      displayName: participant.displayName,
      verifiedAt: participant.verifiedAt,
      verification: COPY.selfAttested,
      eligibleAt: participant.eligibleAt,
      agreementAcceptedAt: participant.agreementAcceptedAt,
      allowlistTx: participant.allowlistTx,
    },
    marketUrl: `${appUrl()}/market/${id}`,
  };
}

/** Covers the swap network fee plus rent for the new token accounts a first buy creates. */
export const MIN_SOL_LAMPORTS = 10_000_000n; // 0.01 SOL

/**
 * GET /api/issuances/:id/wallets/:wallet — PUBLIC. Onboarding state + pre-flight funds for one
 * wallet, so the gate can say "you're set" or "fund this wallet first" before any signature.
 */
export async function walletView(id: string, walletRaw: string) {
  const issuance = await loadIssuance(id);
  const { baseMint } = requireMarket(issuance);
  const wallet = walletRaw.trim();
  let valid = false;
  try {
    valid = bs58.decode(wallet).length === 32;
  } catch {
    valid = false;
  }
  if (!valid) throw new HttpError(400, "invalid_input", "wallet must be a base58 Solana address");

  const chain = await getChain();
  const [participant, funds] = await Promise.all([
    prisma.participant.findUnique({ where: { issuanceId_wallet: { issuanceId: id, wallet } } }),
    chain.registry.getWalletFunds(baseMint, wallet),
  ]);
  const hasSol = funds.lamports >= MIN_SOL_LAMPORTS;
  const hasUsdc = funds.quote > 0n;
  return {
    wallet,
    registered: Boolean(participant?.agreementAcceptedAt && participant.allowlistTx),
    participant: participant
      ? {
          agreementAcceptedAt: participant.agreementAcceptedAt,
          verification: COPY.selfAttested,
          allowlistTx: participant.allowlistTx,
        }
      : null,
    inviteRequired: issuance.inviteCode !== null,
    funds: {
      simulated: chain.mode === "fake",
      sol: { lamports: funds.lamports, display: `${formatUnits(funds.lamports, 9)} SOL` },
      usdc: usdc(funds.quote),
      units: tokenAmount(funds.base, issuance.terms.tokenDecimals, issuance.terms.symbol),
    },
    preflight: {
      hasSol,
      hasUsdc,
      minSol: `${formatUnits(MIN_SOL_LAMPORTS, 9)} SOL`,
      ready: hasSol && hasUsdc,
    },
    /** The exact text this wallet signs to accept the agreement. */
    message: agreementAcceptanceMessage({ issuanceId: id, wallet, agreementHash: issuance.agreement.hash }),
  };
}

// ---------------------------------------------------------------- quote / swap

function parseSide(v: unknown): "BUY" | "SELL" {
  const s = typeof v === "string" ? v.toUpperCase() : "";
  if (s !== "BUY" && s !== "SELL") throw new HttpError(400, "invalid_input", "side must be BUY or SELL");
  return s;
}

export type SwapMode = "EXACT_IN" | "EXACT_OUT";

/**
 * Resolves the swap amount from `amountIn` (EXACT_IN, default) or `amountOut` (EXACT_OUT).
 * `mode` is optional: passing only `amountOut` implies EXACT_OUT.
 */
export function parseSwapAmount(src: { amountIn?: unknown; amountOut?: unknown; mode?: unknown }): { mode: SwapMode; amount: bigint } {
  const rawMode = typeof src.mode === "string" ? src.mode.toUpperCase() : "";
  if (rawMode && rawMode !== "EXACT_IN" && rawMode !== "EXACT_OUT") {
    throw new HttpError(400, "invalid_input", "mode must be EXACT_IN or EXACT_OUT");
  }
  const has = (v: unknown) => v !== undefined && v !== null && v !== "";
  const mode: SwapMode = rawMode ? (rawMode as SwapMode) : !has(src.amountIn) && has(src.amountOut) ? "EXACT_OUT" : "EXACT_IN";
  if (mode === "EXACT_OUT") return { mode, amount: parseBaseUnits(src.amountOut, "amountOut") };
  return { mode, amount: parseBaseUnits(src.amountIn, "amountIn") };
}

/**
 * Amounts are base units: BUY amountIn = USDC base units, SELL amountIn = token base units.
 * EXACT_OUT: `amount` is the desired output (BUY: tokens, SELL: USDC); the quote's pay side is
 * the required input incl. fees.
 * Pool fee is assumed quote-denominated (USDC), as Meteora DBC collects fees in quote.
 */
export async function quoteView(id: string, sideRaw: unknown, amount: bigint, mode: SwapMode = "EXACT_IN") {
  const issuance = await loadIssuance(id);
  const { dbcPool } = requireMarket(issuance);
  const side = parseSide(sideRaw);
  if (amount <= 0n) throw new HttpError(400, "invalid_input", `${mode === "EXACT_OUT" ? "amountOut" : "amountIn"} must be > 0`);
  const chain = await getChain();
  const q = await chain.market.quote(dbcPool, side, amount, mode);
  const m = issuance.monetization;
  const { symbol, tokenDecimals } = issuance.terms;
  // Meteora keeps its protocol share; only the remaining trading fee is split startup / Founder Stack.
  const tradingFee = q.poolFee - q.protocolFee;
  const fsFee = (tradingFee * BigInt(m.dbcTradingFees.partnerPct)) / 100n;
  const token = (a: bigint) => tokenAmount(a, tokenDecimals, symbol);
  const pay = side === "BUY" ? { asset: "USDC", ...usdc(q.amountIn) } : { asset: symbol, ...token(q.amountIn) };
  const receive = side === "BUY" ? { asset: symbol, ...token(q.amountOut) } : { asset: "USDC", ...usdc(q.amountOut) };
  return {
    side,
    mode,
    dbcPool,
    pay,
    receive,
    price: usdc(q.price),
    priceImpactBps: q.priceImpactBps,
    priceImpact: pctDisplay(q.priceImpactBps),
    fees: {
      poolFee: usdc(q.poolFee),
      meteoraProtocolFee: usdc(q.protocolFee),
      startupShare: usdc(tradingFee - fsFee),
      founderStackFee: { ...usdc(fsFee), mode: m.mode, note: `${m.dbcTradingFees.partnerPct}% of the trading fee (after Meteora's protocol fee) goes to Founder Stack (${m.mode})` },
      networkFee: { lamports: q.networkFeeLamports, sol: formatUnits(q.networkFeeLamports, 9) },
    },
    raw: q,
  };
}

/** Default slippage for EXACT_OUT when maxAmountIn is not given: 1%. */
export const DEFAULT_EXACT_OUT_SLIPPAGE_BPS = 100n;

/**
 * EXACT_IN: spend `amountIn`, receive ≥ `minAmountOut`.
 * EXACT_OUT: receive exactly `minAmountOut`, spend at most `amountIn`; `amountIn` = 0 means
 * "quoted input + slippageBps" (body.slippageBps, default 100 = 1%).
 */
export async function swapView(
  id: string,
  body: Record<string, unknown>,
  amountIn: bigint,
  minAmountOut: bigint,
  mode: SwapMode = "EXACT_IN",
) {
  const owner = typeof body.owner === "string" ? body.owner.trim() : "";
  if (!owner) throw new HttpError(400, "invalid_input", "owner (wallet address) is required");
  const quote = await quoteView(id, body.side, mode === "EXACT_OUT" ? minAmountOut : amountIn, mode);
  let maxIn = amountIn;
  if (mode === "EXACT_OUT" && maxIn === 0n) {
    const bps = body.slippageBps === undefined ? DEFAULT_EXACT_OUT_SLIPPAGE_BPS : parseBaseUnits(body.slippageBps, "slippageBps");
    maxIn = (quote.raw.amountIn * (10_000n + bps) + 9_999n) / 10_000n;
  }
  const chain = await getChain();
  const { tx } = await chain.market.buildSwapTx(quote.dbcPool, owner, quote.side, maxIn, minAmountOut, mode);
  const participant = await prisma.participant.findUnique({ where: { issuanceId_wallet: { issuanceId: id, wallet: owner } } });
  return {
    tx,
    encoding: "base64",
    owner,
    mode,
    minAmountOut,
    ...(mode === "EXACT_OUT" ? { amountOut: minAmountOut, maxAmountIn: maxIn } : {}),
    registered: Boolean(participant?.allowlistTx),
    warning: participant?.allowlistTx
      ? null
      : "Wallet is not onboarded. Buys will fail on-chain with NotEligible (Token-2022 transfer hook).",
    quote,
  };
}
