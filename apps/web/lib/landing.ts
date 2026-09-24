// Landing page (SPEC section 9.1): every link and every sentence on `/` above the markets list.
//
// PASTE HERE after the mainnet run (A29) and the video (U13). Empty strings / empty arrays render
// as "coming soon" or are hidden, so the page ships fine before they exist.
// Explorer links are built with lib/cluster (no ?cluster= suffix on mainnet).

export const LANDING_LINKS = {
  /** The ≤ 3-min demo video. YouTube, Loom or a direct .mp4/.webm URL. Empty = "coming soon". */
  videoUrl: "",
  repoUrl: "https://github.com/Founders-Stack/fundraise",
  /** Hackathon page. Empty = hidden. */
  hackathonUrl: "",
  founderStackUrl: "https://f-stack.ai",
};

/**
 * Pinned mainnet pilot proof. Each field overrides what the page would otherwise read live from the
 * database; leave empty to fall back to live data (or "coming soon" when there is none).
 */
export const LANDING_PILOT = {
  /** Issuance id of the pilot market, for the "See the live mainnet pilot" CTA (/market/<id>). */
  marketId: "",
  /** fs_allowlist program ID on mainnet. Empty = lib/cluster (FS_ALLOWLIST_PROGRAM_ID). */
  allowlistProgramId: "",
  /** DBC pool address. */
  poolAddress: "",
  /** Token mint (ACME-CF). */
  mintAddress: "",
  /** Transaction signatures to show, e.g. launch, Carol's rejected buy, Q3 and Q4 payouts. */
  signatures: [] as { label: string; sig: string }[],
};

// ---------------------------------------------------------------- copy (linted by tests/landing.test.ts)

export const LANDING_COPY = {
  hero: {
    title: "Raise against your cash flow,",
    titleAccent: "from your coding agent",
    subline:
      "Equity-free capital: no shares, no cap-table change, no board seat. Invited investors are paid in USDC every period, on Solana.",
    ctaInstall: "Install for Claude Code / Codex",
    ctaPilot: "See the live mainnet pilot",
    ctaPilotSoon: "Mainnet pilot link coming soon",
    ctaDevnet: "See a live market",
  },
  how: {
    eyebrow: "How it works",
    title: "Three steps, one loop",
    steps: [
      {
        title: "Launch from the agent",
        body: "Type /fstack:fundraise in Claude Code or Codex. The skill previews terms, price and the agreement hash, and waits for your explicit yes.",
      },
      {
        title: "Investors onboard and buy",
        body: "Invited investors accept the agreement with one signature and buy on a Meteora DBC curve priced from the target yield.",
      },
      {
        title: "Holders are paid each period",
        body: "Report the period's cash flow from your finance export. Current holders at the record date receive USDC, pro rata.",
      },
    ],
  },
  sides: {
    founders: {
      title: "For founders",
      does: "Launch, report and distribute from your coding agent. Capital without a priced round.",
      givesUp:
        "A fixed share of each period's Distributable Cash Flow, paid in USDC for as long as the agreement runs. That is a real cost of capital, and the implied rate is the target yield.",
      keeps: "Ownership, the cap table, voting, board seats and exit proceeds stay untouched.",
    },
    investors: {
      title: "For investors",
      does: "Onboard with one signature, buy on the curve, sell back into the pool any time.",
      givesUp:
        "Holders get no shares and no say. Payouts depend on issuer-reported cash flow, so yield is informational and can go to zero.",
      keeps: "A contractual claim on the rights pool, enforced by the agreement, with transfers limited to eligible wallets.",
    },
  },
  proof: {
    eyebrow: "Live proof",
    title: "Check it on-chain",
    body: "Addresses and signatures link to Solana Explorer. Nothing here is a screenshot.",
    cluster: "Cluster",
    program: "fs_allowlist program",
    dbc: "Meteora DBC program",
    pool: "DBC pool",
    mint: "Token mint",
    lastDistribution: "Last distribution",
    video: "Demo video",
    soon: "Coming soon",
  },
  why: {
    eyebrow: "Why Solana + Meteora",
    items: [
      {
        title: "Token-2022 transfer hook",
        body: "Eligibility is enforced at the token level by a Token-2022 transfer hook. A buy from a wallet that never onboarded fails on-chain.",
      },
      {
        title: "A curve priced from yield",
        body: "The DBC starting market cap is the annual rights pool divided by the target yield, so the first price already reflects the cash flow.",
      },
      {
        title: "Locked issuer LP",
        body: "Meteora DBC provides distribution, price discovery and liquidity. The issuer's LP share locks at graduation.",
      },
    ],
  },
  honest: {
    title: "Honest framing",
    // The first line on the page is the cluster banner (lib/cluster), so devnet never claims mainnet.
    lines: [
      "Distributions are based on issuer-reported Distributable Cash Flow.",
      "Yield figures are informational, not a promise of future payouts.",
      "Token market cap is not company valuation.",
      "Protocol economics shown are illustrative. The production model is software fees (one config switch).",
    ],
  },
  footer: {
    repo: "Source on GitHub",
    video: "Demo video",
    hackathon: "Hackathon submission",
  },
} as const;

/** Every string in the landing copy, flattened (for lintCopy). */
export function landingStrings(v: unknown = LANDING_COPY): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap((x) => landingStrings(x));
  if (v && typeof v === "object") return Object.values(v).flatMap((x) => landingStrings(x));
  return [];
}

/** How to embed a video URL: YouTube / Loom become iframes, anything else a <video>. null = no video yet. */
export function videoEmbed(url: string): { kind: "iframe" | "video"; src: string } | null {
  const u = url.trim();
  if (!u) return null;
  const yt = u.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
  if (yt) return { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${yt[1]}` };
  const loom = u.match(/loom\.com\/(?:share|embed)\/([\w-]+)/);
  if (loom) return { kind: "iframe", src: `https://www.loom.com/embed/${loom[1]}` };
  return { kind: "video", src: u };
}
