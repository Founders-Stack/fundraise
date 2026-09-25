// Requests a ZK-passport query proof from Rarimo's hosted verificator, waits for the iPhone/RariMe
// app to answer, saves proof.json/public.json and verifies them against the vkey extracted from
// the RariMe APK (circuit_query_zkey.zkey).
import pkg from "@rarimo/zk-passport";
const { ZkPassport, CustomProofParamsBuilder } = pkg;
import qrcode from "qrcode-terminal";
import crypto from "node:crypto";
import fs from "node:fs";
import { Keypair } from "@solana/web3.js";
import * as snarkjs from "snarkjs";

// Usage: cd <dir with `npm i @rarimo/zk-passport qrcode-terminal snarkjs @solana/web3.js@1`> && node kyc-proof-request.mjs
// VKEY: extracted from the RariMe APK (assets/circuit_query_zkey.zkey) with `snarkjs zkey export verificationkey`.
const VKEY = process.env.KYC_VKEY ?? "../rarime-apk/query_vkey.json";
const id = "fs-" + crypto.randomBytes(6).toString("hex");

// Test Solana wallet the proof gets bound to via eventData (first 31 bytes of sha256(pubkey)).
const wallet = fs.existsSync("test-wallet.json") ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("test-wallet.json", "utf8")))) : Keypair.generate();
const eventData = "0x" + crypto.createHash("sha256").update(wallet.publicKey.toBytes()).digest().subarray(0, 31).toString("hex");
// Fixed protocol event id (same value goes into the on-chain KycConfig).
const eventId = "0x" + crypto.createHash("sha256").update("fs-allowlist-kyc-v1").digest().subarray(0, 31).toString("hex");
// "older than 18": birth date < today - 18y, passport-encoded YYMMDD.
const now = new Date();
const cut = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
const yymmdd = (d) => String(d.getUTCFullYear() % 100).padStart(2, "0") + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
const ageCutoff = yymmdd(cut);

// selector: bit0 nullifier + bit5 citizenship reveal + bit15 birthDate < upper bound
const params = new CustomProofParamsBuilder()
  .withSelector("0b1000000000100001")
  .withBirthDateBounds({ lower: "000000", upper: ageCutoff })
  .withEventId(eventId)
  .withEventData(eventData)
  .build();

const zk = new ZkPassport();
const link = await zk.requestVerificationLink(id, params);
console.log("request id  :", id);
console.log("wallet      :", wallet.publicKey.toBase58());
console.log("eventData   :", eventData);
console.log("age cutoff  :", ageCutoff, "(birth date must be before this)");
console.log("\nOpen this link on the iPhone (Notes/Messages -> tap), RariMe should offer the proof request:\n\n" + link + "\n");
qrcode.generate(link, { small: true });
fs.writeFileSync("last-request.json", JSON.stringify({ id, wallet: wallet.publicKey.toBase58(), eventData, eventId, ageCutoff }, null, 2));
fs.writeFileSync("test-wallet.json", JSON.stringify(Array.from(wallet.secretKey))); // devnet/localnet TEST key only

let status;
for (let i = 0; i < 360; i++) {
  status = await zk.getVerificationStatus(id).catch((e) => "err:" + e.message);
  process.stdout.write(`\rstatus: ${status}        `);
  if (status === "verified") break;
  await new Promise((r) => setTimeout(r, 5000));
}
console.log();
const proof = await zk.getVerifiedProof(id);
if (!proof) { console.error("no proof returned"); process.exit(1); }
fs.writeFileSync("proof.json", JSON.stringify({ pi_a: proof.proof.piA, pi_b: proof.proof.piB, pi_c: proof.proof.piC, protocol: "groth16", curve: "bn128" }, null, 1));
fs.writeFileSync("public.json", JSON.stringify(proof.pubSignals, null, 1));
console.log("public signals:", proof.pubSignals.length);
const ok = await snarkjs.groth16.verify(JSON.parse(fs.readFileSync(VKEY)), proof.pubSignals, { pi_a: proof.proof.piA, pi_b: proof.proof.piB, pi_c: proof.proof.piC, protocol: "groth16", curve: "bn128" });
console.log("snarkjs verify against APK vkey:", ok);
process.exit(0);
