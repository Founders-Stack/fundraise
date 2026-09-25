import { appUrl } from "@/lib/server/http";
import { ConnectFlow } from "@/components/auth/connect-flow";

export const dynamic = "force-dynamic";

// Founder sign-in: prove control of a wallet, get an API key for the fstack agent (Claude Code / Codex).
export default function ConnectPage() {
  return (
    <div className="fs-backdrop -mx-4 -mt-8 px-4 pt-12 pb-4 sm:-mx-6 sm:-mt-10 sm:px-6 sm:pt-16">
      <div className="mx-auto max-w-xl space-y-6">
        <div className="space-y-3 text-center">
          <p className="eyebrow">For founders</p>
          <h1 className="text-[clamp(1.75rem,5vw,2.5rem)] leading-[1] font-semibold tracking-[-0.04em] text-balance">Connect your agent</h1>
          <p className="mx-auto max-w-md text-sm text-muted-foreground text-pretty">
            Sign one free message with your wallet to get an API key. Your agent uses it to launch and manage your own token; it
            can&apos;t touch anyone else&apos;s.
          </p>
        </div>
        <div className="space-y-5 rounded-[4px] border bg-card p-5 sm:p-6">
          <ConnectFlow apiUrl={`${appUrl()}/api`} />
        </div>
      </div>
    </div>
  );
}
