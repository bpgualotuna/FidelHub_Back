ALTER TABLE "Contact" ADD COLUMN "interestStatus" TEXT;
ALTER TABLE "Contact" ADD COLUMN "interestRespondedAt" TIMESTAMP(3);
CREATE INDEX "Contact_organizationId_interestStatus_idx" ON "Contact"("organizationId", "interestStatus");
ALTER TABLE "Message" ADD COLUMN "metaTemplateName" TEXT;
