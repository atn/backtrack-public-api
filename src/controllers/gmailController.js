const gmailService = require('../services/gmailService');
const prisma = require('../lib/prisma');
const { syncPastEmailsForAccount } = require('../services/backgroundGmailService');
const { google } = require('googleapis'); // For token revocation

async function processRecentEmails(req, reply) {
  try {
    const userId = req.user.id;
    const { googleAccountId, forceResyncAll = false } = req.body;

    if (!googleAccountId) {
      return reply.status(400).send({ 
        success: false,
        error: 'Google account ID is required.',
        code: 'MISSING_ACCOUNT_ID'
      });
    }

    // Validate ownership of the googleAccountId
    const googleAccount = await prisma.googleAccount.findUnique({ where: { id: googleAccountId } });
    if (!googleAccount) {
      return reply.status(404).send({ 
        success: false,
        error: 'Google account not found. The account may have been removed.',
        code: 'ACCOUNT_NOT_FOUND'
      });
    }
    if (googleAccount.userId !== userId) {
      req.log.warn({ userId, googleAccountId, ownerUserId: googleAccount.userId }, 'User attempted to process emails for a Google account they do not own.');
      return reply.status(403).send({ 
        success: false,
        error: 'You do not have permission to access this Google account.',
        code: 'ACCESS_DENIED'
      });
    }

    // Update account status to SYNCING_EMAIL_IDENTIFICATION
    await prisma.googleAccount.update({
      where: { id: googleAccountId },
      data: {
        lastSyncStatus: 'SYNCING_EMAIL_IDENTIFICATION',
        lastSyncAt: new Date()
      }
    });

    req.log.info({ userId, googleAccountId, forceResyncAll }, `Processing recent emails for Google Account ID: ${googleAccountId}. Force resync: ${forceResyncAll}`);

    // Get the last sync date to use as the start date for the query
    // If lastSyncAt is not set, use a default of 7 days ago
    const defaultDate = new Date();
    defaultDate.setDate(defaultDate.getDate() - 7); // 7 days ago
    const lastSyncDate = googleAccount.lastSyncAt || defaultDate;
    const queryDateAfter = `${lastSyncDate.getFullYear()}/${String(lastSyncDate.getMonth() + 1).padStart(2, '0')}/${String(lastSyncDate.getDate()).padStart(2, '0')}`;
    const query = `after:${queryDateAfter} (subject:(receipt OR order OR invoice OR confirmation OR statement OR booking) OR from:(amazon OR walmart OR ebay OR "best buy" OR target OR newegg OR uber OR lyft OR doordash OR grubhub))`;

    const queryOptions = {
      query: query,
      maxResults: 100,
    };

    let totalEmailsQueued = 0;
    let totalEmailsSkipped = 0;
    let totalEmailsUpdated = 0;
    let totalErrors = 0;
    let nextPageToken = null;
    let pageCount = 0;

    do {
      pageCount++;
      req.log.info({ userId, googleAccountId, page: pageCount }, `Fetching page ${pageCount} of recent emails.`);

      const messagesResponse = await gmailService.listMessages(googleAccountId, { ...queryOptions, pageToken: nextPageToken });

      if (!messagesResponse || !messagesResponse.messages || messagesResponse.messages.length === 0) {
        req.log.info({ userId, googleAccountId, page: pageCount }, 'No more messages found for query.');
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

      if (forceResyncAll) {
        const existingEmailsInDbForPage = await prisma.processedEmail.findMany({
          where: { googleAccountId: googleAccountId, googleEmailId: { in: messageIdsFromPage } },
          select: { googleEmailId: true, id: true },
        });
        const existingEmailIdsInDbSet = new Set(existingEmailsInDbForPage.map(e => e.googleEmailId));

        const newEmailIds = messageIdsFromPage.filter(id => !existingEmailIdsInDbSet.has(id));
        emailsToCreateThisPage = newEmailIds.map(googleEmailId => ({
          userId: googleAccount.userId,
          googleAccountId,
          googleEmailId,
          status: 'PENDING_BACKGROUND_FETCH_AND_PROCESS',
          subject: null,
          snippet: null,
          sender: null,
          receivedAt: null,
          rawContent: null,
          errorMessage: null,
        }));

        const emailIdsToUpdate = existingEmailsInDbForPage.map(e => e.id);
        if (emailIdsToUpdate.length > 0) {
          const updateResult = await prisma.processedEmail.updateMany({
            where: { id: { in: emailIdsToUpdate } },
            data: {
              status: 'PENDING_BACKGROUND_FETCH_AND_PROCESS',
              subject: null,
              snippet: null,
              sender: null,
              receivedAt: null,
              rawContent: null,
              processedAt: null,
              errorMessage: null,
            },
          });
          emailsToUpdateThisPage = updateResult.count;
          totalEmailsUpdated += emailsToUpdateThisPage;
        }
      } else {
        const existingProcessedEmails = await prisma.processedEmail.findMany({
          where: { googleAccountId: googleAccountId, googleEmailId: { in: messageIdsFromPage } },
          select: { googleEmailId: true },
        });
        const existingGoogleEmailIds = new Set(existingProcessedEmails.map(email => email.googleEmailId));
        totalEmailsSkipped += existingGoogleEmailIds.size;

        const newEmailIdsToQueue = messageIdsFromPage.filter(id => !existingGoogleEmailIds.has(id));
        if (newEmailIdsToQueue.length > 0) {
          emailsToCreateThisPage = newEmailIdsToQueue.map(googleEmailId => ({
            userId: googleAccount.userId,
            googleAccountId,
            googleEmailId,
            status: 'PENDING_BACKGROUND_FETCH_AND_PROCESS',
            subject: null,
            snippet: null,
            sender: null,
            receivedAt: null,
            rawContent: null,
            errorMessage: null,
          }));
        }
      }

      if (emailsToCreateThisPage.length > 0) {
        try {
          const createResult = await prisma.processedEmail.createMany({
            data: emailsToCreateThisPage,
            skipDuplicates: true,
          });
          totalEmailsQueued += createResult.count;
        } catch (err) {
          req.log.error({
            err,
            userId,
            googleAccountId,
            attemptedCount: emailsToCreateThisPage.length,
          }, 'Error creating ProcessedEmail records');
          totalErrors += emailsToCreateThisPage.length;
        }
      }

      nextPageToken = messagesResponse.nextPageToken;
    } while (nextPageToken);

    // Update account status to PENDING_FETCH_AND_PROCESS
    await prisma.googleAccount.update({
      where: { id: googleAccountId },
      data: {
        lastSyncStatus: 'PENDING_FETCH_AND_PROCESS',
        lastSyncAt: new Date()
      }
    });

    // Trigger background processing - first fetch email details, then process receipts, then refresh feed
    const { processPendingEmails } = require('../services/backgroundGmailService');
    const backgroundReceiptService = require('../services/backgroundReceiptService');
    const { processUserFeedAutomatically } = require('./resaleFeedController');
    
    processPendingEmails(userId)
      .then(() => {
        req.log.info({ userId, googleAccountId }, 'Background email processing completed, starting receipt extraction.');
        return backgroundReceiptService.extractDataFromPendingEmails(userId);
      })
      .then(() => {
        req.log.info({ userId, googleAccountId }, 'Background receipt extraction completed, starting feed processing.');
        return processUserFeedAutomatically(userId);
      })
      .then((feedResult) => {
        if (feedResult.success) {
          req.log.info({ userId, googleAccountId }, `Feed processing completed after resync. Items generated: ${feedResult.itemsGenerated}`);
        } else {
          req.log.info({ userId, googleAccountId }, `Feed processing skipped after resync: ${feedResult.error}`);
        }
      })
      .catch(processingError => {
        req.log.error({ err: processingError, userId, googleAccountId }, 'Failed to complete background processing after recent email processing.');
      });

    const summary = {
      success: true,
      message: `Recent email processing completed for Google Account ${googleAccount.emailAddress}.`,
      data: {
        queued_for_processing: totalEmailsQueued,
        updated_for_reprocessing: totalEmailsUpdated,
        skipped_already_processed: totalEmailsSkipped,
        errors_creating_records: totalErrors,
        pages_processed: pageCount,
      }
    };

    req.log.info({ userId, googleAccountId, summary }, 'Recent email processing summary for account.');
    return reply.status(200).send({
      success: true,
      ...summary
    });

  } catch (error) {
    // Update account status to ERROR_RESCAN on failure
    if (req.body?.googleAccountId) {
      try {
        await prisma.googleAccount.update({
          where: { id: req.body.googleAccountId },
          data: {
            lastSyncStatus: 'ERROR_RECENT_EMAIL_PROCESSING',
            lastSyncAt: new Date()
          }
        });
      } catch (updateError) {
        req.log.error({ err: updateError }, 'Failed to update Google account status to ERROR_RECENT_EMAIL_PROCESSING');
      }
    }

    req.log.error({ err: error, userId: req.user?.id, googleAccountId: req.body?.googleAccountId }, 'Error in processRecentEmails controller.');
    
    // Handle specific error types with user-friendly messages
    if (error.message.includes('token') || error.message.includes('authentication') || 
        error.message.includes('unauthorized') || error.message.includes('Invalid Credentials') ||
        (error.response && (error.response.status === 401 || error.response.status === 403))) {
      return reply.status(401).send({ 
        success: false,
        error: 'Your Google account connection has expired. Please reconnect your Google account to continue syncing emails.',
        code: 'GOOGLE_AUTH_EXPIRED',
        requiresReconnection: true
      });
    }
    
    if (error.message.includes('quota') || error.message.includes('rate limit') || 
        (error.response && error.response.status === 429)) {
      return reply.status(429).send({
        success: false,
        error: 'Google API rate limit reached. Please try again in a few minutes.',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: 300 // 5 minutes
      });
    }
    
    if (error.message.includes('network') || error.message.includes('timeout') ||
        error.code === 'ENOTFOUND' || error.code === 'ECONNRESET') {
      return reply.status(503).send({
        success: false,
        error: 'Network connection issue. Please check your internet connection and try again.',
        code: 'NETWORK_ERROR',
        retryable: true
      });
    }
    
    if (error.message.includes('Account not found') || error.message.includes('does not exist')) {
      return reply.status(404).send({
        success: false,
        error: 'Google account not found. The account may have been removed.',
        code: 'ACCOUNT_NOT_FOUND'
      });
    }
    
    // Generic server error
    return reply.status(500).send({
      success: false,
      error: 'An unexpected error occurred during email sync. Please try again later.',
      code: 'INTERNAL_ERROR'
    });
  }
}



async function listGoogleAccounts(req, reply) {
  try {
    const userId = req.user.id;
    const googleAccounts = await prisma.googleAccount.findMany({
      where: { userId: userId },
      select: {
        id: true,
        emailAddress: true,
        lastSyncAt: true,
        lastSyncStatus: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
    
    return reply.status(200).send({
      success: true,
      data: {
        accounts: googleAccounts,
        totalCount: googleAccounts.length
      }
    });
  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id }, 'Error listing Google accounts');
    return reply.status(500).send({
      success: false,
      error: 'An error occurred while fetching Google accounts.',
      code: 'INTERNAL_ERROR'
    });
  }
}

async function unlinkGoogleAccount(req, reply) {
  try {
    const userId = req.user.id;
    const { accountId } = req.params;

    if (!accountId) {
      return reply.status(400).send({ 
        success: false,
        error: 'Account ID is required.',
        code: 'MISSING_ACCOUNT_ID'
      });
    }

    // Validate that the account belongs to the user
    const googleAccount = await prisma.googleAccount.findUnique({
      where: { id: accountId },
    });

    if (!googleAccount) {
      return reply.status(404).send({ 
        success: false,
        error: 'Google Account not found.',
        code: 'ACCOUNT_NOT_FOUND'
      });
    }

    if (googleAccount.userId !== userId) {
      return reply.status(403).send({ 
        success: false,
        error: 'Forbidden. This Google Account does not belong to you.',
        code: 'ACCESS_DENIED'
      });
    }

    // Delete all associated ProcessedEmails and Receipts
    await prisma.processedEmail.deleteMany({
      where: { googleAccountId: accountId },
    });

    // Delete the GoogleAccount
    await prisma.googleAccount.delete({
      where: { id: accountId },
    });

    req.log.info({ userId, accountId }, 'Google account and all associated data unlinked successfully.');
    
    return reply.status(200).send({ 
      success: true,
      message: 'Google account and all associated data unlinked successfully.'
    });

  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id, accountId: req.params?.accountId }, 'Error unlinking Google account');
    return reply.status(500).send({
      success: false,
      error: 'An error occurred while unlinking the Google account.',
      code: 'INTERNAL_ERROR'
    });
  }
}

async function triggerFullSyncForAccount(req, reply) {
  try {
    const userId = req.user.id;
    const { googleAccountId } = req.params;

    // Validate that the account belongs to the user
    const googleAccount = await prisma.googleAccount.findUnique({
      where: { id: googleAccountId },
    });

    if (!googleAccount) {
      return reply.status(404).send({ 
        success: false,
        error: 'Google Account not found.',
        code: 'ACCOUNT_NOT_FOUND'
      });
    }

    if (googleAccount.userId !== userId) {
      return reply.status(403).send({ 
        success: false,
        error: 'Forbidden. This Google Account does not belong to you.',
        code: 'ACCESS_DENIED'
      });
    }

    // Check if sync is already in progress
    if (googleAccount.lastSyncStatus && 
        (googleAccount.lastSyncStatus.includes('SYNCING') || googleAccount.lastSyncStatus.includes('REQUESTED'))) {
      return reply.status(409).send({
        success: false,
        error: 'A sync is already in progress for this account.',
        code: 'SYNC_IN_PROGRESS'
      });
    }

    // Trigger the background sync
    const { syncPastEmailsForAccount } = require('../services/backgroundGmailService');
    syncPastEmailsForAccount(googleAccountId, true) // forceResyncAll = true
      .then(() => {
        req.log.info({ userId, googleAccountId }, 'Full sync process completed successfully.');
      })
      .catch(syncError => {
        req.log.error({ err: syncError, userId, googleAccountId }, 'Error during background full sync process.');
      });

    req.log.info({ userId, googleAccountId }, 'Full sync process initiated for the Google Account.');
    
    return reply.status(202).send({ 
      success: true,
      message: 'Full sync process initiated for the Google Account. Check account status for updates.'
    });

  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id, googleAccountId: req.params?.googleAccountId }, 'Error triggering full sync');
    return reply.status(500).send({
      success: false,
      error: 'An error occurred while triggering the sync.',
      code: 'INTERNAL_ERROR'
    });
  }
}

module.exports = {
  processRecentEmails,
  listGoogleAccounts,
  unlinkGoogleAccount,
  triggerFullSyncForAccount,
};
