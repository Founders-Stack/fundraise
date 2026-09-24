-- Execution lease: an execute claims the distribution row until this time (atomic, works across API processes).
ALTER TABLE "Distribution" ADD COLUMN "executingUntil" DATETIME;
