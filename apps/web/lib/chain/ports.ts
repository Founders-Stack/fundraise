// Chain ports: the only seam between the API (brain) and Solana.
// API routes depend on these interfaces, never on the Meteora/SPL SDKs directly.
// Two implementations: `fake.ts` (CHAIN_MODE=fake, local dev + tests) and
// `real.ts` (CHAIN_MODE=devnet, Meteora DBC + Token-2022 + fs_allowlist).
// All amounts are bigint base units (USDC 6 dp, rights token 6 dp).
import type { DbcFeeParams, HolderBalance } from "@fstack/core";

export interface CreatePoolInput {
  name: string;
  symbol: string;
  /** Metadata URI for the token (may be a data: or API URL). */
  uri: string;
  tokenSupply: bigint; // whole tokens
  tokenDecimals: number;
  startingMarketCap: bigint; // USDC base units
  graduationMarketCap: bigint; // USDC base units
  fees: DbcFeeParams;
  /** Issuer LP ownership after graduation: 100 = issuer owns all locked LP (SPEC section 5). */
  creatorLockedLiquidityPercentage: number;
}

export interface CreatePoolResult {
  baseMint: string;
  dbcConfig: string;
  dbcPool: string;
  /** DBC pool authority / vault owners that were allowlisted as infrastructure. */
  poolOwners: string[];
  signatures: string[];
  /** Normalized params actually sent to DBC, for display ("How your market is configured"). */
  dbcParams: Record<string, unknown>;
}

export interface MarketState {
  dbcPool: string;
  baseMint: string;
  quoteMint: string;
  /** USDC base units per 1 whole token. */
  price: bigint;
  quoteReserve: bigint;
  migrationQuoteThreshold: bigint;
  /** 0..10000 */
  progressBps: number;
  isMigrated: boolean;
  dammPool?: string;
  accruedFees: { creator: bigint; partner: bigint };
}

/**
 * EXACT_IN (default): `amountIn` is fixed, `amountOut` is the estimate.
 * EXACT_OUT: `amountOut` is fixed (e.g. exactly 100,000 tokens), `amountIn` is the required input incl. fees.
 */
export type SwapMode = "EXACT_IN" | "EXACT_OUT";

export interface SwapQuote {
  side: "BUY" | "SELL";
  mode?: SwapMode;
  amountIn: bigint;
  amountOut: bigint;
  price: bigint;
  priceImpactBps: number;
  /** Total fee the trader pays, USDC base units (trading fee + Meteora protocol fee). */
  poolFee: bigint;
  /** Meteora's protocol share of poolFee (not split between startup and Founder Stack). */
  protocolFee: bigint;
  /** Estimated network fee in lamports. */
  networkFeeLamports: bigint;
}

export interface MarketPort {
  createIssuancePool(input: CreatePoolInput): Promise<CreatePoolResult>;
  getMarketState(dbcPool: string): Promise<MarketState>;
  /** `amount` is amountIn for EXACT_IN (default) and the desired amountOut for EXACT_OUT. */
  quote(dbcPool: string, side: "BUY" | "SELL", amount: bigint, mode?: SwapMode): Promise<SwapQuote>;
  /**
   * Unsigned, base64-serialized transaction for the investor's wallet to sign.
   * EXACT_IN (default): spend `amountIn`, receive ≥ `minAmountOut`.
   * EXACT_OUT: receive exactly `minAmountOut`, spend at most `amountIn` (= maximumAmountIn).
   */
  buildSwapTx(
    dbcPool: string,
    owner: string,
    side: "BUY" | "SELL",
    amountIn: bigint,
    minAmountOut: bigint,
    mode?: SwapMode,
  ): Promise<{ tx: string }>;
}

export interface RegistryPort {
  /** Adds an AllowEntry for (mint, wallet). Idempotent. */
  allowWallet(mint: string, wallet: string): Promise<{ signature: string }>;
  /**
   * All token accounts of the mint with non-zero balance, merged by owner.
   * `kind` is POOL for `poolOwners`, otherwise UNREGISTERED — the API
   * upgrades matches against Participant rows to PARTICIPANT.
   */
  getHolders(mint: string, poolOwners: string[]): Promise<{ slot: number; holders: HolderBalance[] }>;
}

export interface PayoutPort {
  quoteMint(): string;
  issuerAddress(): string;
  getIssuerQuoteBalance(): Promise<bigint>;
  /** Transfers USDC from the issuer to each wallet in ONE transaction (caller batches ≤ 10). */
  transferBatch(rows: { wallet: string; amount: bigint }[]): Promise<{ signature: string }>;
}

export interface ChainPorts {
  mode: "fake" | "devnet";
  market: MarketPort;
  registry: RegistryPort;
  payout: PayoutPort;
}
