// Devnet implementation of the chain ports (Meteora DBC + Token-2022 + fs_allowlist).
// OWNED BY the W2-chain workstream. SDK objects stay inside lib/chain/devnet/*; this file
// only maps them to the normalized port types.
//
// Custody (SPEC 0.4, P0): the server signs with FS_AUTHORITY_KEYPAIR (partner / allowlist admin /
// mock-USDC mint authority) and ISSUER_KEYPAIR (DBC pool creator / payout source). Swaps are NOT
// signed here: buildSwapTx returns an unsigned tx for the investor's wallet.
import { PublicKey, Transaction } from "@solana/web3.js";
import { agreementMemo } from "@fstack/core";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { ChainPorts, CreatePoolInput, MarketState, SwapMode, SwapQuote, UnsignedTx } from "./ports";
import { TxError, devnetEnv, loadKeypair, sendSignedTx, sendTx, withRetry } from "./devnet/env";
import { addAllowIx, isAllowed } from "./devnet/allowlist";
import {
  DBC_POOL_AUTHORITY,
  buildHookPoolTxForCreator,
  buildMemoTx,
  buildSwapTransaction,
  createHookPool,
  getPriceFromSqrtPrice,
  initHookAllowlist,
  quoteSwap,
  readPool,
} from "./devnet/dbc";
import { listHolders } from "./devnet/holders";
import { buildTransferTx, tokenBalance, transferBatch, usdcAta } from "./devnet/usdc";

const b64 = (tx: Transaction) => Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");

/** 5000 lamports/signature + priority fee (400k CU × 20k µlamports = 8000 lamports). ATA rent not included. */
const SWAP_NETWORK_FEE_LAMPORTS = 13_000n;

export async function createDevnetPorts(): Promise<ChainPorts> {
  const env = devnetEnv();
  const { connection, fsAuthority, issuer, quoteMint, allowlistProgram } = env;
  const escrow = process.env.ESCROW_KEYPAIR ? loadKeypair(process.env.ESCROW_KEYPAIR) : fsAuthority;

  const priceOfSqrt = (sqrt: Parameters<typeof getPriceFromSqrtPrice>[0], tokenDecimals: number) =>
    BigInt(
      getPriceFromSqrtPrice(sqrt, tokenDecimals as Parameters<typeof getPriceFromSqrtPrice>[1], 6)
        .mul(1_000_000)
        .floor()
        .toFixed(0),
    );

  return {
    mode: "devnet",
    market: {
      async createIssuancePool(input: CreatePoolInput) {
        const created = await createHookPool(
          env,
          { name: input.name, symbol: input.symbol, uri: input.uri },
          {
            tokenSupply: input.tokenSupply, // whole tokens (converted to base units by the DBC builder)
            tokenDecimals: input.tokenDecimals,
            startingMarketCap: input.startingMarketCap,
            graduationMarketCap: input.graduationMarketCap,
            fees: input.fees,
            creatorLockedLiquidityPercentage: input.creatorLockedLiquidityPercentage,
          },
          { agreementHash: input.agreementHash },
        );
        return {
          agreementAcceptance: created.agreementMemo
            ? { signer: issuer.publicKey.toBase58(), memo: created.agreementMemo, signature: created.signatures[0] }
            : undefined,
          baseMint: created.baseMint.toBase58(),
          dbcConfig: created.config.toBase58(),
          dbcPool: created.pool.toBase58(),
          // The DBC pool authority PDA owns the base vault; it is allowlisted in the same flow.
          poolOwners: [DBC_POOL_AUTHORITY.toBase58()],
          signatures: created.signatures,
          dbcParams: {
            ...created.dbcParams,
            quoteMint: quoteMint.toBase58(),
            transferHookProgram: allowlistProgram.toBase58(),
            partner: fsAuthority.publicKey.toBase58(),
            creator: issuer.publicKey.toBase58(),
          },
        };
      },

      async getMarketState(dbcPool: string): Promise<MarketState> {
        const s = await withRetry(() => readPool(env, new PublicKey(dbcPool)));
        const progressBps =
          s.migrationQuoteThreshold === 0n
            ? 0
            : Math.min(10_000, Number((s.quoteReserve * 10_000n) / s.migrationQuoteThreshold));
        return {
          dbcPool,
          baseMint: s.baseMint.toBase58(),
          quoteMint: s.quoteMint.toBase58(),
          price: s.price,
          quoteReserve: s.quoteReserve,
          migrationQuoteThreshold: s.migrationQuoteThreshold,
          progressBps: s.isMigrated ? 10_000 : progressBps,
          isMigrated: s.isMigrated,
          dammPool: s.dammPool?.toBase58(),
          accruedFees: { creator: s.creatorQuoteFee, partner: s.partnerQuoteFee },
        };
      },

      async quote(dbcPool: string, side: "BUY" | "SELL", amount: bigint, mode: SwapMode = "EXACT_IN"): Promise<SwapQuote> {
        const pool = new PublicKey(dbcPool);
        const s = await withRetry(() => readPool(env, pool));
        const q = await withRetry(() => quoteSwap(env, pool, side, amount, mode === "EXACT_OUT"));
        const next = priceOfSqrt(q.nextSqrtPrice, s.tokenDecimals);
        const impact = s.price === 0n ? 0 : Number(((next > s.price ? next - s.price : s.price - next) * 10_000n) / s.price);
        return {
          side,
          mode,
          amountIn: q.amountIn,
          amountOut: q.amountOut,
          price: s.price,
          priceImpactBps: impact,
          // collectFeeMode = QuoteToken: the whole fee (trading + Meteora protocol share) is in USDC for BUY and SELL.
          poolFee: q.tradingFee + q.protocolFee,
          protocolFee: q.protocolFee,
          networkFeeLamports: SWAP_NETWORK_FEE_LAMPORTS,
        };
      },

      async buildSwapTx(dbcPool, owner, side, amountIn, minAmountOut, mode = "EXACT_IN") {
        const tx = await withRetry(() =>
          buildSwapTransaction(env, new PublicKey(dbcPool), new PublicKey(owner), side, amountIn, minAmountOut, {
            exactOut: mode === "EXACT_OUT",
          }),
        );
        const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        return { tx: Buffer.from(bytes).toString("base64") };
      },
    },

    registry: {
      async allowWallet(mint: string, wallet: string) {
        const m = new PublicKey(mint);
        const w = new PublicKey(wallet);
        // add_allow is idempotent on-chain too (init_if_needed); skip the tx if already active.
        if (await withRetry(() => isAllowed(connection, allowlistProgram, m, w))) {
          return { signature: "already-allowlisted" };
        }
        const tx = new Transaction().add(addAllowIx({ program: allowlistProgram, admin: fsAuthority.publicKey, mint: m, wallet: w }));
        tx.feePayer = fsAuthority.publicKey;
        const signature = await sendTx(connection, tx, [fsAuthority], `add_allow(${wallet})`);
        return { signature };
      },

      async getBalances(mint: string, extraOwners: string[]) {
        const r = await listHolders(connection, new PublicKey(mint), {
          allowlistProgram,
          extraOwners: [...extraOwners, DBC_POOL_AUTHORITY.toBase58()],
        });
        return {
          slot: r.slot,
          balances: r.holders.map((h) => ({ owner: h.owner, tokenAccount: h.tokenAccount, amount: h.amount })),
        };
      },

      async getWalletFunds(mint: string, owner: string) {
        const o = new PublicKey(owner);
        const unitsAta = getAssociatedTokenAddressSync(new PublicKey(mint), o, false, TOKEN_2022_PROGRAM_ID);
        const [lamports, quote, base] = await Promise.all([
          withRetry(() => connection.getBalance(o)),
          tokenBalance(connection, usdcAta(quoteMint, o)),
          tokenBalance(connection, unitsAta),
        ]);
        return { lamports: BigInt(lamports), quote, base };
      },
    },

    payout: {
      quoteMint: () => quoteMint.toBase58(),
      issuerAddress: () => issuer.publicKey.toBase58(),
      async getIssuerQuoteBalance() {
        return tokenBalance(connection, usdcAta(quoteMint, issuer.publicKey));
      },
      /**
       * One transferChecked tx for ≤ 10 rows (missing ATAs are created first in a separate,
       * idempotent tx). Double-pay safe: the transfer tx is signed once with a single blockhash
       * and polled until confirmed or until that blockhash expired; it is never re-signed here.
       * On throw, `TxError.landed === false` (message contains "not landed"/"preflight") means it
       * definitely did not pay; a program failure (landed=true) also moved no funds.
       */
      async transferBatch(rows, opts) {
        try {
          const { signature } = await transferBatch(connection, quoteMint, issuer, rows, opts?.memo);
          return { signature };
        } catch (e) {
          if (e instanceof TxError) {
            throw new Error(
              `${e.message} [payout NOT applied: ${e.landed ? "transaction failed on-chain" : "transaction definitely did not land"}; safe to retry]`,
            );
          }
          throw e;
        }
      },
    },

    // Claim escrow (SPEC 7 P1): a server-held USDC account owned by ESCROW_KEYPAIR (falls back to the
    // Founder Stack authority). Releases pay the holder's ATA creation + fee from the escrow wallet's SOL.
    escrow: {
      address: () => escrow.publicKey.toBase58(),
      async getBalance() {
        return tokenBalance(connection, usdcAta(quoteMint, escrow.publicKey));
      },
      async release(rows, opts) {
        try {
          const { signature } = await transferBatch(connection, quoteMint, escrow, rows, opts?.memo);
          return { signature };
        } catch (e) {
          if (e instanceof TxError) {
            throw new Error(
              `${e.message} [release NOT applied: ${e.landed ? "transaction failed on-chain" : "transaction definitely did not land"}; safe to retry]`,
            );
          }
          throw e;
        }
      },
    },

    // SPEC 0.4 P1: the founder's wallet signs; the server only adds ephemeral / partner signatures.
    wallet: {
      async buildCreatePoolTx(input: CreatePoolInput, creator: string) {
        const built = await withRetry(() =>
          buildHookPoolTxForCreator(
            env,
            { name: input.name, symbol: input.symbol, uri: input.uri },
            {
              tokenSupply: input.tokenSupply,
              tokenDecimals: input.tokenDecimals,
              startingMarketCap: input.startingMarketCap,
              graduationMarketCap: input.graduationMarketCap,
              fees: input.fees,
              creatorLockedLiquidityPercentage: input.creatorLockedLiquidityPercentage,
            },
            new PublicKey(creator),
          ),
        );
        const memo = input.agreementHash ? agreementMemo(built.baseMint.toBase58(), input.agreementHash) : undefined;
        const memoTx = memo ? await withRetry(() => buildMemoTx(env, memo, new PublicKey(creator))) : undefined;
        return {
          tx: { tx: b64(built.tx), label: `Create ${input.symbol} token + market`, lastValidBlockHeight: built.lastValidBlockHeight },
          memoTx: memoTx && { tx: b64(memoTx.tx), label: "Accept the agreement for the issuer (records its hash on-chain)", lastValidBlockHeight: memoTx.lastValidBlockHeight },
          pool: {
            agreementMemo: memo,
            baseMint: built.baseMint.toBase58(),
            dbcConfig: built.config.toBase58(),
            dbcPool: built.pool.toBase58(),
            poolOwners: [DBC_POOL_AUTHORITY.toBase58()],
            dbcParams: {
              ...built.dbcParams,
              quoteMint: quoteMint.toBase58(),
              transferHookProgram: allowlistProgram.toBase58(),
              partner: fsAuthority.publicKey.toBase58(),
              creator,
            },
          },
        };
      },

      async finalizeCreatePool(pool) {
        return { signatures: [await initHookAllowlist(env, new PublicKey(pool.baseMint))] };
      },

      async buildTransferBatchTx(from, rows) {
        const { tx, lastValidBlockHeight } = await buildTransferTx(connection, quoteMint, new PublicKey(from), rows);
        return { tx: b64(tx), label: `Pay ${rows.length} holder${rows.length === 1 ? "" : "s"}`, lastValidBlockHeight };
      },

      async submitSigned(unsigned: UnsignedTx, signedTx: string, signer: string) {
        const expected = Transaction.from(Buffer.from(unsigned.tx, "base64"));
        let signed: Transaction;
        try {
          signed = Transaction.from(Buffer.from(signedTx, "base64"));
        } catch {
          throw new Error("signed transaction is not a valid legacy transaction");
        }
        if (!signed.serializeMessage().equals(expected.serializeMessage())) {
          throw new Error("signed transaction does not match the prepared one");
        }
        const own = signed.signatures.find((s) => s.publicKey.toBase58() === signer);
        if (!own?.signature) throw new Error(`transaction is not signed by ${signer}`);
        if (!signed.verifySignatures(true)) throw new Error("transaction signatures are missing or invalid");
        const sig = await sendSignedTx(connection, signed.serialize(), signed.signature!, unsigned.lastValidBlockHeight, unsigned.label);
        return { signature: sig };
      },
    },
  };
}

