// Selects the chain implementation. CHAIN_MODE=fake (default until real.ts lands) | devnet.
import type { ChainPorts } from "./ports";
import { createFakePorts } from "./fake";

let cached: ChainPorts | null = null;

export async function getChain(): Promise<ChainPorts> {
  if (cached) return cached;
  const mode = process.env.CHAIN_MODE ?? "fake";
  if (mode === "devnet") {
    // real.ts is implemented by the chain workstream (W2-chain). Keep the import dynamic
    // so the fake path never loads the Meteora / Solana SDKs.
    const { createDevnetPorts } = await import("./real");
    cached = await createDevnetPorts();
  } else {
    cached = createFakePorts();
  }
  return cached;
}

export type * from "./ports";
