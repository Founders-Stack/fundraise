// lib/cluster (SPEC sections 3 and 14): one config per cluster, selected by SOLANA_CLUSTER=devnet|mainnet-beta.
// Nothing else branches on the cluster: RPC defaults, quote mint, program IDs, explorer links and all
// cluster-specific copy (banner, custody label, header badge) come from here.

export type ClusterName = "devnet" | "mainnet-beta";

export interface ClusterCopy {
  /** Short header badge text. */
  badge: string;
  /** Site-wide banner / footer line. */
  banner: string;
  /** Blockquote at the top of the agreement document (markdown). */
  agreementBanner: string;
  /** Custody label shown in the UI and returned by the API. */
  custody: string;
  /** Network label, e.g. on the home page eyebrow. */
  networkLabel: string;
}

export interface ClusterConfig {
  name: ClusterName;
  /** Default RPC endpoint (RPC_URL env overrides). */
  defaultRpcUrl: string;
  /** Default quote mint (QUOTE_MINT env overrides). null = must be configured (devnet mock USDC). */
  defaultQuoteMint: string | null;
  programs: {
    /** fs_allowlist transfer-hook program (FS_ALLOWLIST_PROGRAM_ID env overrides). null = must be configured. */
    fsAllowlist: string | null;
    /** Meteora DBC: one ID for all clusters (SPEC V11). */
    dbc: string;
  };
  copy: ClusterCopy;
}

const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";

export const CLUSTERS: Record<ClusterName, ClusterConfig> = {
  devnet: {
    name: "devnet",
    defaultRpcUrl: "https://api.devnet.solana.com",
    defaultQuoteMint: null,
    programs: { fsAllowlist: "3gfXWxgHN8tjJzxXGeAEiZWaixDe7ZMxXQGnpvHkQZu7", dbc: DBC_PROGRAM_ID },
    copy: {
      badge: "Devnet",
      banner: "DEMO — devnet prototype, not an offer of securities",
      agreementBanner:
        "**DEMO — devnet prototype, not an offer of securities.** This document is a hackathon prototype template. It has no legal effect and nothing on devnet has monetary value.",
      custody: "Demo custody (devnet)",
      networkLabel: "Solana devnet",
    },
  },
  "mainnet-beta": {
    name: "mainnet-beta",
    defaultRpcUrl: "https://api.mainnet-beta.solana.com",
    defaultQuoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    programs: { fsAllowlist: null, dbc: DBC_PROGRAM_ID },
    copy: {
      badge: "Mainnet pilot",
      banner:
        "Closed mainnet pilot. Not an offer of securities. Participants are the team and invited testers.",
      agreementBanner:
        "**Closed mainnet pilot. Not an offer of securities.** Participants are the team and invited testers. This document is a pilot template and has no legal effect.",
      custody: "Team custody (closed pilot)",
      networkLabel: "Solana mainnet pilot",
    },
  },
};

export function parseClusterName(v: string | undefined | null): ClusterName {
  if (!v || v === "devnet") return "devnet";
  if (v === "mainnet-beta" || v === "mainnet") return "mainnet-beta";
  throw new Error(`SOLANA_CLUSTER must be devnet or mainnet-beta, got "${v}"`);
}

/** The active cluster. Server: SOLANA_CLUSTER. Browser bundles: NEXT_PUBLIC_SOLANA_CLUSTER (inlined at build). */
export function currentCluster(): ClusterConfig {
  return CLUSTERS[parseClusterName(process.env.SOLANA_CLUSTER || process.env.NEXT_PUBLIC_SOLANA_CLUSTER)];
}

function explorerSuffix(c: ClusterConfig): string {
  return c.name === "mainnet-beta" ? "" : `?cluster=${c.name}`;
}

export function explorerTxUrl(sig: string, c: ClusterConfig = currentCluster()): string {
  return `https://explorer.solana.com/tx/${sig}${explorerSuffix(c)}`;
}

export function explorerAddressUrl(addr: string, c: ClusterConfig = currentCluster()): string {
  return `https://explorer.solana.com/address/${addr}${explorerSuffix(c)}`;
}

/** RPC URL: RPC_URL env, else the cluster default. */
export function clusterRpcUrl(c: ClusterConfig = currentCluster()): string {
  return process.env.RPC_URL || c.defaultRpcUrl;
}

/** fs_allowlist program ID: FS_ALLOWLIST_PROGRAM_ID env, else the cluster default. */
export function clusterAllowlistProgramId(c: ClusterConfig = currentCluster()): string {
  const id = process.env.FS_ALLOWLIST_PROGRAM_ID || c.programs.fsAllowlist;
  if (!id) throw new Error(`FS_ALLOWLIST_PROGRAM_ID is not set (required on ${c.name})`);
  return id;
}

/** Quote mint: QUOTE_MINT env, else the cluster default (null on devnet: mock USDC must be configured). */
export function clusterQuoteMint(c: ClusterConfig = currentCluster()): string | null {
  return process.env.QUOTE_MINT || c.defaultQuoteMint;
}
