-- AlterTable
ALTER TABLE "ReceiptItem" ADD COLUMN     "lastFeedCandidateAt" TIMESTAMP(3),
ADD COLUMN     "lastFeedReason" TEXT,
ADD COLUMN     "recommendedAction" TEXT,
ADD COLUMN     "resaleValueHistory" JSONB,
ADD COLUMN     "resaleValueLastChecked" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastFeedRefresh" TIMESTAMP(3);
