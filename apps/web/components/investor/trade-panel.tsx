"use client";

// Buy / sell against the DBC curve with a full preview (pay, receive, price impact, pool fee split,
// network fee). An unregistered wallet pressing Buy gets the onboarding gate inline (SPEC section 6);
// it can still submit anyway, and then the token's transfer hook rejects it (SPEC section 10, beat 2).
import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Transaction, type Connection } from "@solana/web3.js";
import { Check, ChevronDown, Loader2, ShieldAlert, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { TxLink } from "@/components/explorer-link";
import { parseAmount, units, usd } from "@/components/format";
import { api, announceMarketChange, isNotEligible, isUserRejection, useWalletStatus } from "./client";
import { Callout, OnboardingGate, type OnboardingGateProps } from "./onboarding-gate";

type Side = "BUY" | "SELL";
type Amount = { baseUnits: string; display: string };

interface Quote {
  side: Side;
  pay: Amount & { asset: string };
  receive: Amount & { asset: string };
  price: Amount;
  priceImpact: string;
  priceImpactBps: number;
  fees: {
    poolFee: Amount;
    meteoraProtocolFee: Amount;
    startupShare: Amount;
    founderStackFee: Amount & { note: string };
    networkFee: { lamports: string; sol: string };
  };
}

type Outcome =
  | { kind: "done"; side: Side; signature: string; receive: string }
  | { kind: "not-eligible"; signature: string | null }
  | { kind: "error"; message: string };

const SLIPPAGE_BPS = 100n; // 1%

export interface TradePanelProps {
  issuanceId: string;
  symbol: string;
  chainMode: "fake" | "devnet";
  graduated: boolean;
  gate: Omit<OnboardingGateProps, "variant" | "onTryAnyway" | "onCancel">;
}

export function TradePanel({ issuanceId, symbol, chainMode, graduated, gate }: TradePanelProps) {
  const router = useRouter();
  const { connection } = useConnection();
  const { sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const { wallet, status, refresh } = useWalletStatus(issuanceId);

  const [side, setSide] = useState<Side>("BUY");
  const [input, setInput] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [showFees, setShowFees] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [submitting, setSubmitting] = useState<null | "build" | "sign" | "confirm">(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [justEnabled, setJustEnabled] = useState(false);
  const wasRegistered = useRef<boolean | null>(null);

  const amount = useMemo(() => parseAmount(input), [input]);
  const registered = Boolean(status?.registered);

  // Close the gate (and say so) once the wallet is onboarded.
  useEffect(() => {
    if (!status) return;
    if (wasRegistered.current === false && status.registered) {
      setGateOpen(false);
      setJustEnabled(true);
    }
    wasRegistered.current = status.registered;
  }, [status]);
  useEffect(() => {
    wasRegistered.current = null;
    setGateOpen(false);
    setJustEnabled(false);
    setOutcome(null);
  }, [wallet]);

  // Debounced quote.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!amount) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setQuoting(true);
      try {
        const q = await api<Quote>(`/api/issuances/${issuanceId}/quote?side=${side}&amountIn=${amount.toString()}`, { signal: ctrl.signal });
        setQuote(q);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setQuoteError((e as Error).message);
      } finally {
        setQuoting(false);
      }
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [amount, side, issuanceId]);

  const balance = side === "BUY" ? status?.funds.usdc : status?.funds.units;
  const insufficient = Boolean(amount && balance && amount > BigInt(balance.baseUnits));
  const minOut = quote ? (BigInt(quote.receive.baseUnits) * (10_000n - SLIPPAGE_BPS)) / 10_000n : 0n;
  // USDC amounts in the house format ($981.44); unit amounts as the API displays them.
  const fmtReceive = (baseUnits: string | bigint) =>
    side === "SELL" ? usd(baseUnits) : `${units(baseUnits, { max: 6 })} ${symbol}`;

  async function submit(opts: { anyway?: boolean } = {}) {
    if (!wallet || !amount || !quote) return;
    if (side === "BUY" && !registered && !opts.anyway) {
      setGateOpen(true);
      return;
    }
    setGateOpen(false);
    setOutcome(null);
    try {
      let signature: string;
      if (chainMode === "fake") {
        // Local fake chain: nothing to sign; the dev endpoint applies the quoted swap.
        setSubmitting("confirm");
        const tokens = side === "BUY" ? quote.receive.baseUnits : amount.toString();
        signature = (await api<{ signature: string }>("/api/dev/fake-swap", { method: "POST", body: { issuanceId, owner: wallet, side, tokens } }))
          .signature;
      } else {
        setSubmitting("build");
        const built = await api<{ tx: string }>(`/api/issuances/${issuanceId}/swap`, {
          method: "POST",
          body: { owner: wallet, side, amountIn: amount.toString(), minAmountOut: minOut.toString() },
        });
        const tx = Transaction.from(Uint8Array.from(atob(built.tx), (c) => c.charCodeAt(0)));
        setSubmitting("sign");
        signature = await sendTransaction(tx, connection);
        setSubmitting("confirm");
        await waitForConfirmation(connection, signature);
      }
      setOutcome({ kind: "done", side, signature, receive: fmtReceive(quote.receive.baseUnits) });
      setInput("");
      announceMarketChange();
      router.refresh();
      void refresh();
    } catch (e) {
      if (isNotEligible(e)) setOutcome({ kind: "not-eligible", signature: (e as { signature?: string }).signature ?? null });
      else if (isUserRejection(e)) setOutcome({ kind: "error", message: "Transaction cancelled in the wallet." });
      else setOutcome({ kind: "error", message: (e as Error).message || "The swap failed." });
    } finally {
      setSubmitting(null);
    }
  }

  if (graduated) {
    return (
      <Panel>
        <p className="text-sm text-muted-foreground">
          This curve has graduated to a Meteora DAMM v2 pool. Trading continues there; distributions still go only to registered
          participants.
        </p>
      </Panel>
    );
  }

  if (gateOpen && wallet && !registered) {
    return (
      <Panel title={`Onboard to buy ${symbol}`}>
        <OnboardingGate
          {...gate}
          variant="inline"
          onCancel={() => setGateOpen(false)}
          onTryAnyway={() => void submit({ anyway: true })}
        />
      </Panel>
    );
  }

  const payAsset = side === "BUY" ? "USDC" : symbol;

  return (
    <Panel>
      <div className="grid grid-cols-2 rounded-[3px] border bg-muted p-1 font-mono text-[11px] tracking-[0.1em] uppercase" role="tablist">
        {(["BUY", "SELL"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            onClick={() => {
              setSide(s);
              setInput("");
              setOutcome(null);
            }}
            className={cn("h-8 rounded-[2px] transition-colors", side === s ? "bg-card text-strong shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            {s === "BUY" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      {justEnabled && (
        <Callout tone="positive">
          <span className="flex items-center gap-2 font-medium">
            <Check className="size-4 text-positive" /> Trading enabled
          </span>
        </Callout>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <label htmlFor="trade-amount" className="label-mono">{side === "BUY" ? "You pay" : "You sell"}</label>
          {balance && (
            <span className="num">
              Balance {balance.display}
              {side === "SELL" && BigInt(balance.baseUnits) > 0n && (
                <button
                  type="button"
                  onClick={() => setInput(units(balance.baseUnits, { max: 6 }).replace(/,/g, ""))}
                  className="ml-1.5 font-medium text-foreground underline underline-offset-2"
                >
                  Max
                </button>
              )}
            </span>
          )}
        </div>
        <div className="flex h-12 items-center rounded-[2px] border border-input bg-background px-3 focus-within:border-brand">
          <input
            id="trade-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={input}
            onChange={(e) => {
              setInput(e.target.value.replace(/[^\d.,]/g, ""));
              setOutcome(null);
            }}
            className="num min-w-0 flex-1 bg-transparent text-xl font-semibold tracking-[-0.02em] text-strong outline-none placeholder:text-faint"
          />
          <span className="ml-2 font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">{payAsset}</span>
        </div>
        {side === "BUY" && (
          <div className="flex gap-1.5">
            {["10", "100", "1000"].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setInput(v)}
                className="num h-6 rounded-[2px] border bg-card px-2 font-mono text-[10px] text-muted-foreground hover:border-brand hover:bg-brand-soft hover:text-brand"
              >
                ${Number(v).toLocaleString("en-US")}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------- preview */}
      <div className="rounded-[3px] border bg-surface text-[13px]">
        <Row label="You receive (est.)">
          {quoting ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : quote ? (
            <span className="num font-medium">{fmtReceive(quote.receive.baseUnits)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>
        <Row label="Price">
          <span className="num">{quote ? `${usd(quote.price.baseUnits)} / unit` : "—"}</span>
        </Row>
        <Row label="Price impact">
          <span className={cn("num", quote && quote.priceImpactBps >= 300 && "text-warning")}>{quote ? quote.priceImpact : "—"}</span>
        </Row>
        <button
          type="button"
          onClick={() => setShowFees((v) => !v)}
          className="flex w-full items-center justify-between border-b px-3 py-2 text-left text-muted-foreground hover:text-foreground"
          aria-expanded={showFees}
        >
          <span className="flex items-center gap-1">
            Pool fee <ChevronDown className={cn("size-3.5 transition-transform", showFees && "rotate-180")} />
          </span>
          <span className="num text-foreground">{quote ? usd(quote.fees.poolFee.baseUnits) : "—"}</span>
        </button>
        {showFees && quote && (
          <div className="space-y-1 border-t border-dashed px-3 py-2 text-xs text-muted-foreground">
            <FeeLine label="Startup" value={usd(quote.fees.startupShare.baseUnits)} />
            <FeeLine label="Founder Stack" value={usd(quote.fees.founderStackFee.baseUnits)} />
            <FeeLine label="Meteora protocol" value={usd(quote.fees.meteoraProtocolFee.baseUnits)} />
            <p className="pt-1">{quote.fees.founderStackFee.note}.</p>
          </div>
        )}
        <Row label="Network fee">
          <span className="num">{quote ? `~${quote.fees.networkFee.sol} SOL` : "—"}</span>
        </Row>
        <Row label={`Min. received (${Number(SLIPPAGE_BPS) / 100}% slippage)`} last>
          <span className="num whitespace-nowrap">{quote ? fmtReceive(minOut) : "—"}</span>
        </Row>
      </div>

      {quoteError && <Callout tone="error">{quoteError}</Callout>}

      {/* ---------------------------------------------------------- action */}
      {!wallet ? (
        <ActionButton onClick={() => setVisible(true)}>
          <Wallet className="size-4" /> Connect wallet
        </ActionButton>
      ) : (
        <ActionButton disabled={!quote || !status || insufficient || Boolean(submitting)} onClick={() => void submit()}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {submitting === "build"
            ? "Preparing transaction…"
            : submitting === "sign"
              ? "Approve in your wallet…"
              : submitting === "confirm"
                ? "Confirming…"
                : insufficient
                  ? `Not enough ${payAsset}`
                  : side === "BUY"
                    ? registered || !status
                      ? `Buy ${symbol}`
                      : `Buy ${symbol} · onboard first`
                    : `Sell ${symbol}`}
        </ActionButton>
      )}

      {outcome?.kind === "done" && (
        <Callout tone="positive">
          <p className="font-medium">
            {outcome.side === "BUY" ? "Bought" : "Sold"} · received ~{outcome.receive}
          </p>
          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            Tx <TxLink sig={outcome.signature} />
          </p>
        </Callout>
      )}
      {outcome?.kind === "not-eligible" && (
        <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-destructive">
            <ShieldAlert className="size-4" /> Rejected by the token: NotEligible
          </p>
          <p className="text-muted-foreground">
            This wallet isn&apos;t a registered participant, so the {symbol} Token-2022 transfer hook refused the transfer. Eligibility
            is enforced by the token itself, not by this website.
          </p>
          {outcome.signature && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              Tx <TxLink sig={outcome.signature} />
            </p>
          )}
          <button type="button" onClick={() => setGateOpen(true)} className="text-xs font-medium underline underline-offset-4">
            Onboard this wallet
          </button>
        </div>
      )}
      {outcome?.kind === "error" && <Callout tone="error">{outcome.message}</Callout>}

      {wallet && status && (
        <div className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
          <span>Your {symbol}</span>
          <span className="num font-medium text-foreground">{status.funds.units.display}</span>
        </div>
      )}
      {wallet && status && !registered && side === "BUY" && (
        <p className="text-xs text-muted-foreground">
          Only registered wallets can receive {symbol}. Buying opens a one-signature onboarding step.
        </p>
      )}
    </Panel>
  );
}

async function waitForConfirmation(connection: Connection, signature: string, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const s = value[0];
    if (s?.err) throw Object.assign(new Error(`Transaction failed: ${JSON.stringify(s.err)}`), { signature, logs: s.err });
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Object.assign(new Error("Timed out waiting for confirmation. Check the explorer before retrying."), { signature });
}

function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-[4px] border bg-card p-4 sm:p-5">
      {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

function Row({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 px-3 py-2", !last && "border-b")}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function FeeLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span className="num text-foreground">{value}</span>
    </div>
  );
}

function ActionButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[2px] bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-[color-mix(in_srgb,var(--primary),#000_12%)] disabled:pointer-events-none disabled:opacity-45"
    >
      {children}
    </button>
  );
}
