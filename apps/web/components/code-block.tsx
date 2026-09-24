"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border bg-surface">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">{label ?? "shell"}</span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Copy to clipboard"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed">
        {code.split("\n").map((line, i) => (
          <div key={i} className={line.startsWith("#") ? "text-muted-foreground" : line.startsWith(">") ? "text-brand" : undefined}>
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
