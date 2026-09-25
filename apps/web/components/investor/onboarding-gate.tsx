"use client";

// One screen, one signature (SPEC section 6): connect → pre-flight (SOL + USDC) → one checkbox next
// to the 5-line agreement summary → one signMessage → the server checks invite + signature and
// allowlists the wallet → "Trading enabled". Used full-size on /onboard/[id] and inline on the
// market page when an unregistered wallet presses Buy.
import { useState, type ReactNode } from "react";
import Link from "next/link";
import bs58 from "bs58";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ArrowRight, Check, ChevronDown, CircleAlert, Loader2, ShieldCheck, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgreementText } from "@/components/agreement-text";
import { TxLink } from "@/components/explorer-link";
import { shortAddr } from "@/components/format";
import { ELIGIBILITY_STATEMENT, agreementAcceptanceMessage } from "@/lib/server/agreement-message";
import { api, announceMarketChange, isUserRejection, useInvite, useWalletStatus, type WalletStatus } from "./client";
import { ZkKycPanel } from "./zk-kyc-panel";

export interface GateAgreement {
  hash: string;
  version: string;
  text: string;
  summary: string[];
}

export interface OnboardingGateProps {
  issuanceId: string;
  symbol: string;
  agreement: GateAgreement;
  /** COPY.onboardingSteps labels, in order, and COPY.selfAttested. */
  steps: readonly [string, string, string];
  selfAttested: string;
  inviteFromUrl: string | null;
  variant: "page" | "inline";
  /** Inline only: submit the buy anyway so the transfer hook rejects it (the NotEligible demo beat). */
  onTryAnyway?: () => void;
  /** Inline only: close the gate. */
  onCancel?: () => void;
}

export function OnboardingGate(props: OnboardingGateProps) {
  const { issuanceId, symbol, agreement, steps, variant } = props;
  const { wallet, status, error: statusError, refresh } = useWalletStatus(issuanceId);
  const { signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const [invite, setInvite] = useInvite(issuanceId, props.inviteFromUrl);
  const [editingInvite, setEditingInvite] = useState(false);
  const [checked, setChecked] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [busy, setBusy] = useState<null | "sign" | "register">(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  // ZK passport path (Rarimo): when the market accepts it, on-chain KYC replaces the invite code.
  const [kycDone, setKycDone] = useState<{ tx: string | null } | null>(null);
  const kycMode = Boolean(status?.kyc?.available);
  const kycReady = Boolean(kycDone) || Boolean(status?.kyc?.allowlisted);
  const [enabledFor, setEnabled] = useState<{ wallet: string; allowlistTx: string | null } | null>(null);
  // Only counts for the wallet that just signed: switching wallets must not carry "Trading enabled" over.
  const enabled = enabledFor && enabledFor.wallet === wallet ? enabledFor : null;

  const registered = Boolean(enabled) || Boolean(status?.registered);
  const step = !wallet ? 0 : registered ? 2 : 1;
  const inviteMissing = Boolean(status?.inviteRequired) && invite.trim() === "";
  const canSign = Boolean(wallet && status && checked && !busy && (kycMode ? kycReady : !inviteMissing));

  async function acceptAndSign() {
    if (!wallet || !status) return;
    setError(null);
    if (!signMessage) {
      setError({ code: "unsupported", message: "This wallet can't sign messages. Try Phantom, Backpack or Solflare." });
      return;
    }
    const message = agreementAcceptanceMessage({ issuanceId, wallet, agreementHash: agreement.hash });
    let signature: string;
    try {
      setBusy("sign");
      signature = bs58.encode(await signMessage(new TextEncoder().encode(message)));
    } catch (e) {
      setBusy(null);
      setError(
        isUserRejection(e)
          ? { code: "rejected", message: "Signature cancelled in the wallet. Nothing was recorded." }
          : { code: "sign_failed", message: (e as Error).message || "The wallet couldn't sign the message." },
      );
      return;
    }
    try {
      setBusy("register");
      const res = await api<{ participant: { allowlistTx: string | null } }>(`/api/issuances/${issuanceId}/participants`, {
        method: "POST",
        body: {
          wallet,
          eligible: true,
          agreementHash: agreement.hash,
          signature,
          ...(kycMode ? { kyc: true, kycTx: kycDone?.tx ?? undefined } : { invite: invite.trim() || undefined }),
        },
      });
      setEnabled({ wallet, allowlistTx: res.participant.allowlistTx });
      announceMarketChange();
      await refresh();
    } catch (e) {
      const err = e as { code?: string; message: string };
      setError({ code: err.code ?? "error", message: err.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={cn("space-y-5", variant === "page" && "rounded-[4px] border bg-card p-5 shadow-[0_10px_34px_rgba(40,35,25,0.1)] sm:p-6 dark:shadow-[0_6px_24px_rgba(0,0,0,0.6)]")}>
      <Steps steps={steps} active={step} />

      {/* ---------------------------------------------------------- 1. connect */}
      {!wallet && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Connect the wallet you&apos;ll hold {symbol} in. You&apos;ll sign one message, no transaction and no fee.
          </p>
          <button
            type="button"
            onClick={() => setVisible(true)}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-[2px] bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-[color-mix(in_srgb,var(--primary),#000_12%)]"
          >
            <Wallet className="size-4" /> Connect wallet
          </button>
        </div>
      )}

      {wallet && !status && !statusError && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking {shortAddr(wallet)}…
        </p>
      )}
      {wallet && statusError && <Callout tone="error">{statusError}</Callout>}

      {/* ---------------------------------------------------------- done */}
      {wallet && status && registered && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-[3px] border border-positive/30 bg-positive-soft p-4">
            <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-positive text-background">
              <Check className="size-3.5" />
            </span>
            <div className="min-w-0 space-y-1 text-sm">
              <p className="font-medium">{steps[2]}</p>
              <p className="text-muted-foreground">
                {shortAddr(wallet)} is on the {symbol} allowlist. {props.selfAttested}.
              </p>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                Allowlist tx <TxLink sig={enabled?.allowlistTx ?? status.participant?.allowlistTx} />
              </p>
            </div>
          </div>
          {variant === "page" && (
            <Link
              href={`/market/${issuanceId}`}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-[2px] bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-[color-mix(in_srgb,var(--primary),#000_12%)]"
            >
              Go to the {symbol} market <ArrowRight className="size-4" />
            </Link>
          )}
        </div>
      )}

      {/* ---------------------------------------------------------- 2. accept + sign */}
      {wallet && status && !registered && (
        <div className="space-y-4">
          <Preflight status={status} />

          {kycMode && status.kyc && (
            <ZkKycPanel
              issuanceId={issuanceId}
              wallet={wallet}
              kyc={status.kyc}
              onDone={(tx) => setKycDone({ tx })}
              onError={(e) => setError(e.message ? e : null)}
            />
          )}

          {!kycMode && status.inviteRequired && (editingInvite || inviteMissing || error?.code === "invalid_invite") && (
            <label className="block space-y-1.5">
              <span className="label-mono">Invite code</span>
              <input
                value={invite}
                onChange={(e) => {
                  setEditingInvite(true);
                  setInvite(e.target.value);
                }}
                placeholder="From the issuer's invite link"
                className="h-9 w-full rounded-[2px] border border-input bg-card px-3 font-mono text-sm outline-none focus-visible:border-brand"
              />
              <span className="block text-xs text-muted-foreground">Closed pilot: onboarding needs the invite link from the issuer.</span>
            </label>
          )}

          <div className="rounded-[3px] border bg-surface">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
              <span className="label-mono text-muted-foreground">Agreement {agreement.version}</span>
              <span className="font-mono text-[10px] text-faint" title={`sha256 ${agreement.hash}`}>
                sha256 {agreement.hash.slice(0, 8)}…{agreement.hash.slice(-4)}
              </span>
            </div>
            <ol className="space-y-2 px-4 py-3 text-sm">
              {agreement.summary.map((line, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="mt-0.5 w-4 shrink-0 font-mono text-[10px] text-brand">{String(i + 1).padStart(2, "0")}</span>
                  <span className="text-muted-foreground">{line}</span>
                </li>
              ))}
            </ol>
            <div className="border-t px-4 py-2">
              <button
                type="button"
                onClick={() => setShowFull((v) => !v)}
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                aria-expanded={showFull}
              >
                <ChevronDown className={cn("size-3.5 transition-transform", showFull && "rotate-180")} />
                {showFull ? "Hide the full agreement" : "Read the full agreement"}
              </button>
              {showFull && (
                <div className="mt-3 max-h-80 overflow-y-auto border-t pt-3 pr-1">
                  <AgreementText markdown={agreement.text} />
                  <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">sha256 {agreement.hash}</p>
                </div>
              )}
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-[3px] border border-input p-3 has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
            />
            <span className="text-sm font-semibold text-strong">{ELIGIBILITY_STATEMENT}</span>
          </label>

          {error && error.code !== "invalid_invite" && <Callout tone="error">{error.message}</Callout>}
          {error?.code === "invalid_invite" && <Callout tone="error">That invite code isn&apos;t valid for this issuance.</Callout>}

          <button
            type="button"
            disabled={!canSign}
            onClick={acceptAndSign}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-[2px] bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-[color-mix(in_srgb,var(--primary),#000_12%)] disabled:pointer-events-none disabled:opacity-45"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            {busy === "sign" ? "Confirm in your wallet…" : busy === "register" ? "Enabling trading…" : "Sign and enable trading"}
          </button>
          <p className="text-xs text-muted-foreground">
            One signature over the agreement hash, no transaction. Founder Stack then adds {shortAddr(wallet)} to the{" "}
            {symbol} transfer-hook allowlist.
          </p>

          {variant === "inline" && props.onTryAnyway && (
            <div className="border-t pt-3 text-xs text-muted-foreground">
              Skip onboarding?{" "}
              <button type="button" onClick={props.onTryAnyway} className="font-medium text-foreground underline underline-offset-4">
                Submit the buy anyway
              </button>{" "}
              and the token&apos;s transfer hook will reject it.
            </div>
          )}
        </div>
      )}

      {variant === "inline" && props.onCancel && (
        <button type="button" onClick={props.onCancel} className="text-xs text-muted-foreground hover:text-foreground">
          ← Back
        </button>
      )}
    </div>
  );
}

function Steps({ steps, active }: { steps: readonly string[]; active: number }) {
  return (
    <ol className="flex items-center gap-2 text-xs">
      {steps.map((label, i) => (
        <li key={label} className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]",
              i < active && "border-positive bg-positive text-background",
              i === active && (active === steps.length - 1 ? "border-positive bg-positive text-background" : "border-brand bg-brand-soft text-brand"),
              i > active && "text-muted-foreground",
            )}
          >
            {i < active || (i === active && active === steps.length - 1) ? <Check className="size-3" /> : i + 1}
          </span>
          <span className={cn("truncate", i === active ? "font-medium text-foreground" : "hidden text-muted-foreground sm:inline")}>{label}</span>
          {i < steps.length - 1 && <span className="h-px w-4 shrink-0 bg-border sm:w-6" />}
        </li>
      ))}
    </ol>
  );
}

function Preflight({ status }: { status: WalletStatus }) {
  const { funds, preflight } = status;
  const rows = [
    { ok: preflight.hasSol, label: "SOL for network fees", value: funds.sol.display, fix: `Needs at least ${preflight.minSol}` },
    { ok: preflight.hasUsdc, label: "USDC to buy with", value: `${funds.usdc.display} USDC`, fix: "Fund this wallet with USDC before buying" },
  ];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="label-mono">Pre-flight · {shortAddr(status.wallet)}</span>
        {funds.simulated && (
          <span className="rounded bg-muted px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground" title="Local fake chain (CHAIN_MODE=fake): balances are notional">
            sim
          </span>
        )}
      </div>
      <ul className="divide-y rounded-[3px] border text-sm">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="flex items-center gap-2">
              {r.ok ? <Check className="size-4 text-positive" /> : <CircleAlert className="size-4 text-warning" />}
              <span>{r.label}</span>
            </span>
            <span className="num text-right text-xs text-muted-foreground">{r.ok ? r.value : r.fix}</span>
          </li>
        ))}
      </ul>
      {!preflight.ready && (
        <p className="text-xs text-muted-foreground">You can onboard now and fund the wallet later; buying needs both.</p>
      )}
    </div>
  );
}

export function Callout({ tone, children }: { tone: "error" | "warning" | "positive"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-[3px] border px-3 py-2.5 text-sm",
        tone === "error" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "warning" && "border-warning/40 bg-warning-soft text-foreground",
        tone === "positive" && "border-positive/30 bg-positive-soft text-foreground",
      )}
    >
      {children}
    </div>
  );
}
