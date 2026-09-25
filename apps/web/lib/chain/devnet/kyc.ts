// ZK-KYC client for fs_allowlist (Rarimo queryIdentity Groth16 proof verified on-chain).
// Raw Anchor instructions (no IDL), same style as ./allowlist.ts. Server- and browser-safe: no node
// built-ins other than `crypto` via the tiny sha256 helper below (Web Crypto is used in the browser).
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { allowPda, configPda } from "./allowlist";

/** Circuit event id every proof must be generated for: "fs-allowlist-kyc-v1" (matches the on-chain KycConfig). */
export const KYC_EVENT_ID_LABEL = "fs-allowlist-kyc-v1";
/** selector bits: 0 nullifier | 5 citizenship reveal | 15 birthDate < upper bound. */
export const KYC_SELECTOR = (1 << 0) | (1 << 5) | (1 << 15);

/** Compute-unit limit for submit_kyc_proof (~232k used). */
export const KYC_SUBMIT_CU = 400_000;

const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}
const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function disc(name: string): Promise<Buffer> {
  return Buffer.from((await sha256(utf8(`global:${name}`))).subarray(0, 8));
}

export const kycConfigPda = (program: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("kyc-config")], program)[0];
export const kycPolicyPda = (program: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("kyc-policy"), mint.toBuffer()], program)[0];
export const kycAttestationPda = (program: PublicKey, wallet: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("kyc"), wallet.toBuffer()], program)[0];
export const kycNullifierPda = (program: PublicKey, nullifier: Uint8Array) =>
  PublicKey.findProgramAddressSync([Buffer.from("nullifier"), Buffer.from(nullifier)], program)[0];

/** eventData the proof must carry for `wallet`: 31 bytes of sha256(pubkey) as a 0x-prefixed hex string. */
export async function kycEventDataFor(wallet: PublicKey): Promise<`0x${string}`> {
  return `0x${hex((await sha256(wallet.toBytes())).subarray(0, 31))}`;
}
/** The fixed circuit event id as a 0x-prefixed hex string (31 bytes, fits the 254-bit limit). */
export async function kycEventId(): Promise<`0x${string}`> {
  return `0x${hex((await sha256(utf8(KYC_EVENT_ID_LABEL))).subarray(0, 31))}`;
}

/** "Older than `minAge`": birth-date upper bound as passport YYMMDD (birthDate must be < this). */
export function ageUpperBoundYymmdd(now: Date, minAge = 18): string {
  const y = now.getUTCFullYear() - minAge;
  let d = now.getUTCDate();
  if (now.getUTCMonth() === 1 && d === 29 && !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) d = 28;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(y % 100)}${pad(now.getUTCMonth() + 1)}${pad(d)}`;
}

// ---- snarkjs proof -> instruction args ---------------------------------------------------------
const be32 = (v: bigint | string): Buffer => Buffer.from(BigInt(v).toString(16).padStart(64, "0"), "hex");

export interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}
export interface KycProofArgs {
  proofA: Buffer; // negated G1, 64 bytes
  proofB: Buffer; // G2, 128 bytes (c1||c0 ordering)
  proofC: Buffer; // G1, 64 bytes
  nullifier: Buffer;
  citizenship: number;
  root: Buffer;
  currentDate: bigint;
  timestampUpper: bigint;
  identityCounterUpper: bigint;
  birthDateUpper: bigint;
}

/** Converts a Rarimo/snarkjs proof + its 23 public signals into `submit_kyc_proof` arguments. */
export function kycArgsFromSnarkjs(proof: SnarkjsProof, pub: string[]): KycProofArgs {
  if (pub.length !== 23) throw new Error(`expected 23 public signals, got ${pub.length}`);
  return {
    proofA: Buffer.concat([be32(proof.pi_a[0]), be32((P - BigInt(proof.pi_a[1])) % P)]),
    proofB: Buffer.concat([
      be32(proof.pi_b[0][1]), be32(proof.pi_b[0][0]), be32(proof.pi_b[1][1]), be32(proof.pi_b[1][0]),
    ]),
    proofC: Buffer.concat([be32(proof.pi_c[0]), be32(proof.pi_c[1])]),
    nullifier: be32(pub[0]),
    citizenship: Number(pub[6]),
    root: be32(pub[11]),
    currentDate: BigInt(pub[13]),
    timestampUpper: BigInt(pub[15]),
    identityCounterUpper: BigInt(pub[17]),
    birthDateUpper: BigInt(pub[19]),
  };
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

/** Mint admin (Config.admin): opt a mint in to KYC self-onboarding. */
export async function enableKycIx(p: { program: PublicKey; admin: PublicKey; mint: PublicKey }) {
  return new TransactionInstruction({
    programId: p.program,
    keys: [
      { pubkey: p.admin, isSigner: true, isWritable: true },
      { pubkey: configPda(p.program, p.mint), isSigner: false, isWritable: false },
      { pubkey: kycPolicyPda(p.program, p.mint), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: await disc("enable_kyc"),
  });
}

/** Wallet-signed: verify the Rarimo proof on-chain and record the attestation. Prepend a CU-limit ix. */
export async function submitKycProofIx(p: { program: PublicKey; wallet: PublicKey; args: KycProofArgs }) {
  const a = p.args;
  return new TransactionInstruction({
    programId: p.program,
    keys: [
      { pubkey: p.wallet, isSigner: true, isWritable: true },
      { pubkey: kycConfigPda(p.program), isSigner: false, isWritable: false },
      { pubkey: kycAttestationPda(p.program, p.wallet), isSigner: false, isWritable: true },
      { pubkey: kycNullifierPda(p.program, a.nullifier), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      await disc("submit_kyc_proof"),
      a.proofA, a.proofB, a.proofC, a.nullifier, u32(a.citizenship), a.root,
      u64(a.currentDate), u64(a.timestampUpper), u64(a.identityCounterUpper), u64(a.birthDateUpper),
    ]),
  });
}
export const kycComputeBudgetIx = () => ComputeBudgetProgram.setComputeUnitLimit({ units: KYC_SUBMIT_CU });

/** Wallet-signed: activate the wallet's own AllowEntry for a KYC-enabled mint. */
export async function addAllowKycIx(p: { program: PublicKey; wallet: PublicKey; mint: PublicKey }) {
  return new TransactionInstruction({
    programId: p.program,
    keys: [
      { pubkey: p.wallet, isSigner: true, isWritable: true },
      { pubkey: kycConfigPda(p.program), isSigner: false, isWritable: false },
      { pubkey: kycPolicyPda(p.program, p.mint), isSigner: false, isWritable: false },
      { pubkey: kycAttestationPda(p.program, p.wallet), isSigner: false, isWritable: false },
      { pubkey: allowPda(p.program, p.mint, p.wallet), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: await disc("add_allow_kyc"),
  });
}

/** Permissionless crank: deactivate the AllowEntry of a wallet whose attestation expired / country got blocked. */
export async function revokeKycAllowIx(p: { program: PublicKey; caller: PublicKey; mint: PublicKey; wallet: PublicKey }) {
  return new TransactionInstruction({
    programId: p.program,
    keys: [
      { pubkey: p.caller, isSigner: true, isWritable: false },
      { pubkey: kycConfigPda(p.program), isSigner: false, isWritable: false },
      { pubkey: kycPolicyPda(p.program, p.mint), isSigner: false, isWritable: false },
      { pubkey: kycAttestationPda(p.program, p.wallet), isSigner: false, isWritable: false },
      { pubkey: allowPda(p.program, p.mint, p.wallet), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([await disc("revoke_kyc_allow"), p.wallet.toBuffer()]),
  });
}

/** Decoded KycAttestation account (8-byte discriminator, then wallet|nullifier|citizenship|issued|expires|bump). */
export interface KycAttestation {
  wallet: PublicKey;
  nullifier: Buffer;
  citizenship: string;
  issuedAt: number;
  expiresAt: number;
}
export function decodeKycAttestation(data: Buffer): KycAttestation {
  const c = data.readUInt32LE(8 + 64);
  return {
    wallet: new PublicKey(data.subarray(8, 40)),
    nullifier: data.subarray(40, 72),
    citizenship: String.fromCharCode((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff),
    issuedAt: Number(data.readBigInt64LE(8 + 68)),
    expiresAt: Number(data.readBigInt64LE(8 + 76)),
  };
}

/** Admin (root relayer): accept a Rarimo identity-state root in the KycConfig. */
export async function pushKycRootIx(p: { program: PublicKey; admin: PublicKey; root: Uint8Array }) {
  return new TransactionInstruction({
    programId: p.program,
    keys: [
      { pubkey: p.admin, isSigner: true, isWritable: false },
      { pubkey: kycConfigPda(p.program), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([await disc("push_kyc_root"), Buffer.from(p.root)]),
  });
}

export interface KycConfigState {
  admin: PublicKey;
  eventId: Buffer;
  minAge: number;
  ttlSecs: number;
  /** Blocked citizenships, ISO alpha-3. */
  blocked: string[];
  roots: Buffer[];
}
const alpha3 = (c: number) => String.fromCharCode((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);

/** Decoded KycConfig account: disc | admin | event_id | min_age u8 | ttl i64 | blocked Vec<u32> | roots Vec<[u8;32]> | bump. */
export function decodeKycConfig(data: Buffer): KycConfigState {
  let o = 8;
  const admin = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const eventId = Buffer.from(data.subarray(o, o + 32)); o += 32;
  const minAge = data.readUInt8(o); o += 1;
  const ttlSecs = Number(data.readBigInt64LE(o)); o += 8;
  const nb = data.readUInt32LE(o); o += 4;
  const blocked: string[] = [];
  for (let i = 0; i < nb; i++, o += 4) blocked.push(alpha3(data.readUInt32LE(o)));
  const nr = data.readUInt32LE(o); o += 4;
  const roots: Buffer[] = [];
  for (let i = 0; i < nr; i++, o += 32) roots.push(Buffer.from(data.subarray(o, o + 32)));
  return { admin, eventId, minAge, ttlSecs, blocked, roots };
}

/** AllowEntry (mint|wallet|active|bump) is active? */
export function allowEntryActive(data: Buffer): boolean {
  return data.length >= 8 + 65 && data[8 + 64] === 1;
}
