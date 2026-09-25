import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  ageUpperBoundYymmdd,
  decodeKycAttestation,
  decodeKycConfig,
  allowEntryActive,
  kycArgsFromSnarkjs,
  kycEventDataFor,
  kycEventId,
  KYC_SELECTOR,
} from "@/lib/chain/devnet/kyc";

const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

describe("ZK-KYC client helpers", () => {
  it("selector = nullifier + citizenship reveal + birthDate upper bound", () => {
    expect(KYC_SELECTOR).toBe(32801);
  });

  it("age bound: today minus min age, passport YYMMDD", () => {
    expect(ageUpperBoundYymmdd(new Date(Date.UTC(2026, 8, 25)), 18)).toBe("080925");
    expect(ageUpperBoundYymmdd(new Date(Date.UTC(2026, 8, 25)), 30)).toBe("960925");
    // Feb 29 -> Feb 28 when the target year is not a leap year
    expect(ageUpperBoundYymmdd(new Date(Date.UTC(2028, 1, 29)), 18)).toBe("100228");
    expect(ageUpperBoundYymmdd(new Date(Date.UTC(2028, 1, 29)), 20)).toBe("080229");
  });

  it("event id and wallet binding are 31-byte sha256 prefixes", async () => {
    expect(await kycEventId()).toMatch(/^0x[0-9a-f]{62}$/);
    const w = new PublicKey("11111111111111111111111111111112");
    const ed = await kycEventDataFor(w);
    expect(ed).toMatch(/^0x[0-9a-f]{62}$/);
    expect(await kycEventDataFor(w)).toBe(ed);
    expect(await kycEventDataFor(new PublicKey("11111111111111111111111111111113"))).not.toBe(ed);
  });

  it("converts a snarkjs proof: negated A, swapped G2 limbs, argument fields from the 23 public signals", () => {
    const pub = Array.from({ length: 23 }, (_, i) => String(1000 + i));
    pub[6] = "5589842"; // "UKR"
    const args = kycArgsFromSnarkjs(
      { pi_a: ["7", "11", "1"], pi_b: [["1", "2"], ["3", "4"], ["1", "0"]], pi_c: ["5", "6", "1"] },
      pub,
    );
    expect(args.proofA.length).toBe(64);
    expect(BigInt("0x" + args.proofA.subarray(32).toString("hex"))).toBe(P - 11n);
    expect(args.proofB.length).toBe(128);
    // x.c1 || x.c0 || y.c1 || y.c0
    expect([0, 32, 64, 96].map((o) => Number(BigInt("0x" + args.proofB.subarray(o, o + 32).toString("hex"))))).toEqual([2, 1, 4, 3]);
    expect(args.citizenship).toBe(5589842);
    expect(args.currentDate).toBe(1013n);
    expect(args.birthDateUpper).toBe(1019n);
    expect(BigInt("0x" + args.nullifier.toString("hex"))).toBe(1000n);
    expect(BigInt("0x" + args.root.toString("hex"))).toBe(1011n);
    expect(() => kycArgsFromSnarkjs({ pi_a: [], pi_b: [], pi_c: [] }, pub.slice(1))).toThrow(/23 public signals/);
  });

  it("decodes KycConfig / KycAttestation / AllowEntry accounts as laid out by the program", () => {
    const admin = new PublicKey("11111111111111111111111111111112");
    const cfg = Buffer.alloc(8 + 32 + 32 + 1 + 8 + 4 + 8 + 4 + 32 + 1);
    let o = 8;
    admin.toBuffer().copy(cfg, o); o += 32;
    cfg.fill(9, o, o + 32); o += 32;
    cfg.writeUInt8(18, o); o += 1;
    cfg.writeBigInt64LE(2592000n, o); o += 8;
    cfg.writeUInt32LE(2, o); o += 4;
    cfg.writeUInt32LE(0x525553, o); o += 4; // RUS
    cfg.writeUInt32LE(0x495241, o); o += 4; // IRA (not a real alpha-3, just a value)
    cfg.writeUInt32LE(1, o); o += 4;
    cfg.fill(7, o, o + 32);
    const d = decodeKycConfig(cfg.subarray(0, o + 32));
    expect(d.minAge).toBe(18);
    expect(d.ttlSecs).toBe(2592000);
    expect(d.blocked).toEqual(["RUS", "IRA"]);
    expect(d.roots).toHaveLength(1);
    expect(d.roots[0][0]).toBe(7);

    const att = Buffer.alloc(8 + 32 + 32 + 4 + 8 + 8 + 1);
    admin.toBuffer().copy(att, 8);
    att.writeUInt32LE(5589842, 8 + 64);
    att.writeBigInt64LE(1_790_000_000n, 8 + 68);
    att.writeBigInt64LE(1_792_592_000n, 8 + 76);
    const a = decodeKycAttestation(att);
    expect(a.citizenship).toBe("UKR");
    expect(a.expiresAt - a.issuedAt).toBe(2_592_000);

    const allow = Buffer.alloc(8 + 32 + 32 + 1 + 1);
    expect(allowEntryActive(allow)).toBe(false);
    allow[8 + 64] = 1;
    expect(allowEntryActive(allow)).toBe(true);
  });
});
