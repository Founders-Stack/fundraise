-- CreateTable
CREATE TABLE "SignRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purpose" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "summaryJson" TEXT NOT NULL,
    "signer" TEXT,
    "payloadJson" TEXT,
    "signatures" TEXT NOT NULL DEFAULT '[]',
    "resultJson" TEXT,
    "error" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SignRequest_purpose_subjectId_idx" ON "SignRequest"("purpose", "subjectId");
