-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedToUserId" TEXT,
ADD COLUMN     "autoMessageDetectedAt" TIMESTAMP(3),
ADD COLUMN     "isNewLead" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Conversation_assignedToUserId_idx" ON "Conversation"("assignedToUserId");

-- CreateIndex
CREATE INDEX "Conversation_isNewLead_idx" ON "Conversation"("isNewLead");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
