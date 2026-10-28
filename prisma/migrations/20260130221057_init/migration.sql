-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('RECEIVED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "lastUserMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "status" "MessageStatus" NOT NULL DEFAULT 'SENT',
    "body" TEXT NOT NULL,
    "whatsappMessageId" TEXT NOT NULL,
    "whatsappTimestamp" TIMESTAMP(3) NOT NULL,
    "fromAi" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_phone_key" ON "Contact"("phone");

-- CreateIndex
CREATE INDEX "Contact_phone_idx" ON "Contact"("phone");

-- CreateIndex
CREATE INDEX "Conversation_contactId_idx" ON "Conversation"("contactId");

-- CreateIndex
CREATE INDEX "Conversation_contactId_createdAt_idx" ON "Conversation"("contactId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Message_whatsappMessageId_key" ON "Message"("whatsappMessageId");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- CreateIndex
CREATE INDEX "Message_conversationId_whatsappTimestamp_idx" ON "Message"("conversationId", "whatsappTimestamp" ASC);

-- CreateIndex
CREATE INDEX "Message_whatsappMessageId_idx" ON "Message"("whatsappMessageId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
