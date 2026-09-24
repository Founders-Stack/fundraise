import type { Metadata } from "next";
import localFont from "next/font/local";
import { Geist_Mono } from "next/font/google";
import { COPY } from "@fstack/core";
import { SolanaProvider } from "@/components/wallet-provider";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

// Founder Stack type system (f-stack.ai): Instrument Sans for text, Instrument Serif italic for the
// one accent word, Geist Mono for labels, figures and addresses.
const instrumentSans = localFont({
  src: "./fonts/InstrumentSans-Variable.ttf",
  variable: "--font-instrument-sans",
  display: "swap",
  weight: "400 700",
});
const instrumentSerif = localFont({
  src: "./fonts/InstrumentSerif-Italic.ttf",
  variable: "--font-instrument-serif",
  display: "swap",
  style: "italic",
  weight: "400",
});
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Founder Stack: Cash Flow Rights",
  description: "Raise against a share of future distributable cash flow, from Claude Code or Codex.",
};

// Runs before paint: stored choice, else the OS preference. `?theme=dark|light` overrides (for demos).
const themeScript = `(function(){try{var q=new URLSearchParams(location.search).get('theme');if(q==='dark'||q==='light'){localStorage.setItem('fs-theme',q)}var t=localStorage.getItem('fs-theme');var d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${instrumentSans.variable} ${instrumentSerif.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <SolanaProvider>
          <SiteHeader />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">{children}</main>
          <footer className="border-t">
            <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <p>{COPY.demoBanner}</p>
              <a href="https://f-stack.ai" target="_blank" rel="noreferrer" className="hover:text-foreground">
                Founder Stack · f-stack.ai
              </a>
            </div>
          </footer>
        </SolanaProvider>
      </body>
    </html>
  );
}
