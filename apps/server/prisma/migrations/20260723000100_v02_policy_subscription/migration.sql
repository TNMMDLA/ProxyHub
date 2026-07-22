-- V0.2 additive migration: unified policy rules and secure subscriptions.
CREATE TABLE "Policy" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "defaultAction" TEXT NOT NULL DEFAULT 'DIRECT',
  "defaultNodePoolId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Policy_defaultNodePoolId_fkey" FOREIGN KEY ("defaultNodePoolId") REFERENCES "NodePool" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Policy_name_key" ON "Policy"("name");
CREATE INDEX "Policy_enabled_updatedAt_idx" ON "Policy"("enabled", "updatedAt");
CREATE INDEX "Policy_defaultNodePoolId_idx" ON "Policy"("defaultNodePoolId");

CREATE TABLE "PolicyRule" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "policyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "priority" INTEGER NOT NULL,
  "matchType" TEXT NOT NULL,
  "matchValue" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "nodePoolId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PolicyRule_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PolicyRule_nodePoolId_fkey" FOREIGN KEY ("nodePoolId") REFERENCES "NodePool" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "PolicyRule_policyId_priority_idx" ON "PolicyRule"("policyId", "priority");
CREATE INDEX "PolicyRule_nodePoolId_idx" ON "PolicyRule"("nodePoolId");

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "policyId" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "tokenPrefix" TEXT NOT NULL,
  "expiresAt" DATETIME,
  "lastAccessAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Subscription_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Subscription_name_key" ON "Subscription"("name");
CREATE UNIQUE INDEX "Subscription_tokenHash_key" ON "Subscription"("tokenHash");
CREATE INDEX "Subscription_policyId_idx" ON "Subscription"("policyId");
CREATE INDEX "Subscription_enabled_expiresAt_idx" ON "Subscription"("enabled", "expiresAt");
