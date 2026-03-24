/*
  Warnings:

  - You are about to drop the `VaultItem` table. If the table is not empty, all the data it contains will be lost.

*/

-- AlterTable - Add new columns to ReceiptItem and temporarily make receiptId nullable
ALTER TABLE "ReceiptItem" ADD COLUMN     "storeName" TEXT,
ADD COLUMN     "swipedAt" TIMESTAMP(3),
ADD COLUMN     "transactionDate" TIMESTAMP(3);

-- Temporarily make receiptId nullable to handle vault items without original receipt items
ALTER TABLE "ReceiptItem" ALTER COLUMN "receiptId" DROP NOT NULL;

-- Migrate existing VaultItem data to ReceiptItem
-- First, update ReceiptItems that have corresponding VaultItems (linked by originalReceiptItemId)
UPDATE "ReceiptItem" 
SET 
  "status" = 'vault',
  "storeName" = "VaultItem"."storeName",
  "transactionDate" = "VaultItem"."transactionDate",
  "swipedAt" = "VaultItem"."swipedAt",
  "resaleValue" = "VaultItem"."resaleValue",
  "sellScore" = "VaultItem"."sellScore"
FROM "VaultItem" 
WHERE "ReceiptItem"."id" = "VaultItem"."originalReceiptItemId"
  AND "VaultItem"."originalReceiptItemId" IS NOT NULL;

-- For vault items without originalReceiptItemId, create new ReceiptItem records
-- These will have NULL receiptId since they don't belong to a specific receipt
INSERT INTO "ReceiptItem" (
  "id", "receiptId", "userId", "itemName", "itemPrice", "itemQuantity", 
  "sellScore", "status", "resaleValue", "storeName", "transactionDate", "swipedAt"
)
SELECT 
  "VaultItem"."id",
  NULL, -- No receipt associated
  "VaultItem"."userId",
  "VaultItem"."itemName",
  "VaultItem"."itemPrice",
  "VaultItem"."itemQuantity",  
  "VaultItem"."sellScore",
  'vault',
  "VaultItem"."resaleValue",
  "VaultItem"."storeName", 
  "VaultItem"."transactionDate",
  "VaultItem"."swipedAt"
FROM "VaultItem"
WHERE "VaultItem"."originalReceiptItemId" IS NULL;

-- DropForeignKey
ALTER TABLE "VaultItem" DROP CONSTRAINT "VaultItem_userId_fkey";

-- DropTable
DROP TABLE "VaultItem";
