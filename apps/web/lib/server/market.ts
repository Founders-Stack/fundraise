// Market, holders, quote/swap and participant onboarding views (SPEC sections 6, 9, R7).
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  COPY,
  DEMO_PROTOCOL_CONFIG,
  describeFees,
  perTokenBaseUnits,
  projectEconomics,
  yieldMetrics,
  type MonetizationConfig,
} from "@fstack/core";
import type { Issuance } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chain";
import { getClassifiedHolders } from "@/lib/server/holders";
import { HttpError, appUrl } from "./http";
import { getIssuanceOr404, parseJson, periodsPerYear } from "./issuance";
import { formatUnits, pctDisplay, tokenDisplay, usdc } from "./money";
import { agreementAcceptanceMessage } from "./agreement-message";

const TOKEN_DECIMALS = 6;

function monetizationOf(i: Issuance): MonetizationConfig {
  return parseJson<MonetizationConfig>(i.monetization) ?? DEMO_PROTOCOL_CONFIG;
}

function requireLive(i: Issuance): { dbcPool: string; baseMint: string } {
  if (!i.dbcPool || !i.baseMint) throw new HttpError(409, "issuance_pending", `Issuance ${i.id} has no market yet`);
  return { dbcPool: i.dbcPool, baseMint: i.baseMint };
}

export function progressBar(bps: number, width = 20): string {
  const clamped = Math.max(0, Math.min(10_000, bps));
  const filled = Math.round((clamped / 10_000) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${pctDisplay(clamped)}`;
}

// ---------------------------------------------------------------- market

export async function getMarketView(id: string, now = new Date()) {
  const issuance = await getIssuanceOr404(id);
  const { dbcPool } = requireLive(issuance);
  const chain = await getChain();
  const state = await chain.market.getMarketState(dbcPool);
  const monetization = monetizationOf(issuance);

  const executed = await prisma.distribution.findMany({
    where: { issuanceId: id, status: "EXECUTED" },
    orderBy: { executedAt: "asc" },
  });
  const supplyBase = issuance.tokenSupply * 10n ** BigInt(TOKEN_DECIMALS);
  const history = executed
    .filter((d) => d.executedAt)
    .map((d) => ({ periodLabel: d.periodLabel, executedAt: d.executedAt!, rightsPool: d.rightsPool, tokenSupply: supplyBase }));
  const ppy = periodsPerYear(issuance.distributionFrequency);
  const y = yieldMetrics(history, state.price, ppy, now, TOKEN_DECIMALS);

  const holders = await getClassifiedHolders(id);
  const nonPool = holders.holders.filter((h) => h.kind !== "POOL");
  const econ = projectEconomics(monetization, state.migrationQuoteThreshold);
  const { issuerPct, platformPct, liquidityPct } = monetization.graduation;
  const marketCap = (state.price * issuance.tokenSupply);

  const pending = await prisma.distribution.findMany({
    where: { issuanceId: id, status: { in: ["DRAFT", "SNAPSHOTTED"] } },
    select: { id: true, periodLabel: true, status: true },
  });

  return {
    issuanceId: id,
    issuerName: issuance.issuerName,
    symbol: issuance.symbol,
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
        perToken: usdc(perTokenBaseUnits(d.rightsPool, supplyBase, TOKEN_DECIMALS)),
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
    distributionDue: issuance.nextRecordDate ? issuance.nextRecordDate.getTime() <= now.getTime() : false,
    economics: {
      label: COPY.illustrativeEconomics,
      split: { issuerPct, platformPct, liquidityPct },
      atGraduation: { issuer: usdc(econ.issuer), founderStack: usdc(econ.platform), liquidity: usdc(econ.liquidity) },
      fees: describeFees(monetization),
      note: COPY.positioning.economics,
    },
    marketUrl: `${appUrl()}/market/${id}`,
    onboardUrl: `${appUrl()}/onboard/${id}`,
  };
}

// ---------------------------------------------------------------- holders

const KIND_LABEL = {
  POOL: "Market (DBC pool)",
  PARTICIPANT: "Registered participant",
  UNREGISTERED: "Unregistered (excluded from distributions)",
} as const;

export async function getHoldersView(id: string, isIssuer: boolean) {
  const issuance = await getIssuanceOr404(id);
  requireLive(issuance);
  const [classified, participants] = await Promise.all([
    getClassifiedHolders(id),
    prisma.participant.findMany({ where: { issuanceId: id }, orderBy: { createdAt: "asc" } }),
  ]);
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
        tokens: h.amount,
        tokensDisplay: tokenDisplay(h.amount, TOKEN_DECIMALS),
        pctOfSupply: pctDisplay(supply > 0n ? Number((h.amount * 10_000n) / supply) : 0),
        flag: h.kind === "UNREGISTERED" ? "Holder is not a registered participant; counts as unallocated" : null,
      };
    });
  const holding = new Set(classified.holders.map((h) => h.owner));

  return {
    issuanceId: id,
    symbol: issuance.symbol,
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

export async function registerParticipant(id: string, body: Record<string, unknown>) {
  const issuance = await getIssuanceOr404(id);
  const { baseMint } = requireLive(issuance);
  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 64) || null : null;

  if (!wallet || !signature) throw new HttpError(400, "invalid_input", "wallet and signature are required");
  if (body.verified !== true) throw new HttpError(400, "not_verified", "Identity verification (simulated) must be completed: verified: true");
  if (body.eligible !== true) throw new HttpError(400, "not_eligible", "Eligibility must be confirmed: eligible: true");
  if (body.agreementHash !== issuance.agreementHash) {
    throw new HttpError(400, "agreement_mismatch", "agreementHash does not match this issuance's agreement", {
      expected: issuance.agreementHash,
    });
  }
  const message = agreementAcceptanceMessage(issuance.agreementHash, issuance.id);
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
      eligibleAt: participant.eligibleAt,
      agreementAcceptedAt: participant.agreementAcceptedAt,
      allowlistTx: participant.allowlistTx,
    },
    marketUrl: `${appUrl()}/market/${id}`,
  };
}

// ---------------------------------------------------------------- quote / swap

function parseSide(v: unknown): "BUY" | "SELL" {
  const s = typeof v === "string" ? v.toUpperCase() : "";
  if (s !== "BUY" && s !== "SELL") throw new HttpError(400, "invalid_input", "side must be BUY or SELL");
  return s;
}

/**
 * Amounts are base units: BUY amountIn = USDC base units, SELL amountIn = token base units.
 * Pool fee is assumed quote-denominated (USDC), as Meteora DBC collects fees in quote.
 */
export async function quoteView(id: string, sideRaw: unknown, amountIn: bigint) {
  const issuance = await getIssuanceOr404(id);
  const { dbcPool } = requireLive(issuance);
  const side = parseSide(sideRaw);
  if (amountIn <= 0n) throw new HttpError(400, "invalid_input", "amountIn must be > 0");
  const chain = await getChain();
  const q = await chain.market.quote(dbcPool, side, amountIn);
  const m = monetizationOf(issuance);
  // Meteora keeps its protocol share; only the remaining trading fee is split startup / Founder Stack.
  const tradingFee = q.poolFee - q.protocolFee;
  const fsFee = (tradingFee * BigInt(m.dbcTradingFees.partnerPct)) / 100n;
  const token = (a: bigint) => ({ baseUnits: a, amount: formatUnits(a, TOKEN_DECIMALS), display: `${tokenDisplay(a, TOKEN_DECIMALS)} ${issuance.symbol}` });
  const pay = side === "BUY" ? { asset: "USDC", ...usdc(q.amountIn) } : { asset: issuance.symbol, ...token(q.amountIn) };
  const receive = side === "BUY" ? { asset: issuance.symbol, ...token(q.amountOut) } : { asset: "USDC", ...usdc(q.amountOut) };
  return {
    side,
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

export async function swapView(id: string, body: Record<string, unknown>, amountIn: bigint, minAmountOut: bigint) {
  const owner = typeof body.owner === "string" ? body.owner.trim() : "";
  if (!owner) throw new HttpError(400, "invalid_input", "owner (wallet address) is required");
  const quote = await quoteView(id, body.side, amountIn);
  const issuance = await getIssuanceOr404(id);
  const chain = await getChain();
  const { tx } = await chain.market.buildSwapTx(issuance.dbcPool!, owner, quote.side, amountIn, minAmountOut);
  const participant = await prisma.participant.findUnique({ where: { issuanceId_wallet: { issuanceId: id, wallet: owner } } });
  return {
    tx,
    encoding: "base64",
    owner,
    minAmountOut,
    registered: Boolean(participant?.allowlistTx),
    warning: participant?.allowlistTx
      ? null
      : "Wallet is not onboarded. Buys will fail on-chain with NotEligible (Token-2022 transfer hook).",
    quote,
  };
}
