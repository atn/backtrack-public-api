-- AlterTable
ALTER TABLE "ProcessedEmail" ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "extractedDataJson" TEXT,
ADD COLUMN     "rawContent" TEXT,
ADD COLUMN     "snippet" TEXT,
ADD COLUMN     "subject" TEXT;
