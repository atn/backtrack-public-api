const resaleFeedService = require('../services/resaleFeedService');
const userPersonalizationService = require('../services/userPersonalizationService');
const prisma = require('../lib/prisma');
const { createLogger } = require('../utils/logger');

const logger = createLogger('RESALE_FEED_CONTROLLER');

// Helper functions for market data calculations
function calculateVolatility(history) {
  if (!history || history.length < 2) return null;
  
  const values = history.map(entry => entry.value).filter(val => val > 0);
  if (values.length < 2) return null;
  
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  const standardDeviation = Math.sqrt(variance);
  
  return standardDeviation / mean; // Coefficient of variation
}

function determineTrendDirection(history) {
  if (!history || history.length < 2) return 'unknown';
  
  const recent = history.slice(-3); // Last 3 data points
  const older = history.slice(0, 3); // First 3 data points
  
  if (recent.length === 0 || older.length === 0) return 'unknown';
  
  const recentAvg = recent.reduce((sum, entry) => sum + entry.value, 0) / recent.length;
  const olderAvg = older.reduce((sum, entry) => sum + entry.value, 0) / older.length;
  
  if (recentAvg > olderAvg * 1.05) return 'rising';
  if (recentAvg < olderAvg * 0.95) return 'falling';
  return 'stable';
}

function calculateTrendPercentage(history) {
  if (!history || history.length < 2) return 0;
  
  const recent = history.slice(-3);
  const older = history.slice(0, 3);
  
  if (recent.length === 0 || older.length === 0) return 0;
  
  const recentAvg = recent.reduce((sum, entry) => sum + entry.value, 0) / recent.length;
  const olderAvg = older.reduce((sum, entry) => sum + entry.value, 0) / older.length;
  
  return olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;
}

function calculateConfidenceScore(volatility, marketVolume, trendConsistency) {
  let confidence = 100;
  
  // Reduce confidence for high volatility
  if (volatility > 0.3) confidence -= 20;
  else if (volatility > 0.2) confidence -= 10;
  
  // Reduce confidence for low market volume
  if (marketVolume < 5) confidence -= 30;
  else if (marketVolume < 10) confidence -= 15;
  
  // Adjust for trend consistency
  if (trendConsistency < 0.5) confidence -= 15;
  
  return Math.max(confidence, 10); // Minimum 10% confidence
}

function determineTrendConfidence(history) {
  if (!history || history.length < 2) return 'low';
  
  const volatility = calculateVolatility(history);
  const marketVolume = history.length;
  
  // Calculate trend consistency by looking at direction changes
  let consistentDirections = 0;
  for (let i = 1; i < history.length; i++) {
    const current = history[i].value;
    const previous = history[i - 1].value;
    const direction = current > previous ? 'up' : current < previous ? 'down' : 'same';
    
    if (i > 1) {
      const prevCurrent = history[i - 1].value;
      const prevPrevious = history[i - 2].value;
      const prevDirection = prevCurrent > prevPrevious ? 'up' : prevCurrent < prevPrevious ? 'down' : 'same';
      
      if (direction === prevDirection) {
        consistentDirections++;
      }
    }
  }
  
  const trendConsistency = history.length > 2 ? consistentDirections / (history.length - 2) : 0.5;
  const confidenceScore = calculateConfidenceScore(volatility, marketVolume, trendConsistency);
  
  if (confidenceScore >= 80) return 'high';
  if (confidenceScore >= 60) return 'medium';
  return 'low';
}

function calculateRecentAverage(history) {
  if (!history || history.length === 0) return null;
  
  // Take last 3 data points as "recent"
  const recent = history.slice(-3);
  const sum = recent.reduce((total, entry) => total + (entry.value || 0), 0);
  return recent.length > 0 ? sum / recent.length : null;
}

function calculateOlderAverage(history) {
  if (!history || history.length === 0) return null;
  
  // Take first 3 data points as "older"
  const older = history.slice(0, 3);
  const sum = older.reduce((total, entry) => total + (entry.value || 0), 0);
  return older.length > 0 ? sum / older.length : null;
}

function determineDemandLevel(history) {
  if (!history || history.length === 0) return 'unknown';
  
  // Analyze market volume if available
  const volumes = history.map(entry => entry.marketVolume).filter(vol => vol !== null && vol !== undefined);
  if (volumes.length > 0) {
    const avgVolume = volumes.reduce((sum, vol) => sum + vol, 0) / volumes.length;
    if (avgVolume > 10) return 'high';
    if (avgVolume > 5) return 'medium';
    return 'low';
  }
  
  // Fallback to price trend analysis
  const trend = determineTrendDirection(history);
  if (trend === 'rising') return 'high';
  if (trend === 'stable') return 'medium';
  return 'low';
}

function determineMarketActivity(history) {
  if (!history || history.length === 0) return 'unknown';
  
  // Use stored market activity if available
  const activities = history.map(entry => entry.marketActivity).filter(act => act && act !== 'unknown');
  if (activities.length > 0) {
    return activities[activities.length - 1]; // Return most recent
  }
  
  // Fallback to data point frequency
  if (history.length > 10) return 'very_active';
  if (history.length > 5) return 'active';
  if (history.length > 2) return 'moderate';
  return 'low';
}

// New function for automatic feed processing
async function processUserFeedAutomatically(userId) {
  try {
    logger.info(`Processing feed automatically for user ${userId}`);
    
    const user = await prisma.user.findUnique({ 
      where: { id: userId },
      select: {
        ebayAccessToken: true,
        ebayRefreshToken: true
      }
    });
    
    if (!user) {
      logger.warn(`User not found during automatic feed processing: ${userId}`);
      return { success: false, error: 'User not found' };
    }

    // Check if user has eBay connected
    const hasEbayConnection = user.ebayAccessToken || user.ebayRefreshToken;
    if (!hasEbayConnection) {
      logger.info(`User ${userId} has no eBay connection, skipping automatic feed processing.`);
      return { success: false, error: 'No eBay connection' };
    }

    // Process feed automatically in background
    const refreshResult = await resaleFeedService.refreshResaleFeedForUser(userId);
    
    logger.info(`Automatic feed processing completed for user ${userId}. Items generated: ${refreshResult.itemsGenerated}`);
    
    return {
      success: true,
      itemsGenerated: refreshResult.itemsGenerated,
      insights: refreshResult.insights || [],
      achievements: refreshResult.achievements || []
    };

  } catch (error) {
    logger.error(`Error in automatic feed processing for user ${userId}: ${error.message}`, { userId, error });
    return { success: false, error: error.message };
  }
}

// Main controller functions
async function refreshFeed(req, reply) {
  const userId = req.user.id;

  try {
    const user = await prisma.user.findUnique({ 
      where: { id: userId },
      select: {
        lastFeedRefresh: true,
        ebayAccessToken: true,
        ebayRefreshToken: true
      }
    });
    
    // Add refresh cooldown to prevent API spam (minimum 2 minutes between refreshes)
    const REFRESH_COOLDOWN_MINUTES = 2;
    if (user?.lastFeedRefresh) {
      const timeSinceLastRefresh = (new Date() - user.lastFeedRefresh) / (1000 * 60); // minutes
      if (timeSinceLastRefresh < REFRESH_COOLDOWN_MINUTES) {
        const remainingCooldown = Math.ceil(REFRESH_COOLDOWN_MINUTES - timeSinceLastRefresh);
        logger.info(`User ${userId} attempted refresh too soon. ${remainingCooldown} minutes remaining.`);
        return reply.status(429).send({
          success: false,
          error: `Please wait ${remainingCooldown} minute(s) before refreshing again to prevent API overuse.`,
          code: 'REFRESH_COOLDOWN',
          cooldownRemaining: remainingCooldown
        });
      }
    }
    
    if (!user) {
      logger.warn(`User not found during refreshFeed: ${userId}`);
      return reply.status(404).send({ 
        success: false,
        error: 'User not found.',
        code: 'USER_NOT_FOUND'
      });
    }

    // Check if user has eBay connected
    const hasEbayConnection = user.ebayAccessToken || user.ebayRefreshToken;
    if (!hasEbayConnection) {
      logger.info(`User ${userId} attempted to refresh feed without eBay connection.`);
      return reply.status(400).send({
        success: false,
        error: 'eBay account connection required to check resale prices.',
        code: 'EBAY_CONNECTION_REQUIRED',
        requiresEbayConnection: true,
        data: {
          items: []
        }
      });
    }

    logger.info(`User ${userId} initiated resale feed refresh.`);
    
    // Process feed immediately - no cooldown restrictions
    const refreshResult = await resaleFeedService.refreshResaleFeedForUser(userId);
    
    const updatedUser = await prisma.user.findUnique({ where: { id: userId } });

    logger.info(`Resale feed refresh successful for user ${userId}. Items generated: ${refreshResult.itemsGenerated}`);
    
    return reply.status(200).send({
      success: true,
      data: {
        itemsGenerated: refreshResult.itemsGenerated,
        lastRefresh: updatedUser.lastFeedRefresh ? updatedUser.lastFeedRefresh.toISOString() : new Date().toISOString(),
        insights: refreshResult.insights || [],
        achievements: refreshResult.achievements || [],
        personalizedRecommendations: refreshResult.personalizedRecommendations || [],
        processingStats: {
          ...refreshResult.processingStats,
          apiUsage: {
            callsMade: refreshResult.processingStats?.apiCallsMade || 0,
            cacheHits: refreshResult.processingStats?.cachedDataUsed || 0,
            batchesProcessed: refreshResult.processingStats?.batchesProcessed || 0,
            totalProcessed: refreshResult.processingStats?.totalProcessed || 0
          }
        },
        items: []
      }
    });

  } catch (error) {
    logger.error(`Error in refreshFeed controller for user ${userId}: ${error.message}`, { userId, error });
    
    // Handle specific error cases with better error codes
    if (error.message.includes('User not found')) {
      return reply.status(404).send({ 
        success: false,
        error: error.message,
        code: 'USER_NOT_FOUND'
      });
    }
    
    if (error.message.includes('No connected Google accounts found')) {
      return reply.status(400).send({ 
        success: false,
        error: error.message,
        code: 'GOOGLE_CONNECTION_REQUIRED',
        requiresGoogleConnection: true,
        data: { items: [] }
      });
    }
    
    if (error.message.includes('Cannot refresh feed while Google accounts are syncing')) {
      return reply.status(409).send({ 
        success: false,
        error: error.message,
        code: 'ACCOUNTS_SYNCING',
        accountsSyncing: true,
        data: { items: [] }
      });
    }
    
    return reply.status(500).send({ 
      success: false,
      error: 'An error occurred while refreshing the resale feed.',
      code: 'INTERNAL_ERROR'
    });
  }
}

async function getFeed(req, reply) {
  const userId = req.user.id;
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7); 

  try {
    logger.info(`Fetching resale feed for user ${userId}.`);
    
    // Get user info for metadata
    const user = await prisma.user.findUnique({ 
      where: { id: userId },
      select: { 
        lastFeedRefresh: true,
        ebayAccessToken: true,
        ebayRefreshToken: true
      }
    });

    if (!user) {
      return reply.status(404).send({
        success: false,
        error: 'User not found.',
        code: 'USER_NOT_FOUND'
      });
    }

    const hasNeverRefreshed = !user.lastFeedRefresh;
    const hasEbayConnection = user.ebayAccessToken || user.ebayRefreshToken;
    
    // If user has no eBay connection, explain what's needed
    if (!hasEbayConnection) {
      logger.info(`User ${userId} has no eBay connection. Returning connection required message.`);
      return reply.status(200).send({
        success: true,
        data: {
          items: [],
          metadata: {
            totalItems: 0,
            lastRefresh: user.lastFeedRefresh?.toISOString() || null,
            refreshAvailable: true,
            needsFirstRefresh: false,
            requiresEbayConnection: true,
            message: "Connect your eBay account to discover resale opportunities and track market prices for your items."
          }
        }
      });
    }
    
    // If user has eBay but never refreshed, suggest they refresh first
    if (hasNeverRefreshed) {
      logger.info(`User ${userId} has never refreshed their feed. Returning empty feed with refresh suggestion.`);
      return reply.status(200).send({
        success: true,
        data: {
          items: [],
          metadata: {
            totalItems: 0,
            lastRefresh: null,
            refreshAvailable: true,
            needsFirstRefresh: true,
            requiresEbayConnection: false,
            message: "Welcome! Refresh your feed to discover resale opportunities from your receipts."
          }
        }
      });
    }

    const feedItems = await prisma.receiptItem.findMany({
      where: {
        userId: userId,
        lastFeedCandidateAt: {
          gte: sevenDaysAgo,
        },
      },
      include: {
        receipt: {
      select: {
            vendorName: true,
            transactionDate: true,
          }
        }
      },
      orderBy: [
        { recommendedAction: 'desc' },
        { resaleValue: 'desc' }
      ],
      // Removed take: 10 to show all items
    });

    // Transform data for consistent format and select only needed fields
    const itemsToReturn = feedItems.map(item => ({
        id: item.id,
        itemName: item.itemName,
        resaleValue: item.resaleValue,
        resaleValueLastChecked: item.resaleValueLastChecked?.toISOString(),
        resaleValueHistory: Array.isArray(item.resaleValueHistory) ? item.resaleValueHistory : [],
        recommendedAction: item.recommendedAction,
        lastFeedReason: item.lastFeedReason,
        imageUrl: item.imageUrl,
        storeName: item.receipt.vendorName,
        itemPrice: item.itemPrice,
        itemQuantity: item.itemQuantity,
        sellScore: item.sellScore,
        lastFeedCandidateAt: item.lastFeedCandidateAt?.toISOString(),
        receipt: item.receipt,
        // Calculate profit margin for display
        profitMargin: item.resaleValue && item.itemPrice ? 
          ((item.resaleValue - item.itemPrice) / item.itemPrice) * 100 : null,
        // Enhanced market data for graphs
        marketData: {
          // Price analysis for trend graphs
          priceAnalysis: {
            medianPrice: item.resaleValue,
            meanPrice: item.resaleValue, // We could enhance this with actual mean calculation
            priceRange: {
              min: item.resaleValue * 0.8, // Estimate based on current value
              max: item.resaleValue * 1.2
            },
            volatility: item.resaleValueHistory?.length > 1 ? 
              calculateVolatility(item.resaleValueHistory) : null
          },
          // Market trends for trend graphs
          marketTrends: {
            direction: determineTrendDirection(item.resaleValueHistory),
            percentageChange: calculateTrendPercentage(item.resaleValueHistory),
            confidence: determineTrendConfidence(item.resaleValueHistory),
            recentAverage: calculateRecentAverage(item.resaleValueHistory),
            olderAverage: calculateOlderAverage(item.resaleValueHistory)
          },
          // Market indicators for dashboard graphs
          marketIndicators: {
            demandLevel: determineDemandLevel(item.resaleValueHistory),
            competitionLevel: 'medium', // Could be enhanced with actual data
            marketActivity: determineMarketActivity(item.resaleValueHistory)
          },
          // Historical data points for time series graphs
          historicalData: item.resaleValueHistory?.map(entry => ({
            date: entry.date,
            value: entry.value,
            marketVolume: entry.marketVolume || null,
            priceVolatility: entry.priceVolatility || null,
            historicalTrend: entry.historicalTrend || null,
            historicalConfidence: entry.historicalConfidence || null,
            marketActivity: entry.marketActivity || null
          })) || [],
          // Time range for graph scaling
          timeRange: {
            startDate: item.resaleValueHistory?.length > 0 ? 
              item.resaleValueHistory[0].date : null,
            endDate: item.resaleValueHistory?.length > 0 ? 
              item.resaleValueHistory[item.resaleValueHistory.length - 1].date : null,
            dataPoints: item.resaleValueHistory?.length || 0
          }
        }
    }));

    // Calculate feed quality metrics
    const sellNowCount = itemsToReturn.filter(item => item.recommendedAction === 'sell_now').length;
    const considerSellingCount = itemsToReturn.filter(item => item.recommendedAction === 'consider_selling').length;
    const watchCount = itemsToReturn.filter(item => item.recommendedAction === 'watch').length;
    const averageProfitMargin = itemsToReturn.length > 0 ? 
      itemsToReturn.reduce((sum, item) => sum + (item.profitMargin || 0), 0) / itemsToReturn.length : 0;

    logger.info(`Successfully fetched ${itemsToReturn.length} resale feed items for user ${userId}.`);
    
    // Return consistent object format with enhanced metadata
    return reply.status(200).send({
      success: true,
      data: {
        items: itemsToReturn,
        metadata: {
          totalItems: itemsToReturn.length,
          lastRefresh: user.lastFeedRefresh?.toISOString() || null,
          refreshAvailable: true, // Always available now
          needsFirstRefresh: false,
          requiresEbayConnection: false,
          feedQuality: {
            sellNowCount,
            considerSellingCount,
            watchCount,
            averageProfitMargin: Math.round(averageProfitMargin),
            highValueOpportunities: itemsToReturn.filter(item => (item.profitMargin || 0) > 50).length,
          },
          message: itemsToReturn.length === 0 ? 
            "No current opportunities. Try refreshing to check for new ones!" : 
            `${sellNowCount} hot opportunities, ${considerSellingCount} good prospects available.`
        }
      }
    });

  } catch (error) {
    logger.error(`Error in getFeed controller for user ${userId}: ${error.message}`, { userId, error });
    return reply.status(500).send({ 
      success: false,
      error: 'An error occurred while fetching the resale feed.',
      code: 'INTERNAL_ERROR'
    });
  }
}

async function markItemAsSold(req, reply) {
  const userId = req.user.id;
  const { itemId } = req.params;

  try {
    // Verify the item belongs to the user
    const item = await prisma.receiptItem.findFirst({
      where: {
        id: itemId,
        userId: userId,
      },
      select: {
        id: true,
        itemName: true,
        status: true,
        lastFeedCandidateAt: true,
      }
    });

    if (!item) {
      return reply.status(404).send({ 
        success: false,
        error: 'Item not found or you do not have permission to modify it.',
        code: 'ITEM_NOT_FOUND'
      });
    }

    // Update the item status to 'sold' and clear feed candidate status
    const updatedItem = await prisma.receiptItem.update({
      where: { id: itemId },
      data: {
        status: 'sold',
        soldAt: new Date(),
        // Clear feed candidate status so it can reappear in future feeds
        lastFeedCandidateAt: null,
        recommendedAction: null,
        lastFeedReason: null,
      },
    });

    logger.info(`User ${userId} marked item ${itemId} ("${item.itemName}") as sold.`);
    
    return reply.status(200).send({
      success: true,
      message: 'Item marked as sold successfully.',
      data: {
        item: {
          id: updatedItem.id,
          status: updatedItem.status,
          soldAt: updatedItem.soldAt,
        }
      }
    });

  } catch (error) {
    logger.error(`Error marking item ${itemId} as sold for user ${userId}: ${error.message}`, { userId, itemId, error });
    return reply.status(500).send({ 
      success: false,
      error: 'An error occurred while marking the item as sold.',
      code: 'INTERNAL_ERROR'
    });
  }
}

async function getSoldItems(req, reply) {
  const userId = req.user.id;
  const { limit = 20, offset = 0 } = req.query;

  try {
    logger.info(`Fetching sold items for user ${userId}.`);
    
    const soldItems = await prisma.receiptItem.findMany({
      where: {
        userId: userId,
        status: 'sold',
      },
      include: {
        receipt: {
          select: {
            vendorName: true,
            transactionDate: true,
          }
        }
      },
      orderBy: { soldAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
    });

    const totalCount = await prisma.receiptItem.count({
      where: {
        userId: userId,
        status: 'sold',
      },
    });

    // Transform data for consistent format and select only needed fields
    const itemsToReturn = soldItems.map(item => ({
        id: item.id,
        itemName: item.itemName,
        itemPrice: item.itemPrice,
        itemQuantity: item.itemQuantity,
        resaleValue: item.resaleValue,
        sellScore: item.sellScore,
        soldAt: item.soldAt?.toISOString(),
        imageUrl: item.imageUrl,
        storeName: item.receipt.vendorName,
        transactionDate: item.receipt.transactionDate?.toISOString(),
        resaleValueHistory: Array.isArray(item.resaleValueHistory) ? item.resaleValueHistory : [],
        receipt: item.receipt,
        // Calculate profit/loss
        profitLoss: item.resaleValue && item.itemPrice ? 
          (item.resaleValue - item.itemPrice) * item.itemQuantity : null,
        profitLossPercentage: item.resaleValue && item.itemPrice ? 
          ((item.resaleValue - item.itemPrice) / item.itemPrice) * 100 : null,
        // Enhanced market data for historical analysis graphs
        marketData: {
          // Price analysis for historical trend graphs
          priceAnalysis: {
            medianPrice: item.resaleValue,
            meanPrice: item.resaleValue,
            priceRange: {
              min: item.resaleValue * 0.8,
              max: item.resaleValue * 1.2
            },
            volatility: item.resaleValueHistory?.length > 1 ? 
              calculateVolatility(item.resaleValueHistory) : null
          },
          // Market trends for historical analysis
          marketTrends: {
            direction: determineTrendDirection(item.resaleValueHistory),
            percentageChange: calculateTrendPercentage(item.resaleValueHistory),
            confidence: determineTrendConfidence(item.resaleValueHistory),
            recentAverage: calculateRecentAverage(item.resaleValueHistory),
            olderAverage: calculateOlderAverage(item.resaleValueHistory)
          },
          // Market indicators for historical dashboard
          marketIndicators: {
            demandLevel: determineDemandLevel(item.resaleValueHistory),
            competitionLevel: 'medium',
            marketActivity: determineMarketActivity(item.resaleValueHistory)
          },
          // Historical data points for time series graphs
          historicalData: item.resaleValueHistory?.map(entry => ({
            date: entry.date,
            value: entry.value,
            marketVolume: entry.marketVolume || null,
            priceVolatility: entry.priceVolatility || null,
            historicalTrend: entry.historicalTrend || null,
            historicalConfidence: entry.historicalConfidence || null,
            marketActivity: entry.marketActivity || null
          })) || [],
          // Time range for graph scaling
          timeRange: {
            startDate: item.resaleValueHistory?.length > 0 ? 
              item.resaleValueHistory[0].date : null,
            endDate: item.resaleValueHistory?.length > 0 ? 
              item.resaleValueHistory[item.resaleValueHistory.length - 1].date : null,
            dataPoints: item.resaleValueHistory?.length || 0
          }
        }
    }));

    logger.info(`Successfully fetched ${itemsToReturn.length} sold items for user ${userId}.`);
    
    return reply.status(200).send({
      success: true,
      data: {
        items: itemsToReturn,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: totalCount,
          hasMore: parseInt(offset) + parseInt(limit) < totalCount,
        },
        summary: {
          totalItems: totalCount,
          totalProfit: itemsToReturn.reduce((sum, item) => sum + (item.profitLoss || 0), 0),
          averageProfitPercentage: itemsToReturn.length > 0 ? 
            itemsToReturn.reduce((sum, item) => sum + (item.profitLossPercentage || 0), 0) / itemsToReturn.length : 0,
        }
      }
    });

  } catch (error) {
    logger.error(`Error in getSoldItems controller for user ${userId}: ${error.message}`, { userId, error });
    return reply.status(500).send({ 
      message: 'An error occurred while fetching sold items.',
      items: []
    });
  }
}

async function getItemMarketData(req, reply) {
  const userId = req.user.id;
  const { itemId } = req.params;

  try {
    logger.info(`Fetching detailed market data for item ${itemId} for user ${userId}.`);
    
    const item = await prisma.receiptItem.findFirst({
      where: {
        id: itemId,
        userId: userId,
      },
      include: {
        receipt: {
          select: {
            vendorName: true,
            transactionDate: true,
          }
        }
      }
    });

    if (!item) {
      return reply.status(404).send({ 
        message: 'Item not found or you do not have permission to view it.' 
      });
    }

    // Get fresh eBay data for this specific item
    let freshEbayData = null;
    try {
      freshEbayData = await resaleFeedService.getEbayDataWithHistory(
        userId, 
        item.itemName, 
        item.receipt?.vendorName
      );
    } catch (error) {
      logger.warn(`Failed to get fresh eBay data for item ${itemId}: ${error.message}`);
    }

    // Transform data with enhanced market information
    const itemData = {
      id: item.id,
      itemName: item.itemName,
      itemPrice: item.itemPrice,
      itemQuantity: item.itemQuantity,
      resaleValue: item.resaleValue,
      sellScore: item.sellScore,
      imageUrl: item.imageUrl,
      storeName: item.receipt.vendorName,
      transactionDate: item.receipt.transactionDate?.toISOString(),
      status: item.status,
      recommendedAction: item.recommendedAction,
      lastFeedReason: item.lastFeedReason,
      resaleValueHistory: Array.isArray(item.resaleValueHistory) ? item.resaleValueHistory : [],
      receipt: item.receipt,
      // Calculate profit/loss
      profitMargin: item.resaleValue && item.itemPrice ? 
        ((item.resaleValue - item.itemPrice) / item.itemPrice) * 100 : null,
      profitLoss: item.resaleValue && item.itemPrice ? 
        (item.resaleValue - item.itemPrice) * item.itemQuantity : null,
      // Enhanced market data for detailed analysis
      marketData: {
        // Current price analysis
        priceAnalysis: {
          medianPrice: item.resaleValue,
          meanPrice: item.resaleValue,
          priceRange: {
            min: item.resaleValue * 0.8,
            max: item.resaleValue * 1.2
          },
          volatility: item.resaleValueHistory?.length > 1 ? 
            calculateVolatility(item.resaleValueHistory) : null
        },
        // Market trends
        marketTrends: {
          direction: determineTrendDirection(item.resaleValueHistory),
          percentageChange: calculateTrendPercentage(item.resaleValueHistory),
          confidence: determineTrendConfidence(item.resaleValueHistory),
          recentAverage: calculateRecentAverage(item.resaleValueHistory),
          olderAverage: calculateOlderAverage(item.resaleValueHistory)
        },
        // Market indicators
        marketIndicators: {
          demandLevel: determineDemandLevel(item.resaleValueHistory),
          competitionLevel: 'medium',
          marketActivity: determineMarketActivity(item.resaleValueHistory)
        },
        // Historical data points for time series graphs
        historicalData: item.resaleValueHistory?.map(entry => ({
          date: entry.date,
          value: entry.value,
          marketVolume: entry.marketVolume || null,
          priceVolatility: entry.priceVolatility || null,
          historicalTrend: entry.historicalTrend || null,
          historicalConfidence: entry.historicalConfidence || null,
          marketActivity: entry.marketActivity || null
        })) || [],
        // Time range for graph scaling
        timeRange: {
          startDate: item.resaleValueHistory?.length > 0 ? 
            item.resaleValueHistory[0].date : null,
          endDate: item.resaleValueHistory?.length > 0 ? 
            item.resaleValueHistory[item.resaleValueHistory.length - 1].date : null,
          dataPoints: item.resaleValueHistory?.length || 0
        },
        // Fresh eBay data if available
        freshEbayData: freshEbayData ? {
          currentListings: freshEbayData.currentListings?.length || 0,
          historicalData: freshEbayData.historicalData ? {
            totalSoldItems: freshEbayData.historicalData.summary?.totalSoldItems || 0,
            totalQuantitySold: freshEbayData.historicalData.summary?.totalQuantitySold || 0,
            trendDirection: freshEbayData.historicalData.marketTrends?.direction || 'unknown',
            trendPercentage: freshEbayData.historicalData.marketTrends?.percentageChange || 0,
            confidence: freshEbayData.historicalData.marketTrends?.confidence || 'unknown',
            demandLevel: freshEbayData.historicalData.marketIndicators?.demandLevel || 'unknown',
            competitionLevel: freshEbayData.historicalData.marketIndicators?.competitionLevel || 'unknown',
            marketActivity: freshEbayData.historicalData.marketIndicators?.marketActivity || 'unknown'
          } : null,
          marketTrends: freshEbayData.marketTrends ? {
            totalItems: freshEbayData.marketTrends.totalItems || 0,
            validItems: freshEbayData.marketTrends.validItems || 0,
            trendDirection: freshEbayData.marketTrends.trend?.direction || 'unknown',
            trendPercentage: freshEbayData.marketTrends.trend?.percentageChange || 0,
            confidence: freshEbayData.marketTrends.trend?.confidence || 'unknown'
          } : null
        } : null
      }
    };

    logger.info(`Successfully fetched detailed market data for item ${itemId} for user ${userId}.`);
    
    return reply.status(200).send({
      success: true,
      data: {
        item: itemData,
        metadata: {
          lastUpdated: item.resaleValueLastChecked?.toISOString() || null,
          dataFreshness: freshEbayData ? 'fresh' : 'stored',
          hasHistoricalData: item.resaleValueHistory?.length > 0,
          hasEbayData: !!freshEbayData
        }
      }
    });

  } catch (error) {
    logger.error(`Error in getItemMarketData controller for user ${userId}, item ${itemId}: ${error.message}`, { userId, itemId, error });
    return reply.status(500).send({ 
      message: 'An error occurred while fetching item market data.'
    });
  }
}

async function getUserAnalytics(req, reply) {
  const userId = req.user.id;

  try {
    logger.info(`Fetching analytics for user ${userId}.`);
    
    // Get user profile data
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        achievements: true,
        behaviorProfile: true,
        feedEngagementScore: true,
        sellingStats: true,
        receiptItems: {
          where: { status: 'sold' },
          select: {
            itemPrice: true,
            resaleValue: true,
            categoryTag: true,
            soldAt: true
          }
        }
      }
    });

    if (!user) {
      return reply.status(404).send({ 
      success: false,
      error: 'User not found',
      code: 'USER_NOT_FOUND'
    });
    }

    const soldItems = user.receiptItems;
    const achievements = user.achievements || { earned: [], points: 0, level: 1 };
    const behaviorProfile = user.behaviorProfile || {};

    // Calculate selling stats
    const totalSales = soldItems.length;
    const totalProfit = soldItems.reduce((sum, item) => sum + (item.resaleValue - item.itemPrice), 0);
    const averageProfitMargin = totalSales > 0 ? 
      soldItems.reduce((sum, item) => sum + ((item.resaleValue - item.itemPrice) / item.itemPrice), 0) / totalSales * 100 : 0;

    // Calculate category performance
    const categoryStats = {};
    soldItems.forEach(item => {
      const category = item.categoryTag || 'other';
      if (!categoryStats[category]) {
        categoryStats[category] = { salesCount: 0, totalProfit: 0, items: [] };
      }
      categoryStats[category].salesCount++;
      categoryStats[category].totalProfit += (item.resaleValue - item.itemPrice);
      categoryStats[category].items.push(item);
    });

    const categoryPerformance = Object.entries(categoryStats).map(([category, stats]) => ({
      category,
      salesCount: stats.salesCount,
      totalProfit: stats.totalProfit,
      averageMargin: stats.items.reduce((sum, item) => 
        sum + ((item.resaleValue - item.itemPrice) / item.itemPrice), 0) / stats.items.length * 100,
      preference: behaviorProfile.categoryPreferences?.[category] || 0
    })).sort((a, b) => b.totalProfit - a.totalProfit);

    const topCategory = categoryPerformance.length > 0 ? categoryPerformance[0].category : null;

    // Generate recommendations based on performance
    const recommendations = [];
    
    if (totalSales === 0) {
      recommendations.push({
        type: 'getting_started',
        title: 'Start Your Selling Journey',
        description: 'Mark your first item as sold to unlock detailed analytics!',
        priority: 'high'
      });
    } else if (totalSales < 5) {
      recommendations.push({
        type: 'growth',
        title: 'Build Momentum',
        description: `You've sold ${totalSales} items. Aim for 5 sales to unlock achievement rewards!`,
        priority: 'medium'
      });
    }

    if (topCategory && categoryPerformance[0].totalProfit > 50) {
      recommendations.push({
        type: 'category_focus',
        title: `Excel in ${topCategory}`,
        description: `You've made $${categoryPerformance[0].totalProfit.toFixed(2)} in ${topCategory}. Focus on this category!`,
        priority: 'high'
      });
    }

    if (averageProfitMargin < 20 && totalSales > 2) {
      recommendations.push({
        type: 'pricing_strategy',
        title: 'Improve Profit Margins',
        description: 'Consider focusing on higher-margin items or improving your pricing strategy.',
        priority: 'medium'
      });
    }

    const analytics = {
      userProfile: {
        level: achievements.level || 1,
        points: achievements.points || 0,
        engagementScore: user.feedEngagementScore || 50
      },
      achievements: achievements.earned?.map(achievement => ({
        name: achievement,
        description: getAchievementDescription(achievement),
        points: getAchievementPoints(achievement),
        earnedAt: new Date().toISOString() // This would be stored in the future
      })) || [],
      sellingStats: {
        totalSales,
        totalProfit: Math.round(totalProfit * 100) / 100,
        averageProfitMargin: Math.round(averageProfitMargin * 100) / 100,
        successRate: totalSales > 0 ? 100 : 0, // For now, assume 100% success rate for sold items
        topCategory
      },
      categoryPerformance,
      recommendations
    };

    logger.info(`Successfully fetched analytics for user ${userId}.`);
    return reply.status(200).send({
      success: true,
      data: analytics
    });

  } catch (error) {
    logger.error(`Error fetching analytics for user ${userId}: ${error.message}`);
    return reply.status(500).send({ 
      success: false,
      error: 'Failed to fetch analytics',
      code: 'ANALYTICS_ERROR'
    });
  }
}

// Helper functions for achievements
function getAchievementDescription(achievementName) {
  const descriptions = {
    firstSale: 'Sold your first item',
    profitable: 'Made $100+ in profit',
    frequent: 'Sold 10+ items',
    highValue: 'Sold an item for $250+',
    streakSeller: '5 consecutive profitable sales',
    categoryExpert: 'Dominated a specific category'
  };
  return descriptions[achievementName] || 'Achievement unlocked';
}

function getAchievementPoints(achievementName) {
  const points = {
    firstSale: 100,
    profitable: 200,
    frequent: 300,
    highValue: 250,
    streakSeller: 400,
    categoryExpert: 300
  };
  return points[achievementName] || 100;
}

module.exports = {
  refreshFeed,
  getFeed,
  markItemAsSold,
  getSoldItems,
  getItemMarketData,
  getUserAnalytics,
  processUserFeedAutomatically
};
