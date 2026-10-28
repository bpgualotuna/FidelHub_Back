-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'WEBCHAT', 'TELEGRAM');

-- AlterTable Contact
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "channel" "ChannelType" NOT NULL DEFAULT 'WHATSAPP',
ADD COLUMN IF NOT EXISTS "externalHandle" TEXT,
ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;

-- AlterTable Conversation
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "channel" "ChannelType" NOT NULL DEFAULT 'WHATSAPP',
ADD COLUMN IF NOT EXISTS "channelInstanceId" TEXT,
ADD COLUMN IF NOT EXISTS "activeMcpServerId" TEXT,
ADD COLUMN IF NOT EXISTS "isAiActive" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable Message
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "channel" "ChannelType" NOT NULL DEFAULT 'WHATSAPP',
ADD COLUMN IF NOT EXISTS "metadata" JSONB,
ADD COLUMN IF NOT EXISTS "mcpToolTraces" JSONB;

-- CreateTable ContactChannelIdentity
CREATE TABLE IF NOT EXISTS "ContactChannelIdentity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "externalId" TEXT NOT NULL,
    "usernameHandle" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactChannelIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable McpServerConfig
CREATE TABLE IF NOT EXISTS "McpServerConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "transport" TEXT NOT NULL DEFAULT 'http',
    "endpointUrl" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "assignedChannels" TEXT[] DEFAULT ARRAY['WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'TIKTOK']::TEXT[],
    "cachedTools" JSONB,
    "cachedResources" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpServerConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable ChannelAccountConfig
CREATE TABLE IF NOT EXISTS "ChannelAccountConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "displayName" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "accessTokenEnc" TEXT,
    "webhookVerifyToken" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelAccountConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Contact_organizationId_channel_idx" ON "Contact"("organizationId", "channel");
CREATE UNIQUE INDEX IF NOT EXISTS "ContactChannelIdentity_organizationId_channel_externalId_key" ON "ContactChannelIdentity"("organizationId", "channel", "externalId");
CREATE INDEX IF NOT EXISTS "ContactChannelIdentity_contactId_idx" ON "ContactChannelIdentity"("contactId");
CREATE INDEX IF NOT EXISTS "Conversation_channel_idx" ON "Conversation"("channel");
CREATE INDEX IF NOT EXISTS "Message_channel_idx" ON "Message"("channel");
CREATE INDEX IF NOT EXISTS "McpServerConfig_organizationId_idx" ON "McpServerConfig"("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelAccountConfig_organizationId_channel_key" ON "ChannelAccountConfig"("organizationId", "channel");
CREATE INDEX IF NOT EXISTS "ChannelAccountConfig_organizationId_idx" ON "ChannelAccountConfig"("organizationId");

-- AddForeignKey
ALTER TABLE "ContactChannelIdentity" ADD CONSTRAINT "ContactChannelIdentity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpServerConfig" ADD CONSTRAINT "McpServerConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelAccountConfig" ADD CONSTRAINT "ChannelAccountConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
