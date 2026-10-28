-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "campaignId" TEXT;

-- CreateIndex
CREATE INDEX "Contact_campaignId_idx" ON "Contact"("campaignId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
