// Landing page sections (SPEC 9.1), f-stack.ai style. All copy lives in lib/landing (linted by tests).
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Clock, PlayCircle } from "lucide-react";
import { LANDING_COPY as C, LANDING_LINKS, videoEmbed } from "@/lib/landing";
import type { LandingProof, ProofLink } from "@/lib/server/landing-proof";

const secondaryBtn =
  "inline-flex h-10 items-center gap-2 rounded-[2px] border border-input bg-muted px-4 text-sm font-semibold hover:bg-secondary";

export function PilotCta({ href, isMainnet }: { href: string | null; isMainnet: boolean }) {
  if (!href) {
    return (
      <span className={`${secondaryBtn} cursor-default text-muted-foreground hover:bg-muted`}>
        <Clock className="size-4" /> {isMainnet ? C.hero.ctaPilotSoon : C.hero.ctaDevnet}
      </span>
    );
  }
  return (
    <Link href={href} className={secondaryBtn}>
      {isMainnet ? C.hero.ctaPilot : C.hero.ctaDevnet} <ArrowRight className="size-4" />
    </Link>
  );
}

function SectionHead({ eyebrow, title, body }: { eyebrow: string; title?: string; body?: string }) {
  return (
    <div className="space-y-2">
      <p className="eyebrow">{eyebrow}</p>
      {title && <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>}
      {body && <p className="max-w-2xl text-sm text-muted-foreground">{body}</p>}
    </div>
  );
}

export function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-20 space-y-6">
      <SectionHead eyebrow={C.how.eyebrow} title={C.how.title} />
      <ol className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3">
        {C.how.steps.map((s, n) => (
          <li key={s.title} className="bg-card p-5">
            <span className="label-mono text-brand">0{n + 1}</span>
            <h3 className="mt-2 text-sm font-semibold">{s.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ForBothSides() {
  const cols = [C.sides.founders, C.sides.investors];
  return (
    <section className="grid gap-4 md:grid-cols-2">
      {cols.map((c) => (
        <div key={c.title} className="rounded-xl border bg-card p-5 sm:p-6">
          <h3 className="text-lg font-semibold tracking-tight">{c.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{c.does}</p>
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="label-mono">What you give up</dt>
              <dd className="mt-1">{c.givesUp}</dd>
            </div>
            <div>
              <dt className="label-mono">What you get / keep</dt>
              <dd className="mt-1 text-muted-foreground">{c.keeps}</dd>
            </div>
          </dl>
        </div>
      ))}
    </section>
  );
}

function ProofRow({ link }: { link: ProofLink }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt className="text-sm text-muted-foreground">{link.label}</dt>
      <dd className="min-w-0 truncate font-mono text-xs">
        {link.href ? (
          <a href={link.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-brand">
            {link.value} <ArrowUpRight className="size-3" />
          </a>
        ) : (
          link.value
        )}
      </dd>
    </div>
  );
}

function Soon() {
  return <span className="font-mono text-[10px] tracking-[0.08em] text-faint uppercase">{C.proof.soon}</span>;
}

function Video({ url }: { url: string }) {
  const v = videoEmbed(url);
  return (
    <div className="relative aspect-video overflow-hidden rounded-lg border bg-surface">
      {!v ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
          <PlayCircle className="size-8 text-faint" />
          <span className="text-sm">{C.proof.video}</span>
          <Soon />
        </div>
      ) : v.kind === "iframe" ? (
        <iframe
          src={v.src}
          title={C.proof.video}
          className="absolute inset-0 size-full"
          allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
        />
      ) : (
        <video src={v.src} controls preload="metadata" className="absolute inset-0 size-full bg-black" />
      )}
    </div>
  );
}

export function LiveProof({ proof }: { proof: LandingProof }) {
  return (
    <section id="proof" className="scroll-mt-20 grid gap-6 rounded-2xl border bg-card p-5 sm:p-8 lg:grid-cols-[1fr_1.1fr]">
      <div className="min-w-0 space-y-4">
        <SectionHead eyebrow={C.proof.eyebrow} title={C.proof.title} body={C.proof.body} />
        <dl className="divide-y border-y">
          <div className="flex items-center justify-between gap-3 py-2.5">
            <dt className="text-sm text-muted-foreground">{C.proof.cluster}</dt>
            <dd className="font-mono text-xs">{proof.clusterName}</dd>
          </div>
          {proof.addresses.map((a) => (
            <ProofRow key={a.label} link={a} />
          ))}
          <div className="py-2.5">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-sm text-muted-foreground">{C.proof.lastDistribution}</dt>
              <dd className="font-mono text-xs">{proof.lastDistribution ? proof.lastDistribution.period : <Soon />}</dd>
            </div>
            {proof.lastDistribution && proof.lastDistribution.links.length > 0 && (
              <dl className="mt-1 pl-3">
                {proof.lastDistribution.links.map((l) => (
                  <ProofRow key={l.value} link={l} />
                ))}
              </dl>
            )}
          </div>
        </dl>
      </div>
      <div className="min-w-0 self-center">
        <Video url={proof.videoUrl} />
      </div>
    </section>
  );
}

export function WhySolana() {
  return (
    <section className="space-y-6">
      <SectionHead eyebrow={C.why.eyebrow} />
      <div className="grid gap-4 sm:grid-cols-3">
        {C.why.items.map((it) => (
          <div key={it.title} className="rounded-xl border bg-card p-5">
            <h3 className="text-sm font-semibold">{it.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{it.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function HonestFraming({ banner }: { banner: string }) {
  return (
    <section className="rounded-xl border border-dashed p-5 sm:p-6">
      <p className="eyebrow">{C.honest.title}</p>
      <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
        {[banner, ...C.honest.lines].map((l) => (
          <li key={l} className="flex gap-2">
            <span className="text-brand">—</span>
            <span>{l}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LandingFooter() {
  const links = [
    { label: C.footer.repo, href: LANDING_LINKS.repoUrl },
    { label: C.footer.video, href: LANDING_LINKS.videoUrl },
    { label: C.footer.hackathon, href: LANDING_LINKS.hackathonUrl },
  ].filter((l) => l.href);
  return (
    <nav className="flex flex-wrap gap-x-6 gap-y-2 border-t pt-6 font-mono text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
      {links.map((l) => (
        <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
          {l.label} <ArrowUpRight className="size-3" />
        </a>
      ))}
    </nav>
  );
}
