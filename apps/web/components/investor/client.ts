"use client";

// Client-side plumbing shared by the onboarding gate, the trade panel and the live holders table.
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init?.signal,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? `Request failed (${res.status})`);
  return data as T;
}

/** Tell every live widget on the page that balances changed (after a confirmed swap or onboarding). */
export const MARKET_CHANGED = "fs:market-changed";
export function announceMarketChange() {
  window.dispatchEvent(new Event(MARKET_CHANGED));
}

// ---------------------------------------------------------------- wallet status

type Usdc = { baseUnits: string; usdc: string; display: string };
type Units = { baseUnits: string; amount: string; display: string };

export interface WalletStatus {
  wallet: string;
  registered: boolean;
  participant: { agreementAcceptedAt: string | null; verification: string; allowlistTx: string | null } | null;
  inviteRequired: boolean;
  /** ZK passport onboarding (Rarimo). `available` only when this deployment + mint support it. */
  kyc?: {
    available: boolean;
    minAge?: number;
    blocked?: string[];
    attested?: { citizenship: string; expiresAt: string } | null;
    allowlisted?: boolean;
  };
  funds: { simulated: boolean; sol: { lamports: string; display: string }; usdc: Usdc; units: Units };
  preflight: { hasSol: boolean; hasUsdc: boolean; minSol: string; ready: boolean };
  message: string;
}

/** Onboarding state + pre-flight funds of the connected wallet for this issuance; refetches on market changes. */
export function useWalletStatus(issuanceId: string) {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    setLoading(true);
    try {
      const s = await api<WalletStatus>(`/api/issuances/${issuanceId}/wallets/${wallet}`);
      setStatus(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [issuanceId, wallet]);

  useEffect(() => {
    setStatus(null);
    if (!wallet) return;
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(MARKET_CHANGED, onChange);
    return () => window.removeEventListener(MARKET_CHANGED, onChange);
  }, [wallet, refresh]);

  return { wallet, status: status?.wallet === wallet ? status : null, error, loading, refresh };
}

// ---------------------------------------------------------------- invite code

const inviteKey = (issuanceId: string) => `fs-invite:${issuanceId}`;

/**
 * The invite code from the ?invite= link, remembered per issuance so the inline gate on the market
 * page still has it after the investor navigates there from the onboarding link.
 */
export function useInvite(issuanceId: string, fromUrl: string | null) {
  const [invite, setInviteState] = useState(fromUrl ?? "");
  useEffect(() => {
    try {
      if (fromUrl) localStorage.setItem(inviteKey(issuanceId), fromUrl);
      else setInviteState(localStorage.getItem(inviteKey(issuanceId)) ?? "");
    } catch {
      /* storage unavailable: the code only lives in this page's state */
    }
  }, [issuanceId, fromUrl]);
  const setInvite = useCallback(
    (v: string) => {
      setInviteState(v);
      try {
        localStorage.setItem(inviteKey(issuanceId), v.trim());
      } catch {
        /* ignore */
      }
    },
    [issuanceId],
  );
  return [invite, setInvite] as const;
}

// ---------------------------------------------------------------- errors

/** True when a failed transaction was rejected by the fs_allowlist transfer hook (NotEligible, code 6000 = 0x1770). */
export function isNotEligible(e: unknown): boolean {
  const parts: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (!v || depth > 3) return;
    if (typeof v === "string") parts.push(v);
    else if (v instanceof Error) {
      parts.push(v.message, String((v as { code?: unknown }).code ?? ""));
      walk((v as { error?: unknown }).error, depth + 1);
      walk((v as { logs?: unknown }).logs, depth + 1);
      walk((v as { transactionLogs?: unknown }).transactionLogs, depth + 1);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === "object") walk(JSON.stringify(v), depth + 1);
  };
  walk(e, 0);
  const text = parts.join("\n");
  return /NotEligible|0x1770\b/.test(text);
}

export function isUserRejection(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? "";
  const msg = (e as Error)?.message ?? "";
  return /WalletSignMessageError|WalletSignTransactionError/.test(name) ? /reject|denied|cancel/i.test(msg) : /User rejected|rejected the request/i.test(msg);
}
