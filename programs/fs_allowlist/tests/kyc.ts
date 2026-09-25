// ZK-KYC gate tests. Needs a REAL Rarimo query proof generated for the test wallet with
//   selector 0b1000000000100001, eventId = sha256("fs-allowlist-kyc-v1")[..31], age cutoff = today-18y
// (see /Users/kastet/FS-Stocklana-refs/rarimo-proof-request/request.mjs). Skipped if not present.
import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getMintLen,
  createInitializeTransferHookInstruction,
  createInitializeMintInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const idl = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../target/idl/fs_allowlist.json"), "utf8")
);
const PROOF_DIR =
  process.env.KYC_PROOF_DIR ?? "/Users/kastet/FS-Stocklana-refs/rarimo-proof-request";
const DECIMALS = 6;
const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const country = (s: string) => (s.charCodeAt(0) << 16) | (s.charCodeAt(1) << 8) | s.charCodeAt(2);
const BLOCKED_DEFAULT = ["RUS", "IRN", "PRK", "SYR", "CUB"].map(country);

const be32 = (v: bigint | string) => Buffer.from(BigInt(v).toString(16).padStart(64, "0"), "hex");
const g1 = (p: string[]) => Buffer.concat([be32(p[0]), be32(p[1])]);
const g2 = (p: string[][]) =>
  Buffer.concat([be32(p[0][1]), be32(p[0][0]), be32(p[1][1]), be32(p[1][0])]);

const haveProof = ["proof.json", "public.json", "test-wallet.json"].every((f) =>
  fs.existsSync(path.join(PROOF_DIR, f))
);

(haveProof ? describe : describe.skip)("fs_allowlist ZK-KYC", () => {
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(envProvider.connection.rpcEndpoint, "confirmed"),
    envProvider.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const program = new Program(idl as anchor.Idl, provider) as Program<any>;
  const programId = program.programId;

  const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(PROOF_DIR, f), "utf8"));
  const proof = haveProof ? readJson("proof.json") : null;
  const pub: string[] = haveProof ? readJson("public.json") : [];
  const wallet = haveProof
    ? Keypair.fromSecretKey(Uint8Array.from(readJson("test-wallet.json")))
    : Keypair.generate();
  const fsAuthority = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.FS_AUTHORITY_KEYPAIR ?? "/Users/kastet/FS-Stocklana/keys/fs-authority.json",
          "utf8"
        )
      )
    )
  );
  const kycAdmin = Keypair.generate();
  const mintAdmin = Keypair.generate();
  const impostor = Keypair.generate();
  const mint = Keypair.generate();

  const eventId = Buffer.concat([
    Buffer.from([0]),
    crypto.createHash("sha256").update("fs-allowlist-kyc-v1").digest().subarray(0, 31),
  ]);
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const kycConfig = pda(Buffer.from("kyc-config"));
  const kycPolicy = pda(Buffer.from("kyc-policy"), mint.publicKey.toBuffer());
  const attestationOf = (w: PublicKey) => pda(Buffer.from("kyc"), w.toBuffer());
  const nullifierPda = (n: Buffer) => pda(Buffer.from("nullifier"), n);
  const configPda = pda(Buffer.from("config"), mint.publicKey.toBuffer());
  const extraMetasPda = pda(Buffer.from("extra-account-metas"), mint.publicKey.toBuffer());
  const allowPda = (w: PublicKey) =>
    pda(Buffer.from("allow"), mint.publicKey.toBuffer(), w.toBuffer());
  const ata = (o: PublicKey) =>
    getAssociatedTokenAddressSync(mint.publicKey, o, true, TOKEN_2022_PROGRAM_ID);
  const senderAta = ata(payer.publicKey);

  const nullifier = haveProof ? be32(pub[0]) : Buffer.alloc(32);
  const rootBytes = haveProof ? be32(pub[11]) : Buffer.alloc(32);
  const args = (over: Partial<Record<string, any>> = {}) => ({
    a: Array.from(
      over.a ?? Buffer.concat([be32(proof.pi_a[0]), be32((P - BigInt(proof.pi_a[1])) % P)])
    ),
    b: Array.from(over.b ?? g2(proof.pi_b)),
    c: Array.from(over.c ?? g1(proof.pi_c)),
    nullifier: Array.from(nullifier),
    citizenship: Number(pub[6]),
    root: Array.from(rootBytes),
    currentDate: new BN(pub[13]),
    tsUpper: new BN(pub[15]),
    counterUpper: new BN(pub[17]),
    birthUpper: new BN(pub[19]),
    ...over,
  });

  const submit = (signer: Keypair, over: Partial<Record<string, any>> = {}) => {
    const x = args(over);
    return program.methods
      .submitKycProof(x.a, x.b, x.c, x.nullifier, x.citizenship, x.root, x.currentDate, x.tsUpper, x.counterUpper, x.birthUpper)
      .accountsPartial({
        wallet: signer.publicKey,
        kycConfig,
        attestation: attestationOf(signer.publicKey),
        nullifierRecord: nullifierPda(Buffer.from(x.nullifier)),
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .signers([signer])
      .rpc();
  };
  const setPolicy = (minAge: number, ttl: number, blocked: number[]) =>
    program.methods
      .setKycPolicy(minAge, new BN(ttl), blocked)
      .accountsPartial({ admin: kycAdmin.publicKey, kycConfig })
      .signers([kycAdmin])
      .rpc();
  const addAllowKyc = () =>
    program.methods
      .addAllowKyc()
      .accountsPartial({
        wallet: wallet.publicKey,
        kycConfig,
        kycPolicy,
        attestation: attestationOf(wallet.publicKey),
        allowEntry: allowPda(wallet.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();
  const revoke = () =>
    program.methods
      .revokeKycAllow(wallet.publicKey)
      .accountsPartial({
        caller: payer.publicKey,
        kycConfig,
        kycPolicy,
        attestation: attestationOf(wallet.publicKey),
        allowEntry: allowPda(wallet.publicKey),
      })
      .rpc();
  async function transferTo(to: PublicKey, amount = 1_000_000n) {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection, senderAta, mint.publicKey, ata(to), payer.publicKey, amount, DECIMALS, [],
      "confirmed", TOKEN_2022_PROGRAM_ID
    );
    return sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], {
      commitment: "confirmed",
    });
  }
  async function expectError(p: Promise<unknown>, name: string) {
    try {
      await p;
    } catch (e: any) {
      const logs: string[] = e.logs ?? e.transactionLogs ?? [];
      const text = `${e.message ?? e}\n${logs.join("\n")}`;
      assert.include(text, name, `expected ${name}, got:\n${text}`);
      return;
    }
    assert.fail(`expected failure with ${name}`);
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    for (const k of [wallet, kycAdmin, mintAdmin, impostor]) {
      await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 2e9), "confirmed");
    }
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: mintLen, lamports,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferHookInstruction(mint.publicKey, payer.publicKey, programId, TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(mint.publicKey, DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
        ...[payer.publicKey, wallet.publicKey].map((o) =>
          createAssociatedTokenAccountInstruction(payer.publicKey, ata(o), o, mint.publicKey, TOKEN_2022_PROGRAM_ID)
        ),
        createMintToInstruction(mint.publicKey, senderAta, payer.publicKey, 100_000_000n, [], TOKEN_2022_PROGRAM_ID)
      ),
      [payer, mint]
    );
    await program.methods
      .initialize(mintAdmin.publicKey)
      .accountsPartial({
        payer: payer.publicKey, authority: fsAuthority.publicKey, mint: mint.publicKey,
        config: configPda, extraAccountMetaList: extraMetasPda, systemProgram: SystemProgram.programId,
      })
      .signers([fsAuthority])
      .rpc();
  });

  it("proof fixture sanity: UKR, selector, bound to the test wallet", () => {
    assert.equal(Number(pub[6]), country("UKR"));
    assert.equal(pub[12], String((1 << 0) | (1 << 5) | (1 << 15)));
    const eventData = Buffer.concat([
      Buffer.from([0]),
      crypto.createHash("sha256").update(wallet.publicKey.toBytes()).digest().subarray(0, 31),
    ]);
    assert.equal(BigInt(pub[10]), BigInt("0x" + eventData.toString("hex")));
    assert.equal(BigInt(pub[9]), BigInt("0x" + eventId.toString("hex")));
  });

  it("init_kyc_config by a non-FS-authority fails with Unauthorized", async () => {
    await expectError(
      program.methods
        .initKycConfig(kycAdmin.publicKey, Array.from(eventId), 18, new BN(3600), BLOCKED_DEFAULT)
        .accountsPartial({ payer: payer.publicKey, authority: impostor.publicKey, kycConfig, systemProgram: SystemProgram.programId })
        .signers([impostor])
        .rpc(),
      "Unauthorized"
    );
  });

  it("init_kyc_config (FS authority)", async () => {
    await program.methods
      .initKycConfig(kycAdmin.publicKey, Array.from(eventId), 18, new BN(3600), BLOCKED_DEFAULT)
      .accountsPartial({ payer: payer.publicKey, authority: fsAuthority.publicKey, kycConfig, systemProgram: SystemProgram.programId })
      .signers([fsAuthority])
      .rpc();
    const c: any = await (program.account as any).kycConfig.fetch(kycConfig);
    assert.equal(c.minAge, 18);
    assert.deepEqual(c.blocked, BLOCKED_DEFAULT);
  });

  it("submit before the root is accepted fails with UnknownRoot", async () => {
    await expectError(submit(wallet), "UnknownRoot");
  });

  it("non-admin cannot push_kyc_root", async () => {
    await expectError(
      program.methods.pushKycRoot(Array.from(rootBytes))
        .accountsPartial({ admin: impostor.publicKey, kycConfig }).signers([impostor]).rpc(),
      "Unauthorized"
    );
  });

  it("push_kyc_root", async () => {
    await program.methods.pushKycRoot(Array.from(rootBytes))
      .accountsPartial({ admin: kycAdmin.publicKey, kycConfig }).signers([kycAdmin]).rpc();
    const c: any = await (program.account as any).kycConfig.fetch(kycConfig);
    assert.equal(c.roots.length, 1);
  });

  it("tampered proof fails with InvalidProof", async () => {
    const b = Buffer.from(g2(proof.pi_b));
    b[5] ^= 1;
    await expectError(submit(wallet, { b }), "InvalidProof");
  });

  it("valid proof replayed by another wallet fails (bound to the wallet)", async () => {
    await expectError(submit(impostor), "InvalidProof");
  });

  it("wrong current date fails with StaleProof", async () => {
    await expectError(submit(wallet, { currentDate: new BN(pub[13]).add(new BN(0x0100)) }), "StaleProof");
  });

  it("citizenship on the blocklist fails with CountryBlocked", async () => {
    await setPolicy(18, 3600, [country("UKR")]);
    await expectError(submit(wallet), "CountryBlocked");
    await setPolicy(18, 3600, BLOCKED_DEFAULT);
  });

  it("min age above the proof's bound fails with AgeBoundTooLax", async () => {
    await setPolicy(30, 3600, BLOCKED_DEFAULT);
    await expectError(submit(wallet), "AgeBoundTooLax");
    await setPolicy(18, 3600, BLOCKED_DEFAULT);
  });

  it("valid Rarimo proof -> KycAttestation (age>18, UKR, bound to wallet)", async () => {
    const sig = await submit(wallet);
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    console.log("      submit_kyc_proof compute units:", tx?.meta?.computeUnitsConsumed);
    const a: any = await (program.account as any).kycAttestation.fetch(attestationOf(wallet.publicKey));
    assert.equal(a.citizenship, country("UKR"));
    assert.ok(a.wallet.equals(wallet.publicKey));
    assert.equal(a.expiresAt.sub(a.issuedAt).toNumber(), 3600);
    const n: any = await (program.account as any).nullifierRecord.fetch(nullifierPda(nullifier));
    assert.ok(n.wallet.equals(wallet.publicKey));
  });

  it("before enable_kyc the wallet cannot self-allow", async () => {
    await expectError(addAllowKyc(), "AccountNotInitialized");
  });

  it("enable_kyc is mint-admin only", async () => {
    await expectError(
      program.methods.enableKyc()
        .accountsPartial({ admin: impostor.publicKey, config: configPda, kycPolicy, systemProgram: SystemProgram.programId })
        .signers([impostor]).rpc(),
      "Unauthorized"
    );
    await program.methods.enableKyc()
      .accountsPartial({ admin: mintAdmin.publicKey, config: configPda, kycPolicy, systemProgram: SystemProgram.programId })
      .signers([mintAdmin]).rpc();
  });

  it("no AllowEntry yet -> transfer fails with NotEligible", async () => {
    await expectError(transferTo(wallet.publicKey), "NotEligible");
  });

  it("add_allow_kyc -> transfer to the KYC'd wallet succeeds", async () => {
    await addAllowKyc();
    await transferTo(wallet.publicKey);
    const acc = await getAccount(connection, ata(wallet.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.equal(acc.amount, 1_000_000n);
  });

  it("revoke_kyc_allow while still valid fails with StillValid", async () => {
    await expectError(revoke(), "StillValid");
  });

  it("policy now blocks UKR -> crank revokes -> transfer fails with NotEligible", async () => {
    await setPolicy(18, 3600, [country("UKR")]);
    await revoke();
    await expectError(transferTo(wallet.publicKey, 1_000_001n), "NotEligible");
    await expectError(addAllowKyc(), "CountryBlocked");
    await setPolicy(18, 3600, BLOCKED_DEFAULT);
    await addAllowKyc();
    await transferTo(wallet.publicKey, 1_000_002n);
  });

  it("attestation expiry: short TTL -> crank revokes -> re-submit restores access", async () => {
    await setPolicy(18, 3, BLOCKED_DEFAULT);
    await submit(wallet); // refresh (same wallet + same nullifier is allowed)
    await sleep(5000);
    await revoke();
    await expectError(transferTo(wallet.publicKey, 1_000_003n), "NotEligible");
    await expectError(addAllowKyc(), "AttestationExpired");
    await setPolicy(18, 3600, BLOCKED_DEFAULT);
    await submit(wallet);
    await addAllowKyc();
    await transferTo(wallet.publicKey, 1_000_004n);
  });
});
