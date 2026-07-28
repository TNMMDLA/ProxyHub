-- V0.4 additive migration: bounded, server-side node performance test history.
CREATE TABLE "NetworkPerformanceRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "score" INTEGER,
    "summaryJson" TEXT NOT NULL DEFAULT '{}',
    "environmentJson" TEXT NOT NULL DEFAULT '{}',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "xrayVersion" TEXT,
    "proxyhubVersion" TEXT NOT NULL,
    "buildSha" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NetworkPerformanceRun_nodeId_fkey"
      FOREIGN KEY ("nodeId") REFERENCES "Node" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "NetworkPerformanceTargetResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetLabel" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "directMbps" REAL,
    "tunnelMbps" REAL,
    "efficiencyPercent" REAL,
    "latencyMedianMs" REAL,
    "latencyP95Ms" REAL,
    "jitterMs" REAL,
    "successfulRequests" INTEGER NOT NULL DEFAULT 0,
    "failedRequests" INTEGER NOT NULL DEFAULT 0,
    "directSamplesJson" TEXT NOT NULL DEFAULT '[]',
    "tunnelSamplesJson" TEXT NOT NULL DEFAULT '[]',
    "uploadStatus" TEXT NOT NULL DEFAULT 'NOT_AVAILABLE',
    "analysisCodesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NetworkPerformanceTargetResult_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "NetworkPerformanceRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "NetworkPerformanceRun_nodeId_startedAt_idx"
  ON "NetworkPerformanceRun"("nodeId", "startedAt");
CREATE INDEX "NetworkPerformanceRun_status_startedAt_idx"
  ON "NetworkPerformanceRun"("status", "startedAt");
CREATE UNIQUE INDEX "NetworkPerformanceTargetResult_runId_targetId_key"
  ON "NetworkPerformanceTargetResult"("runId", "targetId");
CREATE INDEX "NetworkPerformanceTargetResult_runId_idx"
  ON "NetworkPerformanceTargetResult"("runId");
