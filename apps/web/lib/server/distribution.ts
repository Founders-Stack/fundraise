// Distribution engine service (SPEC section 7): report -> snapshot -> allocations -> execute.
// Route handlers stay thin and call these functions; each returns { status, body }.
// All money math lives in @fstack/core; this file does I/O (Prisma + chain ports) only.
import {
  allocate,
  batchTransfers,
  computeRightsPool,
  perTokenBaseUnits,
  perTokenDisplay,
  reportHash,
  yieldMetrics,
  COPY,
  DEFAULT_DCF_DEFINITION,
  DEFAULT_TOKEN_DECIMALS,
  type HolderBalance,
} from "@fstack/core";
import type { Allocation, Distribution, Issuance, Participant } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chain";
import { getClassifiedHolders } from "@/lib/server/holders";
import { MoneyParseError, parseUsdc, pctOfSupply, tokensDisplay, usdc, usdcDisplay } from "./distribution-money";

export type ServiceResult = { status: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown>, status = 200): ServiceResult => ({ status, body });
const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): ServiceResult => ({
  status,
  body: { error, message, ...extra },
});

const TOKEN_UNIT = 10n ** BigInt(DEFAULT_TOKEN_DECIMALS);
const MAX_TRANSFERS_PER_TX = 10;

export function periodsPerYear(frequency: string): number {
  return frequency === "MONTHLY" ? 12 : 4;
}

/** Advances a record date by one period (quarter or month), in UTC. */
export function advanceRecordDate(from: Date, frequency: string): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + (frequency === "MONTHLY" ? 1 : 3));
  return d;
}

export function explorerTxUrl(signature: string, mode: "fake" | "devnet"): string | null {
  return mode === "fake" ? null : `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

/** Extracts the agreement's DCF definition (rendered by core renderAgreement), falling back to the default. */
export function dcfDefinitionOf(agreementText: string): string {
  const m = /\*\*Distributable Cash Flow \(DCF\)\*\* means, for each period: ([\s\S]*?) DCF is issuer-reported/.exec(
    agreementText,
  );
  return m ? m[1].trim() : DEFAULT_DCF_DEFINITION;
}

function bpsToPct(bps: number): string {
  return `${bps / 100}%`;
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

function parseSnapshot(json: string | null): StoredSnapshot | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as StoredSnapshot;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- shapes

function summary(d: Distribution, issuance: Pick<Issuance, "tokenSupply">) {
  const supplyBase = issuance.tokenSupply * TOKEN_UNIT;
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
    perToken: perTokenDisplay(d.rightsPool, supplyBase),
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

type DistributionWithAll = Distribution & {
  issuance: Issuance & { participants: Participant[] };
  allocations: Allocation[];
};

async function loadDistribution(id: string): Promise<DistributionWithAll | null> {
  return prisma.distribution.findUnique({
    where: { id },
    include: { issuance: { include: { participants: true } }, allocations: true },
  });
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
 * breakdown + live issuer balance check + confirmTotal. Used by snapshot, execute errors and GET.
 */
async function buildDetail(d: DistributionWithAll, opts: { includeBalance: boolean }) {
  const chain = await getChain();
  const issuance = d.issuance;
  const supplyBase = issuance.tokenSupply * TOKEN_UNIT;
  const names = new Map(issuance.participants.map((p) => [p.id, p.displayName]));
  const namesByWallet = new Map(issuance.participants.map((p) => [p.wallet, p.displayName]));
  const snap = parseSnapshot(d.snapshotJson);

  const allocs = [...d.allocations].sort((a, b) =>
    a.payout === b.payout ? (a.wallet < b.wallet ? -1 : 1) : a.payout > b.payout ? -1 : 1,
  );
  const rows = allocs.map((a) => ({
    wallet: a.wallet,
    displayName: (a.participantId ? names.get(a.participantId) : namesByWallet.get(a.wallet)) ?? null,
    participantId: a.participantId,
    tokens: tokensDisplay(a.tokens),
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
    tokens: tokensDisplay(BigInt(e.tokens)),
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
    distribution: summary(d, issuance),
    issuance: {
      id: issuance.id,
      issuerName: issuance.issuerName,
      symbol: issuance.symbol,
      tokenSupply: issuance.tokenSupply,
      poolPercentage: bpsToPct(issuance.poolPercentageBps),
      distributionFrequency: issuance.distributionFrequency,
      nextRecordDate: issuance.nextRecordDate,
    },
    snapshot: snap ? { slot: snap.slot, takenAt: snap.takenAt, tokenSupply: tokensDisplay(BigInt(snap.tokenSupply)) } : null,
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
            perToken: perTokenDisplay(d.rightsPool, supplyBase),
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

// ---------------------------------------------------------------- report period

export async function reportPeriod(issuanceId: string, input: unknown): Promise<ServiceResult> {
  const body = (input ?? {}) as { periodLabel?: unknown; dcf?: unknown; reportUrl?: unknown };
  const periodLabel = typeof body.periodLabel === "string" ? body.periodLabel.trim() : "";
  if (!periodLabel || periodLabel.length > 40) {
    return fail(400, "invalid_period_label", "periodLabel is required (e.g. \"2026-Q3\"), max 40 chars");
  }
  let dcf: bigint;
  try {
    dcf = parseUsdc(body.dcf);
  } catch (e) {
    return fail(400, "invalid_dcf", e instanceof MoneyParseError ? e.message : "invalid dcf");
  }
  let reportUrl: string | undefined;
  if (body.reportUrl !== undefined && body.reportUrl !== null && body.reportUrl !== "") {
    if (typeof body.reportUrl !== "string" || !/^https?:\/\/\S+$/i.test(body.reportUrl)) {
      return fail(400, "invalid_report_url", "reportUrl must be an http(s) URL");
    }
    reportUrl = body.reportUrl;
  }

  const issuance = await prisma.issuance.findUnique({ where: { id: issuanceId } });
  if (!issuance) return fail(404, "not_found", `issuance ${issuanceId} not found`);

  const dup = await prisma.distribution.findUnique({
    where: { issuanceId_periodLabel: { issuanceId, periodLabel } },
  });
  if (dup) {
    return fail(409, "duplicate_period", `period ${periodLabel} was already reported`, {
      distributionId: dup.id,
      status: dup.status,
    });
  }
  const open = await prisma.distribution.findFirst({ where: { issuanceId, status: { not: "EXECUTED" } } });
  if (open) {
    return fail(409, "open_distribution_exists", `period ${open.periodLabel} is still ${open.status}; distribute it first`, {
      distributionId: open.id,
      periodLabel: open.periodLabel,
      status: open.status,
    });
  }

  const rightsPool = computeRightsPool(dcf, issuance.poolPercentageBps);
  const supplyBase = issuance.tokenSupply * TOKEN_UNIT;
  const hash = reportHash({ issuanceId, periodLabel, dcf, reportUrl });

  const d = await prisma.distribution.create({
    data: {
      issuanceId,
      periodLabel,
      dcf,
      reportUrl: reportUrl ?? null,
      reportHash: hash,
      poolPercentageBps: issuance.poolPercentageBps,
      rightsPool,
      perTokenBaseUnits: perTokenBaseUnits(rightsPool, supplyBase),
      status: "DRAFT",
    },
  });

  return ok(
    {
      distribution: summary(d, issuance),
      issuance: {
        id: issuance.id,
        symbol: issuance.symbol,
        tokenSupply: issuance.tokenSupply,
        poolPercentage: bpsToPct(issuance.poolPercentageBps),
      },
      display: {
        dcf: usdcDisplay(dcf),
        rightsPool: usdcDisplay(rightsPool),
        perToken: perTokenDisplay(rightsPool, supplyBase),
      },
      next: "Run fundraise_snapshot with this distributionId to preview allocations.",
    },
    201,
  );
}

// ---------------------------------------------------------------- history (public)

export async function listDistributions(issuanceId: string): Promise<ServiceResult> {
  const issuance = await prisma.issuance.findUnique({
    where: { id: issuanceId },
    include: {
      participants: true,
      distributions: { include: { allocations: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!issuance) return fail(404, "not_found", `issuance ${issuanceId} not found`);

  const chain = await getChain();
  const supplyBase = issuance.tokenSupply * TOKEN_UNIT;
  const names = new Map(issuance.participants.map((p) => [p.id, p.displayName]));

  let price: bigint | null = null;
  if (issuance.dbcPool) {
    try {
      price = (await chain.market.getMarketState(issuance.dbcPool)).price;
    } catch {
      price = null;
    }
  }

  const executed = issuance.distributions.filter((d) => d.status === "EXECUTED" && d.executedAt);
  const ppy = periodsPerYear(issuance.distributionFrequency);
  const m = yieldMetrics(
    executed.map((d) => ({ periodLabel: d.periodLabel, executedAt: d.executedAt!, rightsPool: d.rightsPool, tokenSupply: supplyBase })),
    price ?? 0n,
    ppy,
    new Date(),
  );
  const bpsStr = (b: number | null) => (b === null ? null : `${(b / 100).toFixed(2)}%`);

  return ok({
    issuance: {
      id: issuance.id,
      issuerName: issuance.issuerName,
      symbol: issuance.symbol,
      tokenSupply: issuance.tokenSupply,
      poolPercentage: bpsToPct(issuance.poolPercentageBps),
      poolPercentageBps: issuance.poolPercentageBps,
      distributionFrequency: issuance.distributionFrequency,
      nextRecordDate: issuance.nextRecordDate,
      dcfDefinition: dcfDefinitionOf(issuance.agreementText),
    },
    distributions: issuance.distributions.map((d) => {
      const paid = d.allocations.filter((a) => a.txSignature);
      return {
        ...summary(d, issuance),
        allocations: {
          count: d.allocations.length,
          paidCount: paid.length,
          rows: [...d.allocations]
            .sort((a, b) => (a.payout === b.payout ? 0 : a.payout > b.payout ? -1 : 1))
            .map((a) => ({
              wallet: a.wallet,
              displayName: a.participantId ? (names.get(a.participantId) ?? null) : null,
              tokens: tokensDisplay(a.tokens),
              pctOfSupply: pctOfSupply(a.tokens, supplyBase),
              payout: usdc(a.payout),
              txSignature: a.txSignature,
            })),
        },
        signatures: signaturesOf(d.allocations, chain.mode),
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
    chainMode: chain.mode,
  });
}

// ---------------------------------------------------------------- detail (issuer)

export async function getDistribution(id: string): Promise<ServiceResult> {
  const d = await loadDistribution(id);
  if (!d) return fail(404, "not_found", `distribution ${id} not found`);
  return ok(await buildDetail(d, { includeBalance: true }));
}

// ---------------------------------------------------------------- snapshot

export async function snapshotDistribution(id: string): Promise<ServiceResult> {
  const d = await loadDistribution(id);
  if (!d) return fail(404, "not_found", `distribution ${id} not found`);
  if (d.status === "EXECUTED") return fail(409, "already_executed", "distribution is EXECUTED; its snapshot is immutable");
  if (d.allocations.some((a) => a.txSignature)) {
    return fail(409, "payout_in_progress", "some allocations are already paid; retry fundraise_execute_distribution instead of re-snapshotting");
  }
  if (executing.has(id)) return fail(409, "execution_in_progress", "execution is running for this distribution");

  const classified = await getClassifiedHolders(d.issuanceId);
  const result = allocate(
    { slot: classified.slot, tokenSupply: classified.tokenSupply, holders: classified.holders },
    d.rightsPool,
  );

  const stored: StoredSnapshot = {
    slot: classified.slot,
    takenAt: new Date().toISOString(),
    tokenSupply: classified.tokenSupply.toString(),
    holders: classified.holders.map((h: HolderBalance) => ({
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

  await prisma.$transaction([
    prisma.allocation.deleteMany({ where: { distributionId: id } }),
    prisma.allocation.createMany({
      data: result.rows.map((r) => ({
        distributionId: id,
        wallet: r.owner,
        participantId: r.participantId ?? null,
        tokens: r.tokens,
        payout: r.payout,
      })),
    }),
    prisma.distribution.update({
      where: { id },
      data: {
        status: "SNAPSHOTTED",
        snapshotSlot: BigInt(classified.slot),
        snapshotJson: JSON.stringify(stored),
        totalAllocated: result.totalAllocated,
        unallocated: result.unallocated,
      },
    }),
  ]);

  const fresh = (await loadDistribution(id))!;
  return ok({
    ...(await buildDetail(fresh, { includeBalance: true })),
    next: "Show this table, then ask the founder to type the exact confirmTotal before calling fundraise_execute_distribution.",
  });
}

// ---------------------------------------------------------------- execute

/** In-process guard against concurrent executes of the same distribution (single API process). */
const executing = new Set<string>();

export async function executeDistribution(id: string, input: unknown): Promise<ServiceResult> {
  const body = (input ?? {}) as { confirmTotal?: unknown };
  if (body.confirmTotal === undefined || body.confirmTotal === null || body.confirmTotal === "") {
    return fail(400, "confirm_total_required", "confirmTotal is required: the founder must type the exact total (USDC) shown in the snapshot preview");
  }
  let typed: bigint;
  try {
    typed = parseUsdc(body.confirmTotal);
  } catch (e) {
    return fail(400, "invalid_confirm_total", e instanceof MoneyParseError ? e.message : "invalid confirmTotal");
  }

  if (executing.has(id)) return fail(409, "execution_in_progress", "execution is already running for this distribution");
  executing.add(id);
  try {
    return await executeLocked(id, typed);
  } finally {
    executing.delete(id);
  }
}

async function executeLocked(id: string, typed: bigint): Promise<ServiceResult> {
  const chain = await getChain();
  const d = await loadDistribution(id);
  if (!d) return fail(404, "not_found", `distribution ${id} not found`);
  if (d.status === "DRAFT") return fail(409, "not_snapshotted", "take a snapshot first (fundraise_snapshot)");
  if (d.totalAllocated === null) return fail(409, "not_snapshotted", "snapshot is missing");

  // Server-enforced gate (SPEC 0.3): the typed total must equal the snapshot's totalAllocated exactly.
  if (typed !== d.totalAllocated) {
    return fail(
      400,
      "confirm_total_mismatch",
      "confirmTotal does not match the snapshot total. Show the snapshot preview again and have the founder type the exact total.",
      { typed: usdc(typed) },
    );
  }

  if (d.status === "EXECUTED") {
    return ok({ ...(await buildDetail(d, { includeBalance: false })), alreadyExecuted: true });
  }
  if (d.status !== "SNAPSHOTTED") return fail(409, "invalid_status", `distribution is ${d.status}`);

  const unpaid = d.allocations
    .filter((a) => a.payout > 0n && !a.txSignature)
    .sort((a, b) => (a.payout === b.payout ? (a.wallet < b.wallet ? -1 : 1) : a.payout > b.payout ? -1 : 1));
  const remaining = unpaid.reduce((s, a) => s + a.payout, 0n);

  const bal = await chain.payout.getIssuerQuoteBalance();
  if (bal < remaining) {
    return fail(409, "insufficient_balance", "issuer USDC balance is below the amount still to pay", {
      issuerAddress: chain.payout.issuerAddress(),
      quoteMint: chain.payout.quoteMint(),
      balance: usdc(bal),
      required: usdc(remaining),
      shortfall: usdc(remaining - bal),
    });
  }

  const batches = batchTransfers(unpaid, MAX_TRANSFERS_PER_TX);
  const newSignatures: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    let signature: string;
    try {
      ({ signature } = await chain.payout.transferBatch(batch.map((a) => ({ wallet: a.wallet, amount: a.payout }))));
    } catch (e) {
      const fresh = (await loadDistribution(id))!;
      return fail(
        502,
        "partial_execution",
        `transfer batch ${i + 1}/${batches.length} failed: ${e instanceof Error ? e.message : String(e)}. ` +
          "Completed batches are recorded; retrying fundraise_execute_distribution with the same confirmTotal pays only unpaid rows.",
        {
          batchesCompleted: i,
          batchesTotal: batches.length,
          newSignatures,
          detail: await buildDetail(fresh, { includeBalance: true }),
        },
      );
    }
    newSignatures.push(signature);
    // Persist right away so a later failure or retry never pays these rows twice.
    await prisma.allocation.updateMany({
      where: { id: { in: batch.map((a) => a.id) }, txSignature: null },
      data: { txSignature: signature },
    });
  }

  const executedAt = new Date();
  // One period forward from the current record date (or from now if none was set).
  const nextRecordDate = advanceRecordDate(d.issuance.nextRecordDate ?? executedAt, d.issuance.distributionFrequency);
  await prisma.$transaction([
    prisma.distribution.update({ where: { id }, data: { status: "EXECUTED", executedAt } }),
    prisma.issuance.update({ where: { id: d.issuanceId }, data: { nextRecordDate } }),
  ]);

  const fresh = (await loadDistribution(id))!;
  return ok({
    ...(await buildDetail(fresh, { includeBalance: false })),
    alreadyExecuted: false,
    newSignatures,
    nextRecordDate,
    note:
      chain.mode === "fake"
        ? "CHAIN_MODE=fake: signatures are simulated, nothing moved on devnet."
        : "Holders can see this distribution on the market page.",
  });
}
