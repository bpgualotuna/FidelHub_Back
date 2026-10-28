-- CreateTable
CREATE TABLE "ConversationAssignmentLog" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "reassignedByUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationAssignmentLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationAssignmentLog_conversationId_idx" ON "ConversationAssignmentLog"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationAssignmentLog_fromUserId_idx" ON "ConversationAssignmentLog"("fromUserId");

-- CreateIndex
CREATE INDEX "ConversationAssignmentLog_createdAt_idx" ON "ConversationAssignmentLog"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ConversationAssignmentLog" ADD CONSTRAINT "ConversationAssignmentLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
