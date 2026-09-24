// Client-safe display helpers. Inputs are base-unit strings (6 dp) as returned by the API.

const DP = 6;

function toBig(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined || v === "") return 0n;
  if (typeof v === "bigint") return v;
  return BigInt(typeof v === "number" ? Math.trunc(v) : v);
}

function group(s: string) {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Formats base units with between min and max fraction digits (truncating, never rounding up). */
export function units(v: string | number | bigint | null | undefined, opts: { min?: number; max?: number; dp?: number } = {}) {
  const dp = opts.dp ?? DP;
  const max = Math.min(opts.max ?? 2, dp);
  const min = Math.min(opts.min ?? 0, max);
  const n = toBig(v);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const base = 10n ** BigInt(dp);
  let frac = (abs % base).toString().padStart(dp, "0").slice(0, max);
  frac = frac.replace(/0+$/, "");
  if (frac.length < min) frac = frac.padEnd(min, "0");
  return `${neg ? "-" : ""}${group((abs / base).toString())}${frac ? "." + frac : ""}`;
}

/** "$1,200,000.00"-style USDC. Sub-dollar amounts keep up to 4 decimals (per-token values). */
export function usd(v: string | number | bigint | null | undefined, opts: { min?: number; max?: number } = {}) {
  const n = toBig(v);
  const abs = n < 0n ? -n : n;
  const small = abs > 0n && abs < 1_000_000n;
  const s = units(n < 0n ? -n : n, { min: opts.min ?? 2, max: opts.max ?? (small ? 4 : 2) });
  return `${n < 0n ? "-" : ""}$${s}`;
}

/** Compact USD for headline numbers: $1.2M, $96.8K. */
export function usdCompact(v: string | number | bigint | null | undefined) {
  const n = Number(toBig(v)) / 1e6;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, "")}M`;
  if (Math.abs(n) >= 1e4) return `$${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return usd(v);
}

export function tokens(v: string | number | bigint | null | undefined, max = 2) {
  return units(v, { max });
}

export function bps(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return `${(v / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/** Decimal string → base units (6 dp). Returns null when not a valid positive amount. */
export function parseAmount(input: string, dp = DP): bigint | null {
  const s = input.trim().replace(/,/g, "");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  const frac = (m[2] ?? "").slice(0, dp).padEnd(dp, "0");
  const v = BigInt(m[1] || "0") * 10n ** BigInt(dp) + BigInt(frac || "0");
  return v > 0n ? v : null;
}

export function shortAddr(a: string | null | undefined, n = 4) {
  if (!a) return "";
  return a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
}

export function fmtDate(d: string | Date | null | undefined, withTime = false) {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }) + (withTime ? " UTC" : "");
}

/** True for signatures that are not real devnet transactions (fake chain / idempotent no-ops). */
export function isSimulatedSig(sig: string | null | undefined) {
  return !sig || sig.startsWith("fake_") || sig === "already-allowlisted" || sig.length < 60;
}

export function explorerTx(sig: string) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

export function explorerAddress(addr: string) {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}

/** Plain JSON (bigint → string, Date → ISO) so server data can be passed to client components. */
export function plain<T>(v: T): Jsonify<T> {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

export type Jsonify<T> = T extends bigint
  ? string
  : T extends Date
    ? string
    : T extends (infer U)[]
      ? Jsonify<U>[]
      : T extends object
        ? { [K in keyof T]: Jsonify<T[K]> }
        : T;
