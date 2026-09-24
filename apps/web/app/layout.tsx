import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { COPY } from "@fstack/core";
import { SolanaProvider } from "@/components/wallet-provider";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Founder Stack: Cash Flow Rights",
  description: "Raise against a share of future distributable cash flow, from Claude Code or Codex.",
};

// Runs before paint: stored choice, else the OS preference. `?theme=dark|light` overrides (for demos).
const themeScript = `(function(){try{var q=new URLSearchParams(location.search).get('theme');if(q==='dark'||q==='light'){localStorage.setItem('fs-theme',q)}var t=localStorage.getItem('fs-theme');var d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <SolanaProvider>
          <SiteHeader />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">{children}</main>
          <footer className="border-t">
            <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <p>{COPY.demoBanner}</p>
              <p>{COPY.positioning.eligibility}</p>
            </div>
          </footer>
        </SolanaProvider>
      </body>
    </html>
  );
}
