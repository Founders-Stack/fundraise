// In-process fake chain for local dev and API tests (CHAIN_MODE=fake). Deterministic, no network.
// Pricing is a linear toy curve, NOT Meteora's — only the shapes of the ports matter here.
// State lives in a JSON file for the dev server (apps/web/.fake-chain.json, gitignored, survives
// reloads) or in memory for tests (`createFakeChain({ file: null })`).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ChainPorts, CreatePoolInput, MarketState } from "./ports";

type Pool = {
  dbcPool: string;
  baseMint: string;
  dbcConfig: string;
  authority: string;
  tokenSupply: string; // base units
  startingMarketCap: string;
  graduationMarketCap: string;
  quoteReserve: string;
  sold: string; // base units sold out of the curve
};
type State = {
  pools: Record<string, Pool>;
  allow: Record<string, string[]>; // mint -> wallets
  balances: Record<string, Record<string, string>>; // mint -> owner -> base units
  issuerUsdc: string;
  usdc: Record<string, string>;
  slot: number;
};

const ISSUER = "FakeIssuer1111111111111111111111111111111111";
const QUOTE_MINT = "FakeUsdc11111111111111111111111111111111111";

const initialState = (): State => ({
  pools: {},
  allow: {},
  balances: {},
  issuerUsdc: (10_000_000n * 1_000_000n).toString(),
  usdc: {},
  slot: 1,
});

/** Where the fake keeps its state. Every read is a fresh copy, like reading chain state. */
function fileStore(file: string) {
  return {
    load: (): State => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : initialState()),
    save: (s: State) => writeFileSync(file, JSON.stringify(s, null, 2)),
  };
}
function memoryStore() {
  let json = JSON.stringify(initialState());
  return {
    load: (): State => JSON.parse(json),
    save: (s: State) => void (json = JSON.stringify(s)),
  };
}

const addr = (prefix: string) => (prefix + randomBytes(24).toString("hex")).slice(0, 44);
const sig = () => "fake_" + randomBytes(32).toString("hex");

function priceOf(p: Pool): bigint {
  // linear from start price to graduation price as supply sells (toy model)
  const supply = BigInt(p.tokenSupply);
  const start = BigInt(p.startingMarketCap) * 1_000_000n / (supply / 1_000_000n) / 1_000_000n;
  const end = BigInt(p.graduationMarketCap) * 1_000_000n / (supply / 1_000_000n) / 1_000_000n;
  return start + ((end - start) * BigInt(p.sold)) / supply;
}

function state(p: Pool): MarketState {
  const threshold = BigInt(p.graduationMarketCap) / 3n; // toy threshold
  const reserve = BigInt(p.quoteReserve);
  return {
    dbcPool: p.dbcPool,
    baseMint: p.baseMint,
    quoteMint: QUOTE_MINT,
    price: priceOf(p),
    quoteReserve: reserve,
    migrationQuoteThreshold: threshold,
    progressBps: Number(threshold === 0n ? 0n : (reserve * 10_000n) / threshold),
    isMigrated: false,
    accruedFees: { creator: reserve / 200n, partner: reserve / 200n },
  };
}

export interface FakeChainControl {
  /** Simulates a confirmed swap by `owner` (the investor signing the tx the market port builds). */
  swap(dbcPool: string, owner: string, side: "BUY" | "SELL", tokens: bigint): { signature: string };
  setIssuerUsdc(baseUnits: bigint): void;
  issuerUsdc(): bigint;
  usdcBalance(wallet: string): bigint;
}

export interface FakeChain {
  ports: ChainPorts;
  control: FakeChainControl;
}

/** `file: null` keeps state in memory (tests); default is `<cwd>/.fake-chain.json` (dev server + scripts). */
export function createFakeChain(opts: { file?: string | null } = {}): FakeChain {
  const store = opts.file === null ? memoryStore() : fileStore(opts.file ?? join(process.cwd(), ".fake-chain.json"));
  const load = store.load;
  const save = (s: State) => {
    s.slot += 1;
    store.save(s);
  };

  const control: FakeChainControl = {
    swap(dbcPool, owner, side, tokens) {
      const s = load();
      const p = s.pools[dbcPool];
      if (!p) throw new Error("unknown pool");
      if (side === "BUY" && !(s.allow[p.baseMint] ?? []).includes(owner)) throw new Error("NotEligible");
      const bal = (s.balances[p.baseMint] ??= {});
      const price = priceOf(p);
      const cost = (tokens * price) / 1_000_000n;
      if (side === "BUY") {
        bal[owner] = (BigInt(bal[owner] ?? "0") + tokens).toString();
        bal[p.authority] = (BigInt(bal[p.authority]) - tokens).toString();
        p.sold = (BigInt(p.sold) + tokens).toString();
        p.quoteReserve = (BigInt(p.quoteReserve) + cost).toString();
      } else {
        if (BigInt(bal[owner] ?? "0") < tokens) throw new Error("insufficient balance");
        bal[owner] = (BigInt(bal[owner]) - tokens).toString();
        bal[p.authority] = (BigInt(bal[p.authority]) + tokens).toString();
        p.sold = (BigInt(p.sold) - tokens).toString();
        p.quoteReserve = (BigInt(p.quoteReserve) - cost).toString();
      }
      save(s);
      return { signature: sig() };
    },
    setIssuerUsdc(baseUnits) {
      const s = load();
      s.issuerUsdc = baseUnits.toString();
      save(s);
    },
    issuerUsdc: () => BigInt(load().issuerUsdc),
    usdcBalance: (wallet) => BigInt(load().usdc[wallet] ?? "0"),
  };

  const ports: ChainPorts = {
    mode: "fake",
    market: {
      async createIssuancePool(input: CreatePoolInput) {
        const s = load();
        const baseMint = addr("Mint");
        const pool: Pool = {
          dbcPool: addr("Pool"),
          baseMint,
          dbcConfig: addr("Conf"),
          authority: addr("Auth"),
          tokenSupply: (input.tokenSupply * 10n ** BigInt(input.tokenDecimals)).toString(),
          startingMarketCap: input.startingMarketCap.toString(),
          graduationMarketCap: input.graduationMarketCap.toString(),
          quoteReserve: "0",
          sold: "0",
        };
        s.pools[pool.dbcPool] = pool;
        s.allow[baseMint] = [pool.authority];
        s.balances[baseMint] = { [pool.authority]: pool.tokenSupply };
        save(s);
        return {
          baseMint,
          dbcConfig: pool.dbcConfig,
          dbcPool: pool.dbcPool,
          poolOwners: [pool.authority],
          signatures: [sig(), sig()],
          dbcParams: { fake: true, ...input, tokenSupply: input.tokenSupply.toString() },
        };
      },
      async getMarketState(dbcPool) {
        const p = load().pools[dbcPool];
        if (!p) throw new Error(`unknown pool ${dbcPool}`);
        return state(p);
      },
      async quote(dbcPool, side, amountIn) {
        const p = load().pools[dbcPool];
        if (!p) throw new Error(`unknown pool ${dbcPool}`);
        const price = priceOf(p);
        const fee = amountIn / 100n;
        const net = amountIn - fee;
        const amountOut = side === "BUY" ? (net * 1_000_000n) / price : (net * price) / 1_000_000n;
        return { side, amountIn, amountOut, price, priceImpactBps: 50, poolFee: fee, protocolFee: fee / 5n, networkFeeLamports: 5000n };
      },
      async buildSwapTx() {
        return { tx: Buffer.from("fake-unsigned-tx").toString("base64") };
      },
    },
    registry: {
      async allowWallet(mint, wallet) {
        const s = load();
        const list = (s.allow[mint] ??= []);
        if (!list.includes(wallet)) list.push(wallet);
        save(s);
        return { signature: sig() };
      },
      async getBalances(mint) {
        const s = load();
        const balances = Object.entries(s.balances[mint] ?? {})
          .filter(([, v]) => BigInt(v) > 0n)
          .map(([owner, v]) => ({ owner, tokenAccount: `ata:${owner.slice(0, 8)}`, amount: BigInt(v) }));
        return { slot: s.slot, balances };
      },
    },
    payout: {
      quoteMint: () => QUOTE_MINT,
      issuerAddress: () => ISSUER,
      async getIssuerQuoteBalance() {
        return BigInt(load().issuerUsdc);
      },
      async transferBatch(rows) {
        const s = load();
        const total = rows.reduce((a, r) => a + r.amount, 0n);
        if (BigInt(s.issuerUsdc) < total) throw new Error("insufficient issuer USDC");
        s.issuerUsdc = (BigInt(s.issuerUsdc) - total).toString();
        for (const r of rows) s.usdc[r.wallet] = (BigInt(s.usdc[r.wallet] ?? "0") + r.amount).toString();
        save(s);
        return { signature: sig() };
      },
    },
  };
  return { ports, control };
}
