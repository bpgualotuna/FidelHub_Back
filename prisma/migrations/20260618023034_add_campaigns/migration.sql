-- DropForeignKey
ALTER TABLE "CrmAuditLog" DROP CONSTRAINT "CrmAuditLog_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "MessageEditHistory" DROP CONSTRAINT "MessageEditHistory_messageId_fkey";

-- AlterTable
ALTER TABLE "Message" ALTER COLUMN "editedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MessageEditHistory" ALTER COLUMN "editedAt" SET DATA TYPE TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CrmIntegration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "codigoVinculacion" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL DEFAULT '',
    "apiKeyEncrypted" TEXT,
    "crmUrl" TEXT,
    "crmName" TEXT NOT NULL DEFAULT 'CRM',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmIntegration_organizationId_key" ON "CrmIntegration"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmIntegration_codigoVinculacion_key" ON "CrmIntegration"("codigoVinculacion");

-- CreateIndex
CREATE INDEX "CrmIntegration_codigoVinculacion_idx" ON "CrmIntegration"("codigoVinculacion");

-- CreateIndex
CREATE INDEX "Campaign_organizationId_idx" ON "Campaign"("organizationId");

-- CreateIndex
CREATE INDEX "Campaign_isActive_idx" ON "Campaign"("isActive");

-- AddForeignKey
ALTER TABLE "CrmIntegration" ADD CONSTRAINT "CrmIntegration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageEditHistory" ADD CONSTRAINT "MessageEditHistory_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
