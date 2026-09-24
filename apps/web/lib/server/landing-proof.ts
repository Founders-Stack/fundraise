// "Live proof" block of the landing page (SPEC 9.1 section 4). Pinned values from lib/landing win;
// otherwise the newest live issuance and its last executed distribution are used. Explorer links
// come from lib/cluster and are omitted for the in-memory fake chain.
import { prisma } from "@/lib/db";
import {
  CLUSTERS,
  clusterAllowlistProgramId,
  currentCluster,
  explorerAddressUrl,
  explorerTxUrl,
} from "@/lib/cluster";
import { LANDING_COPY, LANDING_LINKS, LANDING_PILOT } from "@/lib/landing";
const P = LANDING_COPY.proof;
import type { IssuanceRecord } from "./issuance-record";

export interface ProofLink {
  label: string;
  value: string;
  href: string | null;
}

export interface LandingProof {
  clusterName: string;
  isMainnet: boolean;
  banner: string;
  /** Market page for the pilot CTA; null = no market yet. */
  marketHref: string | null;
  addresses: ProofLink[];
  lastDistribution: { period: string; links: ProofLink[] } | null;
  videoUrl: string;
}

function short(s: string) {
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s;
}

export async function loadProof(rows: { i: IssuanceRecord }[]): Promise<LandingProof> {
  const cluster = currentCluster();
  const live = [...rows].reverse().find(({ i }) => i.market)?.i ?? null; // newest with a market
  const onChain = !!live?.market && live.market.chainMode !== "fake";
  const addr = (label: string, v: string | null | undefined, pinned: boolean): ProofLink | null =>
    v ? { label, value: short(v), href: pinned || onChain ? explorerAddressUrl(v, cluster) : null } : null;

  let programId = LANDING_PILOT.allowlistProgramId;
  if (!programId) {
    try {
      programId = clusterAllowlistProgramId(cluster);
    } catch {
      programId = "";
    }
  }

  const addresses = [
    addr(P.program, programId, true),
    addr(P.dbc, CLUSTERS[cluster.name].programs.dbc, true),
    addr(P.pool, LANDING_PILOT.poolAddress || live?.market?.dbcPool, !!LANDING_PILOT.poolAddress),
    addr(P.mint, LANDING_PILOT.mintAddress || live?.market?.baseMint, !!LANDING_PILOT.mintAddress),
  ].filter((x): x is ProofLink => x !== null);

  let lastDistribution: LandingProof["lastDistribution"] = null;
  if (LANDING_PILOT.signatures.length > 0) {
    lastDistribution = {
      period: "",
      links: LANDING_PILOT.signatures.map(({ label, sig }) => ({ label, value: short(sig), href: explorerTxUrl(sig, cluster) })),
    };
  } else if (live && onChain) {
    try {
      const d = await prisma.distribution.findFirst({
        where: { issuanceId: live.id, status: "EXECUTED" },
        orderBy: { executedAt: "desc" },
        include: { allocations: { where: { txSignature: { not: null } }, take: 3 } },
      });
      if (d) {
        lastDistribution = {
          period: d.periodLabel,
          links: d.allocations.map((a) => ({
            label: `Payout ${short(a.wallet)}`,
            value: short(a.txSignature!),
            href: explorerTxUrl(a.txSignature!, cluster),
          })),
        };
      }
    } catch {
      lastDistribution = null;
    }
  }

  const marketId = LANDING_PILOT.marketId || live?.id || "";
  return {
    clusterName: cluster.name,
    isMainnet: cluster.name === "mainnet-beta",
    banner: cluster.copy.banner,
    marketHref: marketId ? `/market/${marketId}` : null,
    addresses,
    lastDistribution,
    videoUrl: LANDING_LINKS.videoUrl,
  };
}
