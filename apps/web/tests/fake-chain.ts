// One in-memory fake chain per test file (vitest isolates modules per file), installed by tests/setup.ts.
// Tests drive it through `fake.control` (swaps, issuer balance) and never touch apps/web/.fake-chain.json.
import { createFakeChain } from "@/lib/chain/fake";

export const fake = createFakeChain({ file: null });
