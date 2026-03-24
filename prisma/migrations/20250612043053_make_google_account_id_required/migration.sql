/*
  Warnings:

  - Made the column `googleAccountId` on table `ProcessedEmail` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "ProcessedEmail" ALTER COLUMN "googleAccountId" SET NOT NULL;
