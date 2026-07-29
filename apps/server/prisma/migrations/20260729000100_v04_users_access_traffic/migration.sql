-- ProxyHub V0.4 Phase 2: users, node access, and traffic accounting.
CREATE TABLE "UserGroup" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "UserGroup_name_key" ON "UserGroup"("name");

CREATE TABLE "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "remark" TEXT NOT NULL DEFAULT '',
  "groupId" TEXT,
  "adminEnabled" BOOLEAN NOT NULL DEFAULT true,
  "expiresAt" DATETIME,
  "trafficLimitBytes" BIGINT,
  "resetPolicy" TEXT NOT NULL DEFAULT 'NEVER',
    "resetDay" INTEGER,
    "lifecycleStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  "deletedAt" DATETIME,
  "lastTrafficAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "User_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "UserGroup" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "User_groupId_idx" ON "User"("groupId");
CREATE INDEX "User_adminEnabled_expiresAt_idx" ON "User"("adminEnabled", "expiresAt");
CREATE INDEX "User_deletedAt_createdAt_idx" ON "User"("deletedAt", "createdAt");

CREATE TABLE "UserCredential" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "encryptedClientId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rotatedAt" DATETIME,
  CONSTRAINT "UserCredential_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UserCredential_userId_key" ON "UserCredential"("userId");

CREATE TABLE "UserAccess" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "revokedAt" DATETIME,
  "statsIdentity" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "UserAccess_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UserAccess_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "Node" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UserAccess_statsIdentity_key" ON "UserAccess"("statsIdentity");
CREATE UNIQUE INDEX "UserAccess_userId_nodeId_key" ON "UserAccess"("userId", "nodeId");
CREATE INDEX "UserAccess_nodeId_enabled_idx" ON "UserAccess"("nodeId", "enabled");
CREATE INDEX "UserAccess_userId_enabled_idx" ON "UserAccess"("userId", "enabled");
CREATE INDEX "UserAccess_revokedAt_idx" ON "UserAccess"("revokedAt");

CREATE TABLE "UserTrafficUsage" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "currentCycleUplinkBytes" BIGINT NOT NULL DEFAULT 0,
  "currentCycleDownlinkBytes" BIGINT NOT NULL DEFAULT 0,
  "lifetimeUplinkBytes" BIGINT NOT NULL DEFAULT 0,
  "lifetimeDownlinkBytes" BIGINT NOT NULL DEFAULT 0,
  "cycleStartedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cycleEndsAt" DATETIME,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "UserTrafficUsage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "UserAccessTrafficUsage" (
  "userAccessId" TEXT NOT NULL PRIMARY KEY,
  "currentCycleUplinkBytes" BIGINT NOT NULL DEFAULT 0,
  "currentCycleDownlinkBytes" BIGINT NOT NULL DEFAULT 0,
  "lifetimeUplinkBytes" BIGINT NOT NULL DEFAULT 0,
  "lifetimeDownlinkBytes" BIGINT NOT NULL DEFAULT 0,
  "lastTrafficAt" DATETIME,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "UserAccessTrafficUsage_userAccessId_fkey"
    FOREIGN KEY ("userAccessId") REFERENCES "UserAccess" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "UserTrafficRuntimeCounter" (
  "userAccessId" TEXT NOT NULL PRIMARY KEY,
  "uplinkBytes" BIGINT NOT NULL DEFAULT 0,
  "downlinkBytes" BIGINT NOT NULL DEFAULT 0,
  "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "UserTrafficRuntimeCounter_userAccessId_fkey"
    FOREIGN KEY ("userAccessId") REFERENCES "UserAccess" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
