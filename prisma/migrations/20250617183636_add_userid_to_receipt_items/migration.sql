/*
  Warnings:

  - Added the required column `userId` to the `ReceiptItem` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "GoogleAccount" ADD COLUMN     "lastSyncProgress" JSONB;

-- AlterTable - Add userId as nullable first
ALTER TABLE "ReceiptItem" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "userId" INTEGER;

-- Populate userId from related Receipt
UPDATE "ReceiptItem" 
SET "userId" = "Receipt"."userId" 
FROM "Receipt" 
WHERE "ReceiptItem"."receiptId" = "Receipt"."id";

-- Make userId NOT NULL after populating
ALTER TABLE "ReceiptItem" ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "pushToken" TEXT;

-- CreateTable
CREATE TABLE "VaultItem" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "originalReceiptItemId" TEXT,
    "itemName" TEXT NOT NULL,
    "itemPrice" DOUBLE PRECISION NOT NULL,
    "itemQuantity" INTEGER NOT NULL,
    "sellScore" INTEGER,
    "resaleValue" DOUBLE PRECISION,
    "storeName" TEXT,
    "transactionDate" TIMESTAMP(3),
    "swipedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VaultItem_userId_idx" ON "VaultItem"("userId");

-- CreateIndex
CREATE INDEX "VaultItem_originalReceiptItemId_idx" ON "VaultItem"("originalReceiptItemId");

-- CreateIndex
CREATE INDEX "ReceiptItem_userId_status_idx" ON "ReceiptItem"("userId", "status");

-- AddForeignKey
ALTER TABLE "ReceiptItem" ADD CONSTRAINT "ReceiptItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultItem" ADD CONSTRAINT "VaultItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
