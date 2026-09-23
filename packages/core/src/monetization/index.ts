/**
 * Monetization: config, not a service (SPEC section 8).
 *
 * Pure functions only. No I/O, no Meteora SDK import. Callers (lib/meteora/buildConfig.ts)
 * feed the output of `toDbcFeeParams` into the DBC config builder.
 */

export type MonetizationMode = "DEMO_PROTOCOL" | "SOFTWARE";

export type MonetizationConfig = {
  mode: MonetizationMode;
  /** Split of the graduation (migration) quote proceeds. Sums to 100. */
  graduation: { issuerPct: number; platformPct: number; liquidityPct: number };
  /** Split of DBC pre-graduation trading fees. Sums to 100. */
  dbcTradingFees: { creatorPct: number; partnerPct: number };
  /** Software pricing in USD. Display only; never enforced on-chain. */
  software?: { setupFee: number; monthlyFee: number; perDistributionFee: number };
};

/** Meteora DBC `MigrationFeeOption.Customizable`. */
export const MIGRATION_FEE_OPTION_CUSTOMIZABLE = 6 as const;
/** Meteora DBC max for `migrationFee.feePercentage`. */
export const MAX_MIGRATION_FEE_PERCENTAGE = 99;

export const DEMO_PROTOCOL_CONFIG: MonetizationConfig = Object.freeze({
  mode: "DEMO_PROTOCOL",
  graduation: Object.freeze({ issuerPct: 48, platformPct: 2, liquidityPct: 50 }),
  dbcTradingFees: Object.freeze({ creatorPct: 50, partnerPct: 50 }),
}) as MonetizationConfig;

export const SOFTWARE_CONFIG: MonetizationConfig = Object.freeze({
  mode: "SOFTWARE",
  graduation: Object.freeze({ issuerPct: 50, platformPct: 0, liquidityPct: 50 }),
  dbcTradingFees: Object.freeze({ creatorPct: 100, partnerPct: 0 }),
  software: Object.freeze({ setupFee: 2500, monthlyFee: 499, perDistributionFee: 250 }),
}) as MonetizationConfig;

export type DbcFeeParams = {
  migrationFeeOption: typeof MIGRATION_FEE_OPTION_CUSTOMIZABLE;
  migrationFee: { feePercentage: number; creatorFeePercentage: number };
  creatorTradingFeePercentage: number;
};

export type ProjectedEconomics = { issuer: bigint; platform: bigint; liquidity: bigint };

export type FeeLine = { label: string; value: string };
export type FeeDescription = { label?: "Illustrative protocol economics"; lines: FeeLine[] };

// ---------------------------------------------------------------------------

function isNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * Returns creatorFeePercentage if issuerPct / feePercentage * 100 is an exact integer,
 * otherwise null. feePercentage must be > 0.
 */
function exactCreatorFeePercentage(issuerPct: number, feePercentage: number): number | null {
  const scaled = issuerPct * 100;
  return scaled % feePercentage === 0 ? scaled / feePercentage : null;
}

/** Returns a list of human-readable errors; empty list means valid. */
export function validateMonetizationConfig(cfg: MonetizationConfig): string[] {
  const errors: string[] = [];
  if (cfg.mode !== "DEMO_PROTOCOL" && cfg.mode !== "SOFTWARE") {
    errors.push(`mode must be DEMO_PROTOCOL or SOFTWARE, got ${String(cfg.mode)}`);
  }

  const g = cfg.graduation;
  const gradFields = ["issuerPct", "platformPct", "liquidityPct"] as const;
  let gradInts = true;
  for (const k of gradFields) {
    if (!isNonNegInt(g[k])) {
      errors.push(`graduation.${k} must be a non-negative integer, got ${g[k]}`);
      gradInts = false;
    }
  }
  if (gradInts) {
    const sum = g.issuerPct + g.platformPct + g.liquidityPct;
    if (sum !== 100) errors.push(`graduation percentages must sum to 100, got ${sum}`);
    const feePercentage = g.issuerPct + g.platformPct;
    if (feePercentage > MAX_MIGRATION_FEE_PERCENTAGE) {
      errors.push(
        `graduation issuerPct + platformPct (migration feePercentage) must be <= ${MAX_MIGRATION_FEE_PERCENTAGE}, got ${feePercentage}`,
      );
    }
    if (feePercentage > 0 && exactCreatorFeePercentage(g.issuerPct, feePercentage) === null) {
      errors.push(
        `graduation split ${g.issuerPct}/${g.platformPct} is not representable: creatorFeePercentage = ${
          (g.issuerPct / feePercentage) * 100
        } is not an integer`,
      );
    }
  }

  const t = cfg.dbcTradingFees;
  let tradeInts = true;
  for (const k of ["creatorPct", "partnerPct"] as const) {
    if (!isNonNegInt(t[k])) {
      errors.push(`dbcTradingFees.${k} must be a non-negative integer, got ${t[k]}`);
      tradeInts = false;
    }
  }
  if (tradeInts && t.creatorPct + t.partnerPct !== 100) {
    errors.push(`dbcTradingFees percentages must sum to 100, got ${t.creatorPct + t.partnerPct}`);
  }

  if (cfg.software) {
    for (const k of ["setupFee", "monthlyFee", "perDistributionFee"] as const) {
      const v = cfg.software[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        errors.push(`software.${k} must be a non-negative number, got ${v}`);
      }
    }
  }
  return errors;
}

/**
 * Maps config to Meteora DBC fee params (migrationFeeOption = 6, Customizable).
 * Throws if the config is invalid or the issuer/platform split cannot be expressed
 * exactly with an integer creatorFeePercentage.
 */
export function toDbcFeeParams(cfg: MonetizationConfig): DbcFeeParams {
  const errors = validateMonetizationConfig(cfg);
  if (errors.length) throw new Error(`Invalid MonetizationConfig: ${errors.join("; ")}`);

  const { issuerPct, platformPct } = cfg.graduation;
  const feePercentage = issuerPct + platformPct;
  let creatorFeePercentage = 0;
  if (feePercentage > 0) {
    const exact = exactCreatorFeePercentage(issuerPct, feePercentage);
    if (exact === null) throw new Error(`Non-integer creatorFeePercentage for ${issuerPct}/${platformPct}`);
    creatorFeePercentage = exact;
  }
  return {
    migrationFeeOption: MIGRATION_FEE_OPTION_CUSTOMIZABLE,
    migrationFee: { feePercentage, creatorFeePercentage },
    creatorTradingFeePercentage: cfg.dbcTradingFees.creatorPct,
  };
}

/**
 * PROJECTION ONLY. Estimates how the migration quote threshold (quote base units,
 * e.g. USDC with 6 decimals) is split at graduation, using the integer rounding Meteora
 * plausibly applies:
 *   fee       = floor(threshold * feePercentage / 100)
 *   issuer    = floor(fee * creatorFeePercentage / 100)
 *   platform  = fee - issuer
 *   liquidity = threshold - fee
 * Displayed amounts must be reconciled against on-chain pool config / migration state
 * (getPoolMigrationQuoteThreshold, fee fields) before being presented as actuals.
 */
export function projectEconomics(
  cfg: MonetizationConfig,
  migrationQuoteThreshold: bigint,
): ProjectedEconomics {
  if (migrationQuoteThreshold < 0n) throw new Error("migrationQuoteThreshold must be >= 0");
  const { migrationFee } = toDbcFeeParams(cfg);
  const fee = (migrationQuoteThreshold * BigInt(migrationFee.feePercentage)) / 100n;
  const issuer = (fee * BigInt(migrationFee.creatorFeePercentage)) / 100n;
  return { issuer, platform: fee - issuer, liquidity: migrationQuoteThreshold - fee };
}

function usd(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

/** User-visible fee line items. */
export function describeFees(cfg: MonetizationConfig): FeeDescription {
  const { issuerPct, platformPct, liquidityPct } = cfg.graduation;
  const { creatorPct, partnerPct } = cfg.dbcTradingFees;
  const lines: FeeLine[] = [{ label: "Startup", value: `${issuerPct}%` }];

  if (cfg.mode === "DEMO_PROTOCOL") {
    lines.push({ label: "Founder Stack", value: `${platformPct}%` });
    lines.push({ label: "Market liquidity", value: `${liquidityPct}%` });
    lines.push({
      label: "Trading fees",
      value: `Startup ${creatorPct}% / Founder Stack ${partnerPct}%`,
    });
    return { label: "Illustrative protocol economics", lines };
  }

  lines.push({ label: "Market liquidity", value: `${liquidityPct}%` });
  lines.push({
    label: "Trading fees",
    value: partnerPct === 0 ? `Startup ${creatorPct}%` : `Startup ${creatorPct}% / Founder Stack ${partnerPct}%`,
  });
  if (cfg.software) {
    lines.push({ label: "Setup fee", value: usd(cfg.software.setupFee) });
    lines.push({ label: "Monthly", value: `${usd(cfg.software.monthlyFee)}/mo` });
    lines.push({ label: "Per distribution", value: usd(cfg.software.perDistributionFee) });
  }
  return { lines };
}
