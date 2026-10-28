-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "campaignId" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_campaignId_idx" ON "Conversation"("campaignId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
