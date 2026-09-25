-- Wallet login: per-wallet API keys, one-time sign-in challenges, and issuance ownership.
-- NULL ownerWallet = admin-owned (issuances created with the FS_API_TOKEN env token).
ALTER TABLE "Issuance" ADD COLUMN "ownerWallet" TEXT;
ALTER TABLE "IssuancePreview" ADD COLUMN "ownerWallet" TEXT;

CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApiKey_tokenHash_key" ON "ApiKey"("tokenHash");
CREATE INDEX "ApiKey_wallet_idx" ON "ApiKey"("wallet");

CREATE TABLE "AuthChallenge" (
    "nonce" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("nonce")
);
