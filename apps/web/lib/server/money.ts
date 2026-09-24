// Money and amounts in API requests and responses. All amounts are bigint base units internally;
// this is the only place they are parsed from or turned into strings. Every response uses the
// same shapes, so skills follow one rule ("show `.display`"):
//   USDC amount  → { baseUnits, usdc, display }     e.g. { "4000000000", "4000", "$4,000" }
//   token amount → { baseUnits, amount, display }   e.g. { "100000000000", "100000", "100,000" }
//   percentage   → "10%", "12.5%", "7.08%"
import { USDC_DECIMALS } from "@fstack/core";

export class MoneyParseError extends Error {}

/**
 * Parses a human USDC amount into base units (6 dp). Accepts "400000", "400000.50",
 * "400,000.50", "$400,000", "400000 USDC" and plain numbers. Rejects negatives, exponents,
 * more than 6 decimals and anything else ambiguous. Base-unit integers are NOT accepted here:
 * "4000" means 4,000 USDC, never 4,000 base units.
 */
export function parseUsdc(input: unknown): bigint {
  if (typeof input !== "string" && typeof input !== "number") {
    throw new MoneyParseError('amount must be a decimal string, e.g. "400000" or "400000.50"');
  }
  const s = String(input).trim().replace(/^\$\s*/, "").replace(/\s*USDC$/i, "").replace(/,/g, "").trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new MoneyParseError(`not a valid USDC amount: ${JSON.stringify(input)}`);
  if ((m[2] ?? "").length > USDC_DECIMALS) throw new MoneyParseError(`${JSON.stringify(input)} has more than ${USDC_DECIMALS} decimals`);
  return BigInt(m[1]) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0") || "0");
}

/** Base units as a plain decimal string (no grouping), trailing zeros trimmed: 1000000n → "1". */
export function formatUnits(amount: bigint, decimals: number = USDC_DECIMALS): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / base}${frac ? "." + frac : ""}`;
}

const group = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "$4,000", "$4,000.50", "$0.045". Exact: never rounds, so what is shown is what is paid. */
export function usdDisplay(amount: bigint): string {
  const [whole, frac] = formatUnits(amount < 0n ? -amount : amount, USDC_DECIMALS).split(".");
  const cents = frac ? (frac.length === 1 ? frac + "0" : frac) : "";
  return `${amount < 0n ? "-" : ""}$${group(whole)}${cents ? "." + cents : ""}`;
}

export type UsdcAmount = { baseUnits: bigint; usdc: string; display: string };

export function usdc(amount: bigint): UsdcAmount {
  return { baseUnits: amount, usdc: formatUnits(amount, USDC_DECIMALS), display: usdDisplay(amount) };
}

/** Grouped token amount: 100000000000n (6 dp) → "100,000". */
export function tokenDisplay(amount: bigint, decimals: number): string {
  const [whole, frac] = formatUnits(amount, decimals).split(".");
  return group(whole) + (frac ? "." + frac : "");
}

export type TokenAmount = { baseUnits: bigint; amount: string; display: string };

/** `symbol`, when given, is appended to the display string ("100,000 ACME"). */
export function tokenAmount(amount: bigint, decimals: number, symbol?: string): TokenAmount {
  const display = tokenDisplay(amount, decimals);
  return { baseUnits: amount, amount: formatUnits(amount, decimals), display: symbol ? `${display} ${symbol}` : display };
}

/** bps → "16%" / "12.5%" / "7.08%". */
export function pctDisplay(bps: number): string;
export function pctDisplay(bps: number | null): string | null;
export function pctDisplay(bps: number | null): string | null {
  if (bps === null) return null;
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2).replace(/0+$/, "")}%`;
}

/** Share of supply, floored to 0.01%: "10%", "0.04%". */
export function pctOfSupply(tokens: bigint, supply: bigint): string {
  return pctDisplay(supply > 0n ? Number((tokens * 10_000n) / supply) : 0);
}
