import type { ReactNode } from "react";

// Renders the Cash Flow Participation Agreement markdown (headings, paragraphs, bullet lists,
// a blockquote banner, **bold**). Only the subset the template in @fstack/core uses.

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="font-medium text-foreground">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

export function AgreementText({ markdown }: { markdown: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
      para = [];
    }
    if (list.length) {
      blocks.push(
        <ul key={blocks.length} className="list-disc space-y-1 pl-5">
          {list.map((li, i) => (
            <li key={i}>{inline(li)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };

  for (const line of markdown.split("\n")) {
    if (line.startsWith("# ")) {
      flush();
      blocks.push(
        <h3 key={blocks.length} className="text-base font-semibold text-foreground">
          {line.slice(2)}
        </h3>,
      );
    } else if (line.startsWith("## ")) {
      flush();
      blocks.push(
        <h4 key={blocks.length} className="pt-1 text-sm font-medium text-foreground">
          {line.slice(3)}
        </h4>,
      );
    } else if (line.startsWith("> ")) {
      flush();
      blocks.push(
        <p key={blocks.length} className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-foreground">
          {inline(line.slice(2))}
        </p>,
      );
    } else if (line.startsWith("- ")) {
      if (para.length) flush();
      list.push(line.slice(2));
    } else if (line.trim() === "") {
      flush();
    } else if (line.startsWith("**")) {
      // "**Issuer:** Acme SaaS" header lines each stay on their own line
      flush();
      blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();

  return <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">{blocks}</div>;
}
