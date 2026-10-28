/*
  Warnings:

  - You are about to drop the column `tag` on the `Contact` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Contact" DROP COLUMN "tag",
ADD COLUMN     "tagId" TEXT;

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tag_organizationId_idx" ON "Tag"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_organizationId_name_key" ON "Tag"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Contact_tagId_idx" ON "Contact"("tagId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
