// Money helpers for API responses. All amounts are bigint base units; these only
// parse/format decimal strings for display ("human-readable alongside base units").
import { USDC_DECIMALS } from "@fstack/core";

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Parses a decimal string ("1600000", "1600000.50") into base units. Throws on bad input or excess precision. */
export function parseUnits(value: string, decimals: number = USDC_DECIMALS): bigint {
  const v = value.trim().replace(/,/g, "").replace(/^\$/, "");
  if (!DECIMAL_RE.test(v)) throw new Error(`not a non-negative decimal number: "${value}"`);
  const [whole, frac = ""] = v.split(".");
  if (frac.length > decimals) throw new Error(`"${value}" has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Formats base units as a plain decimal string (no grouping), trailing zeros trimmed: 1000000n → "1". */
export function formatUnits(amount: bigint, decimals: number = USDC_DECIMALS): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / base}${frac ? "." + frac : ""}`;
}

/** "$1,600,000" / "$0.04" style display string for USDC base units (floored to cents unless < $0.01 precision matters). */
export function usdDisplay(amount: bigint): string {
  const abs = amount < 0n ? -amount : amount;
  // >= $0.01: floor to cents; sub-cent amounts keep full 6-dp precision.
  const shown = abs >= 10_000n ? (abs / 10_000n) * 10_000n : abs;
  const s = formatUnits(shown, USDC_DECIMALS);
  const [whole, frac] = s.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = frac ? (frac.length === 1 ? frac + "0" : frac) : "";
  return `${amount < 0n ? "-" : ""}$${grouped}${cents ? "." + cents : ""}`;
}

/** Token amount display with grouping: 100000000000n (6dp) → "100,000". */
export function tokenDisplay(amount: bigint, decimals = 6): string {
  const [whole, frac] = formatUnits(amount, decimals).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? "." + frac : "");
}

/** bps → "16%" / "12.5%". */
export function pctDisplay(bps: number | null): string | null {
  if (bps === null) return null;
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2).replace(/0+$/, "")}%`;
}

/** Money object used across responses: base units (string via json()) + human decimal + display. */
export function usdc(amount: bigint) {
  return { baseUnits: amount, usdc: formatUnits(amount, USDC_DECIMALS), display: usdDisplay(amount) };
}

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
