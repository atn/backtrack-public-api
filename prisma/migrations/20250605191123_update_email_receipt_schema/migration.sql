-- AlterTable
ALTER TABLE "ProcessedEmail" ADD COLUMN     "receivedAt" TIMESTAMP(3),
ADD COLUMN     "sender" TEXT;

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD';
