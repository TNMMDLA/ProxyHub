-- V0.3 additive migration: reusable manual/remote rule sets and policy references.
CREATE TABLE "RuleSet" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sourceType" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "sourceUrl" TEXT,
  "updateIntervalMinutes" INTEGER,
  "lastFetchAt" DATETIME,
  "lastSuccessAt" DATETIME,
  "nextUpdateAt" DATETIME,
  "status" TEXT NOT NULL DEFAULT 'EMPTY',
  "lastError" TEXT,
  "contentHash" TEXT,
  "ruleCount" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "RuleSet_name_key" ON "RuleSet"("name");
CREATE INDEX "RuleSet_enabled_status_idx" ON "RuleSet"("enabled", "status");
CREATE INDEX "RuleSet_nextUpdateAt_idx" ON "RuleSet"("nextUpdateAt");

CREATE TABLE "RuleSetEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ruleSetId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "order" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RuleSetEntry_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "RuleSetEntry_ruleSetId_order_idx" ON "RuleSetEntry"("ruleSetId", "order");

CREATE TABLE "RuleSetCache" (
  "ruleSetId" TEXT NOT NULL PRIMARY KEY,
  "normalizedContent" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "ruleCount" INTEGER NOT NULL,
  "duplicateCount" INTEGER NOT NULL DEFAULT 0,
  "warnings" TEXT NOT NULL DEFAULT '[]',
  "sourceEtag" TEXT,
  "sourceLastModified" TEXT,
  "fetchedAt" DATETIME NOT NULL,
  "validatedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RuleSetCache_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "PolicyRule" ADD COLUMN "matchSourceType" TEXT NOT NULL DEFAULT 'INLINE';
ALTER TABLE "PolicyRule" ADD COLUMN "ruleSetId" TEXT REFERENCES "RuleSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "PolicyRule_ruleSetId_idx" ON "PolicyRule"("ruleSetId");
