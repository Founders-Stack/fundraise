-- Wallet login: per-wallet API keys, one-time sign-in challenges, and issuance ownership.
-- NULL ownerWallet = admin-owned (issuances created with the FS_API_TOKEN env token).
ALTER TABLE "Issuance" ADD COLUMN "ownerWallet" TEXT;
ALTER TABLE "IssuancePreview" ADD COLUMN "ownerWallet" TEXT;

CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "wallet" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME
);
CREATE UNIQUE INDEX "ApiKey_tokenHash_key" ON "ApiKey"("tokenHash");
CREATE INDEX "ApiKey_wallet_idx" ON "ApiKey"("wallet");

CREATE TABLE "AuthChallenge" (
    "nonce" TEXT NOT NULL PRIMARY KEY,
    "wallet" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
