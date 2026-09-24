"use client";

// /issuance/new: preview → explicit confirm → create, against the existing issuer API.
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, CircleAlert, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusTag } from "@/components/fs";
import { issuerRequest, previewBody, type IssuanceFormValues } from "@/lib/view/issuance-form";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TOKEN_KEY = "fs-issuer-token";
const DEFAULTS: IssuanceFormValues = {
  issuerName: "",
  symbol: "",
  expectedAnnualDcf: "",
  poolPercent: "10",
  targetYieldPercent: "16",
  tokenSupply: "1000000",
  distributionFrequency: "QUARTERLY",
  graduationMultiple: "3",
};

export function NewIssuanceForm() {
  const [token, setToken] = useState("");
  const [values, setValues] = useState(DEFAULTS);
  const [preview, setPreview] = useState<Json | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);
  const [error, setError] = useState<{ message: string; errors?: string[] } | null>(null);
  const [created, setCreated] = useState<Json | null>(null);

  useEffect(() => {
    try {
      setToken(sessionStorage.getItem(TOKEN_KEY) ?? "");
    } catch {}
  }, []);

  const set = (k: keyof IssuanceFormValues) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [k]: e.target.value }));
    // Any edit invalidates the preview: the founder must confirm exactly what they saw.
    setPreview(null);
    setConfirmed(false);
  };

  async function run(kind: "preview" | "create") {
    setBusy(kind);
    setError(null);
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {}
    const req =
      kind === "preview"
        ? issuerRequest("/api/issuances/preview", token, previewBody(values))
        : issuerRequest("/api/issuances", token, { previewId: preview!.previewId });
    try {
      const res = await fetch(req.url, req.init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError({ message: body.message ?? `Request failed (${res.status})`, errors: body.details?.errors });
        return;
      }
      if (kind === "preview") {
        setPreview(body);
        setConfirmed(false);
      } else setCreated(body);
    } catch (e) {
      setError({ message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (created) {
    return (
      <section className="space-y-4 rounded-xl border bg-card p-5">
        <div className="flex items-center gap-2">
          <StatusTag tone="positive" dot>Live</StatusTag>
          <h2 className="text-[15px] font-semibold">{created.symbol} is live</h2>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Field label="Unit mint" value={<Mono>{created.baseMint}</Mono>} />
          <Field label="Meteora DBC pool" value={<Mono>{created.dbcPool}</Mono>} />
          <Field label="Agreement sha256" value={<Mono>{created.agreementHash}</Mono>} />
          <Field label="Invite link (share with investors)" value={<Mono>{created.onboardUrl}</Mono>} />
        </dl>
        <Link href={`/market/${created.issuanceId}`} className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4">
          Open the market <ArrowRight className="size-3.5" />
        </Link>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
        <h2 className="text-[15px] font-semibold">Terms</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Labeled label="Company name">
            <Input value={values.issuerName} onChange={set("issuerName")} placeholder="Acme Inc." />
          </Labeled>
          <Labeled label="Symbol">
            <Input value={values.symbol} onChange={set("symbol")} placeholder="ACME-CF" />
          </Labeled>
          <Labeled label="Expected annual Distributable Cash Flow (USDC)">
            <Input inputMode="decimal" value={values.expectedAnnualDcf} onChange={set("expectedAnnualDcf")} placeholder="1600000" />
          </Labeled>
          <Labeled label="Share of each period's DCF (%)">
            <Input inputMode="decimal" value={values.poolPercent} onChange={set("poolPercent")} />
          </Labeled>
          <Labeled label="Target initial yield (%)">
            <Input inputMode="decimal" value={values.targetYieldPercent} onChange={set("targetYieldPercent")} />
          </Labeled>
          <Labeled label="Units (fixed supply)">
            <Input inputMode="numeric" value={values.tokenSupply} onChange={set("tokenSupply")} />
          </Labeled>
          <Labeled label="Distribution frequency">
            <select
              value={values.distributionFrequency}
              onChange={set("distributionFrequency")}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            >
              <option value="QUARTERLY">Quarterly</option>
              <option value="MONTHLY">Monthly</option>
            </select>
          </Labeled>
          <Labeled label="Graduation multiple">
            <Input inputMode="decimal" value={values.graduationMultiple} onChange={set("graduationMultiple")} />
          </Labeled>
          <Labeled label="Issuer API token" hint="Kept in this browser tab only (sessionStorage).">
            <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </Labeled>
        </div>
        <Button onClick={() => run("preview")} disabled={busy !== null || !token}>
          {busy === "preview" && <Loader2 className="animate-spin" />} Preview
        </Button>
      </section>

      {error && (
        <div role="alert" className="flex gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium">{error.message}</p>
            {error.errors && (
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                {error.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {preview && <PreviewTables preview={preview} />}

      {preview && (
        <section className="space-y-4 rounded-xl border border-brand/40 bg-brand-soft/40 p-4 sm:p-5">
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1 size-4 accent-[var(--brand)]" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>
              I reviewed this preview. Create {preview.terms.symbol}: a fixed-supply Token-2022 mint with the allowlist transfer hook and a
              Meteora DBC pool, bound to agreement sha256 <Mono>{preview.agreement.hash.slice(0, 16)}…</Mono>. This creates on-chain state
              and cannot be undone.
            </span>
          </label>
          <Button onClick={() => run("create")} disabled={!confirmed || busy !== null}>
            {busy === "create" && <Loader2 className="animate-spin" />} Confirm and create
          </Button>
        </section>
      )}
    </div>
  );
}

function PreviewTables({ preview: p }: { preview: Json }) {
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border bg-card">
        <header className="border-b px-4 py-3 sm:px-5">
          <h2 className="text-[15px] font-semibold">Price derivation</h2>
          <p className="text-xs text-muted-foreground">The starting price is set by the target yield, not by a company estimate.</p>
        </header>
        <table className="w-full text-sm">
          <tbody className="divide-y">
            {(p.pricing.derivation as Json[]).map((d) => (
              <tr key={d.step} className="[&>td]:px-4 [&>td]:py-2.5 sm:[&>td]:px-5">
                <td className="label-mono">{d.step}</td>
                <td className="num text-muted-foreground">{d.formula}</td>
                <td className="num text-right font-medium">{d.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
        <h2 className="text-[15px] font-semibold">What you give up</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {(p.agreement.summary as string[]).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          {p.terms.poolPercentage} of each period&apos;s reported cash flow, about {p.pricing.expectedAnnualRightsPool.display ?? p.pricing.expectedAnnualRightsPool.usdc}{" "}
          a year at the expected DCF. First record date if launched now: {new Date(p.nextRecordDateIfLaunchedNow).toISOString().slice(0, 10)}.
        </p>
      </section>

      <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
        <h2 className="text-[15px] font-semibold">Fees</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {(p.fees.description.lines as Json[]).map((l) => (
            <Field key={l.label} label={l.label} value={l.value} />
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          {p.projectedGraduation.label}: startup {p.projectedGraduation.issuer.display ?? p.projectedGraduation.issuer.usdc}, Founder Stack{" "}
          {p.projectedGraduation.founderStack.display ?? p.projectedGraduation.founderStack.usdc}, locked liquidity{" "}
          {p.projectedGraduation.liquidity.display ?? p.projectedGraduation.liquidity.usdc}. {p.projectedGraduation.note}
        </p>
      </section>

      <section className="space-y-2 rounded-xl border bg-card p-4 sm:p-5">
        <h2 className="text-[15px] font-semibold">Agreement</h2>
        <p className="text-sm">Cash Flow Participation Agreement {p.agreement.version}</p>
        <p className="break-all font-mono text-[11px] text-muted-foreground">sha256 {p.agreement.hash}</p>
        <p className="text-xs text-muted-foreground">{p.custody}</p>
      </section>
    </div>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="label-mono">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="label-mono">{label}</dt>
      <dd className="mt-1 break-all">{value}</dd>
    </div>
  );
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-[12px]">{children}</span>;
