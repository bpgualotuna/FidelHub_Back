-- CreateTable: BroadcastList for CRM mass messaging lists
CREATE TABLE "BroadcastList" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "crmExportedAt" TIMESTAMP(3),
    "contactCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "assignedToUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastList_pkey" PRIMARY KEY ("id")
);

-- CreateTable: BroadcastListContact (junction table)
CREATE TABLE "BroadcastListContact" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "externalId" TEXT,
    "campaign" TEXT,
    "seller" TEXT,
    "source" TEXT DEFAULT 'crm',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastListContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CrmContactLink for traceability
CREATE TABLE "CrmContactLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "crmLeadId" TEXT NOT NULL,
    "chatcontrolContactId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "listId" TEXT,
    "assignedToUserId" TEXT,
    "externalData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmContactLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CrmAuditLog for sync history
CREATE TABLE "CrmAuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "crmUser" TEXT,
    "crmName" TEXT,
    "contactsTotal" INTEGER,
    "contactsCreated" INTEGER,
    "contactsUpdated" INTEGER,
    "contactsRejected" INTEGER,
    "listName" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes for BroadcastList
CREATE INDEX "BroadcastList_organizationId_idx" ON "BroadcastList"("organizationId");
CREATE INDEX "BroadcastList_source_idx" ON "BroadcastList"("source");
CREATE INDEX "BroadcastList_assignedToUserId_idx" ON "BroadcastList"("assignedToUserId");
CREATE UNIQUE INDEX "BroadcastList_organizationId_name_key" ON "BroadcastList"("organizationId", "name");

-- CreateIndexes for BroadcastListContact
CREATE INDEX "BroadcastListContact_listId_idx" ON "BroadcastListContact"("listId");
CREATE INDEX "BroadcastListContact_contactId_idx" ON "BroadcastListContact"("contactId");
CREATE UNIQUE INDEX "BroadcastListContact_listId_contactId_key" ON "BroadcastListContact"("listId", "contactId");

-- CreateIndexes for CrmContactLink
CREATE INDEX "CrmContactLink_organizationId_idx" ON "CrmContactLink"("organizationId");
CREATE INDEX "CrmContactLink_phone_idx" ON "CrmContactLink"("phone");
CREATE INDEX "CrmContactLink_chatcontrolContactId_idx" ON "CrmContactLink"("chatcontrolContactId");
CREATE INDEX "CrmContactLink_listId_idx" ON "CrmContactLink"("listId");
CREATE INDEX "CrmContactLink_assignedToUserId_idx" ON "CrmContactLink"("assignedToUserId");
CREATE UNIQUE INDEX "CrmContactLink_organizationId_crmLeadId_key" ON "CrmContactLink"("organizationId", "crmLeadId");

-- CreateIndexes for CrmAuditLog
CREATE INDEX "CrmAuditLog_organizationId_idx" ON "CrmAuditLog"("organizationId");
CREATE INDEX "CrmAuditLog_createdAt_idx" ON "CrmAuditLog"("createdAt" DESC);

-- AddForeignKeys for BroadcastList
ALTER TABLE "BroadcastList" ADD CONSTRAINT "BroadcastList_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BroadcastList" ADD CONSTRAINT "BroadcastList_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKeys for BroadcastListContact
ALTER TABLE "BroadcastListContact" ADD CONSTRAINT "BroadcastListContact_listId_fkey" FOREIGN KEY ("listId") REFERENCES "BroadcastList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BroadcastListContact" ADD CONSTRAINT "BroadcastListContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKeys for CrmContactLink
ALTER TABLE "CrmContactLink" ADD CONSTRAINT "CrmContactLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmContactLink" ADD CONSTRAINT "CrmContactLink_chatcontrolContactId_fkey" FOREIGN KEY ("chatcontrolContactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmContactLink" ADD CONSTRAINT "CrmContactLink_listId_fkey" FOREIGN KEY ("listId") REFERENCES "BroadcastList"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CrmContactLink" ADD CONSTRAINT "CrmContactLink_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKeys for CrmAuditLog
ALTER TABLE "CrmAuditLog" ADD CONSTRAINT "CrmAuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
