// Chain ports: the only seam between the API (brain) and Solana.
// API routes depend on these interfaces, never on the Meteora/SPL SDKs directly.
// Two implementations: `fake.ts` (CHAIN_MODE=fake, local dev + tests) and
// `real.ts` (CHAIN_MODE=devnet, Meteora DBC + Token-2022 + fs_allowlist).
// All amounts are bigint base units (USDC 6 dp, rights token 6 dp).
import type { DbcFeeParams, TokenBalance } from "@fstack/core";

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
   * All token accounts of the mint with non-zero balance, merged by owner. Raw balances only:
   * who counts as pool / participant is decided by core `classifyHolders`, not here.
   * `extraOwners` must be included even if the adapter can't discover them (e.g. pool vault owners).
   */
  getBalances(mint: string, extraOwners: string[]): Promise<{ slot: number; balances: TokenBalance[] }>;
  /** One wallet's funds for the onboarding pre-flight (SPEC section 6): SOL in lamports, USDC and `mint` units in base units. */
  getWalletFunds(mint: string, owner: string): Promise<WalletFunds>;
}

export interface WalletFunds {
  lamports: bigint;
  quote: bigint;
  base: bigint;
}

export interface PayoutPort {
  quoteMint(): string;
  issuerAddress(): string;
  getIssuerQuoteBalance(): Promise<bigint>;
  /**
   * Transfers USDC from the issuer to each wallet in ONE transaction (caller batches ≤ 10).
   * `memo` (≤ 200 bytes UTF-8) is written into the same transaction as an SPL Memo instruction, so the
   * payout is tied on-chain to the report it pays (e.g. `fstack:report:<reportHash>`).
   */
  transferBatch(rows: { wallet: string; amount: bigint }[], opts?: { memo?: string }): Promise<{ signature: string }>;
}

/**
 * Claim escrow for distributions (SPEC section 7, P1): a server-held USDC token account. The issuer
 * funds it with one transfer (payout.transferBatch or a wallet-signed transfer to `address()`), and
 * each holder's claim is released from it after the API verifies their Merkle proof. Per-distribution
 * accounting lives in the database; this port only moves USDC out of the escrow wallet.
 */
export interface EscrowPort {
  /** Owner wallet of the escrow USDC account (the transfer destination when funding). */
  address(): string;
  getBalance(): Promise<bigint>;
  /** Transfers USDC from the escrow to each row in ONE transaction, with an optional SPL memo. */
  release(rows: { wallet: string; amount: bigint }[], opts?: { memo?: string }): Promise<{ signature: string }>;
}

/**
 * A transaction the founder signs in their own wallet (SPEC 0.4 P1, `/sign/[requestId]`).
 * `tx` is a base64 legacy transaction, possibly already partially signed by ephemeral server
 * keys (new mint / config accounts). `lastValidBlockHeight` bounds how long it can land.
 */
export interface UnsignedTx {
  tx: string;
  label: string;
  lastValidBlockHeight: number;
}

export interface WalletPool extends Omit<CreatePoolResult, "signatures"> {
  /** Extra data the adapter needs in finalizeCreatePool (JSON-safe). */
  finalize?: Record<string, unknown>;
}

/** Wallet-signing seam: builds txs for the founder's wallet instead of signing with server keys. */
export interface WalletSigningPort {
  /** Create-pool tx with `creator` as fee payer + pool creator; the pool addresses are fixed now. */
  buildCreatePoolTx(input: CreatePoolInput, creator: string): Promise<{ tx: UnsignedTx; pool: WalletPool }>;
  /** Server-side follow-up once the founder's create tx landed (Founder Stack allowlist setup). */
  finalizeCreatePool(pool: WalletPool): Promise<{ signatures: string[] }>;
  /** USDC transfers from `from` (the founder's wallet) to each row in ONE tx (caller batches). */
  buildTransferBatchTx(from: string, rows: { wallet: string; amount: bigint }[]): Promise<UnsignedTx>;
  /**
   * Checks that `signedTx` is exactly `unsigned` plus a valid signature by `signer`, broadcasts it
   * and waits for confirmation. Throws on mismatch or on-chain failure.
   */
  submitSigned(unsigned: UnsignedTx, signedTx: string, signer: string): Promise<{ signature: string }>;
}

export interface ChainPorts {
  mode: "fake" | "devnet";
  market: MarketPort;
  registry: RegistryPort;
  payout: PayoutPort;
  escrow: EscrowPort;
  wallet: WalletSigningPort;
}
