// Devnet implementation of the chain ports (Meteora DBC + Token-2022 + fs_allowlist).
// OWNED BY the W2-chain workstream. Placeholder until then.
import type { ChainPorts } from "./ports";

export async function createDevnetPorts(): Promise<ChainPorts> {
  throw new Error("CHAIN_MODE=devnet is not implemented yet (lib/chain/real.ts)");
}
