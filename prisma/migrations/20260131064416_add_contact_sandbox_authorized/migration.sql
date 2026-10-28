-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "isSandboxAuthorized" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "name" TEXT;
