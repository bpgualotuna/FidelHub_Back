-- CreateTable
CREATE TABLE "CampaignContact" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignContact_campaignId_idx" ON "CampaignContact"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignContact_contactId_idx" ON "CampaignContact"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignContact_campaignId_contactId_key" ON "CampaignContact"("campaignId", "contactId");

-- AddForeignKey
ALTER TABLE "CampaignContact" ADD CONSTRAINT "CampaignContact_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContact" ADD CONSTRAINT "CampaignContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
