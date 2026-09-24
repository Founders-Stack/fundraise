-- A25: escrow + Merkle claim for distributions.
ALTER TABLE "Distribution" ADD COLUMN "payoutMode" TEXT NOT NULL DEFAULT 'DIRECT';
ALTER TABLE "Distribution" ADD COLUMN "merkleRoot" TEXT;
ALTER TABLE "Distribution" ADD COLUMN "escrowAddress" TEXT;
ALTER TABLE "Distribution" ADD COLUMN "escrowFundSignature" TEXT;
ALTER TABLE "Distribution" ADD COLUMN "escrowFundedAt" DATETIME;
ALTER TABLE "Allocation" ADD COLUMN "claimingUntil" DATETIME;
ALTER TABLE "Allocation" ADD COLUMN "claimedAt" DATETIME;
