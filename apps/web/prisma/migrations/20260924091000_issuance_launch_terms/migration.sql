-- Launch terms that used to live only in the IssuancePreview row (and, for the DCF definition, inside the
-- agreement text). NULL means the core default for that term.
ALTER TABLE "Issuance" ADD COLUMN "tokenDecimals" INTEGER NOT NULL DEFAULT 6;
ALTER TABLE "Issuance" ADD COLUMN "issuerJurisdiction" TEXT;
ALTER TABLE "Issuance" ADD COLUMN "dcfDefinition" TEXT;
ALTER TABLE "Issuance" ADD COLUMN "recordDateRule" TEXT;

-- Backfill from the preview that created each issuance.
UPDATE "Issuance" SET
  "tokenDecimals" = COALESCE((SELECT json_extract(p."termsJson", '$.terms.tokenDecimals') FROM "IssuancePreview" p WHERE p."issuanceId" = "Issuance"."id" LIMIT 1), 6),
  "issuerJurisdiction" = (SELECT json_extract(p."termsJson", '$.terms.issuerJurisdiction') FROM "IssuancePreview" p WHERE p."issuanceId" = "Issuance"."id" LIMIT 1),
  "dcfDefinition" = (SELECT json_extract(p."termsJson", '$.terms.distributableCashFlowDefinition') FROM "IssuancePreview" p WHERE p."issuanceId" = "Issuance"."id" LIMIT 1),
  "recordDateRule" = (SELECT json_extract(p."termsJson", '$.terms.recordDateRule') FROM "IssuancePreview" p WHERE p."issuanceId" = "Issuance"."id" LIMIT 1);
