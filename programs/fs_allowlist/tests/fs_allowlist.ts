import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
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
import * as fs from "fs";
import * as path from "path";

const idl = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../target/idl/fs_allowlist.json"), "utf8")
);

const DECIMALS = 6;

describe("fs_allowlist", () => {
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

  const mint = Keypair.generate();
  const admin = Keypair.generate();
  const alice = Keypair.generate();
  const carol = Keypair.generate();

  const pda = (...seeds: Buffer[]) =>
    PublicKey.findProgramAddressSync(seeds, programId)[0];
  const configPda = pda(Buffer.from("config"), mint.publicKey.toBuffer());
  const extraMetasPda = pda(
    Buffer.from("extra-account-metas"),
    mint.publicKey.toBuffer()
  );
  const allowPda = (wallet: PublicKey) =>
    pda(Buffer.from("allow"), mint.publicKey.toBuffer(), wallet.toBuffer());

  const ata = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(
      mint.publicKey,
      owner,
      true,
      TOKEN_2022_PROGRAM_ID
    );
  const senderAta = ata(payer.publicKey);

  async function transfer(to: PublicKey, amount = 1_000_000n) {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection,
      senderAta,
      mint.publicKey,
      ata(to),
      payer.publicKey,
      amount,
      DECIMALS,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    return sendAndConfirmTransaction(connection, new Transaction().add(ix), [
      payer,
    ], { commitment: "confirmed" });
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

  before(async () => {
    await connection.confirmTransaction(
      await connection.requestAirdrop(admin.publicKey, 2e9),
      "confirmed"
    );

    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        mint.publicKey,
        payer.publicKey,
        programId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        DECIMALS,
        payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      ),
      ...[payer.publicKey, alice.publicKey, carol.publicKey].map((o) =>
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ata(o),
          o,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID
        )
      ),
      createMintToInstruction(
        mint.publicKey,
        senderAta,
        payer.publicKey,
        100_000_000n,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(connection, tx, [payer, mint]);
  });

  it("initialize creates config + extra account meta list", async () => {
    await program.methods
      .initialize(admin.publicKey)
      .accountsPartial({
        payer: payer.publicKey,
        mint: mint.publicKey,
        config: configPda,
        extraAccountMetaList: extraMetasPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const cfg: any = await (program.account as any).config.fetch(configPda);
    assert.ok(cfg.admin.equals(admin.publicKey));
    assert.ok(cfg.mint.equals(mint.publicKey));
    const metas = await connection.getAccountInfo(extraMetasPda);
    assert.ok(metas?.owner.equals(programId));
  });

  it("non-admin cannot add_allow", async () => {
    await expectError(
      program.methods
        .addAllow(carol.publicKey)
        .accountsPartial({
          admin: payer.publicKey,
          config: configPda,
          allowEntry: allowPda(carol.publicKey),
        })
        .rpc(),
      "Unauthorized"
    );
  });

  it("add_allow(alice) -> transfer to alice succeeds", async () => {
    await program.methods
      .addAllow(alice.publicKey)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        allowEntry: allowPda(alice.publicKey),
      })
      .signers([admin])
      .rpc();
    await transfer(alice.publicKey);
    const acc = await getAccount(
      connection,
      ata(alice.publicKey),
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    assert.equal(acc.amount, 1_000_000n);
  });

  it("transfer to carol (not allowlisted) fails with NotEligible", async () => {
    await expectError(transfer(carol.publicKey), "NotEligible");
  });

  it("execute outside of a transfer fails with NotTransferring", async () => {
    await expectError(
      program.methods
        .execute(new BN(1))
        .accountsPartial({
          sourceToken: senderAta,
          mint: mint.publicKey,
          destinationToken: ata(alice.publicKey),
          owner: payer.publicKey,
          extraAccountMetaList: extraMetasPda,
          allowEntry: allowPda(alice.publicKey),
        })
        .rpc(),
      "NotTransferring"
    );
  });

  it("remove_allow(alice) -> transfer to alice fails with NotEligible", async () => {
    await program.methods
      .removeAllow(alice.publicKey)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        allowEntry: allowPda(alice.publicKey),
      })
      .signers([admin])
      .rpc();
    await expectError(transfer(alice.publicKey), "NotEligible");
  });

  it("re-add alice -> transfer succeeds again", async () => {
    await program.methods
      .addAllow(alice.publicKey)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        allowEntry: allowPda(alice.publicKey),
      })
      .signers([admin])
      .rpc();
    await transfer(alice.publicKey);
    const acc = await getAccount(
      connection,
      ata(alice.publicKey),
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    assert.equal(acc.amount, 2_000_000n);
  });
});
