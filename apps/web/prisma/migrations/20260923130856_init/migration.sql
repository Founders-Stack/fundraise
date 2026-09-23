-- CreateTable
CREATE TABLE "Issuance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuerName" TEXT NOT NULL,
    "rightsType" TEXT NOT NULL DEFAULT 'CASH_FLOW',
    "poolPercentage" REAL NOT NULL,
    "tokenSupply" BIGINT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "distributionFrequency" TEXT NOT NULL DEFAULT 'QUARTERLY',
    "nextRecordDate" DATETIME,
    "expectedAnnualDcf" REAL NOT NULL,
    "targetInitialYield" REAL NOT NULL,
    "agreementVersion" TEXT NOT NULL,
    "agreementHash" TEXT NOT NULL,
    "agreementText" TEXT NOT NULL,
    "startingMarketCap" REAL NOT NULL,
    "graduationMarketCap" REAL NOT NULL,
    "quoteMint" TEXT,
    "baseMint" TEXT,
    "dbcConfig" TEXT,
    "dbcPool" TEXT,
    "dammPool" TEXT,
    "monetization" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuanceId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "displayName" TEXT,
    "verifiedAt" DATETIME,
    "eligibleAt" DATETIME,
    "agreementAcceptedAt" DATETIME,
    "agreementSig" TEXT,
    "allowlistTx" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Participant_issuanceId_fkey" FOREIGN KEY ("issuanceId") REFERENCES "Issuance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Distribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuanceId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "dcf" REAL NOT NULL,
    "reportUrl" TEXT,
    "reportHash" TEXT NOT NULL,
    "poolPercentage" REAL NOT NULL,
    "rightsPool" BIGINT NOT NULL,
    "perToken" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "snapshotSlot" BIGINT,
    "totalAllocated" BIGINT,
    "unallocated" BIGINT,
    "executedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Distribution_issuanceId_fkey" FOREIGN KEY ("issuanceId") REFERENCES "Issuance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Allocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "distributionId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "participantId" TEXT,
    "tokens" BIGINT NOT NULL,
    "payout" BIGINT NOT NULL,
    "txSignature" TEXT,
    CONSTRAINT "Allocation_distributionId_fkey" FOREIGN KEY ("distributionId") REFERENCES "Distribution" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Allocation_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Participant_issuanceId_wallet_key" ON "Participant"("issuanceId", "wallet");

-- CreateIndex
CREATE UNIQUE INDEX "Distribution_issuanceId_periodLabel_key" ON "Distribution"("issuanceId", "periodLabel");

-- CreateIndex
CREATE UNIQUE INDEX "Allocation_distributionId_wallet_key" ON "Allocation"("distributionId", "wallet");
