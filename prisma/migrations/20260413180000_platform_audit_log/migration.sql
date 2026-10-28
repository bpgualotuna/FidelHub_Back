-- CreateTable
CREATE TABLE "PlatformAuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetOrganizationId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformAuditLog_actorUserId_idx" ON "PlatformAuditLog"("actorUserId");
CREATE INDEX "PlatformAuditLog_targetOrganizationId_idx" ON "PlatformAuditLog"("targetOrganizationId");
CREATE INDEX "PlatformAuditLog_createdAt_idx" ON "PlatformAuditLog"("createdAt" DESC);

ALTER TABLE "PlatformAuditLog" ADD CONSTRAINT "PlatformAuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
