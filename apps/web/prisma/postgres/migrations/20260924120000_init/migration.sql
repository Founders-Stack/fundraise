-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Issuance" (
    "id" TEXT NOT NULL,
    "issuerName" TEXT NOT NULL,
    "rightsType" TEXT NOT NULL DEFAULT 'CASH_FLOW',
    "poolPercentageBps" INTEGER NOT NULL,
    "tokenSupply" BIGINT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL DEFAULT 6,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "distributionFrequency" TEXT NOT NULL DEFAULT 'QUARTERLY',
    "nextRecordDate" TIMESTAMP(3),
    "expectedAnnualDcf" BIGINT NOT NULL,
    "targetInitialYieldBps" INTEGER NOT NULL,
    "graduationMultiple" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "agreementVersion" TEXT NOT NULL,
    "agreementHash" TEXT NOT NULL,
    "agreementText" TEXT NOT NULL,
    "issuerJurisdiction" TEXT,
    "dcfDefinition" TEXT,
    "recordDateRule" TEXT,
    "startingMarketCap" BIGINT NOT NULL,
    "graduationMarketCap" BIGINT NOT NULL,
    "quoteMint" TEXT,
    "baseMint" TEXT,
    "dbcConfig" TEXT,
    "dbcPool" TEXT,
    "dammPool" TEXT,
    "monetization" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Issuance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL,
    "issuanceId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "displayName" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "eligibleAt" TIMESTAMP(3),
    "agreementAcceptedAt" TIMESTAMP(3),
    "agreementSig" TEXT,
    "allowlistTx" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Distribution" (
    "id" TEXT NOT NULL,
    "issuanceId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "dcf" BIGINT NOT NULL,
    "reportUrl" TEXT,
    "reportHash" TEXT NOT NULL,
    "poolPercentageBps" INTEGER NOT NULL,
    "rightsPool" BIGINT NOT NULL,
    "perTokenBaseUnits" BIGINT NOT NULL,
    "snapshotJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "snapshotSlot" BIGINT,
    "totalAllocated" BIGINT,
    "unallocated" BIGINT,
    "executedAt" TIMESTAMP(3),
    "executingUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Distribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Allocation" (
    "id" TEXT NOT NULL,
    "distributionId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "participantId" TEXT,
    "tokens" BIGINT NOT NULL,
    "payout" BIGINT NOT NULL,
    "txSignature" TEXT,

    CONSTRAINT "Allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuancePreview" (
    "id" TEXT NOT NULL,
    "termsJson" TEXT NOT NULL,
    "derivedJson" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "issuanceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuancePreview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Participant_issuanceId_wallet_key" ON "Participant"("issuanceId", "wallet");

-- CreateIndex
CREATE UNIQUE INDEX "Distribution_issuanceId_periodLabel_key" ON "Distribution"("issuanceId", "periodLabel");

-- CreateIndex
CREATE UNIQUE INDEX "Allocation_distributionId_wallet_key" ON "Allocation"("distributionId", "wallet");

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_issuanceId_fkey" FOREIGN KEY ("issuanceId") REFERENCES "Issuance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_issuanceId_fkey" FOREIGN KEY ("issuanceId") REFERENCES "Issuance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_distributionId_fkey" FOREIGN KEY ("distributionId") REFERENCES "Distribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
