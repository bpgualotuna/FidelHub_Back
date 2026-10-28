-- AlterTable
ALTER TABLE "BroadcastLog" ADD COLUMN     "failureCategory" TEXT,
ADD COLUMN     "messageId" TEXT,
ADD COLUMN     "runId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastLog_messageId_key" ON "BroadcastLog"("messageId");

-- CreateIndex
CREATE INDEX "BroadcastLog_runId_idx" ON "BroadcastLog"("runId");
