-- Issuer side of the agreement: the wallet that signed the create tx carrying the SPL Memo
-- `fstack:agreement:v1:<mint>:<sha256>`. NULL on issuances created before this migration.
ALTER TABLE "Issuance" ADD COLUMN "issuerSigner" TEXT;
ALTER TABLE "Issuance" ADD COLUMN "agreementMemo" TEXT;
ALTER TABLE "Issuance" ADD COLUMN "agreementMemoTx" TEXT;
ALTER TABLE "Issuance" ADD COLUMN "issuerSignedAt" DATETIME;
