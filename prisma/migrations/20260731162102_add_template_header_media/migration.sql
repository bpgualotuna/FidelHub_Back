-- CreateTable
CREATE TABLE "TemplateHeaderMedia" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "mediaUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateHeaderMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TemplateHeaderMedia_organizationId_idx" ON "TemplateHeaderMedia"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateHeaderMedia_organizationId_templateId_key" ON "TemplateHeaderMedia"("organizationId", "templateId");

-- AddForeignKey
ALTER TABLE "TemplateHeaderMedia" ADD CONSTRAINT "TemplateHeaderMedia_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
