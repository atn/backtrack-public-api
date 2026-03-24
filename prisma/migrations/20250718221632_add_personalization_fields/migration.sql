-- AlterTable
ALTER TABLE "ReceiptItem" ADD COLUMN     "categoryTag" TEXT,
ADD COLUMN     "feedInteractions" JSONB,
ADD COLUMN     "lastUserInteraction" TIMESTAMP(3),
ADD COLUMN     "personalizedScore" DOUBLE PRECISION,
ADD COLUMN     "userEngagement" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "achievements" JSONB,
ADD COLUMN     "behaviorProfile" JSONB,
ADD COLUMN     "feedEngagementScore" DOUBLE PRECISION,
ADD COLUMN     "feedPreferences" JSONB,
ADD COLUMN     "lastFeedInteraction" TIMESTAMP(3),
ADD COLUMN     "sellingStats" JSONB;
