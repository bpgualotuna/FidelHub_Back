-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ORG_ADMIN', 'AGENT');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "whatsappPhoneNumberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Organization_whatsappPhoneNumberId_key" ON "Organization"("whatsappPhoneNumberId");

INSERT INTO "Organization" ("id", "name", "status", "whatsappPhoneNumberId", "createdAt", "updatedAt")
VALUES ('org_default_migration', 'Default', 'ACTIVE', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- CreateTable
CREATE TABLE "OrganizationCredentials" (
    "organizationId" TEXT NOT NULL,
    "whatsappAccessTokenEnc" TEXT,
    "whatsappBusinessAccountIdEnc" TEXT,
    "geminiApiKeyEnc" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationCredentials_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "OrganizationSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "role" "UserRole" NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");
CREATE INDEX "User_email_idx" ON "User"("email");

-- AlterTable Contact
DROP INDEX IF EXISTS "Contact_phone_key";

ALTER TABLE "Contact" ADD COLUMN "organizationId" TEXT;
UPDATE "Contact" SET "organizationId" = 'org_default_migration' WHERE "organizationId" IS NULL;
ALTER TABLE "Contact" ALTER COLUMN "organizationId" SET NOT NULL;

CREATE UNIQUE INDEX "Contact_organizationId_phone_key" ON "Contact"("organizationId", "phone");

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable Template
ALTER TABLE "Template" ADD COLUMN "organizationId" TEXT;
UPDATE "Template" SET "organizationId" = 'org_default_migration' WHERE "organizationId" IS NULL;
ALTER TABLE "Template" ALTER COLUMN "organizationId" SET NOT NULL;

CREATE INDEX "Template_organizationId_idx" ON "Template"("organizationId");

ALTER TABLE "Template" ADD CONSTRAINT "Template_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable BroadcastLog
ALTER TABLE "BroadcastLog" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "BroadcastLog" ADD COLUMN "userId" TEXT;

UPDATE "BroadcastLog" bl
SET "organizationId" = ct."organizationId"
FROM "Conversation" c
INNER JOIN "Contact" ct ON ct."id" = c."contactId"
WHERE bl."conversationId" = c."id" AND bl."organizationId" IS NULL;

CREATE INDEX "BroadcastLog_organizationId_idx" ON "BroadcastLog"("organizationId");

-- AlterTable Message
ALTER TABLE "Message" ADD COLUMN "sentByUserId" TEXT;

CREATE INDEX "Message_sentByUserId_idx" ON "Message"("sentByUserId");

-- FKs after User exists (User has no dependency on Message)
ALTER TABLE "OrganizationCredentials" ADD CONSTRAINT "OrganizationCredentials_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrganizationSetting" ADD CONSTRAINT "OrganizationSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "OrganizationSetting_organizationId_key_key" ON "OrganizationSetting"("organizationId", "key");

CREATE INDEX "OrganizationSetting_organizationId_idx" ON "OrganizationSetting"("organizationId");

ALTER TABLE "Message" ADD CONSTRAINT "Message_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
