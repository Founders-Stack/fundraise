// Distribution engine (SPEC section 2 R1/R5/R7, section 7).
// Pure functions. All money is bigint base units: USDC 6 dp, token 6 dp.

export const USDC_DECIMALS = 6;
export const DEFAULT_TOKEN_DECIMALS = 6;
export const BPS_DENOMINATOR = 10_000;
const MS_PER_365_DAYS = 365 * 24 * 60 * 60 * 1000;

export type HolderKind = "PARTICIPANT" | "POOL" | "UNREGISTERED";

export interface HolderBalance {
  owner: string;
  tokenAccount: string;
  amount: bigint;
  kind: HolderKind;
  participantId?: string;
}

export interface Snapshot {
  slot: number;
  tokenSupply: bigint;
  holders: HolderBalance[];
}

export interface AllocationRow {
  owner: string;
  participantId?: string;
  tokens: bigint;
  payout: bigint;
}

/** Non-participant holders (POOL / UNREGISTERED): shown in the UI, receive nothing. */
export interface ExcludedHolder {
  owner: string;
  kind: Exclude<HolderKind, "PARTICIPANT">;
  tokens: bigint;
  /** floor(tokens * rightsPool / tokenSupply): the share retained by the issuer. */
  retainedShare: bigint;
}

export interface UnallocatedBreakdown {
  /** Share of tokens held by POOL accounts (DBC vault, DAMM, LP). */
  pool: bigint;
  /** Share of tokens held by UNREGISTERED wallets. */
  unregistered: bigint;
  /** Share of tokens not present in the snapshot (supply - sum of balances). */
  unsold: bigint;
  /** Rounding remainder so the breakdown sums exactly to `unallocated`. */
  dust: bigint;
}

export interface AllocationResult {
  slot: number;
  tokenSupply: bigint;
  rightsPool: bigint;
  /** perToken as an exact rational: USDC base units per token base unit. */
  perTokenNumerator: bigint;
  perTokenDenominator: bigint;
  /** PARTICIPANT rows, merged by owner, sorted by payout desc then owner asc. */
  rows: AllocationRow[];
  excluded: ExcludedHolder[];
  totalAllocated: bigint;
  unallocated: bigint;
  unallocatedBreakdown: UnallocatedBreakdown;
}

/** rightsPool = floor(dcf * bps / 10000). 10% = 1000 bps. */
export function computeRightsPool(dcf: bigint, poolPercentageBps: number): bigint {
  if (!Number.isInteger(poolPercentageBps) || poolPercentageBps <= 0 || poolPercentageBps > BPS_DENOMINATOR) {
    throw new RangeError(`poolPercentageBps must be an integer in (0, 10000], got ${poolPercentageBps}`);
  }
  if (dcf < 0n) throw new RangeError("dcf must be >= 0");
  return (dcf * BigInt(poolPercentageBps)) / BigInt(BPS_DENOMINATOR);
}

interface MergedHolder {
  owner: string;
  kind: HolderKind;
  participantId?: string;
  tokens: bigint;
}

function mergeHolders(holders: HolderBalance[]): MergedHolder[] {
  const byOwner = new Map<string, MergedHolder>();
  for (const h of holders) {
    if (h.amount < 0n) throw new RangeError(`negative balance for ${h.tokenAccount}`);
    const existing = byOwner.get(h.owner);
    if (!existing) {
      byOwner.set(h.owner, { owner: h.owner, kind: h.kind, participantId: h.participantId, tokens: h.amount });
      continue;
    }
    if (existing.kind !== h.kind) {
      throw new Error(`owner ${h.owner} has token accounts with conflicting kinds (${existing.kind} vs ${h.kind})`);
    }
    if (existing.participantId && h.participantId && existing.participantId !== h.participantId) {
      throw new Error(`owner ${h.owner} has conflicting participantIds`);
    }
    existing.participantId ??= h.participantId;
    existing.tokens += h.amount;
  }
  return [...byOwner.values()];
}

function compareOwner(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * R1/R5: payout = floor(tokens * rightsPool / tokenSupply) for PARTICIPANT holders only.
 * Invariants: totalAllocated + unallocated == rightsPool; breakdown sums to unallocated.
 */
export function allocate(snapshot: Snapshot, rightsPool: bigint): AllocationResult {
  const { tokenSupply } = snapshot;
  if (tokenSupply <= 0n) throw new RangeError("tokenSupply must be > 0");
  if (rightsPool < 0n) throw new RangeError("rightsPool must be >= 0");

  const merged = mergeHolders(snapshot.holders);
  const held = merged.reduce((s, h) => s + h.tokens, 0n);
  if (held > tokenSupply) {
    throw new RangeError(`snapshot balances (${held}) exceed tokenSupply (${tokenSupply})`);
  }

  const share = (tokens: bigint) => (tokens * rightsPool) / tokenSupply;

  const rows: AllocationRow[] = [];
  const excluded: ExcludedHolder[] = [];
  let poolTokens = 0n;
  let unregisteredTokens = 0n;

  for (const h of merged) {
    if (h.kind === "PARTICIPANT") {
      const row: AllocationRow = { owner: h.owner, tokens: h.tokens, payout: share(h.tokens) };
      if (h.participantId !== undefined) row.participantId = h.participantId;
      rows.push(row);
    } else {
      if (h.kind === "POOL") poolTokens += h.tokens;
      else unregisteredTokens += h.tokens;
      excluded.push({ owner: h.owner, kind: h.kind, tokens: h.tokens, retainedShare: share(h.tokens) });
    }
  }

  rows.sort((a, b) => (a.payout === b.payout ? compareOwner(a.owner, b.owner) : a.payout > b.payout ? -1 : 1));
  excluded.sort((a, b) => (a.tokens === b.tokens ? compareOwner(a.owner, b.owner) : a.tokens > b.tokens ? -1 : 1));

  const totalAllocated = rows.reduce((s, r) => s + r.payout, 0n);
  const unallocated = rightsPool - totalAllocated;
  const pool = share(poolTokens);
  const unregistered = share(unregisteredTokens);
  const unsold = share(tokenSupply - held);
  const dust = unallocated - pool - unregistered - unsold;

  return {
    slot: snapshot.slot,
    tokenSupply,
    rightsPool,
    perTokenNumerator: rightsPool,
    perTokenDenominator: tokenSupply,
    rows,
    excluded,
    totalAllocated,
    unallocated,
    unallocatedBreakdown: { pool, unregistered, unsold, dust },
  };
}

/** USDC base units per ONE whole token, floored: rightsPool * 10^tokenDecimals / tokenSupply. */
export function perTokenBaseUnits(
  rightsPool: bigint,
  tokenSupply: bigint,
  tokenDecimals: number = DEFAULT_TOKEN_DECIMALS,
): bigint {
  if (tokenSupply <= 0n) throw new RangeError("tokenSupply must be > 0");
  return (rightsPool * 10n ** BigInt(tokenDecimals)) / tokenSupply;
}

function formatBaseUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** Per-token entitlement as a USDC string with up to 6 decimals (e.g. "0.04"). Floored. */
export function perTokenDisplay(
  rightsPool: bigint,
  tokenSupply: bigint,
  tokenDecimals: number = DEFAULT_TOKEN_DECIMALS,
): string {
  return formatBaseUnits(perTokenBaseUnits(rightsPool, tokenSupply, tokenDecimals), USDC_DECIMALS);
}

// ---------------- R7: yield (informational) ----------------

export interface DistributionHistoryItem {
  periodLabel: string;
  executedAt: Date;
  rightsPool: bigint;
  tokenSupply: bigint;
}

export interface YieldMetrics {
  /** USDC base units per whole token of the most recent period (0n if no history). */
  lastPerToken: bigint;
  /** Sum of perToken over periods executed in (now - 365d, now]. */
  ttmPerToken: bigint;
  /** ttmPerToken / price in bps; null when price is 0. */
  trailingYieldBps: number | null;
  /** lastPerToken * periodsPerYear. */
  annualizedRunRatePerToken: bigint;
  /** annualizedRunRatePerToken / price in bps; null when price is 0. */
  annualizedYieldBps: number | null;
  /** Number of periods in the TTM window. */
  periodsCounted: number;
  /** True when fewer than periodsPerYear periods fall in the TTM window ("annualized from N periods"). */
  isAnnualized: boolean;
}

/**
 * @param currentPriceQuotePerToken USDC base units per 1 whole token.
 */
export function yieldMetrics(
  history: DistributionHistoryItem[],
  currentPriceQuotePerToken: bigint,
  periodsPerYear: number,
  now: Date,
  tokenDecimals: number = DEFAULT_TOKEN_DECIMALS,
): YieldMetrics {
  if (!Number.isInteger(periodsPerYear) || periodsPerYear <= 0) {
    throw new RangeError(`periodsPerYear must be a positive integer, got ${periodsPerYear}`);
  }
  const nowMs = now.getTime();
  const sorted = [...history].sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime());
  const past = sorted.filter((h) => h.executedAt.getTime() <= nowMs);
  const last = past[past.length - 1];
  const lastPerToken = last ? perTokenBaseUnits(last.rightsPool, last.tokenSupply, tokenDecimals) : 0n;

  const ttm = past.filter((h) => h.executedAt.getTime() > nowMs - MS_PER_365_DAYS);
  const ttmPerToken = ttm.reduce((s, h) => s + perTokenBaseUnits(h.rightsPool, h.tokenSupply, tokenDecimals), 0n);
  const annualizedRunRatePerToken = lastPerToken * BigInt(periodsPerYear);

  const toBps = (amount: bigint): number | null =>
    currentPriceQuotePerToken > 0n
      ? Number((amount * BigInt(BPS_DENOMINATOR)) / currentPriceQuotePerToken)
      : null;

  return {
    lastPerToken,
    ttmPerToken,
    trailingYieldBps: toBps(ttmPerToken),
    annualizedRunRatePerToken,
    annualizedYieldBps: toBps(annualizedRunRatePerToken),
    periodsCounted: ttm.length,
    isAnnualized: ttm.length < periodsPerYear,
  };
}

// ---------------- execution batching ----------------

/** Chunk rows into transfer batches of at most maxPerTx, skipping zero payouts. Order preserved. */
export function batchTransfers<T extends { payout: bigint }>(rows: T[], maxPerTx = 10): T[][] {
  if (!Number.isInteger(maxPerTx) || maxPerTx <= 0) throw new RangeError("maxPerTx must be a positive integer");
  const payable = rows.filter((r) => r.payout > 0n);
  const batches: T[][] = [];
  for (let i = 0; i < payable.length; i += maxPerTx) batches.push(payable.slice(i, i + maxPerTx));
  return batches;
}
