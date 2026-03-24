const prisma = require('../lib/prisma');
const openaiService = require('./openaiService');
const gmailService = require('./gmailService');
const notificationService = require('./notificationService');
const { createLogger } = require('../utils/logger');

const SERVICE_NAME = 'BACKGROUND_RECEIPT_SERVICE';
const logger = createLogger(SERVICE_NAME);
const BATCH_SIZE = parseInt(process.env.RECEIPT_EXTRACTION_BATCH_SIZE, 10) || 10;
const OPENAI_CONCURRENT_CALLS = parseInt(process.env.OPENAI_CONCURRENT_CALLS, 10) || 3;

// Helper function to update GoogleAccount status
async function updateGoogleAccountStatus(googleAccountId, status, errorMessage = null) {
  if (!googleAccountId) { 
    logger.warn(`Attempted to update GoogleAccount status with null/undefined accountId. Status: ${status}`, { service: SERVICE_NAME, status });
    return;
  }
  try {
    await prisma.googleAccount.update({
      where: { id: googleAccountId },
      data: {
        lastSyncStatus: status,
        lastSyncAt: new Date(),
        // errorMessage: errorMessage, // Consider adding if schema supports it
      },
    });
    logger.info(`GAccount ${googleAccountId} status updated to ${status}.`, { service: SERVICE_NAME, googleAccountId, status });
  } catch (error) {
    logger.error(`Failed to update status for GAccount ${googleAccountId} to ${status}: ${error.message}`, { service: SERVICE_NAME, googleAccountId, status, error: error.message, stack: error.stack });
  }
}

// Helper function to validate the structure and content of extracted receipt data
function isValidReceiptData(extractedData, localLogger = console) {
  if (!extractedData || typeof extractedData !== 'object') {
    localLogger.warn('[isValidReceiptData] Extracted data is not an object or is null.');
    return false;
  }

  if (!extractedData.vendor || typeof extractedData.vendor !== 'string') {
    localLogger.warn(`[isValidReceiptData] Invalid vendor type: ${typeof extractedData.vendor}. Value: ${extractedData.vendor}`);
    return false;
  }

  if (!Array.isArray(extractedData.items) || extractedData.items.length === 0) {
    localLogger.warn('[isValidReceiptData] Items array is invalid, empty, or missing.');
    return false;
  }

  // List of terms that indicate non-resellable items
  const nonResellableTerms = [
    'food', 'drink', 'beverage', 'meal', 'snack', 'coffee', 'tea', 'water',
    'soda', 'beer', 'wine', 'alcohol', 'liquor', 'cigarette', 'tobacco',
    'digital', 'subscription', 'service', 'membership', 'fee', 'tax',
    'tip', 'gratuity', 'delivery', 'shipping', 'handling'
  ];

  // Check each item
  for (const item of extractedData.items) {
    if (!item || typeof item !== 'object') {
      localLogger.warn('[isValidReceiptData] Invalid item structure: not an object or is null.');
      return false;
    }

    if (!item.itemName || typeof item.itemName !== 'string') {
      localLogger.warn(`[isValidReceiptData] Invalid item name: not a string or empty. Value: ${item.itemName}`);
      return false;
    }

    if (typeof item.itemPrice !== 'number' || item.itemPrice <= 0) {
      localLogger.warn(`[isValidReceiptData] Invalid item price: not a positive number. Value: ${item.itemPrice}`);
      return false;
    }

    if (!Number.isInteger(item.itemQuantity) || item.itemQuantity <= 0) {
      localLogger.warn(`[isValidReceiptData] Invalid item quantity: not a positive integer. Value: ${item.itemQuantity}`);
      return false;
    }

    // Check for non-resellable items
    const itemNameLower = item.itemName.toLowerCase();
    for (const term of nonResellableTerms) {
      if (itemNameLower.includes(term)) {
        localLogger.warn(`[isValidReceiptData] Non-resellable item found in item name: "${item.itemName}" (contains term: "${term}")`);
        return false;
      }
    }
  }

  return true;
}

// Helper function to find duplicate receipts
async function findDuplicateReceipts(userId, extractedData, receivedAt) {
  const logInfo = { userId, vendor: extractedData.vendor, totalAmount: extractedData.totalAmount };
  
  // Expand the date range to 3 days to catch receipts that might arrive at different times
  const txDate = receivedAt || new Date();
  const dateRange = !isNaN(txDate) ? {
    gte: new Date(txDate.getTime() - 3 * 24 * 60 * 60 * 1000), // 3 days before
    lte: new Date(txDate.getTime() + 3 * 24 * 60 * 60 * 1000)  // 3 days after
  } : undefined;

  // Normalize vendor name for comparison
  const normalizeVendorName = (name) => {
    if (!name) return '';
    return name.toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9\s]/g, '')
      .trim();
  };

  const normalizedVendor = normalizeVendorName(extractedData.vendor);
  const totalAmount = parseFloat(extractedData.totalAmount) || 0;

  // Find potential duplicates with broader criteria
  const potentialDuplicates = await prisma.receipt.findMany({
    where: {
      userId,
      ...(dateRange && { transactionDate: dateRange }),
      // Use OR conditions to catch various scenarios
      OR: [
        // Exact match
        {
          vendorName: extractedData.vendor,
          totalAmount: totalAmount
        },
        // Normalized vendor name match with exact amount
        {
          vendorName: {
            contains: normalizedVendor,
            mode: 'insensitive'
          },
          totalAmount: totalAmount
        },
        // Exact vendor with amount within $2 tolerance (for rounding differences)
        {
          vendorName: extractedData.vendor,
          totalAmount: {
            gte: totalAmount - 2,
            lte: totalAmount + 2
          }
        }
      ]
    },
    include: { 
      items: true,
      processedEmail: {
        select: {
          subject: true,
          googleEmailId: true
        }
      }
    }
  });

  if (potentialDuplicates.length === 0) {
    logger.info(logInfo, 'No potential duplicates found.');
    return null;
  }

  // Normalize items for comparison
  const normalizeItemsForComparison = (items) => {
    return items
      .map(item => ({
        name: item.itemName.toLowerCase().trim().replace(/\s+/g, ' '),
        price: parseFloat(item.itemPrice),
        quantity: parseInt(item.itemQuantity)
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.price - b.price);
  };

  const newItemsNormalized = normalizeItemsForComparison(extractedData.items);

  // Check each potential duplicate
  for (const duplicate of potentialDuplicates) {
    const dupItemsNormalized = normalizeItemsForComparison(duplicate.items);
    
    // Check if items match (allowing for minor variations)
    const itemsMatch = areItemArraysEquivalent(newItemsNormalized, dupItemsNormalized);
    
    if (itemsMatch) {
      logger.info({
        ...logInfo,
        duplicateReceiptId: duplicate.id,
        duplicateEmailSubject: duplicate.processedEmail?.subject,
        duplicateGoogleEmailId: duplicate.processedEmail?.googleEmailId
      }, 'Duplicate receipt detected based on items comparison.');
      
      return duplicate;
    }
  }

  logger.info({
    ...logInfo,
    potentialDuplicatesCount: potentialDuplicates.length
  }, 'Potential duplicates found but items did not match after normalization.');
  
  return null;
}

// Helper function to compare item arrays with tolerance for minor differences
function areItemArraysEquivalent(items1, items2) {
  if (items1.length !== items2.length) return false;
  
  return items1.every((item1, index) => {
    const item2 = items2[index];
    
    // Allow for minor differences in item names (85% similarity)
    const nameMatch = item1.name === item2.name || 
                     calculateStringSimilarity(item1.name, item2.name) > 0.85;
    
    // Allow for small price differences (within $0.50)
    const priceMatch = Math.abs(item1.price - item2.price) <= 0.50;
    
    // Quantities must match exactly
    const quantityMatch = item1.quantity === item2.quantity;
    
    return nameMatch && priceMatch && quantityMatch;
  });
}

// Simple string similarity function
function calculateStringSimilarity(str1, str2) {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1.0;
  
  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
}

// Levenshtein distance calculation
function levenshteinDistance(str1, str2) {
  const matrix = [];
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[str2.length][str1.length];
}

async function processSingleEmailForOpenAI(email, gmailClient) {
  try {
    logger.info(`Processing email ${email.id} for OpenAI extraction`);
    
    // Get the full message details
    const messageDetails = await gmailService.getMessageDetails(gmailClient, email.id);
    if (!messageDetails) {
      logger.warn(`No message details found for email ${email.id}`);
      return;
    }

    // Extract content including images
    const content = gmailService.extractContentFromMessage(messageDetails);
    if (!content || !content.text) {
      logger.warn(`No meaningful content found in email ${email.id}`);
      return;
    }

    // Update status to processing
    await prisma.processedEmail.update({
      where: { id: email.id },
      data: {
        status: 'processing',
        lastProcessedAt: new Date()
      }
    });

    // Extract receipt data using OpenAI
    const extractedData = await openaiService.extractReceiptDataFromEmail(content.text);
    
    if (!extractedData || !extractedData.vendor || !extractedData.items || extractedData.items.length === 0) {
      logger.warn(`No valid receipt data extracted from email ${email.id}`);
      await prisma.processedEmail.update({
        where: { id: email.id },
        data: {
          status: 'no_data',
          lastProcessedAt: new Date()
        }
      });
      return;
    }

    // Validate the extracted data
    const validationResult = isValidReceiptData(extractedData, logger);
    if (!validationResult) {
      logger.warn(`Validation failed for email ${email.id}: Non-resellable item found.`);
      await prisma.processedEmail.update({
        where: { id: email.id },
        data: {
          status: 'validation_failed',
          validationError: 'Non-resellable item found.',
          lastProcessedAt: new Date()
        }
      });
      return;
    }

    // Create receipt items with OpenAI-provided image URLs
    const receiptItems = extractedData.items.map(item => ({
      name: item.name,
      price: item.price,
      quantity: item.quantity || 1,
      imageUrl: item.imageUrl || null // Use OpenAI-provided image URL or null
    }));

    // Create the receipt document
    const receipt = await prisma.receipt.create({
        data: {
        userId: email.userId,
        processedEmailId: email.id,
        vendorName: extractedData.vendor,
        totalAmount: extractedData.total,
        transactionDate: extractedData.date || new Date(),
        currency: extractedData.currency || 'USD',
          status: 'PROCESSED',
        items: {
          create: receiptItems.map(item => ({
            userId: email.userId,
            itemName: item.name,
            itemPrice: item.price,
            itemQuantity: item.quantity,
            imageUrl: item.imageUrl,
          })),
        },
        },
      });

    if (receipt.id) {
      logger.info(`Successfully processed email ${email.id} into receipt ${receipt.id}`);
      
      // Update email status to processed
      await prisma.processedEmail.update({
        where: { id: email.id },
        data: {
          status: 'processed',
          receiptId: receipt.id,
          lastProcessedAt: new Date()
        }
      });
    } else {
      throw new Error('Failed to insert receipt into database');
    }

  } catch (error) {
    logger.error(`Error processing email ${email.id}:`, error);
    
    // Update email status to error
    await prisma.processedEmail.update({
      where: { id: email.id },
      data: {
        status: 'error',
        error: error.message,
        lastProcessedAt: new Date()
      }
    });
  }
}

async function extractDataFromPendingEmails(userId) {
  logger.info(`Starting background extraction for user ${userId}.`);

  // 1. Update Google account status to PROCESSING and initialize progress
  const initialProgress = {
    stage: 'PREPARING_EXTRACTION',
    totalEmailsToProcess: 0,
    emailsProcessed: 0,
    receiptsFound: 0,
    currentEmailSubject: null,
    errorSummary: null,
  };
  await prisma.googleAccount.updateMany({
    where: { userId },
    data: {
      lastSyncStatus: 'PROCESSING',
      lastSyncProgress: initialProgress,
      lastSyncAt: new Date(),
    },
  });

  // Note: Removed "Processing Started" notification to reduce spam
  // Users will only be notified when processing is complete (status changes to IDLE)

  let successfullyProcessed = 0;
  let failedExtractions = 0;
  const processingDetails = [];

  try {
    // Fetch pending emails
    const pendingEmails = await prisma.processedEmail.findMany({
      where: {
        userId,
        status: 'QUEUED_FOR_BACKGROUND_EXTRACTION',
        receipt: null, // Only those not yet having a receipt
      },
      select: {
        id: true,
        rawContent: true,
        receivedAt: true,
        subject: true, // For progress updates
      },
      orderBy: {
        receivedAt: 'desc', // Process newer emails first or as per desired logic
      }
    });

    if (pendingEmails.length > 0) {
      logger.info({ userId, count: pendingEmails.length }, 'Background: processing pending receipts.');
      await prisma.googleAccount.updateMany({
        where: { userId },
        data: {
          lastSyncProgress: {
            ...initialProgress,
            stage: 'ANALYZING_EMAILS',
            totalEmailsToProcess: pendingEmails.length,
          }
        }
      });
    } else {
        await prisma.googleAccount.updateMany({
            where: { userId },
            data: {
              lastSyncStatus: 'SUCCESS_OPENAI_PROCESSING',
              lastSyncProgress: { ...initialProgress, stage: 'COMPLETED', totalEmailsToProcess: 0 },
              lastSyncAt: new Date(),
            },
        });
        logger.info({ userId }, 'Background: No pending emails to process.');
        return { successful: 0, failed: 0, details: [] };
    }
    
    let emailsProcessedInLoop = 0;

    // Process emails in parallel
    const results = await Promise.all(pendingEmails.map(async (pendingEmail, index) => {
      const base = { processedEmailId: pendingEmail.id, subject: pendingEmail.subject };
      if (!pendingEmail.rawContent || pendingEmail.rawContent.trim().length < 50) {
        logger.warn({ userId, ...base }, 'No meaningful content found.');
        return { status: 'NO_CONTENT', ...base, error: 'No meaningful content.' };
      }
      try {
        const extractedData = await openaiService.extractReceiptDataFromEmail(pendingEmail.rawContent);
        const valid = extractedData && extractedData.vendor && typeof extractedData.totalAmount === 'number' &&
                      Array.isArray(extractedData.items) && extractedData.items.length > 0 &&
                      extractedData.items.every(item => item.itemName && typeof item.itemPrice === 'number' && item.itemPrice > 0 &&
                                                 Number.isInteger(item.itemQuantity) && item.itemQuantity > 0);
        if (!valid) {
          logger.warn({ userId, ...base, extractedData }, 'Invalid or incomplete extraction.');
          return { status: 'OPENAI_INVALID', ...base, extractedData: extractedData || {}, error: 'Incomplete or invalid data' };
        }
        return { status: 'SUCCESS', ...base, extractedData, userId, receivedAt: pendingEmail.receivedAt };
      } catch (err) {
        logger.error({ userId, ...base, err }, 'OpenAI extraction error.');
        return { status: 'ERROR', ...base, error: err };
      }
    }));

    // Process results one by one for database operations
    for (const result of results) {
      emailsProcessedInLoop++;
      const baseLog = { userId, processedEmailId: result.processedEmailId, subject: result.subject };

      // Update progress periodically
      if (emailsProcessedInLoop % (parseInt(process.env.PROGRESS_UPDATE_INTERVAL_COUNT, 10) || 5) === 0 || emailsProcessedInLoop === results.length) {
        await prisma.googleAccount.updateMany({
            where: { userId },
            data: {
                lastSyncProgress: {
                    stage: 'ANALYZING_EMAILS',
                    totalEmailsToProcess: pendingEmails.length,
                    emailsProcessed: emailsProcessedInLoop,
                    receiptsFound: successfullyProcessed,
                    currentEmailSubject: result.subject,
                    errorSummary: failedExtractions > 0 ? `${failedExtractions} email(s) failed extraction so far.` : null,
                }
            }
        });
      }

      try {
        switch (result.status) {
          case 'SUCCESS': {
            logger.info(baseLog, 'Extraction succeeded, checking duplicates.');
            const txDate = result.receivedAt || new Date();
            const dateRange = !isNaN(txDate)
              ? {
                  gte: new Date(txDate.getTime() - 24 * 60 * 60 * 1000),
                  lte: new Date(txDate.getTime() + 24 * 60 * 60 * 1000),
                }
              : undefined;

            // Use enhanced deduplication function
            const duplicateReceipt = await findDuplicateReceipts(
              userId, 
              result.extractedData, 
              result.receivedAt, 
              prisma, 
              logger
            );

            if (duplicateReceipt) {
              logger.info(baseLog, 'Duplicate detected—skipping.');
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
            logger.info(baseLog, 'Creating new receipt record.');
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
                    userId: result.userId,
                    itemName: item.itemName,
                    itemPrice: item.itemPrice,
                    sellScore: item.sellScore,
                    itemQuantity: item.itemQuantity,
                    resaleValue: item.resaleValue,
                    imageUrl: item.imageUrl, // Use OpenAI-provided image URL
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
            logger.error({ ...baseLog, err: result.error }, 'Extraction promise error.');
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
        logger.error({ err: dbErr, ...baseLog }, 'DB update error after processing.');
        processingDetails.push({
          processedEmailId: result.processedEmailId,
          status: 'DB_UPDATE_FAILED_AFTER_PROCESSING',
          error: dbErr.message,
        });
        if (result.status === 'SUCCESS') {
          failedExtractions++;
        }
      }
    }

    // Update account status based on outcomes
    const finalOverallStatus =
      failedExtractions > 0
        ? successfullyProcessed > 0
          ? 'PARTIAL_OPENAI_PROCESSING'
          : 'ERROR_OPENAI_PROCESSING'
        : 'SUCCESS_OPENAI_PROCESSING';
    
    const finalProgressState = {
        stage: 'COMPLETED',
        totalEmailsToProcess: pendingEmails.length,
        emailsProcessed: emailsProcessedInLoop,
        receiptsFound: successfullyProcessed,
        currentEmailSubject: null,
        errorSummary: failedExtractions > 0 ? `${failedExtractions} email(s) failed extraction.` : null,
    };

    await prisma.googleAccount.updateMany({
      where: { userId },
      data: { 
          lastSyncStatus: finalOverallStatus, 
          lastSyncProgress: finalProgressState,
          lastSyncAt: new Date() 
        },
    });

    logger.info(
      { userId, successful: successfullyProcessed, failed: failedExtractions, finalStatus: finalOverallStatus },
      'Background: receipt processing complete.'
    );

    // Note: Removed "Processing Complete" notification to reduce spam
    // Users will only be notified when status changes to IDLE (in backgroundGmailService.js)

    return {
      successful: successfullyProcessed,
      failed: failedExtractions,
      details: processingDetails
    };

  } catch (fatalErr) {
    logger.error({ err: fatalErr, userId }, 'Background: fatal error during extraction process.');
    const fatalProgress = {
        stage: 'FAILED',
        totalEmailsToProcess: initialProgress.totalEmailsToProcess, // Or count if available
        emailsProcessed: successfullyProcessed + failedExtractions, // How many were attempted
        receiptsFound: successfullyProcessed,
        currentEmailSubject: null,
        errorSummary: `A fatal error occurred: ${fatalErr.message}`,
    };
    await prisma.googleAccount.updateMany({
      where: { userId },
      data: { 
          lastSyncStatus: 'FATAL_ERROR_PROCESSING', // New distinct status
          lastSyncProgress: fatalProgress,
          lastSyncAt: new Date() 
        },
    });

    // Note: Removed "Processing Failed" notification to reduce spam
    // Users will only be notified when status changes to IDLE (in backgroundGmailService.js)
    
    throw fatalErr;
  }
}