const prisma = require('../lib/prisma');
const { Expo } = require('expo-server-sdk'); // For validation
const { createLogger } = require('../utils/logger');

const logger = createLogger('USER_CONTROLLER');

async function updatePushToken(req, reply) {
  const userId = req.user.id; // Assuming authMiddleware sets req.user
  const { token: pushToken } = req.body;

  if (!pushToken || typeof pushToken !== 'string') {
    logger.warn(`User ${userId} submitted invalid push token (missing or not a string): ${pushToken}`);
    return reply.status(400).send({ 
      success: false,
      error: 'Push token is required and must be a string.',
      code: 'INVALID_TOKEN_TYPE'
    });
  }

  // Validate the token format (basic check + Expo's check)
  if (!Expo.isExpoPushToken(pushToken)) {
    // Basic check for good measure, though Expo.isExpoPushToken should be comprehensive
    if (!pushToken.startsWith('ExponentPushToken[') || !pushToken.endsWith(']')) {
        logger.warn(`User ${userId} submitted invalid push token format (manual check failed): ${pushToken}`);
        return reply.status(400).send({ 
          success: false,
          error: 'Invalid Expo push token format.',
          code: 'INVALID_TOKEN_FORMAT'
        });
    }
    // If Expo.isExpoPushToken is the source of truth, this manual check might be redundant
    // but doesn't hurt as a fallback or for initial quick filtering.
    logger.warn(`User ${userId} submitted invalid Expo push token (Expo SDK check failed): ${pushToken}`);
    return reply.status(400).send({ 
      success: false,
      error: 'Invalid Expo push token.',
      code: 'INVALID_TOKEN_FORMAT'
    });
  }
  
  try {
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { pushToken: pushToken },
    });

    if (!updatedUser) {
      // This case should ideally not happen if userId from auth is always valid
      logger.error(`User ${userId} not found during push token update. This should not happen.`);
      return reply.status(404).send({ 
        success: false,
        error: 'User not found.',
        code: 'USER_NOT_FOUND'
      });
    }

    logger.info(`Successfully updated push token for User ${userId}. Token: ${pushToken}`);
    return reply.status(200).send({ 
      success: true,
      message: 'Push token updated successfully.' 
    });

  } catch (error) {
    logger.error(`Error updating push token for User ${userId}: ${error.message}`, {
      userId,
      error: error.message,
      stack: error.stack,
    });
    // It's possible the Prisma update could fail for other reasons too.
    return reply.status(500).send({ 
      success: false,
      error: 'An error occurred while updating push token.',
      code: 'INTERNAL_ERROR'
    });
  }
}

async function getUserProfile(req, reply) {
  const userId = req.user.id;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        createdAt: true,
        lastFeedRefresh: true,
        ebayAccessToken: true,
        ebayRefreshToken: true,
        googleAccounts: {
          select: { id: true }
        },
        receipts: {
          select: { id: true }
        },
        receiptItems: {
          select: { 
            id: true,
            lastFeedCandidateAt: true
          }
        }
      }
    });

    if (!user) {
      logger.warn(`User profile requested for non-existent user ${userId}`);
      return reply.status(404).send({
        success: false,
        error: 'User not found.',
        code: 'USER_NOT_FOUND'
      });
    }

    const hasEbayConnection = !!(user.ebayAccessToken || user.ebayRefreshToken);
    const hasGoogleConnection = user.googleAccounts.length > 0;
    const totalReceipts = user.receipts.length;
    const totalItems = user.receiptItems.length;
    const feedCandidates = user.receiptItems.filter(item => item.lastFeedCandidateAt).length;

    logger.info(`User profile fetched for user ${userId}`);
    
    return reply.status(200).send({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt.toISOString(),
        lastFeedRefresh: user.lastFeedRefresh?.toISOString() || null,
        hasEbayConnection,
        hasGoogleConnection,
        stats: {
          totalReceipts,
          totalItems,
          feedCandidates
        }
      }
    });

  } catch (error) {
    logger.error(`Error fetching user profile for user ${userId}: ${error.message}`, {
      userId,
      error: error.message,
      stack: error.stack
    });
    return reply.status(500).send({
      success: false,
      error: 'An error occurred while fetching user profile.',
      code: 'INTERNAL_ERROR'
    });
  }
}

module.exports = {
  updatePushToken,
  getUserProfile,
};
