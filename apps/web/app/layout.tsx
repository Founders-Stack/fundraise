import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SolanaProvider } from "@/components/wallet-provider";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Founder Stack: Cash Flow Rights",
  description: "Raise against a share of future distributable cash flow, from Claude Code or Codex.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <SolanaProvider>
          <SiteHeader />
          <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
        </SolanaProvider>
      </body>
    </html>
  );
}
