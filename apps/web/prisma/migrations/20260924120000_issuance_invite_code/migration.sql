-- Closed pilot (SPEC sections 6, 14): onboarding requires the issuance's invite code.
-- NULL (issuances created before this column) means no invite code is required.
ALTER TABLE "Issuance" ADD COLUMN "inviteCode" TEXT;
