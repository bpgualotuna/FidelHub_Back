-- AlterTable: add isEdited + editedAt to Message
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "isEdited" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMPTZ;

-- CreateTable: MessageEditHistory
CREATE TABLE IF NOT EXISTS "MessageEditHistory" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "previousBody" TEXT NOT NULL,
    "editedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageEditHistory_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "MessageEditHistory" ADD CONSTRAINT "MessageEditHistory_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MessageEditHistory_messageId_idx" ON "MessageEditHistory"("messageId");
CREATE INDEX IF NOT EXISTS "MessageEditHistory_editedAt_idx" ON "MessageEditHistory"("editedAt" DESC);
