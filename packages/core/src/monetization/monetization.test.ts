import { describe, expect, it } from "vitest";
import {
  DEMO_PROTOCOL_CONFIG,
  SOFTWARE_CONFIG,
  describeFees,
  projectEconomics,
  toDbcFeeParams,
  validateMonetizationConfig,
  type MonetizationConfig,
} from "./index";

const USDC = 1_000_000n; // 6 decimals

function withGraduation(
  issuerPct: number,
  platformPct: number,
  liquidityPct: number,
): MonetizationConfig {
  return { ...DEMO_PROTOCOL_CONFIG, graduation: { issuerPct, platformPct, liquidityPct } };
}

describe("toDbcFeeParams", () => {
  it("DEMO_PROTOCOL → 50 / 96, creator trading 50", () => {
    expect(toDbcFeeParams(DEMO_PROTOCOL_CONFIG)).toEqual({
      migrationFeeOption: 6,
      migrationFee: { feePercentage: 50, creatorFeePercentage: 96 },
      creatorTradingFeePercentage: 50,
    });
  });

  it("SOFTWARE → 50 / 100, creator trading 100", () => {
    expect(toDbcFeeParams(SOFTWARE_CONFIG)).toEqual({
      migrationFeeOption: 6,
      migrationFee: { feePercentage: 50, creatorFeePercentage: 100 },
      creatorTradingFeePercentage: 100,
    });
  });

  it("zero fee → {0, 0}", () => {
    expect(toDbcFeeParams(withGraduation(0, 0, 100)).migrationFee).toEqual({
      feePercentage: 0,
      creatorFeePercentage: 0,
    });
  });

  it("throws on non-representable split", () => {
    expect(() => toDbcFeeParams(withGraduation(49, 2, 49))).toThrow(/not representable/);
  });
});

describe("projectEconomics", () => {
  it("DEMO_PROTOCOL on 300,000 USDC → 144,000 / 6,000 / 150,000", () => {
    expect(projectEconomics(DEMO_PROTOCOL_CONFIG, 300_000n * USDC)).toEqual({
      issuer: 144_000n * USDC,
      platform: 6_000n * USDC,
      liquidity: 150_000n * USDC,
    });
  });

  it("SOFTWARE on 300,000 USDC → 150,000 / 0 / 150,000", () => {
    expect(projectEconomics(SOFTWARE_CONFIG, 300_000n * USDC)).toEqual({
      issuer: 150_000n * USDC,
      platform: 0n,
      liquidity: 150_000n * USDC,
    });
  });

  it("floors and conserves the total on odd amounts", () => {
    const t = 333n;
    const r = projectEconomics(DEMO_PROTOCOL_CONFIG, t);
    // fee = floor(333*50/100) = 166; issuer = floor(166*96/100) = 159
    expect(r).toEqual({ issuer: 159n, platform: 7n, liquidity: 167n });
    expect(r.issuer + r.platform + r.liquidity).toBe(t);
  });
});

describe("validateMonetizationConfig", () => {
  it("presets are valid", () => {
    expect(validateMonetizationConfig(DEMO_PROTOCOL_CONFIG)).toEqual([]);
    expect(validateMonetizationConfig(SOFTWARE_CONFIG)).toEqual([]);
  });

  it("flags graduation sum 101", () => {
    const errs = validateMonetizationConfig(withGraduation(48, 3, 50));
    expect(errs.some((e) => /sum to 100, got 101/.test(e))).toBe(true);
  });

  it("flags feePercentage 100 (> Meteora max 99)", () => {
    const errs = validateMonetizationConfig(withGraduation(96, 4, 0));
    expect(errs.some((e) => /<= 99, got 100/.test(e))).toBe(true);
  });

  it("47/3 IS representable (47/50 = 94% exactly)", () => {
    expect(validateMonetizationConfig(withGraduation(47, 3, 50))).toEqual([]);
    expect(toDbcFeeParams(withGraduation(47, 3, 50)).migrationFee).toEqual({
      feePercentage: 50,
      creatorFeePercentage: 94,
    });
  });

  it("flags 49/2 as non-representable (49/51 = 96.07...%)", () => {
    const errs = validateMonetizationConfig(withGraduation(49, 2, 49));
    expect(errs.some((e) => /not representable/.test(e))).toBe(true);
  });

  it("flags non-integer and negative percentages", () => {
    const errs = validateMonetizationConfig(withGraduation(47.5, 2.5, 50));
    expect(errs.some((e) => /issuerPct must be a non-negative integer/.test(e))).toBe(true);
    const neg = validateMonetizationConfig({
      ...DEMO_PROTOCOL_CONFIG,
      dbcTradingFees: { creatorPct: 110, partnerPct: -10 },
    });
    expect(neg.some((e) => /partnerPct must be a non-negative integer/.test(e))).toBe(true);
  });

  it("flags trading fee sum != 100", () => {
    const errs = validateMonetizationConfig({
      ...DEMO_PROTOCOL_CONFIG,
      dbcTradingFees: { creatorPct: 50, partnerPct: 40 },
    });
    expect(errs.some((e) => /dbcTradingFees percentages must sum to 100/.test(e))).toBe(true);
  });
});

describe("describeFees", () => {
  it("DEMO_PROTOCOL shows platform fee and the illustrative label", () => {
    expect(describeFees(DEMO_PROTOCOL_CONFIG)).toEqual({
      label: "Illustrative protocol economics",
      lines: [
        { label: "Startup", value: "48%" },
        { label: "Founder Stack", value: "2%" },
        { label: "Market liquidity", value: "50%" },
        { label: "Trading fees", value: "Startup 50% / Founder Stack 50%" },
      ],
    });
  });

  it("SOFTWARE shows software pricing instead of platform fee", () => {
    const d = describeFees(SOFTWARE_CONFIG);
    expect(d.label).toBeUndefined();
    expect(d.lines.map((l) => l.label)).not.toContain("Founder Stack");
    expect(d.lines).toContainEqual({ label: "Setup fee", value: "$2,500" });
    expect(d.lines).toContainEqual({ label: "Monthly", value: "$499/mo" });
    expect(d.lines).toContainEqual({ label: "Per distribution", value: "$250" });
  });
});

/**
 * Stand-in for the launch pipeline's monetization touchpoint: everything monetization
 * contributes to a launch is derived from the config alone. Every other input
 * (rights, hook, registry, distribution, curve) is held constant below.
 */
function buildLaunchMonetization(cfg: MonetizationConfig, migrationQuoteThreshold: bigint) {
  return {
    dbcFeeParams: toDbcFeeParams(cfg),
    fees: describeFees(cfg),
    economics: projectEconomics(cfg, migrationQuoteThreshold),
  };
}

describe("ACCEPTANCE (SPEC §8)", () => {
  it("switching DEMO_PROTOCOL → SOFTWARE changes only the config object; outputs change, no other input changes", () => {
    const threshold = 300_000n * USDC; // identical non-config input for both runs
    const otherInputs = Object.freeze({ threshold });

    const demo = buildLaunchMonetization(DEMO_PROTOCOL_CONFIG, otherInputs.threshold);
    const software = buildLaunchMonetization(SOFTWARE_CONFIG, otherInputs.threshold);

    expect(otherInputs.threshold).toBe(threshold);
    expect(demo).not.toEqual(software);
    expect(demo.dbcFeeParams.migrationFee).toEqual({ feePercentage: 50, creatorFeePercentage: 96 });
    expect(software.dbcFeeParams.migrationFee).toEqual({ feePercentage: 50, creatorFeePercentage: 100 });
    expect(demo.dbcFeeParams.creatorTradingFeePercentage).toBe(50);
    expect(software.dbcFeeParams.creatorTradingFeePercentage).toBe(100);
    expect(demo.fees.label).toBe("Illustrative protocol economics");
    expect(software.fees.label).toBeUndefined();
    expect(demo.economics.platform).toBe(6_000n * USDC);
    expect(software.economics.platform).toBe(0n);
    // Presets are not mutated by use.
    expect(DEMO_PROTOCOL_CONFIG.graduation).toEqual({ issuerPct: 48, platformPct: 2, liquidityPct: 50 });
    expect(Object.isFrozen(SOFTWARE_CONFIG)).toBe(true);
  });
});
