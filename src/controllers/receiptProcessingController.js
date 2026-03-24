const prisma = require('../lib/prisma');
const gmailService = require('../services/gmailService');
const openaiService = require('../services/openaiService');

async function processPendingReceipts(req, reply) {
  const userId = req.user.id;

  // 1. Immediately mark all Google accounts for this user as "PROCESSING"
  await prisma.googleAccount.updateMany({
    where: { userId },
    data: {
      lastSyncStatus: 'PROCESSING',
      lastSyncAt: new Date(),
    },
  });

  // 2. Respond right away so the client isn't blocked
  reply.status(202).send({ 
    success: true,
    message: 'Receipt processing started.'
  });

  // 3. Kick off the heavy work in the background
  (async () => {
    let successfullyProcessed = 0;
    let failedExtractions = 0;
    const processingDetails = [];

    try {
      // Fetch pending emails
      const pendingEmails = await prisma.processedEmail.findMany({
        where: {
          userId,
          status: 'QUEUED_FOR_BACKGROUND_EXTRACTION',
          receipt: null,
        },
        select: {
          id: true,
          rawContent: true,
          receivedAt: true,
        },
      });

      if (pendingEmails.length > 0) {
        req.log.info({ userId, count: pendingEmails.length }, 'Background: processing pending receipts.');
      }

      // Prepare extraction promises
      const processingPromises = pendingEmails.map(async (pendingEmail) => {
        const base = { processedEmailId: pendingEmail.id };

        // Skip if no meaningful content
        const text = pendingEmail.rawContent;
        if (!text || text.trim().length < 50) {
          req.log.warn({ userId, ...base }, 'No meaningful content found.');
          return { status: 'NO_CONTENT', ...base, error: 'No meaningful content.' };
        }

        try {
          // Call OpenAI to extract receipt data
          const extractedData = await openaiService.extractReceiptDataFromEmail(text);

          // Validate extracted structure
          const valid =
            extractedData &&
            extractedData.vendor &&
            typeof extractedData.totalAmount === 'number' &&
            Array.isArray(extractedData.items) &&
            extractedData.items.length > 0 &&
            extractedData.items.every(item =>
              item.itemName &&
              typeof item.itemPrice === 'number' && item.itemPrice > 0 &&
              Number.isInteger(item.itemQuantity) && item.itemQuantity > 0
            );

          if (!valid) {
            req.log.warn({ userId, ...base, extractedData }, 'Invalid or incomplete extraction.');
            return {
              status: 'OPENAI_INVALID',
              ...base,
              extractedData: extractedData || {},
              error: 'Incomplete or invalid data',
            };
          }

          return { 
            status: 'SUCCESS', 
            ...base, 
            extractedData, 
            userId,
            receivedAt: pendingEmail.receivedAt
          };
        } catch (err) {
          req.log.error({ userId, ...base, err }, 'OpenAI extraction error.');
          return { status: 'ERROR', ...base, error: err };
        }
      });

      const results = await Promise.all(processingPromises);

      // Process results one by one
      for (const result of results) {
        const baseLog = { userId, processedEmailId: result.processedEmailId };

        try {
          switch (result.status) {
            case 'SUCCESS': {
              req.log.info(baseLog, 'Extraction succeeded, checking duplicates.');
              const txDate = result.receivedAt || new Date();
              const dateRange = !isNaN(txDate)
                ? {
                    gte: new Date(txDate.getTime() - 24 * 60 * 60 * 1000),
                    lte: new Date(txDate.getTime() + 24 * 60 * 60 * 1000),
                  }
                : undefined;

              // Use enhanced deduplication function from backgroundReceiptService
              const backgroundReceiptService = require('../services/backgroundReceiptService');
              const duplicateReceipt = await backgroundReceiptService.findDuplicateReceipts(
                userId, 
                result.extractedData, 
                result.receivedAt, 
                prisma, 
                req.log
              );

              if (duplicateReceipt) {
                req.log.info(baseLog, 'Duplicate detected—skipping.');
                await prisma.processedEmail.update({
                  where: { id: result.processedEmailId },
                  data: {
                    status: 'SKIPPED_DUPLICATE_RECEIPT',
                    extractedDataJson: JSON.stringify(result.extractedData),
                  },
                });
                processingDetails.push({
                  processedEmailId: result.processedEmailId,
                  status: 'SKIPPED_DUPLICATE_RECEIPT',
                  reason: 'Duplicate within 24h',
                });
                failedExtractions++;
                break;
              }

              // Create receipt and line items
              req.log.info(baseLog, 'Creating new receipt record.');
              const created = await prisma.receipt.create({
                data: {
                  userId: result.userId,
                  processedEmailId: result.processedEmailId,
                  vendorName: result.extractedData.vendor,
                  transactionDate: txDate,
                  totalAmount: parseFloat(result.extractedData.totalAmount) || 0,
                  status: 'PROCESSED',
                  items: {
                    create: result.extractedData.items.map(item => ({
                      itemName: item.itemName,
                      itemPrice: item.itemPrice,
                      sellScore: item.sellScore,
                      itemQuantity: item.itemQuantity,
                    })),
                  },
                },
              });
              await prisma.processedEmail.update({
                where: { id: result.processedEmailId },
                data: {
                  status: 'PROCESSED_RECEIPT_VIA_OPENAI',
                  extractedDataJson: JSON.stringify(result.extractedData),
                },
              });
              processingDetails.push({
                processedEmailId: result.processedEmailId,
                status: 'PROCESSED_RECEIPT_VIA_OPENAI',
                receiptId: created.id,
              });
              successfullyProcessed++;
              break;
            }

            case 'NO_CONTENT':
              await prisma.processedEmail.update({
                where: { id: result.processedEmailId },
                data: {
                  status: 'EXTRACTION_FAILED_NO_CONTENT',
                  extractedDataJson: JSON.stringify({}),
                },
              });
              processingDetails.push({
                processedEmailId: result.processedEmailId,
                status: 'EXTRACTION_FAILED_NO_CONTENT',
                error: result.error,
              });
              failedExtractions++;
              break;

            case 'OPENAI_INVALID':
              await prisma.processedEmail.update({
                where: { id: result.processedEmailId },
                data: {
                  status: 'OPENAI_EXTRACTION_EMPTY_OR_INVALID',
                  extractedDataJson: JSON.stringify(result.extractedData),
                },
              });
              processingDetails.push({
                processedEmailId: result.processedEmailId,
                status: 'OPENAI_EXTRACTION_EMPTY_OR_INVALID',
                error: result.error,
              });
              failedExtractions++;
              break;

            case 'ERROR':
              req.log.error({ ...baseLog, err: result.error }, 'Extraction promise error.');
              await prisma.processedEmail.update({
                where: { id: result.processedEmailId },
                data: {
                  status: 'EXTRACTION_FAILED_CONTROLLER_ERROR',
                  errorMessage: result.error.message?.substring(0, 1000) || 'Unknown error',
                },
              });
              processingDetails.push({
                processedEmailId: result.processedEmailId,
                status: 'EXTRACTION_FAILED_CONTROLLER_ERROR',
                error: result.error.message || 'Unknown',
              });
              failedExtractions++;
              break;
          }
        } catch (dbErr) {
          req.log.error({ err: dbErr, ...baseLog }, 'DB update error after processing.');
          processingDetails.push({
            processedEmailId: result.processedEmailId,
            status: 'DB_UPDATE_FAILED_AFTER_PROCESSING',
            error: dbErr.message,
          });
          // Avoid double-counting if extraction already failed
          if (result.status === 'SUCCESS') {
            failedExtractions++;
          }
        }
      }

      // Update account status based on outcomes
      const finalStatus =
        failedExtractions > 0
          ? successfullyProcessed > 0
            ? 'PARTIAL_OPENAI_PROCESSING'
            : 'ERROR_OPENAI_PROCESSING'
          : 'SUCCESS_OPENAI_PROCESSING';

      await prisma.googleAccount.updateMany({
        where: { userId },
        data: { lastSyncStatus: finalStatus, lastSyncAt: new Date() },
      });

      req.log.info(
        { userId, successful: successfullyProcessed, failed: failedExtractions },
        'Background: receipt processing complete.'
      );
    } catch (fatalErr) {
      req.log.error({ err: fatalErr, userId }, 'Background: fatal error.');
      await prisma.googleAccount.updateMany({
        where: { userId },
        data: { lastSyncStatus: 'ERROR_OPENAI_PROCESSING', lastSyncAt: new Date() },
      });
    }
  })();
}

module.exports = {
  processPendingReceipts,
};