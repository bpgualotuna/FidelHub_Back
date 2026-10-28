-- CreateTable
CREATE TABLE "BroadcastLog" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BroadcastLog_conversationId_idx" ON "BroadcastLog"("conversationId");

-- CreateIndex
CREATE INDEX "BroadcastLog_createdAt_idx" ON "BroadcastLog"("createdAt" DESC);
