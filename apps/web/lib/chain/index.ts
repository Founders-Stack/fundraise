// Selects the chain implementation: CHAIN_MODE=fake (default) | devnet. Tests inject their own with setChain().
import type { ChainPorts } from "./ports";
import { createFakeChain } from "./fake";

let cached: ChainPorts | null = null;

export async function getChain(): Promise<ChainPorts> {
  if (cached) return cached;
  const mode = process.env.CHAIN_MODE ?? "fake";
  if (mode === "devnet") {
    // Keep the import dynamic so the fake path never loads the Meteora / Solana SDKs.
    const { createDevnetPorts } = await import("./real");
    cached = await createDevnetPorts();
  } else {
    cached = createFakeChain().ports;
  }
  return cached;
}

/** Uses `ports` for every later getChain() (tests: an in-memory fake). `null` goes back to CHAIN_MODE. */
export function setChain(ports: ChainPorts | null): void {
  cached = ports;
}

export type * from "./ports";
