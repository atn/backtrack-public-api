const prisma = require('../lib/prisma');
const gmailService = require('./gmailService');

const SERVICE_NAME = 'BACKGROUND_GMAIL_SERVICE';
const FETCH_ERROR_BACKOFF_MINUTES = 60; // 1 hour backoff for ERROR_FETCH
const MAX_RESULTS_PER_PAGE_NEW_EMAIL_CHECK = 50; // Max emails to check in one run for new emails
const MAX_RESULTS_PER_PAGE_PAST_SYNC = 100; // Max emails per page for past sync

async function updateGoogleAccountStatus(googleAccountId, status, errorMessage = null) {
  try {
    await prisma.googleAccount.update({
      where: { id: googleAccountId },
      data: {
        lastSyncStatus: status,
        lastSyncAt: new Date(),
        // Potentially log errorMessage to a new field in GoogleAccount if needed
      },
    });
    console.info(`[${SERVICE_NAME}] GAccount ${googleAccountId} status updated to ${status}.`);
  } catch (error) {
    console.error(`[${SERVICE_NAME}_ERROR] Failed to update status for GAccount ${googleAccountId} to ${status}:`, error.message);
    // This is a critical error in status tracking, might need alerting
  }
}

async function syncPastEmailsForAccount(googleAccountId, forceResyncAll = false) {
  if (!googleAccountId) {
    console.error({
        service: SERVICE_NAME,
        action: 'syncPastEmailsForAccount_missing_param',
        error: 'Google Account ID is required',
        googleAccountId
    });
    return { totalQueued: 0, totalUpdated: 0, totalSkipped:0, totalErrors:0, pagesFetched: 0, error: 'Missing googleAccountId' };
  }

  const googleAccount = await prisma.googleAccount.findUnique({ where: { id: googleAccountId } });
  if (!googleAccount) {
    console.error({
        service: SERVICE_NAME,
        action: 'syncPastEmailsForAccount_account_not_found',
        googleAccountId,
        error: 'GoogleAccount not found'
    });
    return { totalQueued: 0, totalUpdated: 0, totalSkipped:0, totalErrors:0, pagesFetched: 0, error: 'GoogleAccount not found' };
  }

  // 1. Update initial status
  await updateGoogleAccountStatus(googleAccountId, 'SYNCING_EMAIL_IDENTIFICATION');
  console.info({
      service: SERVICE_NAME,
      action: 'syncPastEmailsForAccount_start',
      googleAccountId,
      userId: googleAccount.userId,
      forceResyncAll,
      message: `Starting past email sync for GAccount ID: ${googleAccountId}. Force resync all: ${forceResyncAll}`
  });

  let totalEmailsQueuedForPendingProcessingInSync = 0;
  let totalEmailsSkippedAsExistingInSync = 0; // If not forceResyncAll
  let totalEmailsUpdatedForReprocessingInSync = 0; // If forceResyncAll
  let totalErrorsDuringQueuing = 0;
  let pageCount = 0;
  const fiveYearsAgo = new Date();
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
  const queryDateAfter = `${fiveYearsAgo.getFullYear()}/${String(fiveYearsAgo.getMonth() + 1).padStart(2, '0')}/${String(fiveYearsAgo.getDate()).padStart(2, '0')}`;
  const query = `after:${queryDateAfter} (subject:(receipt OR order OR invoice OR confirmation OR statement OR booking) OR from:(amazon OR walmart OR ebay OR "best buy" OR target OR newegg OR uber OR lyft OR doordash OR grubhub))`;

  let nextPageToken = null;

  try {
    do {
      pageCount++;
      // console.info(`[${SERVICE_NAME}] GAccount ${googleAccountId} - Fetching page ${pageCount} of past email IDs.`);
      console.info({
        service: SERVICE_NAME,
        action: 'syncPastEmailsForAccount_fetching_page',
        googleAccountId,
        page: pageCount,
        message: `GAccount ${googleAccountId} - Fetching page ${pageCount} of past email IDs.`
      });
      const messagesResponse = await gmailService.listMessages(googleAccountId, { query: query, maxResults: MAX_RESULTS_PER_PAGE_PAST_SYNC, pageToken: nextPageToken });

      if (!messagesResponse || !messagesResponse.messages || messagesResponse.messages.length === 0) {
        // console.info(`[${SERVICE_NAME}] GAccount ${googleAccountId} - No more messages found for query on page ${pageCount}.`);
        console.info({
            service: SERVICE_NAME,
            action: 'syncPastEmailsForAccount_no_more_messages',
            googleAccountId,
            page: pageCount,
            querySummary: `after:${queryDateAfter} subject:(receipt...) from:(amazon...)`, // A summary of the query
            message: `GAccount ${googleAccountId} - No more messages found for query on page ${pageCount}.`
        });
        break;
      }
      const messageSummariesOnPage = messagesResponse.messages.filter(m => m && m.id);
      if (messageSummariesOnPage.length === 0) {
        nextPageToken = messagesResponse.nextPageToken;
        if (!nextPageToken) break;
        continue;
      }

      const messageIdsFromPage = messageSummariesOnPage.map(msg => msg.id);
      let emailsToCreateThisPage = [];
      let emailsToUpdateThisPage = 0;
      const pageLogPayload = { service: SERVICE_NAME, action: 'syncPastEmailsForAccount_page_processing', googleAccountId, page: pageCount, forceResyncAll };

      if (forceResyncAll) {
        const existingEmailsInDbForPage = await prisma.processedEmail.findMany({
          where: { googleAccountId: googleAccountId, googleEmailId: { in: messageIdsFromPage } },
          select: { googleEmailId: true, id: true },
        });
        const existingEmailIdsInDbSet = new Set(existingEmailsInDbForPage.map(e => e.googleEmailId));

        const newEmailIds = messageIdsFromPage.filter(id => !existingEmailIdsInDbSet.has(id));
        emailsToCreateThisPage = newEmailIds.map(googleEmailId => ({
          userId: googleAccount.userId, googleAccountId, googleEmailId, status: 'PENDING_BACKGROUND_FETCH_AND_PROCESS',
          subject: null, snippet: null, sender: null, receivedAt: null, rawContent: null, /* processedAt removed */ errorMessage: null,
        }));

        const emailIdsToUpdate = existingEmailsInDbForPage.map(e => e.id);
        if (emailIdsToUpdate.length > 0) {
          const updateResult = await prisma.processedEmail.updateMany({
            where: { id: { in: emailIdsToUpdate } },
            data: { status: 'PENDING_BACKGROUND_FETCH_AND_PROCESS', subject: null, snippet: null, sender: null, receivedAt: null, rawContent: null, processedAt: null, errorMessage: null },
          });
          emailsToUpdateThisPage = updateResult.count;
          totalEmailsUpdatedForReprocessingInSync += emailsToUpdateThisPage;
        }
        console.info({ ...pageLogPayload, newToCreate: newEmailIds.length, existingToUpdate: emailsToUpdateThisPage, message: `ForceResync: ${newEmailIds.length} new, ${emailsToUpdateThisPage} updated to PENDING_BACKGROUND_FETCH_AND_PROCESS.`});
      } else { // Not forceResyncAll
        const existingProcessedEmails = await prisma.processedEmail.findMany({
          where: { googleAccountId: googleAccountId, googleEmailId: { in: messageIdsFromPage } },
          select: { googleEmailId: true },
        });
        const existingGoogleEmailIds = new Set(existingProcessedEmails.map(email => email.googleEmailId));
        totalEmailsSkippedAsExistingInSync += existingGoogleEmailIds.size;

        const newEmailIdsToQueue = messageIdsFromPage.filter(id => !existingGoogleEmailIds.has(id));
        if (newEmailIdsToQueue.length > 0) {
          emailsToCreateThisPage = newEmailIdsToQueue.map(googleEmailId => ({
            userId: googleAccount.userId, googleAccountId, googleEmailId, status: 'PENDING_BACKGROUND_FETCH_AND_PROCESS',
            subject: null, snippet: null, sender: null, receivedAt: null, rawContent: null, /* processedAt removed */ errorMessage: null,
          }));
          console.info({ ...pageLogPayload, newToCreate: newEmailIdsToQueue.length, skippedExisting: existingGoogleEmailIds.size, message: `Standard sync: Found ${newEmailIdsToQueue.length} new emails to queue.` });
        } else {
          console.info({ ...pageLogPayload, newToCreate: 0, skippedExisting: existingGoogleEmailIds.size, message: `Standard sync: No new emails to queue, ${messageIdsFromPage.length} already exist or skipped.` });
        }
      }

      if (emailsToCreateThisPage.length > 0) {
        // try { // This outer try-catch was already present for dbCreateError
        // The new requirement is a more specific try-catch for createMany
        try {
          console.info({ 
            ...pageLogPayload, 
            attemptedCount: emailsToCreateThisPage.length, 
            message: `Attempting prisma.processedEmail.createMany with ${emailsToCreateThisPage.length} records.`
          });
          const createResult = await prisma.processedEmail.createMany({
            data: emailsToCreateThisPage,
            skipDuplicates: true, // This helps avoid issues with duplicate googleEmailId if any slip through logic
          });
          totalEmailsQueuedForPendingProcessingInSync += createResult.count;
          console.info({ ...pageLogPayload, createdCount: createResult.count, message: `Successfully created ${createResult.count} new ProcessedEmail records.` });
        } catch (err) { // Specific catch for createMany
          console.error({
            service: SERVICE_NAME, // Ensures service name is part of the structured log
            action: "syncPastEmailsForAccount_createMany_error", // Specific action key
            message: "[CRITICAL_ERROR] syncPastEmailsForAccount: Failed prisma.processedEmail.createMany",
            googleAccountId: googleAccountId,
            page: pageCount,
            attemptedCount: emailsToCreateThisPage.length,
            errorMessage: err.message, // Log err.message directly
            errorCode: err.code,      // Prisma error code
            errorStack: err.stack,    // Log stack as a string property (optional, can be long)
                                      // Avoid logging raw `err` object or `err.meta` directly if it's complex and causes pollution
            dataSample: JSON.stringify(emailsToCreateThisPage.slice(0, 3).map(e => ({ googleEmailId: e.googleEmailId, userId: e.userId, status: e.status }))), // Stringified sample
          });
          totalErrorsDuringQueuing += emailsToCreateThisPage.length; // Consider all attempted in this batch as errored for now
          // Continue to the next page, error is logged. Outer try-catch of syncPastEmailsForAccount will handle overall function error state if necessary.
        }
      }
      nextPageToken = messagesResponse.nextPageToken;
    } while (nextPageToken);

    // 3. Remove SUCCESS_PAST_SYNC, will be handled in finally
    const syncSummary = {
        totalEmailsQueuedForPendingProcessingInSync,
        totalEmailsUpdatedForReprocessingInSync,
        totalEmailsSkippedAsExistingInSync,
        totalErrorsDuringQueuing,
        pagesFetched: pageCount
    };
    console.info({
        service: SERVICE_NAME,
        action: 'syncPastEmailsForAccount_completed_sync_loop',
        googleAccountId,
        summary: syncSummary,
        message: `Finished past email sync loop for GAccount ID: ${googleAccountId}.`
    });

    // Conditional call to processPendingEmails removed from the end of the try block.
    // It will be called unconditionally in the finally block.
    return { totalQueued: totalEmailsQueuedForPendingProcessingInSync, totalUpdated: totalEmailsUpdatedForReprocessingInSync, totalSkipped: totalEmailsSkippedAsExistingInSync, totalErrors: totalErrorsDuringQueuing, pagesFetched: pageCount, error: null };

  } catch (error) {
    console.error({
        service: SERVICE_NAME,
        action: 'syncPastEmailsForAccount_critical_error',
        googleAccountId,
        err: { message: error.message, stack: error.stack, name: error.name },
        message: `CRITICAL error during syncPastEmailsForAccount for GAccount ${googleAccountId}.`
    });
    // 2. Update error status
    let errorStatus = 'ERROR_FETCH_EMAIL_LIST'; 
    if (gmailService.isAuthError(error)) {
      errorStatus = 'ERROR_AUTH';
    }
    await updateGoogleAccountStatus(googleAccountId, errorStatus, error.message);
    // Ensure the return structure matches the success case for consistency if called by other services
    return { totalQueued: totalEmailsQueuedForPendingProcessingInSync, totalUpdated: totalEmailsUpdatedForReprocessingInSync, totalSkipped: totalEmailsSkippedAsExistingInSync, totalErrors: totalErrorsDuringQueuing, pagesFetched: pageCount, error: error.message };
  } finally {
    // Unconditionally call processPendingEmails
    console.info({
        message: "[DIAGNOSTIC] Attempting to call processPendingEmails from syncPastEmailsForAccount (finally block)",
        service: SERVICE_NAME,
        action: 'syncPastEmailsForAccount_triggering_processPendingEmails_finally',
        googleAccountId,
        // Note: These counts reflect the state at the end of the try or catch block.
        // If an error happened mid-try, they might not be fully accurate for "this run" but represent what was completed.
        emailsQueuedInThisRun: totalEmailsQueuedForPendingProcessingInSync, 
        emailsUpdatedInThisRun: totalEmailsUpdatedForReprocessingInSync,
    });
    try {
        const processingStats = await processPendingEmails(googleAccount.userId);
        console.info({
            message: "[DIAGNOSTIC] processPendingEmails call completed from syncPastEmailsForAccount (finally block)",
            service: SERVICE_NAME,
            action: 'syncPastEmailsForAccount_processPendingEmails_completed_finally',
            googleAccountId,
            processingStats,
        });
    } catch (ppeError) {
        console.error({
            message: "[DIAGNOSTIC] Error calling processPendingEmails from syncPastEmailsForAccount (finally block)",
            service: SERVICE_NAME,
            action: 'syncPastEmailsForAccount_processPendingEmails_error_finally',
            googleAccountId,
            err: { message: ppeError.message, stack: ppeError.stack, name: ppeError.name }
        });
    }

    // New: Update final status for the account after processPendingEmails
    console.info(`[${SERVICE_NAME}] Updating final status for GAccount ${googleAccountId} after syncPastEmailsForAccount run.`);
    // We need to check if the main processing (before this finally) had a critical error for this account.
    // The 'error' variable from the catch block of the main try/catch in syncPastEmailsForAccount would indicate this.
    // However, that variable is not in scope here. We assume if we reach here, processPendingEmails ran.
    // A simple way is to check the current status; if it's ERROR_FETCH_EMAIL_LIST or ERROR_AUTH, don't override with IDLE/PENDING_OPENAI.
    const currentStatus = await prisma.googleAccount.findUnique({ where: { id: googleAccountId }, select: { lastSyncStatus: true } });

    if (currentStatus && currentStatus.lastSyncStatus !== 'ERROR_FETCH_EMAIL_LIST' && currentStatus.lastSyncStatus !== 'ERROR_AUTH') {
      try {
        const queuedForOpenAICount = await prisma.processedEmail.count({
          where: {
            googleAccountId: googleAccountId,
            status: 'QUEUED_FOR_BACKGROUND_EXTRACTION',
          },
        });

        const stillPendingFetchCount = await prisma.processedEmail.count({
          where: {
            googleAccountId: googleAccountId,
            status: 'PENDING_BACKGROUND_FETCH_AND_PROCESS',
          },
        });

        if (stillPendingFetchCount === 0) {
          if (queuedForOpenAICount > 0) {
            await updateGoogleAccountStatus(googleAccountId, 'PENDING_OPENAI_PROCESSING');
          } else {
            await updateGoogleAccountStatus(googleAccountId, 'IDLE');
            
            // Send notification only when processing is completely finished (status = IDLE)
            try {
              const user = await prisma.user.findUnique({ 
                where: { id: googleAccount.userId },
                select: { id: true, pushToken: true }
              });
              
              if (user && user.pushToken) {
                const messagePayload = {
                  title: 'Receipt Sync Complete',
                  body: 'Your receipt sync has finished. Check your app for new receipts!',
                  data: {
                    screen: 'HomeScreen',
                    params: { 
                      userId: user.id,
                      status: 'IDLE',
                      googleAccountId: googleAccountId
                    }
                  }
                };
                
                const notificationService = require('./notificationService');
                await notificationService.sendPushNotifications([user.pushToken], messagePayload);
                console.info(`[${SERVICE_NAME}] Sent 'Processing Complete' notification to user ${user.id} when status changed to IDLE`, { 
                  userId: user.id, 
                  googleAccountId 
                });
              }
            } catch (notificationError) {
              console.error(`[${SERVICE_NAME}_ERROR] Failed to send 'Processing Complete' notification for user ${googleAccount.userId}: ${notificationError.message}`, {
                userId: googleAccount.userId,
                googleAccountId,
                error: notificationError.message
              });
            }
          }
        } else {
          console.warn(`[${SERVICE_NAME}] GAccount ${googleAccountId} (syncPast) still has ${stillPendingFetchCount} emails in PENDING_BACKGROUND_FETCH_AND_PROCESS. Status not changed to IDLE/PENDING_OPENAI_PROCESSING.`);
        }
      } catch (statusUpdateError) {
        console.error(`[${SERVICE_NAME}_ERROR] Failed to update final status for GAccount ${googleAccountId} (syncPast):`, statusUpdateError.message);
      }
    } else {
        console.info(`[${SERVICE_NAME}] GAccount ${googleAccountId} (syncPast) is in error state (${currentStatus?.lastSyncStatus}), skipping final IDLE/PENDING_OPENAI_PROCESSING update.`);
    }
  }
}

// Conceptual ProcessedEmail statuses:
// PENDING_BACKGROUND_FETCH_AND_PROCESS: Initial status for emails identified by controllers or scans.
// ERROR_FETCH_DETAILS: Failed to fetch full details from Gmail API.
// SKIPPED_UNLIKELY_RECEIPT: Processed by background worker, determined not a receipt, rawContent not stored.
// QUEUED_FOR_BACKGROUND_EXTRACTION: Confirmed potential receipt, rawContent stored, ready for OpenAI.
// --- (existing statuses like COMPLETED_PROCESSED, ERROR_PROCESSING_OPENAI etc. also apply)

async function processPendingEmails(userId, batchSize = 49) {
  console.info({
    service: SERVICE_NAME,
    action: 'processPendingEmails_start_full_run',
    userId,
    batchSize,
    message: `Starting full processing of pending emails for user ${userId}. Batch size: ${batchSize}`
  });

  // Initialize accumulators for total counts across all batches
  let totalEmailsProcessedInFullRun = 0;
  let totalSuccessfullyDetailedInFullRun = 0;
  let totalQueuedForExtractionInFullRun = 0;
  let totalSkippedAsUnlikelyInFullRun = 0;
  let totalFailedFetchInFullRun = 0;
  let batchesProcessed = 0;

  while (true) { // Loop to process all emails in batches
    batchesProcessed++;
    console.info({
        service: SERVICE_NAME,
        action: 'processPendingEmails_starting_batch',
        userId,
        batchNumber: batchesProcessed,
        batchSize
    });

    try {
      const queryDetails = {
          where: { 
            status: 'PENDING_BACKGROUND_FETCH_AND_PROCESS',
            userId: userId // Only process emails for this user
          },
          orderBy: { processedAt: 'asc' },
          take: batchSize,
          include: { googleAccount: { select: { userId: true } } }
      };

      console.info({
          message: "[DIAGNOSTIC] processPendingEmails: Querying for pending emails",
          service: SERVICE_NAME,
          action: 'processPendingEmails_query_details',
          userId,
          batchNumber: batchesProcessed,
          batchSize,
          query: queryDetails
      });
      const pendingEmailsFromDB = await prisma.processedEmail.findMany(queryDetails);

      console.info({
          message: `[DIAGNOSTIC] processPendingEmails: Found ${pendingEmailsFromDB.length} pending emails in this DB batch`,
          service: SERVICE_NAME,
          action: 'processPendingEmails_fetch_results',
          userId,
          batchNumber: batchesProcessed,
          count: pendingEmailsFromDB.length,
          batchSize
      });

      if (pendingEmailsFromDB.length === 0) {
        console.info({
          message: "[DIAGNOSTIC] processPendingEmails: No more pending emails found, ending processing loop.",
          service: SERVICE_NAME,
          action: 'processPendingEmails_no_more_emails_found_loop_end',
          userId,
          batchNumber: batchesProcessed,
          statusToQuery: 'PENDING_BACKGROUND_FETCH_AND_PROCESS',
        });
        break; // Exit the while(true) loop
      }

      console.info({
        service: SERVICE_NAME,
        action: 'processPendingEmails_db_batch_fetched', // Differentiate from API batch
        batchNumber: batchesProcessed,
        dbBatchCount: pendingEmailsFromDB.length,
        message: `Processing DB batch ${batchesProcessed} with ${pendingEmailsFromDB.length} emails.`
      });

      // Group emails by googleAccountId
      const emailsByAccount = pendingEmailsFromDB.reduce((acc, emailRecord) => {
        const accountId = emailRecord.googleAccountId;
        if (!accountId) {
            console.warn({
                service: SERVICE_NAME,
                action: 'processPendingEmails_skip_email_no_account_id',
                batchNumber: batchesProcessed,
                processedEmailId: emailRecord.id,
                googleEmailId: emailRecord.googleEmailId,
                message: 'Skipping email in DB batch as it has no googleAccountId.'
            });
            totalFailedFetchInFullRun++; 
            return acc;
        }
        if (!acc[accountId]) {
          acc[accountId] = [];
        }
        acc[accountId].push(emailRecord);
        return acc;
      }, {});

      for (const accountId in emailsByAccount) {
        const accountEmails = emailsByAccount[accountId]; // These are ProcessedEmail records from DB
        if (accountEmails.length === 0) continue;

        let batchGmailClient;
        try {
            // Update GoogleAccount status when starting detail fetch for this account's emails
            await updateGoogleAccountStatus(accountId, 'SYNCING_EMAIL_DETAILS_AND_FILTERING');
            batchGmailClient = await gmailService.getBatchEnabledGmailClient(accountId);
        } catch (clientError) {
            console.error({
                service: SERVICE_NAME,
                action: 'processPendingEmails_getBatchClient_error',
                googleAccountId: accountId,
                batchNumber: batchesProcessed,
                err: { message: clientError.message, stack: clientError.stack },
                message: `Failed to get batch enabled Gmail client for account ${accountId}. Marking ${accountEmails.length} emails as ERROR_FETCH_DETAILS.`
            });
            for (const dbEmailRecord of accountEmails) {
                totalEmailsProcessedInFullRun++; // Considered attempted
                totalFailedFetchInFullRun++;
                try {
                    await prisma.processedEmail.update({
                        where: { id: dbEmailRecord.id },
                        data: { status: 'ERROR_FETCH_DETAILS', errorMessage: `Client setup error for account ${accountId}: ${clientError.message}`, processedAt: new Date() },
                    });
                } catch (dbUpdateErr) {
                    console.error({ service: SERVICE_NAME, action: 'processPendingEmails_dbUpdate_clientError_fail', processedEmailId: dbEmailRecord.id, err: dbUpdateErr });
                }
            }
            continue; 
        }
        
        console.info({
            service: SERVICE_NAME,
            action: 'processPendingEmails_preparing_batch_api_calls',
            googleAccountId: accountId,
            batchNumber: batchesProcessed,
            emailCountInAccountGroup: accountEmails.length,
        });

        // Create promises for fetching details for emails of the current account
        const detailPromises = accountEmails.map(dbEmailRecord =>
          batchGmailClient.users.messages.get({
            userId: 'me',
            id: dbEmailRecord.googleEmailId,
            format: 'full',
          })
          .then(response => ({ status: 'fulfilled', details: response.data, originalRecord: dbEmailRecord }))
          .catch(error => Promise.resolve({ status: 'rejected', error, originalRecord: dbEmailRecord })) // Ensure it always resolves an object
        );

        const settledResults = await Promise.allSettled(detailPromises);

        for (const result of settledResults) {
           const { status: resultStatus, value, reason } = result; // allSettled gives {status, value} or {status, reason}
           const { originalRecord, details, error: apiError } = (resultStatus === 'fulfilled' ? value : reason) || {};

           if (!originalRecord) {
             console.error({service: SERVICE_NAME, action: 'processPendingEmails_missing_originalRecord', result, message: "Original record not found in settled promise, skipping."});
             totalFailedFetchInFullRun++; // Count as a failure if we can't map back
             continue;
           }
          
           totalEmailsProcessedInFullRun++; 

           const logPayload = {
             service: SERVICE_NAME,
             action: 'processPendingEmails_processing_settled_email',
             batchNumber: batchesProcessed,
             googleEmailId: originalRecord.googleEmailId,
             googleAccountId: originalRecord.googleAccountId,
             processedEmailId: originalRecord.id,
             userId: originalRecord.googleAccount?.userId || 'N/A' 
           };

           if (resultStatus === 'fulfilled' && details) {
             const messageDetailsAPI = details;
             try {
               const subject = messageDetailsAPI?.payload?.headers?.find(h => h.name.toLowerCase() === 'subject')?.value || null;
               const sender = messageDetailsAPI?.payload?.headers?.find(h => h.name.toLowerCase() === 'from')?.value || null;
               const receivedAt = messageDetailsAPI?.internalDate ? new Date(Number(messageDetailsAPI.internalDate)) : null;
               const emailTextContent = gmailService.extractTextFromMessage(messageDetailsAPI);
               const isPotential = gmailService.isPotentialReceipt(messageDetailsAPI);

               if (isPotential) {
                 console.info({
                   ...logPayload, // Spread common fields
                   action: "processPendingEmails_queue_for_openai", // Override action
                   message: "Email assessed as potential receipt, preparing for OpenAI queue.",
                   rawContentLength: emailTextContent ? emailTextContent.length : 0,
                   contentSnippet: emailTextContent ? emailTextContent.substring(0, 100) + (emailTextContent.length > 100 ? '...' : '') : 'N/A'
                 });
                 await prisma.processedEmail.update({
                   where: { id: originalRecord.id },
                   data: {
                     status: 'QUEUED_FOR_BACKGROUND_EXTRACTION',
                     rawContent: emailTextContent, subject, sender, receivedAt,
                     processedAt: new Date(), errorMessage: null,
                   },
                 });
                 totalQueuedForExtractionInFullRun++;
                 console.info({ ...logPayload, newStatus: 'QUEUED_FOR_BACKGROUND_EXTRACTION', message: `Email successfully processed and queued for AI extraction.` });
               } else {
                 await prisma.processedEmail.update({
                   where: { id: originalRecord.id },
                   data: {
                     status: 'SKIPPED_UNLIKELY_RECEIPT', rawContent: null, subject, sender, receivedAt,
                     processedAt: new Date(), errorMessage: null,
                   },
                 });
                 totalSkippedAsUnlikelyInFullRun++;
                 console.info({ ...logPayload, newStatus: 'SKIPPED_UNLIKELY_RECEIPT', message: `Email successfully processed and skipped as unlikely receipt.` });
               }
               totalSuccessfullyDetailedInFullRun++;
             } catch (processingError) { 
               totalFailedFetchInFullRun++; 
               console.error({
                 ...logPayload,
                 errName: processingError.name, errMessage: processingError.message, errStack: processingError.stack,
                 message: `Error during post-fetch processing of email for ${originalRecord.googleEmailId}.`
               });
               try {
                   await prisma.processedEmail.update({
                       where: { id: originalRecord.id },
                       data: {
                           status: 'ERROR_PROCESSING_DETAILS', 
                           errorMessage: `Post-fetch processing error: ${processingError.message}`,
                           processedAt: new Date(),
                       },
                   });
                } catch (dbUpdateErr) {
                   console.error({ ...logPayload, errMessage: dbUpdateErr.message, originalErrorMsg: processingError.message, message: "Failed to update email to ERROR_PROCESSING_DETAILS after post-fetch processing error."});
                }
             }
           } else { // resultStatus === 'rejected' or fulfilled but with an error structure from .catch()
               totalFailedFetchInFullRun++;
               const effectiveError = apiError || reason || { message: "Unknown error from batch API call or promise structure." };
               console.error({
                 ...logPayload,
                 errName: effectiveError.name, errMessage: effectiveError.message, errStack: effectiveError.stack, errCode: effectiveError.code,
                 message: `Failed to fetch details for email ${originalRecord.googleEmailId} via batch. Setting status to ERROR_FETCH_DETAILS.`
               });
              
               const isAuthErr = gmailService.isAuthError(effectiveError);
               if (isAuthErr && originalRecord.googleAccountId) {
                   console.warn({ ...logPayload, authError: true, accountStatusUpdateTo: 'ERROR_AUTH', message: `Authentication error for GAccount ${originalRecord.googleAccountId} during batch fetch. Setting account status to ERROR_AUTH.`});
                   await updateGoogleAccountStatus(originalRecord.googleAccountId, 'ERROR_AUTH', `Failed to fetch email details for ${originalRecord.googleEmailId} due to auth error: ${effectiveError.message}`);
               }

               try {
                 await prisma.processedEmail.update({
                   where: { id: originalRecord.id },
                   data: { status: 'ERROR_FETCH_DETAILS', errorMessage: effectiveError.message, processedAt: new Date() },
                 });
                  console.info({ ...logPayload, oldStatus: originalRecord.status, newStatus: 'ERROR_FETCH_DETAILS', errorMessage: effectiveError.message, message: "Updated email status to ERROR_FETCH_DETAILS in DB due to batch part failure."});
               } catch (dbUpdateError) {
                 console.error({
                   ...logPayload,
                   errMessage: dbUpdateError.message,
                   originalApiErrorMsg: effectiveError.message,
                   message: `CRITICAL: Failed to update email status to ERROR_FETCH_DETAILS for email ID ${originalRecord.googleEmailId} after batch part failure.`
                 });
               }
             }
        } // end for...of settledResults
      } // end for...of emailsByAccount

      console.info({
          service: SERVICE_NAME,
          action: 'processPendingEmails_db_batch_completed', 
          batchNumber: batchesProcessed,
          dbBatchSize: pendingEmailsFromDB.length, 
      });

      // Process receipts for this batch
      const backgroundReceiptService = require('./backgroundReceiptService');
      await backgroundReceiptService.extractDataFromPendingEmails(userId);
      console.info({
        service: SERVICE_NAME,
        action: 'processPendingEmails_triggered_receipt_processing',
        userId,
        batchNumber: batchesProcessed,
        message: `Triggered receipt processing for user ${userId}`
      });

    } catch (error) { // Catch errors from the DB findMany or other unexpected issues within the main batch loop
      console.error({
          service: SERVICE_NAME,
          action: 'processPendingEmails_batch_loop_critical_error',
          batchNumber: batchesProcessed,
          err: { message: error.message, stack: error.stack, name: error.name },
          message: `Critical error during batch processing loop in processPendingEmails. May attempt next batch if applicable or exit.`
      });
      // Depending on the error, might be wise to break or implement a backoff for retries
      // For now, it will continue to the next iteration of while(true) which will retry findMany
      // or break if the error was such that it prevents further findMany, e.g. DB connection.
      // If findMany itself fails consistently, the loop might become too tight.
      // A counter for consecutive findMany errors could be added to break if it exceeds a threshold.
    }
  } // end while(true)

  const finalSummary = {
    totalBatchesProcessed: batchesProcessed,
    totalEmailsProcessedInFullRun, // Total emails across all batches that were attempted
    totalSuccessfullyDetailedAndCategorized: totalSuccessfullyDetailedInFullRun,
    totalQueuedForExtraction: totalQueuedForExtractionInFullRun,
    totalSkippedUnlikelyReceipt: totalSkippedAsUnlikelyInFullRun,
    totalFetchOrCategorizationFailures: totalFailedFetchInFullRun,
  };
  console.info({
    service: SERVICE_NAME,
    action: 'processPendingEmails_finish_full_run', // Changed action name
    summary: finalSummary,
    message: `Finished full processing of all pending emails.`
  });

  return finalSummary;
}


module.exports = {
  syncPastEmailsForAccount,
  processPendingEmails,
};
