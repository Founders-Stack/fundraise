// Response shapes for the distribution API (SPEC section 7). Pure presentation over loaded rows,
// plus the live issuer balance check. The lifecycle rules live in ./distribution.
import {
  allocate,
  perTokenDisplay,
  periodToReport,
  periodsPerYear,
  yieldMetrics,
  COPY,
  type HolderBalance,
} from "@fstack/core";
import type { Allocation, Distribution, Participant } from "@prisma/client";
import { getChain } from "@/lib/chain";
import { pctOfSupply, tokensDisplay, usdc, usdcDisplay } from "./distribution-money";
import type { IssuanceRecord } from "./issuance-record";

export type DistributionWithAll = Distribution & {
  issuance: IssuanceRecord;
  participants: Participant[];
  allocations: Allocation[];
};

export function explorerTxUrl(signature: string, mode: "fake" | "devnet"): string | null {
  return mode === "fake" ? null : `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function bpsToPct(bps: number): string {
  return `${bps / 100}%`;
}

export function executionLeaseHeld(d: Pick<Distribution, "executingUntil">, now = new Date()): boolean {
  return d.executingUntil !== null && d.executingUntil.getTime() > now.getTime();
}

// ---------------------------------------------------------------- snapshot JSON

interface StoredSnapshot {
  slot: number;
  takenAt: string;
  tokenSupply: string;
  holders: { owner: string; tokenAccount: string; amount: string; kind: string; participantId?: string }[];
  excluded: { owner: string; kind: "POOL" | "UNREGISTERED"; tokens: string; retainedShare: string }[];
  unallocatedBreakdown: { pool: string; unregistered: string; unsold: string; dust: string };
  unregisteredCount: number;
}

/** Serializes the immutable snapshot stored on the distribution row. */
export function encodeSnapshot(
  classified: { slot: number; tokenSupply: bigint; holders: HolderBalance[]; unregisteredCount: number },
  result: ReturnType<typeof allocate>,
  takenAt: Date,
): string {
  const stored: StoredSnapshot = {
    slot: classified.slot,
    takenAt: takenAt.toISOString(),
    tokenSupply: classified.tokenSupply.toString(),
    holders: classified.holders.map((h) => ({
      owner: h.owner,
      tokenAccount: h.tokenAccount,
      amount: h.amount.toString(),
      kind: h.kind,
      ...(h.participantId ? { participantId: h.participantId } : {}),
    })),
    excluded: result.excluded.map((e) => ({
      owner: e.owner,
      kind: e.kind,
      tokens: e.tokens.toString(),
      retainedShare: e.retainedShare.toString(),
    })),
    unallocatedBreakdown: {
      pool: result.unallocatedBreakdown.pool.toString(),
      unregistered: result.unallocatedBreakdown.unregistered.toString(),
      unsold: result.unallocatedBreakdown.unsold.toString(),
      dust: result.unallocatedBreakdown.dust.toString(),
    },
    unregisteredCount: classified.unregisteredCount,
  };
  return JSON.stringify(stored);
}

function parseSnapshot(json: string | null): StoredSnapshot | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as StoredSnapshot;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- shapes

export function distributionSummary(d: Distribution, issuance: IssuanceRecord) {
  const supplyBase = issuance.supplyBaseUnits;
  return {
    id: d.id,
    issuanceId: d.issuanceId,
    periodLabel: d.periodLabel,
    status: d.status,
    dcf: usdc(d.dcf),
    dcfBaseUnits: d.dcf,
    reportUrl: d.reportUrl,
    reportHash: d.reportHash,
    poolPercentageBps: d.poolPercentageBps,
    poolPercentage: bpsToPct(d.poolPercentageBps),
    rightsPool: usdc(d.rightsPool),
    rightsPoolBaseUnits: d.rightsPool,
    perToken: perTokenDisplay(d.rightsPool, supplyBase, issuance.terms.tokenDecimals),
    perTokenBaseUnits: d.perTokenBaseUnits,
    snapshotSlot: d.snapshotSlot,
    totalAllocated: d.totalAllocated === null ? null : usdc(d.totalAllocated),
    totalAllocatedBaseUnits: d.totalAllocated,
    unallocated: d.unallocated === null ? null : usdc(d.unallocated),
    unallocatedBaseUnits: d.unallocated,
    executedAt: d.executedAt,
    createdAt: d.createdAt,
  };
}

/** Body of POST /api/issuances/:id/distributions. */
export function reportedPeriodView(d: Distribution, issuance: IssuanceRecord) {
  const { terms } = issuance;
  return {
    distribution: distributionSummary(d, issuance),
    issuance: {
      id: issuance.id,
      symbol: terms.symbol,
      tokenSupply: terms.tokenSupply,
      poolPercentage: bpsToPct(terms.poolPercentageBps),
    },
    display: {
      dcf: usdcDisplay(d.dcf),
      rightsPool: usdcDisplay(d.rightsPool),
      perToken: perTokenDisplay(d.rightsPool, issuance.supplyBaseUnits, terms.tokenDecimals),
    },
    next: "Run fundraise_snapshot with this distributionId to preview allocations.",
  };
}

/** Signatures grouped by batch (one tx pays up to 10 holders). */
function signaturesOf(allocs: Allocation[], mode: "fake" | "devnet") {
  const bySig = new Map<string, { signature: string; wallets: string[]; amount: bigint }>();
  for (const a of allocs) {
    if (!a.txSignature) continue;
    const e = bySig.get(a.txSignature) ?? { signature: a.txSignature, wallets: [], amount: 0n };
    e.wallets.push(a.wallet);
    e.amount += a.payout;
    bySig.set(a.txSignature, e);
  }
  return [...bySig.values()].map((e) => ({
    signature: e.signature,
    explorerUrl: explorerTxUrl(e.signature, mode),
    fake: mode === "fake",
    wallets: e.wallets,
    amount: usdc(e.amount),
  }));
}

/**
 * Full issuer-facing detail: summary + allocation table + excluded holders + unallocated
 * breakdown + live issuer balance check + confirmTotal. Used by snapshot, execute and GET.
 */
export async function distributionDetail(d: DistributionWithAll, opts: { includeBalance: boolean }) {
  const chain = await getChain();
  const { issuance } = d;
  const { terms } = issuance;
  const supplyBase = issuance.supplyBaseUnits;
  const tokens = (baseUnits: bigint) => tokensDisplay(baseUnits, terms.tokenDecimals);
  const names = new Map(d.participants.map((p) => [p.id, p.displayName]));
  const namesByWallet = new Map(d.participants.map((p) => [p.wallet, p.displayName]));
  const snap = parseSnapshot(d.snapshotJson);

  const allocs = [...d.allocations].sort((a, b) =>
    a.payout === b.payout ? (a.wallet < b.wallet ? -1 : 1) : a.payout > b.payout ? -1 : 1,
  );
  const rows = allocs.map((a) => ({
    wallet: a.wallet,
    displayName: (a.participantId ? names.get(a.participantId) : namesByWallet.get(a.wallet)) ?? null,
    participantId: a.participantId,
    tokens: tokens(a.tokens),
    tokensBaseUnits: a.tokens,
    pctOfSupply: pctOfSupply(a.tokens, supplyBase),
    payout: usdc(a.payout),
    payoutDisplay: usdcDisplay(a.payout),
    payoutBaseUnits: a.payout,
    paid: Boolean(a.txSignature),
    txSignature: a.txSignature,
    explorerUrl: a.txSignature ? explorerTxUrl(a.txSignature, chain.mode) : null,
  }));

  const excluded = (snap?.excluded ?? []).map((e) => ({
    wallet: e.owner,
    kind: e.kind,
    label: e.kind === "POOL" ? "Market (DBC pool)" : "Unregistered wallet",
    tokens: tokens(BigInt(e.tokens)),
    tokensBaseUnits: e.tokens,
    pctOfSupply: pctOfSupply(BigInt(e.tokens), supplyBase),
    retainedShare: usdc(BigInt(e.retainedShare)),
  }));

  const b = snap?.unallocatedBreakdown;
  const unallocated =
    d.unallocated === null || !b
      ? null
      : {
          label: COPY.unallocated,
          total: usdc(d.unallocated),
          totalDisplay: usdcDisplay(d.unallocated),
          breakdown: {
            marketPool: usdc(BigInt(b.pool)),
            unregistered: usdc(BigInt(b.unregistered)),
            unsold: usdc(BigInt(b.unsold)),
            roundingDust: usdc(BigInt(b.dust)),
          },
        };

  const unpaid = d.allocations.filter((a) => a.payout > 0n && !a.txSignature);
  const remaining = unpaid.reduce((s, a) => s + a.payout, 0n);

  let balance: Record<string, unknown> | null = null;
  if (opts.includeBalance && d.status !== "EXECUTED" && d.totalAllocated !== null) {
    const bal = await chain.payout.getIssuerQuoteBalance();
    const shortfall = remaining > bal ? remaining - bal : 0n;
    balance = {
      issuerAddress: chain.payout.issuerAddress(),
      quoteMint: chain.payout.quoteMint(),
      balance: usdc(bal),
      balanceDisplay: usdcDisplay(bal),
      required: usdc(remaining),
      requiredDisplay: usdcDisplay(remaining),
      sufficient: shortfall === 0n,
      shortfall: usdc(shortfall),
    };
  }

  const warnings: string[] = [];
  if (snap && snap.unregisteredCount > 0) {
    warnings.push(
      `${snap.unregisteredCount} non-pool holder(s) are not registered participants; their share is unallocated (retained by issuer).`,
    );
  }

  return {
    chainMode: chain.mode,
    distribution: distributionSummary(d, issuance),
    executionInProgress: d.status !== "EXECUTED" && executionLeaseHeld(d),
    issuance: {
      id: issuance.id,
      issuerName: terms.issuerName,
      symbol: terms.symbol,
      tokenSupply: terms.tokenSupply,
      poolPercentage: bpsToPct(terms.poolPercentageBps),
      distributionFrequency: terms.distributionFrequency,
      nextRecordDate: issuance.nextRecordDate,
    },
    snapshot: snap ? { slot: snap.slot, takenAt: snap.takenAt, tokenSupply: tokens(BigInt(snap.tokenSupply)) } : null,
    rows,
    excluded,
    unallocated,
    totals:
      d.totalAllocated === null
        ? null
        : {
            rightsPool: usdc(d.rightsPool),
            totalAllocated: usdc(d.totalAllocated),
            totalAllocatedDisplay: usdcDisplay(d.totalAllocated),
            unallocated: d.unallocated === null ? null : usdc(d.unallocated),
            perToken: perTokenDisplay(d.rightsPool, supplyBase, terms.tokenDecimals),
            payees: rows.filter((r) => r.payoutBaseUnits > 0n).length,
            paid: rows.filter((r) => r.paid).length,
            remainingToPay: usdc(remaining),
          },
    balance,
    /** The exact string the founder must type back to execute (USDC decimal, not base units). */
    confirmTotal: d.status === "SNAPSHOTTED" && d.totalAllocated !== null ? usdc(d.totalAllocated) : null,
    signatures: signaturesOf(d.allocations, chain.mode),
    warnings,
  };
}

// ---------------------------------------------------------------- history (public)

/** Body of GET /api/issuances/:id/distributions. `price` is null when the market can't be read. */
export function distributionHistory(
  issuance: IssuanceRecord,
  participants: Participant[],
  distributions: (Distribution & { allocations: Allocation[] })[],
  price: bigint | null,
  mode: "fake" | "devnet",
  now = new Date(),
) {
  const { terms } = issuance;
  const supplyBase = issuance.supplyBaseUnits;
  const names = new Map(participants.map((p) => [p.id, p.displayName]));
  const executed = distributions.filter((d) => d.status === "EXECUTED" && d.executedAt);
  const m = yieldMetrics(
    executed.map((d) => ({ periodLabel: d.periodLabel, executedAt: d.executedAt!, rightsPool: d.rightsPool, tokenSupply: supplyBase })),
    price ?? 0n,
    periodsPerYear(terms.distributionFrequency),
    now,
    terms.tokenDecimals,
  );
  const bpsStr = (b: number | null) => (b === null ? null : `${(b / 100).toFixed(2)}%`);

  return {
    issuance: {
      id: issuance.id,
      issuerName: terms.issuerName,
      symbol: terms.symbol,
      tokenSupply: terms.tokenSupply,
      poolPercentage: bpsToPct(terms.poolPercentageBps),
      poolPercentageBps: terms.poolPercentageBps,
      distributionFrequency: terms.distributionFrequency,
      nextRecordDate: issuance.nextRecordDate,
      nextPeriod: periodToReport(issuance.nextRecordDate, terms.distributionFrequency, now),
      dcfDefinition: terms.distributableCashFlowDefinition,
    },
    distributions: distributions.map((d) => {
      const paid = d.allocations.filter((a) => a.txSignature);
      return {
        ...distributionSummary(d, issuance),
        allocations: {
          count: d.allocations.length,
          paidCount: paid.length,
          rows: [...d.allocations]
            .sort((a, b) => (a.payout === b.payout ? 0 : a.payout > b.payout ? -1 : 1))
            .map((a) => ({
              wallet: a.wallet,
              displayName: a.participantId ? (names.get(a.participantId) ?? null) : null,
              tokens: tokensDisplay(a.tokens, terms.tokenDecimals),
              pctOfSupply: pctOfSupply(a.tokens, supplyBase),
              payout: usdc(a.payout),
              txSignature: a.txSignature,
            })),
        },
        signatures: signaturesOf(d.allocations, mode),
      };
    }),
    yield: {
      label: COPY.trailingYield,
      periods: executed.length,
      annualizedNote: m.isAnnualized ? COPY.annualizedFromPeriods(m.periodsCounted) : null,
      currentPrice: price === null ? null : usdc(price),
      lastPerToken: usdc(m.lastPerToken),
      ttmPerToken: usdc(m.ttmPerToken),
      trailingYield: bpsStr(m.trailingYieldBps),
      trailingYieldBps: m.trailingYieldBps,
      annualizedRunRatePerToken: usdc(m.annualizedRunRatePerToken),
      annualizedYield: bpsStr(m.annualizedYieldBps),
      annualizedYieldBps: m.annualizedYieldBps,
      isAnnualized: m.isAnnualized,
    },
    chainMode: mode,
  };
}
