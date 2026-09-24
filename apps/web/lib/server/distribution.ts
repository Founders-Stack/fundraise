// Distribution lifecycle (SPEC section 7): report → snapshot → execute.
//
//   DRAFT ──snapshot──▶ SNAPSHOTTED ──execute──▶ EXECUTED
//                        ▲      │ (re-snapshot allowed until a payout is recorded)
//                        └──────┘
//
// Every transition is an atomic database claim, so the rules hold across API processes
// (serverless), not just inside one: execute takes a lease on the row (`executingUntil`) and
// only the lease holder pays; snapshot refuses to replace allocations while a lease is held.
// Errors are HttpErrors (routes wrap them with handle()); response shapes live in ./distribution-views.
// All money math lives in @fstack/core; this file does I/O (Prisma + chain ports) only.
import {
  allocate,
  batchTransfers,
  computeRightsPool,
  parsePeriodLabel,
  periodLabelFormat,
  periodToReport,
  perTokenBaseUnits,
  recordDateAfter,
  reportHash,
} from "@fstack/core";
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chain";
import { getClassifiedHolders } from "@/lib/server/holders";
import { MoneyParseError, parseUsdc, usdc } from "./money";
import {
  distributionDetail,
  distributionHistory,
  encodeSnapshot,
  executionLeaseHeld,
  reportedPeriodView,
  type DistributionWithAll,
} from "./distribution-views";
import { HttpError, appUrl } from "./http";
import { awaitingSignature, openSignRequest, signingMode, type SignPayload } from "./signing";
import { loadIssuance, toIssuanceRecord } from "./issuance-record";

const MAX_TRANSFERS_PER_TX = 10;
/**
 * How long one execute holds the row. Longer than the execute route's maxDuration (60s), so a live
 * executor never loses it; a crashed one frees the row once it expires. Renewed after every batch.
 */
export const EXECUTION_LEASE_MS = 120_000;

async function loadDistribution(id: string): Promise<DistributionWithAll | null> {
  const row = await prisma.distribution.findUnique({
    where: { id },
    include: { issuance: { include: { participants: true } }, allocations: true },
  });
  if (!row) return null;
  const { issuance, ...distribution } = row;
  return { ...distribution, issuance: toIssuanceRecord(issuance), participants: issuance.participants };
}

async function loadOr404(id: string): Promise<DistributionWithAll> {
  const d = await loadDistribution(id);
  if (!d) throw new HttpError(404, "not_found", `distribution ${id} not found`);
  return d;
}

/** Prisma filter: no live execution lease on the row. */
const leaseFree = (now: Date) => ({ OR: [{ executingUntil: null }, { executingUntil: { lt: now } }] });

// ---------------------------------------------------------------- report period

export async function reportPeriod(issuanceId: string, input: unknown) {
  const body = (input ?? {}) as { periodLabel?: unknown; dcf?: unknown; reportUrl?: unknown };
  const rawLabel = typeof body.periodLabel === "string" ? body.periodLabel.trim() : "";
  if (!rawLabel) throw new HttpError(400, "invalid_period_label", 'periodLabel is required (e.g. "2026-Q3")');
  let dcf: bigint;
  try {
    dcf = parseUsdc(body.dcf);
  } catch (e) {
    throw new HttpError(400, "invalid_dcf", e instanceof MoneyParseError ? e.message : "invalid dcf");
  }
  let reportUrl: string | undefined;
  if (body.reportUrl !== undefined && body.reportUrl !== null && body.reportUrl !== "") {
    if (typeof body.reportUrl !== "string" || !/^https?:\/\/\S+$/i.test(body.reportUrl)) {
      throw new HttpError(400, "invalid_report_url", "reportUrl must be an http(s) URL");
    }
    reportUrl = body.reportUrl;
  }

  const issuance = await loadIssuance(issuanceId);
  const frequency = issuance.terms.distributionFrequency;
  const period = parsePeriodLabel(rawLabel, frequency);
  if (!period) {
    throw new HttpError(400, "invalid_period_label", `periodLabel must be a ${frequency.toLowerCase()} period: ${periodLabelFormat(frequency)}`, {
      nextPeriod: periodToReport(issuance.nextRecordDate, frequency, new Date()),
    });
  }
  const periodLabel = period.label;

  const dup = await prisma.distribution.findUnique({
    where: { issuanceId_periodLabel: { issuanceId, periodLabel } },
  });
  if (dup) {
    throw new HttpError(409, "duplicate_period", `period ${periodLabel} was already reported`, {
      distributionId: dup.id,
      status: dup.status,
    });
  }
  const open = await prisma.distribution.findFirst({ where: { issuanceId, status: { not: "EXECUTED" } } });
  if (open) {
    throw new HttpError(409, "open_distribution_exists", `period ${open.periodLabel} is still ${open.status}; distribute it first`, {
      distributionId: open.id,
      periodLabel: open.periodLabel,
      status: open.status,
    });
  }

  const { poolPercentageBps, tokenDecimals } = issuance.terms;
  const rightsPool = computeRightsPool(dcf, poolPercentageBps);
  const d = await prisma.distribution.create({
    data: {
      issuanceId,
      periodLabel,
      dcf,
      reportUrl: reportUrl ?? null,
      reportHash: reportHash({ issuanceId, periodLabel, dcf, reportUrl }),
      poolPercentageBps,
      rightsPool,
      perTokenBaseUnits: perTokenBaseUnits(rightsPool, issuance.supplyBaseUnits, tokenDecimals),
      status: "DRAFT",
    },
  });
  return reportedPeriodView(d, issuance);
}

// ---------------------------------------------------------------- reads

export async function listDistributions(issuanceId: string) {
  const issuance = await loadIssuance(issuanceId);
  const [participants, distributions] = await Promise.all([
    prisma.participant.findMany({ where: { issuanceId } }),
    prisma.distribution.findMany({ where: { issuanceId }, include: { allocations: true }, orderBy: { createdAt: "asc" } }),
  ]);

  const chain = await getChain();
  let price: bigint | null = null;
  if (issuance.market) {
    try {
      price = (await chain.market.getMarketState(issuance.market.dbcPool)).price;
    } catch {
      price = null;
    }
  }
  return distributionHistory(issuance, participants, distributions, price, chain.mode);
}

export async function getDistribution(id: string) {
  return distributionDetail(await loadOr404(id), { includeBalance: true });
}

/** Read-only public view for /distributions/[id]: the same detail without the issuer's live balance check. */
export async function getPublicDistribution(id: string) {
  return distributionDetail(await loadOr404(id), { includeBalance: false });
}

// ---------------------------------------------------------------- snapshot

export async function snapshotDistribution(id: string) {
  const d = await loadOr404(id);
  assertSnapshotAllowed(d);

  const classified = await getClassifiedHolders(d.issuance, d.participants);
  const result = allocate(
    { slot: classified.slot, tokenSupply: classified.tokenSupply, holders: classified.holders },
    d.rightsPool,
  );

  // Re-check inside the transaction: an execute may have claimed the row while holders were read.
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const claimed = await tx.distribution.updateMany({
      where: { id, status: { not: "EXECUTED" }, ...leaseFree(now) },
      data: {
        status: "SNAPSHOTTED",
        snapshotSlot: BigInt(classified.slot),
        snapshotJson: encodeSnapshot(classified, result, now),
        totalAllocated: result.totalAllocated,
        unallocated: result.unallocated,
      },
    });
    // Checked after the write, under SQLite's write lock: no payout can land between here and commit.
    assertSnapshotAllowed(await tx.distribution.findUniqueOrThrow({ where: { id }, include: { allocations: true } }), now);
    if (claimed.count === 0) throw new HttpError(409, "execution_in_progress", "execution is running for this distribution");

    await tx.allocation.deleteMany({ where: { distributionId: id } });
    await tx.allocation.createMany({
      data: result.rows.map((r) => ({
        distributionId: id,
        wallet: r.owner,
        participantId: r.participantId ?? null,
        tokens: r.tokens,
        payout: r.payout,
      })),
    });
  });

  return {
    ...(await distributionDetail(await loadOr404(id), { includeBalance: true })),
    next: "Show this table, then ask the founder to type the exact confirmTotal before calling fundraise_execute_distribution.",
  };
}

function assertSnapshotAllowed(
  d: { status: string; executingUntil: Date | null; allocations: { txSignature: string | null }[] },
  now = new Date(),
) {
  if (d.status === "EXECUTED") throw new HttpError(409, "already_executed", "distribution is EXECUTED; its snapshot is immutable");
  if (executionLeaseHeld(d, now)) throw new HttpError(409, "execution_in_progress", "execution is running for this distribution");
  if (d.allocations.some((a) => a.txSignature)) {
    throw new HttpError(409, "payout_in_progress", "some allocations are already paid; retry fundraise_execute_distribution instead of re-snapshotting");
  }
}

// ---------------------------------------------------------------- execute

export async function executeDistribution(id: string, input: unknown) {
  const body = (input ?? {}) as { confirmTotal?: unknown; signingMode?: unknown };
  const mode = signingMode(body.signingMode);
  if (body.confirmTotal === undefined || body.confirmTotal === null || body.confirmTotal === "") {
    throw new HttpError(400, "confirm_total_required", "confirmTotal is required: the founder must type the exact total (USDC) shown in the snapshot preview");
  }
  let typed: bigint;
  try {
    typed = parseUsdc(body.confirmTotal);
  } catch (e) {
    throw new HttpError(400, "invalid_confirm_total", e instanceof MoneyParseError ? e.message : "invalid confirmTotal");
  }

  const d = await loadOr404(id);
  assertExecutable(d, typed);
  if (d.status === "EXECUTED") return { ...(await distributionDetail(d, { includeBalance: false })), alreadyExecuted: true };
  if (mode === "wallet") return requestDistributionSignature(d, typed);

  // Claim the row. `totalAllocated: typed` makes the claim fail if a re-snapshot changed the total
  // after the founder confirmed it.
  const lease: Lease = { until: new Date(Date.now() + EXECUTION_LEASE_MS) };
  const claimed = await prisma.distribution.updateMany({
    where: { id, status: "SNAPSHOTTED", totalAllocated: typed, ...leaseFree(new Date()) },
    data: { executingUntil: lease.until },
  });
  if (claimed.count === 0) {
    const current = await loadOr404(id);
    assertExecutable(current, typed);
    if (current.status === "EXECUTED") return { ...(await distributionDetail(current, { includeBalance: false })), alreadyExecuted: true };
    throw new HttpError(409, "execution_in_progress", "execution is already running for this distribution");
  }

  try {
    return await payClaimed(id, lease);
  } finally {
    // Release our lease unless the row was executed (which clears it) or another executor took over.
    await prisma.distribution.updateMany({ where: { id, executingUntil: lease.until }, data: { executingUntil: null } });
  }
}

function assertExecutable(d: DistributionWithAll, typed: bigint) {
  if (d.status === "DRAFT") throw new HttpError(409, "not_snapshotted", "take a snapshot first (fundraise_snapshot)");
  if (d.totalAllocated === null) throw new HttpError(409, "not_snapshotted", "snapshot is missing");
  // Server-enforced gate (SPEC 0.3): the typed total must equal the snapshot's totalAllocated exactly.
  if (typed !== d.totalAllocated) {
    throw new HttpError(
      400,
      "confirm_total_mismatch",
      "confirmTotal does not match the snapshot total. Show the snapshot preview again and have the founder type the exact total.",
      { typed: usdc(typed) },
    );
  }
  if (d.status !== "EXECUTED" && d.status !== "SNAPSHOTTED") throw new HttpError(409, "invalid_status", `distribution is ${d.status}`);
}

/** The execution lease this process holds; `until` moves forward after every paid batch. */
interface Lease {
  until: Date;
}

/** On-chain memo for every payout batch: ties the USDC transfer to the reported period (SPEC report hash). */
export const reportMemo = (hash: string) => `fstack:report:${hash}`;

/** Pays every unpaid allocation of a distribution this process holds the lease on, then marks it EXECUTED. */
async function payClaimed(id: string, lease: Lease) {
  const chain = await getChain();
  // Re-read after the claim: a previous (expired) executor may have paid rows since we first loaded.
  const d = await loadOr404(id);
  const unpaid = d.allocations
    .filter((a) => a.payout > 0n && !a.txSignature)
    .sort((a, b) => (a.payout === b.payout ? (a.wallet < b.wallet ? -1 : 1) : a.payout > b.payout ? -1 : 1));
  const remaining = unpaid.reduce((s, a) => s + a.payout, 0n);

  const bal = await chain.payout.getIssuerQuoteBalance();
  if (bal < remaining) {
    throw new HttpError(409, "insufficient_balance", "issuer USDC balance is below the amount still to pay", {
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
      ({ signature } = await chain.payout.transferBatch(
        batch.map((a) => ({ wallet: a.wallet, amount: a.payout })),
        { memo: reportMemo(d.reportHash) },
      ));
    } catch (e) {
      throw new HttpError(
        502,
        "partial_execution",
        `transfer batch ${i + 1}/${batches.length} failed: ${e instanceof Error ? e.message : String(e)}. ` +
          "Completed batches are recorded; retrying fundraise_execute_distribution with the same confirmTotal pays only unpaid rows.",
        {
          batchesCompleted: i,
          batchesTotal: batches.length,
          newSignatures,
          detail: await distributionDetail(await loadOr404(id), { includeBalance: true }),
        },
      );
    }
    newSignatures.push(signature);
    // Persist right away so a later failure or retry never pays these rows twice.
    await prisma.allocation.updateMany({
      where: { id: { in: batch.map((a) => a.id) }, txSignature: null },
      data: { txSignature: signature },
    });
    const next = new Date(Date.now() + EXECUTION_LEASE_MS);
    const renewed = await prisma.distribution.updateMany({ where: { id, executingUntil: lease.until }, data: { executingUntil: next } });
    if (renewed.count === 0) {
      throw new HttpError(409, "execution_in_progress", "lost the execution lease; another execution took over this distribution", {
        batchesCompleted: i + 1,
        batchesTotal: batches.length,
        newSignatures,
      });
    }
    lease.until = next;
  }

  return markExecuted(d, newSignatures, chain.mode);
}

/** Every payout is recorded: mark EXECUTED and move the issuance to its next record date. */
async function markExecuted(d: DistributionWithAll, newSignatures: string[], chainMode: "fake" | "devnet") {
  const id = d.id;
  const executedAt = new Date();
  const frequency = d.issuance.terms.distributionFrequency;
  // The record date of the period after the one just paid (labels from before canonical labels fall back to the current period).
  const paidPeriod = parsePeriodLabel(d.periodLabel, frequency) ?? periodToReport(d.issuance.nextRecordDate, frequency, executedAt);
  const nextRecordDate = recordDateAfter(paidPeriod, d.issuance.nextRecordDate);
  await prisma.$transaction([
    prisma.distribution.update({ where: { id }, data: { status: "EXECUTED", executedAt, executingUntil: null } }),
    prisma.issuance.update({ where: { id: d.issuanceId }, data: { nextRecordDate } }),
  ]);

  return {
    ...(await distributionDetail(await loadOr404(id), { includeBalance: false })),
    alreadyExecuted: false,
    newSignatures,
    nextRecordDate,
    note:
      chainMode === "fake"
        ? "CHAIN_MODE=fake: signatures are simulated, nothing moved on devnet."
        : "Holders can see this distribution on the market page.",
  };
}

// ---------------------------------------------------------------- wallet signing (SPEC 0.4 P1)

/** Holder payouts per wallet-signed tx (each also creates missing recipient ATAs, so fewer than custody's 10). */
const MAX_TRANSFERS_PER_WALLET_TX = 5;

/** Wallet mode: the confirmed total is locked into a sign request; the founder's wallet pays. */
async function requestDistributionSignature(d: DistributionWithAll, confirmed: bigint) {
  const unpaid = d.allocations.filter((a) => a.payout > 0n && !a.txSignature);
  const remaining = unpaid.reduce((s, a) => s + a.payout, 0n);
  const txCount = Math.ceil(unpaid.length / MAX_TRANSFERS_PER_WALLET_TX);
  const symbol = d.issuance.terms.symbol;
  const row = await openSignRequest("DISTRIBUTION_EXECUTE", d.id, {
    title: `Pay the ${symbol} ${d.periodLabel} distribution`,
    action: `Send USDC from your wallet to ${unpaid.length} holder${unpaid.length === 1 ? "" : "s"} of ${symbol}, as in the snapshot you confirmed.`,
    lines: [
      { label: "Issuer", value: d.issuance.terms.issuerName },
      { label: "Period", value: d.periodLabel },
      { label: "Confirmed total", value: usdc(confirmed).display },
      { label: "Still to pay", value: usdc(remaining).display },
      { label: "Holders", value: String(unpaid.length) },
      { label: "Transactions to sign", value: String(txCount) },
    ],
    warning: "Your wallet must hold the USDC total plus a little SOL for fees and new token accounts.",
    doneUrl: `${appUrl()}/distributions/${d.id}`,
    meta: { confirmTotal: confirmed.toString() },
  });
  return awaitingSignature(row, {
    distributionId: d.id,
    periodLabel: d.periodLabel,
    confirmTotal: usdc(confirmed),
    remaining: usdc(remaining),
    holders: unpaid.length,
  });
}

function confirmedTotalOf(summaryMeta: Record<string, string> | undefined): bigint {
  const raw = summaryMeta?.confirmTotal;
  if (!raw) throw new HttpError(500, "invalid_sign_request", "sign request has no confirmed total");
  return BigInt(raw);
}

/** Unpaid payouts → one transfer tx per ≤ 5 holders, from the founder's wallet. */
export async function buildDistributionSignTxs(id: string, wallet: string, meta: Record<string, string> | undefined): Promise<SignPayload> {
  const d = await loadOr404(id);
  assertExecutable(d, confirmedTotalOf(meta));
  if (d.status === "EXECUTED") throw new HttpError(409, "already_executed", "this distribution was already paid");
  const chain = await getChain();
  const unpaid = d.allocations
    .filter((a) => a.payout > 0n && !a.txSignature)
    .sort((a, b) => (a.payout === b.payout ? (a.wallet < b.wallet ? -1 : 1) : a.payout > b.payout ? -1 : 1));
  const batches = batchTransfers(unpaid, MAX_TRANSFERS_PER_WALLET_TX);
  const txs = [];
  for (const batch of batches) txs.push(await chain.wallet.buildTransferBatchTx(wallet, batch.map((a) => ({ wallet: a.wallet, amount: a.payout }))));
  return { txs, data: { batches: batches.map((b) => b.map((a) => a.id)) } };
}

/**
 * Broadcasts the founder-signed payout txs one by one under the execution lease, recording each
 * batch as it confirms (a retry via a fresh build pays only unpaid rows), then marks EXECUTED.
 */
export async function applyDistributionSigned(
  id: string,
  wallet: string,
  meta: Record<string, string> | undefined,
  payload: SignPayload,
  signedTxs: string[],
  onSignature: (sig: string) => Promise<void>,
) {
  const confirmed = confirmedTotalOf(meta);
  const lease: Lease = { until: new Date(Date.now() + EXECUTION_LEASE_MS) };
  const claimed = await prisma.distribution.updateMany({
    where: { id, status: "SNAPSHOTTED", totalAllocated: confirmed, ...leaseFree(new Date()) },
    data: { executingUntil: lease.until },
  });
  if (claimed.count === 0) {
    const current = await loadOr404(id);
    assertExecutable(current, confirmed);
    if (current.status === "EXECUTED") throw new HttpError(409, "already_executed", "this distribution was already paid");
    throw new HttpError(409, "execution_in_progress", "execution is already running for this distribution");
  }
  try {
    const chain = await getChain();
    const batches = payload.data.batches as string[][];
    const newSignatures: string[] = [];
    for (let i = 0; i < payload.txs.length; i++) {
      let signature: string;
      try {
        ({ signature } = await chain.wallet.submitSigned(payload.txs[i], signedTxs[i], wallet));
      } catch (e) {
        throw new HttpError(
          502,
          "partial_execution",
          `payout tx ${i + 1}/${payload.txs.length} failed: ${e instanceof Error ? e.message : String(e)}. ` +
            "Completed payouts are recorded; reload the sign page to sign the rest.",
          { batchesCompleted: i, batchesTotal: payload.txs.length, newSignatures },
        );
      }
      newSignatures.push(signature);
      await onSignature(signature);
      await prisma.allocation.updateMany({ where: { id: { in: batches[i] }, distributionId: id, txSignature: null }, data: { txSignature: signature } });
      const next = new Date(Date.now() + EXECUTION_LEASE_MS);
      await prisma.distribution.updateMany({ where: { id, executingUntil: lease.until }, data: { executingUntil: next } });
      lease.until = next;
    }
    const d = await loadOr404(id);
    if (d.allocations.some((a) => a.payout > 0n && !a.txSignature)) {
      throw new HttpError(409, "payouts_remaining", "some payouts are still unpaid; reload the sign page to sign the rest");
    }
    return await markExecuted(d, newSignatures, chain.mode);
  } finally {
    await prisma.distribution.updateMany({ where: { id, executingUntil: lease.until }, data: { executingUntil: null } });
  }
}
