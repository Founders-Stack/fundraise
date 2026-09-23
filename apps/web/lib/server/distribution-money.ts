// USDC decimal-string <-> base-unit helpers for the distribution API.
// Money is bigint base units everywhere (USDC 6 dp); decimal strings only at the API edge.
import { USDC_DECIMALS, DEFAULT_TOKEN_DECIMALS } from "@fstack/core";

export class MoneyParseError extends Error {}

/**
 * Parses a human USDC amount into base units (6 dp). Accepts "400000", "400000.50",
 * "400,000.50", "$400,000", "400000 USDC". Rejects negatives, exponents, >6 decimals
 * and anything else ambiguous. Base-unit integers are NOT accepted here: "4000" means
 * 4,000 USDC, never 4,000 base units.
 */
export function parseUsdc(input: unknown): bigint {
  if (typeof input !== "string" && typeof input !== "number") {
    throw new MoneyParseError("amount must be a decimal string, e.g. \"400000\" or \"400000.50\"");
  }
  let s = String(input).trim();
  s = s.replace(/^\$\s*/, "").replace(/\s*USDC$/i, "").replace(/,/g, "").trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new MoneyParseError(`not a valid USDC amount: ${JSON.stringify(input)}`);
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0") || "0");
  return whole * 10n ** BigInt(USDC_DECIMALS) + frac;
}

function formatUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

function groupThousands(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Canonical decimal string, trailing zeros trimmed: 4_000_000_000n -> "4000". */
export const usdc = (baseUnits: bigint): string => formatUnits(baseUnits, USDC_DECIMALS);

/** Display string with separators and at least 2 decimals: 4_000_000_000n -> "4,000.00". */
export function usdcDisplay(baseUnits: bigint): string {
  const s = formatUnits(baseUnits, USDC_DECIMALS);
  const [w, f = ""] = s.replace("-", "").split(".");
  const frac = f.length >= 2 ? f : f.padEnd(2, "0");
  return `${baseUnits < 0n ? "-" : ""}${groupThousands(w)}.${frac}`;
}

/** Whole-token display for token base units (6 dp): 100_000_000_000n -> "100,000". */
export function tokensDisplay(baseUnits: bigint, decimals = DEFAULT_TOKEN_DECIMALS): string {
  const s = formatUnits(baseUnits, decimals);
  const [w, f] = s.split(".");
  return groupThousands(w) + (f ? "." + f : "");
}

/** Percent of supply with 2 decimals, floored: "10.00%". */
export function pctOfSupply(tokens: bigint, supply: bigint): string {
  if (supply <= 0n) return "0.00%";
  const hundredths = (tokens * 10_000n) / supply; // basis points
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}%`;
}
