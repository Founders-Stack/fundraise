// Meteora DBC integration (transfer-hook pools). SDK objects stay inside this module;
// callers get normalized bigint/string values.
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  Transaction,
  type AccountMeta,
  type Connection,
} from "@solana/web3.js";
import {
  AccountsType,
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2BaseFeeMode,
  DammV2DynamicFeeMode,
  DynamicBondingCurveClient,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  PoolService,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithCustomSqrtPrices,
  buildCurveWithMarketCap,
  getSqrtPriceFromPrice,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  getCurrentPoint,
  getPriceFromSqrtPrice,
  type ConfigParameters,
  type BuildCurveWithMarketCapParams,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { DbcFeeParams } from "@fstack/core";
import { COMMITMENT, computeBudgetIxs, sendTx, type DevnetEnv } from "./env";
import { addAllowIx, hookAccounts, initializeIx } from "./allowlist";

export const DBC_POOL_AUTHORITY = deriveDbcPoolAuthority();

export interface CurveInput {
  tokenSupply: bigint; // whole tokens
  tokenDecimals: number;
  startingMarketCap: bigint; // USDC base units
  graduationMarketCap: bigint; // USDC base units
  fees: DbcFeeParams;
  creatorLockedLiquidityPercentage: number;
  /** Anti-sniper decaying base fee. Defaults: 10% -> 1% over 5 minutes. */
  feeSchedule?: { startingFeeBps: number; endingFeeBps: number; numberOfPeriod: number; totalDurationSec: number };
}

const QUOTE_DECIMALS = 6;
const usdc = (v: bigint) => Number(v) / 10 ** QUOTE_DECIMALS;

export function buildCurveParams(input: CurveInput): { params: BuildCurveWithMarketCapParams; config: ConfigParameters } {
  const sched = input.feeSchedule ?? { startingFeeBps: 1000, endingFeeBps: 100, numberOfPeriod: 10, totalDurationSec: 300 };
  const creatorLocked = input.creatorLockedLiquidityPercentage;
  const params: BuildCurveWithMarketCapParams = {
    token: {
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: input.tokenDecimals as TokenDecimal,
      tokenQuoteDecimal: QUOTE_DECIMALS as TokenDecimal,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: Number(input.tokenSupply),
      leftover: (input as CurveInput & { leftover?: number }).leftover ?? 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: sched.startingFeeBps,
          endingFeeBps: sched.endingFeeBps,
          numberOfPeriod: sched.numberOfPeriod,
          totalDuration: sched.totalDurationSec,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: input.fees.creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: input.fees.migrationFeeOption as unknown as MigrationFeeOption,
      migrationFee: { ...input.fees.migrationFee },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: 100,
        baseFeeMode: DammV2BaseFeeMode.FeeTimeSchedulerLinear,
      },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 100 - creatorLocked,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: creatorLocked,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    initialMarketCap: usdc(input.startingMarketCap),
    migrationMarketCap: usdc(input.graduationMarketCap),
  };
  return { params, config: buildCurveWithMarketCapRobust(params) };
}

/**
 * SDK 1.5.12's buildCurveWithMarketCap fails with "Not enough liquidity ... amountLeft: ~357" at our
 * magnitudes ($1M -> $3M market cap, 1M supply, 6 dp base / 6 dp quote): the single-segment curve's
 * base-side liquidity rounds down so it can't absorb the whole migrationQuoteThreshold. The same
 * inputs with a 9-dp base token build fine. Fallback (SPEC H8 fallback): derive the start/migration
 * UI prices from the 9-dp build and feed them to buildCurveWithCustomSqrtPrices at the real decimals.
 */
export function buildCurveWithMarketCapRobust(params: BuildCurveWithMarketCapParams): ConfigParameters {
  try {
    return buildCurveWithMarketCap(params);
  } catch (e) {
    if (!/Not enough liquidity/i.test(String((e as Error).message))) throw e;
  }
  const base = params.token.tokenBaseDecimal;
  const quote = params.token.tokenQuoteDecimal;
  const ref = buildCurveWithMarketCap({ ...params, token: { ...params.token, tokenBaseDecimal: TokenDecimal.NINE } });
  const startUi = getPriceFromSqrtPrice(ref.sqrtStartPrice, TokenDecimal.NINE, quote);
  const migUi = getPriceFromSqrtPrice(ref.curve[0].sqrtPrice, TokenDecimal.NINE, quote);
  const sqrtPrices = [getSqrtPriceFromPrice(startUi.toString(), base, quote), getSqrtPriceFromPrice(migUi.toString(), base, quote)];
  let lastErr: unknown;
  for (const leftover of [params.token.leftover, 1, 10, 100]) {
    try {
      const { initialMarketCap: _i, migrationMarketCap: _m, ...rest } = params;
      return buildCurveWithCustomSqrtPrices({ ...rest, token: { ...params.token, leftover }, sqrtPrices });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** JSON-safe summary of what was sent to DBC (for "How your market is configured"). */
export function describeConfig(params: BuildCurveWithMarketCapParams, config: ConfigParameters): Record<string, unknown> {
  return {
    tokenType: "Token2022",
    totalTokenSupply: params.token.totalTokenSupply,
    tokenBaseDecimal: params.token.tokenBaseDecimal,
    tokenQuoteDecimal: params.token.tokenQuoteDecimal,
    initialMarketCap: params.initialMarketCap,
    migrationMarketCap: params.migrationMarketCap,
    migrationQuoteThreshold: config.migrationQuoteThreshold.toString(),
    sqrtStartPrice: config.sqrtStartPrice.toString(),
    migrationOption: "DAMM_V2",
    migrationFeeOption: params.migration.migrationFeeOption,
    migrationFee: params.migration.migrationFee,
    creatorTradingFeePercentage: params.fee.creatorTradingFeePercentage,
    baseFee:
      params.fee.baseFeeParams.baseFeeMode === BaseFeeMode.RateLimiter
        ? params.fee.baseFeeParams.rateLimiterParam
        : { mode: "FeeSchedulerExponential", ...params.fee.baseFeeParams.feeSchedulerParam },
    liquidityDistribution: params.liquidityDistribution,
    activationType: "Timestamp",
    transferHook: "fs_allowlist",
  };
}

export interface CreatedPool {
  baseMint: PublicKey;
  config: PublicKey;
  pool: PublicKey;
  signatures: string[];
  dbcParams: Record<string, unknown>;
}

/**
 * tx1: DBC createConfigAndPoolWithTransferHook (partner/feeClaimer/payer = FS authority, creator = issuer).
 *      DBC creates the Token-2022 mint with TransferHook{program: fs_allowlist, authority: DBC pool authority}
 *      and mints the supply into the base vault (MintTo doesn't invoke the hook).
 * tx2: fs_allowlist.initialize(mint, admin = FS authority) + add_allow(DBC pool authority).
 */
export async function createHookPool(
  env: DevnetEnv,
  meta: { name: string; symbol: string; uri: string },
  curve: CurveInput,
  opts: { configKeypair?: Keypair; baseMintKeypair?: Keypair } = {},
): Promise<CreatedPool> {
  const { connection, fsAuthority, issuer, quoteMint, allowlistProgram } = env;
  const client = new DynamicBondingCurveClient(connection, COMMITMENT);
  const configKp = opts.configKeypair ?? Keypair.generate();
  const baseMintKp = opts.baseMintKeypair ?? Keypair.generate();
  const { params, config } = buildCurveParams(curve);

  const tx1 = await client.partner.createConfigAndPoolWithTransferHook({
    ...config,
    config: configKp.publicKey,
    feeClaimer: fsAuthority.publicKey,
    leftoverReceiver: fsAuthority.publicKey,
    quoteMint,
    transferHookProgram: allowlistProgram,
    payer: fsAuthority.publicKey,
    preCreatePoolParam: {
      name: meta.name.slice(0, 32),
      symbol: meta.symbol.slice(0, 10),
      uri: meta.uri.slice(0, 200),
      poolCreator: issuer.publicKey,
      baseMint: baseMintKp.publicKey,
    },
  });
  const t1 = new Transaction().add(...computeBudgetIxs(600_000), ...tx1.instructions);
  t1.feePayer = fsAuthority.publicKey;
  const sig1 = await sendTx(connection, t1, [fsAuthority, configKp, baseMintKp, issuer], "createConfigAndPoolWithTransferHook");

  const t2 = new Transaction().add(
    ...computeBudgetIxs(200_000),
    initializeIx({
      program: allowlistProgram,
      payer: fsAuthority.publicKey,
      authority: fsAuthority.publicKey,
      mint: baseMintKp.publicKey,
      admin: fsAuthority.publicKey,
    }),
    addAllowIx({
      program: allowlistProgram,
      admin: fsAuthority.publicKey,
      mint: baseMintKp.publicKey,
      wallet: DBC_POOL_AUTHORITY,
    }),
  );
  t2.feePayer = fsAuthority.publicKey;
  const sig2 = await sendTx(connection, t2, [fsAuthority], "fs_allowlist.initialize+add_allow(pool authority)");

  const pool = deriveDbcPoolAddress(quoteMint, baseMintKp.publicKey, configKp.publicKey);
  return {
    baseMint: baseMintKp.publicKey,
    config: configKp.publicKey,
    pool,
    signatures: [sig1, sig2],
    dbcParams: describeConfig(params, config),
  };
}

/** PoolService whose transfer-hook account resolution uses our explicit fs_allowlist accounts. */
class HookPoolService extends PoolService {
  hook: AccountMeta[] = [];
  protected override async getRemainingAccountsForTransferHook(
    _mint: PublicKey,
    accountTypes: Parameters<PoolService["getRemainingAccountsForTransferHook"]>[1] = [AccountsType.TransferHookBase],
  ) {
    const types = accountTypes ?? [AccountsType.TransferHookBase];
    return {
      info: { slices: types.map((accountsType) => ({ accountsType, length: this.hook.length })) },
      accounts: types.flatMap(() => this.hook),
    };
  }
}

/** Unsigned swap2WithTransferHook tx (fee payer = owner). BUY: quote -> base; SELL: base -> quote. */
export async function buildSwapTransaction(
  env: DevnetEnv,
  pool: PublicKey,
  owner: PublicKey,
  side: "BUY" | "SELL",
  amountIn: bigint,
  minAmountOut: bigint,
): Promise<Transaction> {
  const { connection, allowlistProgram } = env;
  const svc = new HookPoolService(connection, COMMITMENT);
  const state = await readPool(env, pool);
  // Token-2022 resolves AllowEntry from the base-token DESTINATION owner.
  const destOwner = side === "BUY" ? owner : DBC_POOL_AUTHORITY;
  svc.hook = hookAccounts(allowlistProgram, state.baseMint, destOwner);
  const tx = await svc.swap2WithTransferHook({
    owner,
    payer: owner,
    pool,
    swapBaseForQuote: side === "SELL",
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(minAmountOut.toString()),
    referralTokenAccount: null,
  });
  const out = new Transaction().add(...computeBudgetIxs(400_000, 20_000), ...tx.instructions);
  out.feePayer = owner;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(COMMITMENT);
  out.recentBlockhash = blockhash;
  out.lastValidBlockHeight = lastValidBlockHeight;
  return out;
}

export interface PoolReading {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  config: PublicKey;
  sqrtPrice: BN;
  price: bigint; // USDC base units per whole token
  quoteReserve: bigint;
  baseReserve: bigint;
  migrationQuoteThreshold: bigint;
  isMigrated: boolean;
  creatorQuoteFee: bigint;
  partnerQuoteFee: bigint;
  tokenDecimals: number;
  activationType: number;
}

type AnyPool = Awaited<ReturnType<DynamicBondingCurveClient["state"]["getPool"]>>;
type AnyConfig = Awaited<ReturnType<DynamicBondingCurveClient["state"]["getPoolConfig"]>>;

export async function fetchPoolAndConfig(env: DevnetEnv, pool: PublicKey) {
  const client = new DynamicBondingCurveClient(env.connection, COMMITMENT);
  const vp = (await client.state.getPool(pool)) as NonNullable<AnyPool> | null;
  if (!vp) throw new Error(`DBC pool not found: ${pool.toBase58()}`);
  const ps = (vp as unknown as { poolState?: unknown }).poolState ?? vp;
  const cfg = (await client.state.getPoolConfig((ps as { config: PublicKey }).config)) as NonNullable<AnyConfig> | null;
  if (!cfg) throw new Error("DBC pool config not found");
  return { client, virtualPool: vp, poolState: ps as Record<string, unknown>, config: cfg };
}

const big = (v: unknown) => BigInt((v as BN).toString());

export async function readPool(env: DevnetEnv, pool: PublicKey): Promise<PoolReading> {
  const { poolState: s, config: c } = await fetchPoolAndConfig(env, pool);
  const tokenDecimals = Number((c as unknown as { tokenDecimal: number }).tokenDecimal);
  const priceUi = getPriceFromSqrtPrice(s.sqrtPrice as BN, tokenDecimals as TokenDecimal, QUOTE_DECIMALS as TokenDecimal);
  return {
    baseMint: s.baseMint as PublicKey,
    quoteMint: (c as unknown as { quoteMint: PublicKey }).quoteMint,
    config: s.config as PublicKey,
    sqrtPrice: s.sqrtPrice as BN,
    price: BigInt(priceUi.mul(10 ** QUOTE_DECIMALS).floor().toFixed(0)),
    quoteReserve: big(s.quoteReserve),
    baseReserve: big(s.baseReserve),
    migrationQuoteThreshold: big((c as unknown as { migrationQuoteThreshold: BN }).migrationQuoteThreshold),
    isMigrated: Number(s.isMigrated) === 1,
    creatorQuoteFee: big(s.creatorQuoteFee),
    partnerQuoteFee: big(s.partnerQuoteFee),
    tokenDecimals,
    activationType: Number((c as unknown as { activationType: number }).activationType),
  };
}

export async function quoteSwap(env: DevnetEnv, pool: PublicKey, side: "BUY" | "SELL", amountIn: bigint) {
  const { client, virtualPool, config } = await fetchPoolAndConfig(env, pool);
  const activationType = Number((config as unknown as { activationType: number }).activationType) as ActivationType;
  const currentPoint = await getCurrentPoint(env.connection, activationType);
  const q = client.pool.swapQuote2({
    virtualPool: virtualPool as never,
    config: config as never,
    swapBaseForQuote: side === "SELL",
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(amountIn.toString()),
    slippageBps: 0,
  });
  return {
    amountOut: big(q.outputAmount),
    tradingFee: big(q.tradingFee),
    protocolFee: big(q.protocolFee),
    nextSqrtPrice: q.nextSqrtPrice as BN,
  };
}

export { deriveDbcPoolAddress, getPriceFromSqrtPrice };
export type { Connection };
