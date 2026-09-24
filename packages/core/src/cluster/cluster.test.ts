import { afterEach, describe, expect, it } from "vitest";
import {
  CLUSTERS,
  clusterAllowlistProgramId,
  clusterQuoteMint,
  clusterRpcUrl,
  currentCluster,
  explorerAddressUrl,
  explorerTxUrl,
  parseClusterName,
} from "./index";
import { lintCopy } from "../rights/copy";

const KEYS = ["SOLANA_CLUSTER", "NEXT_PUBLIC_SOLANA_CLUSTER", "RPC_URL", "QUOTE_MINT", "FS_ALLOWLIST_PROGRAM_ID"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function clearEnv() {
  for (const k of KEYS) delete process.env[k];
}

describe("lib/cluster", () => {
  it("defaults to devnet and parses mainnet-beta", () => {
    clearEnv();
    expect(currentCluster().name).toBe("devnet");
    process.env.SOLANA_CLUSTER = "mainnet-beta";
    expect(currentCluster().name).toBe("mainnet-beta");
    expect(parseClusterName("mainnet")).toBe("mainnet-beta");
    expect(() => parseClusterName("testnet")).toThrow(/SOLANA_CLUSTER/);
  });

  it("falls back to NEXT_PUBLIC_SOLANA_CLUSTER (browser bundles)", () => {
    clearEnv();
    process.env.NEXT_PUBLIC_SOLANA_CLUSTER = "mainnet-beta";
    expect(currentCluster().name).toBe("mainnet-beta");
  });

  it("mainnet copy uses the SPEC section 14 wording, devnet copy the devnet wording", () => {
    const m = CLUSTERS["mainnet-beta"].copy;
    expect(m.banner).toBe(
      "Closed mainnet pilot. Not an offer of securities. Participants are the team and invited testers.",
    );
    expect(m.agreementBanner).toContain("Closed mainnet pilot. Not an offer of securities.");
    expect(m.custody).toBe("Team custody (closed pilot)");
    const d = CLUSTERS.devnet.copy;
    expect(d.banner).toBe("DEMO — devnet prototype, not an offer of securities");
    expect(d.custody).toBe("Demo custody (devnet)");
  });

  it("no devnet string ships on mainnet, no mainnet claim on devnet, all copy lints clean", () => {
    for (const s of Object.values(CLUSTERS["mainnet-beta"].copy)) {
      expect(s).not.toMatch(/devnet/i);
      expect(lintCopy(s)).toEqual([]);
    }
    for (const s of Object.values(CLUSTERS.devnet.copy)) {
      expect(s).not.toMatch(/mainnet/i);
      expect(lintCopy(s)).toEqual([]);
    }
  });

  it("explorer links carry ?cluster= only off mainnet", () => {
    expect(explorerTxUrl("SIG", CLUSTERS.devnet)).toBe("https://explorer.solana.com/tx/SIG?cluster=devnet");
    expect(explorerTxUrl("SIG", CLUSTERS["mainnet-beta"])).toBe("https://explorer.solana.com/tx/SIG");
    expect(explorerAddressUrl("A", CLUSTERS["mainnet-beta"])).toBe("https://explorer.solana.com/address/A");
  });

  it("RPC, quote mint and program IDs: env overrides, else cluster defaults", () => {
    clearEnv();
    expect(clusterRpcUrl(CLUSTERS.devnet)).toBe("https://api.devnet.solana.com");
    expect(clusterQuoteMint(CLUSTERS.devnet)).toBeNull();
    expect(clusterQuoteMint(CLUSTERS["mainnet-beta"])).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(clusterAllowlistProgramId(CLUSTERS.devnet)).toBe("3gfXWxgHN8tjJzxXGeAEiZWaixDe7ZMxXQGnpvHkQZu7");
    expect(() => clusterAllowlistProgramId(CLUSTERS["mainnet-beta"])).toThrow(/FS_ALLOWLIST_PROGRAM_ID/);
    process.env.RPC_URL = "https://rpc.example";
    process.env.FS_ALLOWLIST_PROGRAM_ID = "Prog111";
    expect(clusterRpcUrl(CLUSTERS["mainnet-beta"])).toBe("https://rpc.example");
    expect(clusterAllowlistProgramId(CLUSTERS["mainnet-beta"])).toBe("Prog111");
    expect(CLUSTERS.devnet.programs.dbc).toBe(CLUSTERS["mainnet-beta"].programs.dbc);
  });
});
