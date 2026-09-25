#!/usr/bin/env node
// ZK-KYC admin + Rarimo root relayer for fs_allowlist.
//
//   init    --admin <pubkey> [--min-age 18] [--ttl 2592000] [--blocked RUS,IRN,PRK,SYR,CUB]   (FS authority signs)
//   policy  [--min-age N] [--ttl S] [--blocked A,B,C]                                          (kyc admin signs)
//   root    once | watch [seconds] | proof <public.json>                                       (kyc admin signs)
//
// root once/watch : read the latest identity-state root from Rarimo's PoseidonSMT and push it.
// root proof      : check that the proof's idStateRoot is valid on Rarimo (isRootValid), then push it.
//
// env: SOLANA_RPC (default http://127.0.0.1:8999)  FS_AUTHORITY_KEYPAIR  KYC_ADMIN_KEYPAIR
//      RARIMO_RPC (default https://l2.rarimo.com)  RARIMO_SMT (default 0x479F8450...A879)
import anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Program, AnchorProvider, Wallet, BN } = anchor;
const here = path.dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(fs.readFileSync(path.join(here, "../target/idl/fs_allowlist.json"), "utf8"));
const RPC = process.env.SOLANA_RPC ?? "http://127.0.0.1:8999";
const RARIMO_RPC = process.env.RARIMO_RPC ?? "https://l2.rarimo.com";
const RARIMO_SMT = process.env.RARIMO_SMT ?? "0x479F84502Db545FA8d2275372E0582425204A879";
const SEL = { getRoot: "0x5ca1e165", isRootValid: "0x30ef41b4", isRootLatest: "0x8492307f", rootValidity: "0xcffe9676" };

const loadKey = (envName) => {
  const p = process.env[envName];
  if (!p) throw new Error(`set ${envName}=/path/to/keypair.json`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
};
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const country = (s) => (s.charCodeAt(0) << 16) | (s.charCodeAt(1) << 8) | s.charCodeAt(2);
const blockedList = (s) => (s ? s.split(",").filter(Boolean).map((c) => country(c.trim().toUpperCase())) : []);
// Same value the web app / proof request uses (31 bytes of sha256, left-padded to 32).
const EVENT_ID = Buffer.concat([Buffer.from([0]), crypto.createHash("sha256").update("fs-allowlist-kyc-v1").digest().subarray(0, 31)]);

const connection = new Connection(RPC, "confirmed");
const programFor = (kp) => new Program(idl, new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" }));
const kycConfigPda = (programId) => PublicKey.findProgramAddressSync([Buffer.from("kyc-config")], programId)[0];

async function ethCall(data) {
  const r = await fetch(RARIMO_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: RARIMO_SMT, data }, "latest"] }),
  }).then((x) => x.json());
  if (r.error) throw new Error(`Rarimo RPC: ${JSON.stringify(r.error)}`);
  return r.result;
}
const rarimoLatestRoot = async () => Buffer.from((await ethCall(SEL.getRoot)).slice(2), "hex");
const rarimoRootValid = async (root) => BigInt(await ethCall(SEL.isRootValid + root.toString("hex"))) === 1n;

async function pushRoot(root) {
  const admin = loadKey("KYC_ADMIN_KEYPAIR");
  const program = programFor(admin);
  const kycConfig = kycConfigPda(program.programId);
  const cfg = await program.account.kycConfig.fetch(kycConfig);
  if (cfg.roots.some((r) => Buffer.from(r).equals(root))) return console.log("root already accepted:", "0x" + root.toString("hex"));
  const sig = await program.methods.pushKycRoot(Array.from(root)).accountsPartial({ admin: admin.publicKey, kycConfig }).rpc();
  console.log("pushed root 0x" + root.toString("hex"), "tx", sig);
}

const [cmd, sub, extra] = process.argv.slice(2);
if (cmd === "init") {
  const fsAuth = loadKey("FS_AUTHORITY_KEYPAIR");
  const program = programFor(fsAuth);
  const kycConfig = kycConfigPda(program.programId);
  const sig = await program.methods
    .initKycConfig(new PublicKey(arg("admin")), Array.from(EVENT_ID), Number(arg("min-age", "18")), new BN(arg("ttl", String(30 * 86400))), blockedList(arg("blocked", "RUS,IRN,PRK,SYR,CUB")))
    .accountsPartial({ payer: fsAuth.publicKey, authority: fsAuth.publicKey, kycConfig, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("kyc-config", kycConfig.toBase58(), "tx", sig);
} else if (cmd === "policy") {
  const admin = loadKey("KYC_ADMIN_KEYPAIR");
  const program = programFor(admin);
  const kycConfig = kycConfigPda(program.programId);
  const cur = await program.account.kycConfig.fetch(kycConfig);
  const sig = await program.methods
    .setKycPolicy(Number(arg("min-age", String(cur.minAge))), new BN(arg("ttl", cur.ttlSecs.toString())), arg("blocked") !== undefined ? blockedList(arg("blocked")) : cur.blocked)
    .accountsPartial({ admin: admin.publicKey, kycConfig })
    .rpc();
  console.log("policy updated tx", sig);
} else if (cmd === "root" && sub === "once") {
  await pushRoot(await rarimoLatestRoot());
} else if (cmd === "root" && sub === "watch") {
  const every = Number(extra ?? 60) * 1000;
  console.log(`watching ${RARIMO_SMT} on ${RARIMO_RPC} every ${every / 1000}s (Rarimo keeps superseded roots valid for ~1h)`);
  for (;;) {
    try { await pushRoot(await rarimoLatestRoot()); } catch (e) { console.error("relay error:", e.message); }
    await new Promise((r) => setTimeout(r, every));
  }
} else if (cmd === "root" && sub === "proof") {
  const pub = JSON.parse(fs.readFileSync(extra, "utf8"));
  const root = Buffer.from(BigInt(pub[11]).toString(16).padStart(64, "0"), "hex");
  if (!(await rarimoRootValid(root))) throw new Error("proof's idStateRoot is NOT valid on Rarimo; refusing to push");
  console.log("proof root is valid on Rarimo:", "0x" + root.toString("hex"));
  await pushRoot(root);
} else {
  console.log("usage: see header of scripts/kyc-admin.mjs");
  process.exit(1);
}
