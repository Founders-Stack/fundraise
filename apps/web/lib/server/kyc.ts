// ZK-KYC (Rarimo ZK passport) for the investor onboarding: request a proof from Rarimo's hosted
// verificator, validate it, publish the identity-state root to fs_allowlist (Rarimo root relayer),
// and build the unsigned transaction the investor's wallet signs (submit_kyc_proof + add_allow_kyc).
// Devnet only (KYC_ENABLED=1). Needs KYC_ADMIN_KEYPAIR (the KycConfig admin) to relay roots.
import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { HttpError } from "@/lib/server/http";

const RARIMO_API = () => (process.env.RARIMO_API_URL ?? "https://api.app.rarime.com").replace(/\/$/, "");
const RARIMO_RPC = () => process.env.RARIMO_RPC ?? "https://l2.rarimo.com";
const RARIMO_SMT = () => process.env.RARIMO_SMT ?? "0x479F84502Db545FA8d2275372E0582425204A879";
const SEL_IS_ROOT_VALID = "0x30ef41b4";

const asciiHex = (s: string) => `0x${Buffer.from(s, "ascii").toString("hex")}`;

export function kycEnabled(): boolean {
  return process.env.CHAIN_MODE === "devnet" && process.env.KYC_ENABLED === "1";
}

async function rarimo<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${RARIMO_API()}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* handled below */
  }
  if (!res.ok) {
    const e = (parsed as { errors?: { title?: string; meta?: { error?: string } }[] } | null)?.errors?.[0];
    throw new HttpError(502, "kyc_provider_error", `Rarimo verificator: ${e?.meta?.error ?? e?.title ?? res.status}`);
  }
  return parsed as T;
}

async function ctx() {
  const d = await import("@/lib/chain/devnet");
  const env = d.devnetEnv();
  const info = await env.connection.getAccountInfo(d.kycConfigPda(env.allowlistProgram));
  if (!info) throw new HttpError(503, "kyc_unavailable", "KYC is not configured on this cluster (kyc-config missing)");
  return { d, env, config: d.decodeKycConfig(info.data) };
}

const requestId = (wallet: string) => `fsk-${wallet}`;
const asPubkey = (wallet: string) => {
  try {
    return new PublicKey(wallet);
  } catch {
    throw new HttpError(400, "invalid_input", "wallet must be a base58 Solana address");
  }
};

/** Per-wallet, per-mint KYC view for the onboarding gate. */
export async function kycWalletView(baseMint: string, walletRaw: string) {
  if (!kycEnabled()) return { available: false as const };
  const { d, env, config } = await ctx();
  const mint = new PublicKey(baseMint);
  const wallet = asPubkey(walletRaw);
  const [policy, att, allow] = await env.connection.getMultipleAccountsInfo([
    d.kycPolicyPda(env.allowlistProgram, mint),
    d.kycAttestationPda(env.allowlistProgram, wallet),
    d.allowPda(env.allowlistProgram, mint, wallet),
  ]);
  const attestation = att ? d.decodeKycAttestation(att.data) : null;
  const valid = attestation && attestation.expiresAt > Date.now() / 1000 && !config.blocked.includes(attestation.citizenship);
  return {
    available: Boolean(policy),
    minAge: config.minAge,
    blocked: config.blocked,
    attested: valid ? { citizenship: attestation.citizenship, expiresAt: new Date(attestation.expiresAt * 1000).toISOString() } : null,
    allowlisted: Boolean(allow && d.allowEntryActive(allow.data)),
  };
}

/** Start a proof request: returns the RariMe deep link (also usable as a QR code). */
export async function requestKycProof(walletRaw: string) {
  if (!kycEnabled()) throw new HttpError(503, "kyc_unavailable", "ZK KYC is not enabled on this deployment");
  const wallet = asPubkey(walletRaw);
  const { d, config } = await ctx();
  const eventData = await d.kycEventDataFor(wallet);
  const upper = d.ageUpperBoundYymmdd(new Date(), config.minAge);
  const r = await rarimo<{ data: { attributes: { get_proof_params: string } } }>(
    "/integrations/verificator-svc/v2/private/verification-link",
    {
      method: "POST",
      body: {
        data: {
          id: requestId(wallet.toBase58()),
          type: "advanced_verification",
          attributes: {
            event_id: BigInt(`0x${config.eventId.toString("hex")}`).toString(10), // the API wants decimal
            selector: String(d.KYC_SELECTOR),
            event_data: eventData,
            birth_date_lower_bound: asciiHex("000000"),
            birth_date_upper_bound: asciiHex(upper),
          },
        },
      },
    },
  );
  const proofParamsUrl = r.data.attributes.get_proof_params;
  const link = `https://app.rarime.com/external?type=proof-request&proof_params_url=${encodeURIComponent(proofParamsUrl)}`;
  return { link, minAge: config.minAge, blockedCitizenships: config.blocked };
}

async function rarimoRootValid(root: Buffer): Promise<boolean> {
  const res = await fetch(RARIMO_RPC(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: RARIMO_SMT(), data: SEL_IS_ROOT_VALID + root.toString("hex") }, "latest"] }),
    signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json());
  return typeof res.result === "string" && BigInt(res.result) === 1n;
}

/** Relay a Rarimo identity-state root into fs_allowlist (after Rarimo confirms it is valid). */
async function ensureRoot(connection: Connection, root: Buffer) {
  const { d, env, config } = await ctx();
  if (config.roots.some((r) => r.equals(root))) return;
  if (!(await rarimoRootValid(root))) {
    throw new HttpError(422, "kyc_root_invalid", "Rarimo does not (or no longer) accept this proof's identity-state root. Request the proof again.");
  }
  if (!process.env.KYC_ADMIN_KEYPAIR) throw new HttpError(503, "kyc_unavailable", "KYC_ADMIN_KEYPAIR is not set; cannot relay the Rarimo root");
  const admin = d.loadKeypair(process.env.KYC_ADMIN_KEYPAIR);
  const tx = new Transaction().add(await d.pushKycRootIx({ program: env.allowlistProgram, admin: admin.publicKey, root }));
  await d.sendTx(connection, tx, [admin], "push_kyc_root");
}

const pubFromDecimal = (s: string) => BigInt(s);

/**
 * Poll: has the wallet's proof arrived? When it has (or the wallet already holds a valid attestation)
 * returns the unsigned base64 transaction to sign: [compute budget, submit_kyc_proof?, add_allow_kyc].
 */
export async function kycTransaction(baseMint: string, walletRaw: string) {
  if (!kycEnabled()) throw new HttpError(503, "kyc_unavailable", "ZK KYC is not enabled on this deployment");
  const wallet = asPubkey(walletRaw);
  const mint = new PublicKey(baseMint);
  const { d, env, config } = await ctx();
  const { connection, allowlistProgram: program } = env;

  const view = await kycWalletView(baseMint, wallet.toBase58());
  if (!view.available) throw new HttpError(409, "kyc_not_enabled", "This market does not accept ZK KYC onboarding");

  const ixs = [];
  let citizenship: string;
  if (view.attested) {
    citizenship = view.attested.citizenship;
  } else {
    const st = await rarimo<{ data: { attributes: { status: string } } }>(
      `/integrations/verificator-svc/private/verification-status/${requestId(wallet.toBase58())}`,
    ).catch((e) => {
      if (e instanceof HttpError && /Not Found/.test(e.message)) return null;
      throw e;
    });
    const status = st?.data.attributes.status ?? "not_requested";
    if (status === "not_verified" || status === "not_requested") return { status: "pending" as const };
    if (status !== "verified") throw new HttpError(422, "kyc_failed", `Rarimo could not verify the proof (${status})`);

    const pr = await rarimo<{ data: { attributes: { proof: { proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] } | null; pub_signals: string[] | null } } } }>(
      `/integrations/verificator-svc/private/proof/${requestId(wallet.toBase58())}`,
    );
    const { proof, pub_signals: pub } = pr.data.attributes.proof;
    if (!proof || !pub) return { status: "pending" as const };

    // pre-flight the same checks the program makes, so the investor gets a readable error, not a failed tx
    const eventData = await d.kycEventDataFor(wallet);
    if (pub.length !== 23) throw new HttpError(422, "kyc_bad_proof", "Unexpected proof shape");
    if (pubFromDecimal(pub[10]) !== BigInt(eventData)) throw new HttpError(422, "kyc_bad_proof", "This proof is not bound to your wallet");
    if (pubFromDecimal(pub[9]) !== BigInt(`0x${config.eventId.toString("hex")}`)) throw new HttpError(422, "kyc_bad_proof", "Proof was generated for a different event");
    const args = d.kycArgsFromSnarkjs(proof, pub);
    const cit = String.fromCharCode((args.citizenship >> 16) & 0xff, (args.citizenship >> 8) & 0xff, args.citizenship & 0xff);
    if (config.blocked.includes(cit)) throw new HttpError(403, "kyc_country_blocked", `Passports from ${cit} cannot be onboarded on this market`);
    await ensureRoot(connection, args.root);
    citizenship = cit;
    ixs.push(d.kycComputeBudgetIx(), await d.submitKycProofIx({ program, wallet, args }));
  }
  ixs.push(await d.addAllowKycIx({ program, wallet, mint }));

  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet;
  const bh = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.lastValidBlockHeight = bh.lastValidBlockHeight;
  return {
    status: "verified" as const,
    citizenship,
    tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
  };
}

/**
 * For registerParticipant(kyc): the wallet's AllowEntry for this mint is active on-chain.
 * Returns the latest transaction that touched the AllowEntry (shown as the "Allowlist tx").
 */
export async function requireKycAllowed(baseMint: string, walletRaw: string): Promise<string | null> {
  if (!kycEnabled()) throw new HttpError(400, "kyc_unavailable", "ZK KYC onboarding is not available");
  const v = await kycWalletView(baseMint, walletRaw);
  if (!v.available || !v.allowlisted || !v.attested) {
    throw new HttpError(409, "kyc_not_completed", "Complete the ZK passport verification first (the on-chain allowlist entry is not active yet)");
  }
  const { d, env } = await ctx();
  const sigs = await env.connection.getSignaturesForAddress(
    d.allowPda(env.allowlistProgram, new PublicKey(baseMint), asPubkey(walletRaw)),
    { limit: 1 },
    "confirmed",
  );
  return sigs[0]?.signature ?? null;
}
