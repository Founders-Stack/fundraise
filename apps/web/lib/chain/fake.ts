// In-process fake chain for local dev and API tests (CHAIN_MODE=fake). Deterministic, no network.
// Pricing is a linear toy curve, NOT Meteora's — only the shapes of the ports matter here.
// State lives in a JSON file for the dev server (apps/web/.fake-chain.json, gitignored, survives
// reloads) or in memory for tests (`createFakeChain({ file: null })`).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ChainPorts, CreatePoolInput, MarketState, UnsignedTx, WalletPool } from "./ports";

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
  /** signature -> SPL memo carried by that payout transaction */
  memos?: Record<string, string>;
};

const ISSUER = "FakeIssuer1111111111111111111111111111111111";
const ESCROW = "FakeEscrow111111111111111111111111111111111";
const QUOTE_MINT = "FakeUsdc11111111111111111111111111111111111";
/** Investor wallets aren't funded on the fake chain; the pre-flight sees this notional balance. */
const FAKE_WALLET_LAMPORTS = 1_000_000_000n; // 1 SOL
const FAKE_WALLET_USDC = 1_000_000n * 1_000_000n; // $1M

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
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** Same limit the real adapter enforces for the SPL Memo instruction. */
function assertMemo(memo: string) {
  if (Buffer.byteLength(memo, "utf8") > 200) throw new Error("memo longer than 200 bytes");
}
const sig = () => "fake_" + randomBytes(32).toString("hex");

type FakeWalletTx =
  | {
      kind: "create_pool";
      nonce: string;
      creator: string;
      pool: { dbcPool: string; baseMint: string; dbcConfig: string; authority: string };
      tokenSupply: string;
      startingMarketCap: string;
      graduationMarketCap: string;
    }
  | { kind: "transfer"; nonce: string; from: string; rows: { wallet: string; amount: string }[] };

const fakeTx = (body: FakeWalletTx, label: string): UnsignedTx => ({
  tx: Buffer.from(JSON.stringify(body)).toString("base64"),
  label,
  lastValidBlockHeight: 0,
});

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
  /** The SPL memo a payout transaction carried, if any. */
  memoOf(signature: string): string | undefined;
}

export interface FakeChain {
  ports: ChainPorts;
  control: FakeChainControl;
}

/** `file: null` keeps state in memory (tests); default is `<cwd>/.fake-chain.json` (dev server + scripts). */
export function createFakeChain(opts: { file?: string | null } = {}): FakeChain {
  // Serverless filesystems are read-only: never write .fake-chain.json on Vercel.
  const store = opts.file === null || (opts.file === undefined && process.env.VERCEL) ? memoryStore(): fileStore(opts.file ?? join(process.cwd(), ".fake-chain.json"));
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
    memoOf: (signature) => load().memos?.[signature],
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
      async quote(dbcPool, side, amount, mode = "EXACT_IN") {
        const p = load().pools[dbcPool];
        if (!p) throw new Error(`unknown pool ${dbcPool}`);
        const price = priceOf(p);
        let amountIn: bigint;
        let amountOut: bigint;
        if (mode === "EXACT_OUT") {
          // Invert the toy pricing: net input needed (rounded up), then gross up for the 1% fee.
          amountOut = amount;
          const net = side === "BUY" ? ceilDiv(amount * price, 1_000_000n) : ceilDiv(amount * 1_000_000n, price);
          amountIn = ceilDiv(net * 100n, 99n);
        } else {
          amountIn = amount;
          const net = amountIn - amountIn / 100n;
          amountOut = side === "BUY" ? (net * 1_000_000n) / price : (net * price) / 1_000_000n;
        }
        const fee = amountIn / 100n;
        return { side, mode, amountIn, amountOut, price, priceImpactBps: 50, poolFee: fee, protocolFee: fee / 5n, networkFeeLamports: 5000n };
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
      async getWalletFunds(mint, owner) {
        const s = load();
        return {
          lamports: FAKE_WALLET_LAMPORTS,
          quote: FAKE_WALLET_USDC + BigInt(s.usdc[owner] ?? "0"),
          base: BigInt(s.balances[mint]?.[owner] ?? "0"),
        };
      },
    },
    payout: {
      quoteMint: () => QUOTE_MINT,
      issuerAddress: () => ISSUER,
      async getIssuerQuoteBalance() {
        return BigInt(load().issuerUsdc);
      },
      async transferBatch(rows, opts) {
        if (opts?.memo !== undefined) assertMemo(opts.memo);
        const s = load();
        const total = rows.reduce((a, r) => a + r.amount, 0n);
        if (BigInt(s.issuerUsdc) < total) throw new Error("insufficient issuer USDC");
        s.issuerUsdc = (BigInt(s.issuerUsdc) - total).toString();
        for (const r of rows) s.usdc[r.wallet] = (BigInt(s.usdc[r.wallet] ?? "0") + r.amount).toString();
        const signature = sig();
        if (opts?.memo) (s.memos ??= {})[signature] = opts.memo;
        save(s);
        return { signature };
      },
    },
    escrow: {
      address: () => ESCROW,
      async getBalance() {
        return BigInt(load().usdc[ESCROW] ?? "0");
      },
      async release(rows, opts) {
        if (opts?.memo !== undefined) assertMemo(opts.memo);
        const s = load();
        const total = rows.reduce((a, r) => a + r.amount, 0n);
        const bal = BigInt(s.usdc[ESCROW] ?? "0");
        if (bal < total) throw new Error("insufficient escrow USDC");
        s.usdc[ESCROW] = (bal - total).toString();
        for (const r of rows) s.usdc[r.wallet] = (BigInt(s.usdc[r.wallet] ?? "0") + r.amount).toString();
        const signature = sig();
        if (opts?.memo) (s.memos ??= {})[signature] = opts.memo;
        save(s);
        return { signature };
      },
    },
    // Wallet signing on the fake chain: a "tx" is base64 JSON describing the effect. Nothing can be
    // signed with a real wallet, so the signed tx must equal the unsigned one (a simulated signature)
    // and the effect is applied on submit. The founder's USDC is the fake issuer balance.
    wallet: {
      async buildCreatePoolTx(input, creator) {
        const pool: WalletPool = {
          baseMint: addr("Mint"),
          dbcConfig: addr("Conf"),
          dbcPool: addr("Pool"),
          poolOwners: [addr("Auth")],
          dbcParams: { fake: true, ...input, tokenSupply: input.tokenSupply.toString(), creator },
        };
        const body: FakeWalletTx = {
          kind: "create_pool",
          nonce: randomBytes(8).toString("hex"),
          creator,
          pool: { dbcPool: pool.dbcPool, baseMint: pool.baseMint, dbcConfig: pool.dbcConfig, authority: pool.poolOwners[0] },
          tokenSupply: (input.tokenSupply * 10n ** BigInt(input.tokenDecimals)).toString(),
          startingMarketCap: input.startingMarketCap.toString(),
          graduationMarketCap: input.graduationMarketCap.toString(),
        };
        return { tx: fakeTx(body, `Create ${input.symbol} market`), pool };
      },
      async finalizeCreatePool() {
        return { signatures: [sig()] };
      },
      async buildTransferBatchTx(from, rows) {
        const body: FakeWalletTx = {
          kind: "transfer",
          nonce: randomBytes(8).toString("hex"),
          from,
          rows: rows.map((r) => ({ wallet: r.wallet, amount: r.amount.toString() })),
        };
        return fakeTx(body, `Pay ${rows.length} holder${rows.length === 1 ? "" : "s"}`);
      },
      async submitSigned(unsigned, signedTx, signer) {
        if (signedTx !== unsigned.tx) throw new Error("signed transaction does not match the prepared one");
        const body = JSON.parse(Buffer.from(unsigned.tx, "base64").toString("utf8")) as FakeWalletTx;
        const s = load();
        if (body.kind === "create_pool") {
          if (body.creator !== signer) throw new Error("signer is not the pool creator");
          const { dbcPool, baseMint, dbcConfig, authority } = body.pool;
          s.pools[dbcPool] = {
            dbcPool,
            baseMint,
            dbcConfig,
            authority,
            tokenSupply: body.tokenSupply,
            startingMarketCap: body.startingMarketCap,
            graduationMarketCap: body.graduationMarketCap,
            quoteReserve: "0",
            sold: "0",
          };
          s.allow[baseMint] = [authority];
          s.balances[baseMint] = { [authority]: body.tokenSupply };
        } else {
          if (body.from !== signer) throw new Error("signer is not the payer");
          const total = body.rows.reduce((a, r) => a + BigInt(r.amount), 0n);
          if (BigInt(s.issuerUsdc) < total) throw new Error("insufficient USDC in the signing wallet");
          s.issuerUsdc = (BigInt(s.issuerUsdc) - total).toString();
          for (const r of body.rows) s.usdc[r.wallet] = (BigInt(s.usdc[r.wallet] ?? "0") + BigInt(r.amount)).toString();
        }
        save(s);
        return { signature: sig() };
      },
    },
  };
  return { ports, control };
}
