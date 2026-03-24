const prisma = require('../lib/prisma');
const ebayApiService = require('./ebayApiService');
const userPersonalizationService = require('./userPersonalizationService');
const marketIntelligenceService = require('./marketIntelligenceService');
const { createLogger } = require('../utils/logger');

const logger = createLogger('RESALE_FEED_SERVICE');

// Helper function for volatility calculation
function calculateVolatility(history) {
  if (!history || history.length < 2) return null;
  
  const values = history.map(entry => entry.value).filter(val => val > 0);
  if (values.length < 2) return null;
  
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  const standardDeviation = Math.sqrt(variance);
  
  return standardDeviation / mean; // Coefficient of variation
}

// Enhanced Algorithm Configuration - Show ALL items, no limit
const RESALE_FEED_CANDIDATE_LIMIT = 1000; // Effectively unlimited for complete feed

// API Rate Limiting Configuration
const MAX_API_CALLS_PER_REFRESH = 50; // Limit eBay API calls per refresh
const MIN_CACHE_TIME_MINUTES = 30; // Minimum time before re-checking same item
const BATCH_SIZE = 10; // Process items in batches
const BATCH_DELAY_MS = 2000; // 2 second delay between batches

const SIGNIFICANT_PRICE_INCREASE_THRESHOLD = 0.15;
const MODERATE_PRICE_INCREASE_THRESHOLD = 0.08;
const PRICE_DROP_THRESHOLD = -0.10;
const MIN_PROFIT_MARGIN = 0.15; // Slightly reduced for more opportunities
const MAX_DAYS_SINCE_PURCHASE = 365;
const MIN_RESALE_VALUE = 8; // Slightly reduced threshold

// Enhanced scoring weights with personalization
const ENHANCED_SCORE_WEIGHTS = {
  PERSONALIZATION: 0.30,    // User preferences and behavior
  MARKET_INTELLIGENCE: 0.25, // Market trends and timing
  PROFIT_POTENTIAL: 0.20,   // Profit margin and value
  ENGAGEMENT: 0.15,         // User engagement patterns
  RECENCY: 0.10            // Item recency
};

// Legacy weights for backward compatibility
const SCORE_WEIGHTS = {
  PRICE_CHANGE: 0.35,
  PROFIT_MARGIN: 0.25,
  SELL_SCORE: 0.15,
  RECENCY: 0.15,
  MARKET_VOLUME: 0.10
};

async function refreshResaleFeedForUser(userId) {
  logger.info(`Starting enhanced resale feed refresh for user ${userId}`);

  try {
    // Initialize user personalization if needed
    await userPersonalizationService.initializeUserPersonalization(userId);
    
    // Check if all Google accounts are in IDLE status
    await checkGoogleAccountsIdle(userId);
    logger.info(`All Google accounts for user ${userId} are in IDLE status. Proceeding with enhanced feed refresh.`);

    // Get user preferences and behavior profile
    const userProfile = await getUserProfile(userId);
    const { feedPreferences, behaviorProfile, achievements } = userProfile;

    // Get items to consider with enhanced filtering
    const itemsToConsider = await getItemsToConsider(userId, feedPreferences);

    if (itemsToConsider.length === 0) {
      logger.info(`No items to consider for enhanced feed for user ${userId}.`);
      await updateUserFeedRefresh(userId);
      return {
        itemsGenerated: 0,
        insights: generateEmptyFeedInsights(userProfile),
        achievements: []
      };
    }

    logger.info(`Found ${itemsToConsider.length} items to process for enhanced feed for user ${userId}.`);
    
    const enhancedCandidates = [];
    const processingSummary = {
      totalProcessed: 0,
      successful: 0,
      errors: 0,
      skipped: 0,
      apiCallsMade: 0,
      cachedDataUsed: 0,
      batchesProcessed: 0
    };

    // Process items in batches with API rate limiting
    let apiCallCount = 0;
    
    // Sort items by priority - least recently checked first
    itemsToConsider.sort((a, b) => {
      const aLastChecked = a.resaleValueLastChecked ? new Date(a.resaleValueLastChecked) : new Date(0);
      const bLastChecked = b.resaleValueLastChecked ? new Date(b.resaleValueLastChecked) : new Date(0);
      return aLastChecked - bLastChecked;
    });
    
    // Process items in batches with delays to prevent API spam
    for (let i = 0; i < itemsToConsider.length; i += BATCH_SIZE) {
      const batch = itemsToConsider.slice(i, i + BATCH_SIZE);
      
      logger.info(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(itemsToConsider.length / BATCH_SIZE)} (${batch.length} items)`);
      
      // Process batch items in parallel but with API call limiting
      const batchPromises = batch.map(async (item) => {
        try {
          processingSummary.totalProcessed++;
          
                     // Check if we've hit API call limit
           if (apiCallCount >= MAX_API_CALLS_PER_REFRESH) {
             logger.info(`Reached API call limit (${MAX_API_CALLS_PER_REFRESH}), using cached data for remaining items`);
             
             // Use cached data for remaining items
             processingSummary.cachedDataUsed++;
             const cachedItem = await processItemWithCachedData(item, userId, feedPreferences, behaviorProfile);
             if (cachedItem) {
               enhancedCandidates.push(cachedItem);
               processingSummary.successful++;
             } else {
               processingSummary.skipped++;
             }
             return;
           }
          
          // Check if item was recently checked (within cache time)
          const lastChecked = item.resaleValueLastChecked ? new Date(item.resaleValueLastChecked) : null;
          const cacheExpired = !lastChecked || (new Date() - lastChecked) > (MIN_CACHE_TIME_MINUTES * 60 * 1000);
          
          let enhancedItem;
                     if (cacheExpired) {
             // Make fresh API call
             apiCallCount++;
             processingSummary.apiCallsMade++;
             enhancedItem = await processItemWithEnhancements(
               item, 
               userId, 
               feedPreferences, 
               behaviorProfile,
               true // Force fresh API call
             );
           } else {
             // Use cached data but still process for scoring
             processingSummary.cachedDataUsed++;
             enhancedItem = await processItemWithCachedData(item, userId, feedPreferences, behaviorProfile);
           }
          
          if (enhancedItem) {
            enhancedCandidates.push(enhancedItem);
            processingSummary.successful++;
          } else {
            processingSummary.skipped++;
          }
          
        } catch (error) {
          logger.error(`Error processing enhanced item ${item.id}: ${error.message}`);
          processingSummary.errors++;
          
          // Still update the checked timestamp
          await prisma.receiptItem.update({
            where: { id: item.id },
            data: { resaleValueLastChecked: new Date() }
          });
        }
      });
      
             // Wait for batch to complete
       await Promise.all(batchPromises);
       processingSummary.batchesProcessed++;
       
       // Add delay between batches (except for last batch)
       if (i + BATCH_SIZE < itemsToConsider.length) {
         logger.info(`Waiting ${BATCH_DELAY_MS}ms before next batch...`);
         await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
       }
     }
    
         logger.info(`API calls made: ${apiCallCount}/${MAX_API_CALLS_PER_REFRESH}`);
    
    // Update final processing summary
    processingSummary.apiCallsMade = apiCallCount;

    // Enhanced candidate selection with personalization
    const selectedCandidates = selectEnhancedCandidates(
      enhancedCandidates, 
      feedPreferences, 
      behaviorProfile
    );

    // Mark selected candidates and update with enhanced data
    let itemsMarkedAsCandidate = 0;
    for (const candidate of selectedCandidates) {
      await markItemAsEnhancedCandidate(candidate, userId);
      itemsMarkedAsCandidate++;
    }

    // Update user behavior tracking
    await userPersonalizationService.updateUserBehavior(userId, 'view_feed');
    
    // Check for new achievements
    const newAchievements = await userPersonalizationService.checkAchievements(userId);
    
    // Generate personalized insights
    const enhancedInsights = await generateEnhancedFeedInsights(
      userProfile, 
      selectedCandidates, 
      processingSummary
    );

    // Update user profile with latest activity
    await updateUserFeedRefresh(userId, {
      lastFeedInteraction: new Date(),
      feedEngagementScore: calculateEngagementScore(behaviorProfile)
    });

    logger.info(`Enhanced resale feed refresh completed for user ${userId}. ${itemsMarkedAsCandidate} items marked as candidates.`);
    
    return {
      itemsGenerated: itemsMarkedAsCandidate,
      insights: enhancedInsights,
      achievements: newAchievements,
      processingStats: processingSummary,
      personalizedRecommendations: generatePersonalizedRecommendations(userProfile, selectedCandidates)
    };

  } catch (error) {
    logger.error(`Failed to refresh enhanced resale feed for user ${userId}: ${error.message}`);
    throw error;
  }
}

// Helper function to analyze eBay prices
function analyzePrices(ebayResults, originalPrice) {
  const validPricedItems = ebayResults.filter(res => 
    res.price && parseFloat(res.price.value) > 0 && parseFloat(res.price.value) >= MIN_RESALE_VALUE
  );

  if (validPricedItems.length === 0) {
    return { isValid: false };
  }

  const prices = validPricedItems.map(item => parseFloat(item.price.value)).sort((a, b) => a - b);
  
  // Calculate median price (more robust than average)
  const medianPrice = prices.length % 2 === 0 
    ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
    : prices[Math.floor(prices.length / 2)];

  // Calculate volatility (standard deviation)
  const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const variance = prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
  const volatility = Math.sqrt(variance) / mean; // Coefficient of variation

  // Filter out outliers (prices more than 2 standard deviations from median)
  const filteredPrices = prices.filter(price => 
    Math.abs(price - medianPrice) <= 2 * Math.sqrt(variance)
  );

  const finalMedianPrice = filteredPrices.length % 2 === 0 
    ? (filteredPrices[filteredPrices.length / 2 - 1] + filteredPrices[filteredPrices.length / 2]) / 2
    : filteredPrices[Math.floor(filteredPrices.length / 2)];

  return {
    isValid: true,
    medianPrice: finalMedianPrice,
    volatility,
    marketVolume: validPricedItems.length,
    priceRange: { min: Math.min(...prices), max: Math.max(...prices) }
  };
}

// Helper function to analyze eBay prices with historical data
function analyzePricesWithHistory(ebayResults, originalPrice) {
  // Handle the new data structure from searchItemsWithHistory
  const currentListings = ebayResults.currentListings || [];
  const validPricedItems = currentListings.filter(res => 
    res.price && parseFloat(res.price.value) > 0 && parseFloat(res.price.value) >= MIN_RESALE_VALUE
  );

  if (validPricedItems.length === 0) {
    return { isValid: false };
  }

  const prices = validPricedItems.map(item => parseFloat(item.price.value)).sort((a, b) => a - b);
  
  // Calculate median price (more robust than average)
  const medianPrice = prices.length % 2 === 0 
    ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
    : prices[Math.floor(prices.length / 2)];

  // Calculate volatility (standard deviation)
  const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const variance = prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
  const volatility = Math.sqrt(variance) / mean; // Coefficient of variation

  // Filter out outliers (prices more than 2 standard deviations from median)
  const filteredPrices = prices.filter(price => 
    Math.abs(price - medianPrice) <= 2 * Math.sqrt(variance)
  );

  const finalMedianPrice = filteredPrices.length % 2 === 0 
    ? (filteredPrices[filteredPrices.length / 2 - 1] + filteredPrices[filteredPrices.length / 2]) / 2
    : filteredPrices[Math.floor(filteredPrices.length / 2)];

  return {
    isValid: true,
    medianPrice: finalMedianPrice,
    volatility,
    marketVolume: validPricedItems.length,
    priceRange: { min: Math.min(...prices), max: Math.max(...prices) }
  };
}

// Helper function to determine recommendation with historical data
function determineRecommendationWithHistory(percentageChange, profitMargin, volatility, marketVolume, sellScore, historicalData, marketTrends) {
  const normalizedSellScore = (sellScore || 50) / 100;
  
  // Get historical trend information
  const historicalTrend = historicalData?.marketTrends?.direction || 'unknown';
  const historicalConfidence = historicalData?.marketTrends?.confidence || 'unknown';
  const marketActivity = historicalData?.marketIndicators?.marketActivity || 'unknown';
  const demandLevel = historicalData?.marketIndicators?.demandLevel || 'medium';
  const competitionLevel = historicalData?.marketIndicators?.competitionLevel || 'medium';
  
  // Strong sell signals with historical confirmation
  if (percentageChange > SIGNIFICANT_PRICE_INCREASE_THRESHOLD && profitMargin > MIN_PROFIT_MARGIN) {
    let reason = `🔥 Hot market! Value up ${Math.round(percentageChange * 100)}% with ${Math.round(profitMargin * 100)}% profit margin.`;
    
    if (historicalTrend === 'rising' && historicalConfidence === 'high') {
      reason += ` 📈 Historical data confirms strong upward trend.`;
    } else if (demandLevel === 'high') {
      reason += ` 📊 High market demand detected.`;
    }
    
    return { action: 'sell_now', reason };
  }
  
  // Good opportunities with market context
  if (percentageChange > MODERATE_PRICE_INCREASE_THRESHOLD && profitMargin > 0.15) {
    let reason = `📈 Good opportunity: ${Math.round(percentageChange * 100)}% increase, ${Math.round(profitMargin * 100)}% profit margin.`;
    
    if (historicalTrend === 'rising') {
      reason += ` Trend is favorable.`;
    } else if (marketActivity === 'active' || marketActivity === 'very_active') {
      reason += ` Active market with good liquidity.`;
    }
    
    return { action: 'consider_selling', reason };
  }
  
  // High profit potential scenarios
  if (profitMargin > 0.25 && marketVolume > 3) {
    let reason = `💰 High profit potential: ${Math.round(profitMargin * 100)}% margin with active market (${marketVolume} listings).`;
    
    if (competitionLevel === 'low') {
      reason += ` Low competition environment.`;
    } else if (demandLevel === 'high') {
      reason += ` High demand market.`;
    }
    
    return { action: 'consider_selling', reason };
  }
  
  // Watch scenarios with historical context
  if (percentageChange < PRICE_DROP_THRESHOLD) {
    let reason = `📉 Price dropped ${Math.abs(Math.round(percentageChange * 100))}%.`;
    
    if (historicalTrend === 'falling') {
      reason += ` Historical trend confirms decline - monitor for recovery.`;
    } else if (historicalTrend === 'stable') {
      reason += ` May be temporary dip in stable market.`;
    } else {
      reason += ` Monitor for recovery.`;
    }
    
    return { action: 'watch', reason };
  }
  
  // Volatile market scenarios
  if (volatility > 0.3 && marketVolume > 5) {
    let reason = `📊 Volatile market (${Math.round(volatility * 100)}% variation).`;
    
    if (historicalData?.priceAnalysis?.coefficientOfVariation > 0.25) {
      reason += ` Historical volatility confirms - consider timing your sale carefully.`;
    } else {
      reason += ` Consider timing your sale.`;
    }
    
    return { action: 'watch', reason };
  }
  
  // Stable market scenarios
  let reason = `⏳ Stable market. Current value offers ${Math.round(profitMargin * 100)}% potential profit.`;
  
  if (historicalTrend === 'stable' && historicalConfidence === 'high') {
    reason += ` Historical data shows consistent pricing.`;
  } else if (marketActivity === 'moderate') {
    reason += ` Moderate market activity - good for steady sales.`;
  }
  
  return { action: 'wait', reason };
}

// Helper function to calculate overall score
function calculateOverallScore({ percentageChange, profitMargin, sellScore, recencyScore, marketVolume, priceVolatility }) {
  const normalizedSellScore = sellScore / 100;
  const normalizedMarketVolume = Math.min(marketVolume / 10, 1); // Cap at 10 listings
  const volatilityScore = Math.max(0, 1 - priceVolatility); // Lower volatility is better
  
  const score = 
    (Math.max(0, percentageChange) * SCORE_WEIGHTS.PRICE_CHANGE) +
    (Math.max(0, profitMargin) * SCORE_WEIGHTS.PROFIT_MARGIN) +
    (normalizedSellScore * SCORE_WEIGHTS.SELL_SCORE) +
    (recencyScore * SCORE_WEIGHTS.RECENCY) +
    (normalizedMarketVolume * SCORE_WEIGHTS.MARKET_VOLUME);
  
  return Math.min(1, Math.max(0, score)); // Clamp between 0 and 1
}

// Helper function to calculate overall score with historical data
function calculateOverallScoreWithHistory({ percentageChange, profitMargin, sellScore, recencyScore, marketVolume, priceVolatility, historicalData, marketTrends }) {
  const normalizedSellScore = sellScore / 100;
  const normalizedMarketVolume = Math.min(marketVolume / 10, 1); // Cap at 10 listings
  const volatilityScore = Math.max(0, 1 - priceVolatility); // Lower volatility is better
  
  // Historical data scoring
  let historicalScore = 0.5; // Default neutral score
  let trendBonus = 0;
  let confidenceBonus = 0;
  let marketActivityBonus = 0;
  
  if (historicalData) {
    const trend = historicalData.marketTrends?.direction || 'unknown';
    const confidence = historicalData.marketTrends?.confidence || 'unknown';
    const marketActivity = historicalData.marketIndicators?.marketActivity || 'unknown';
    const demandLevel = historicalData.marketIndicators?.demandLevel || 'medium';
    const competitionLevel = historicalData.marketIndicators?.competitionLevel || 'medium';
    
    // Trend scoring
    if (trend === 'rising') {
      trendBonus = 0.2;
    } else if (trend === 'stable') {
      trendBonus = 0.1;
    } else if (trend === 'falling') {
      trendBonus = -0.1;
    }
    
    // Confidence scoring
    if (confidence === 'high') {
      confidenceBonus = 0.15;
    } else if (confidence === 'medium') {
      confidenceBonus = 0.1;
    }
    
    // Market activity scoring
    if (marketActivity === 'very_active') {
      marketActivityBonus = 0.15;
    } else if (marketActivity === 'active') {
      marketActivityBonus = 0.1;
    } else if (marketActivity === 'moderate') {
      marketActivityBonus = 0.05;
    }
    
    // Demand and competition scoring
    let demandCompetitionScore = 0;
    if (demandLevel === 'high' && competitionLevel === 'low') {
      demandCompetitionScore = 0.2; // Best scenario
    } else if (demandLevel === 'high') {
      demandCompetitionScore = 0.1;
    } else if (competitionLevel === 'low') {
      demandCompetitionScore = 0.05;
    }
    
    historicalScore = 0.5 + trendBonus + confidenceBonus + marketActivityBonus + demandCompetitionScore;
  }
  
  // Market trends scoring (if available)
  let marketTrendsScore = 0.5;
  if (marketTrends) {
    const trendDirection = marketTrends.trend?.direction || 'unknown';
    const trendConfidence = marketTrends.trend?.confidence || 'unknown';
    
    if (trendDirection === 'rising' && trendConfidence === 'high') {
      marketTrendsScore = 0.8;
    } else if (trendDirection === 'rising') {
      marketTrendsScore = 0.7;
    } else if (trendDirection === 'stable') {
      marketTrendsScore = 0.6;
    } else if (trendDirection === 'falling') {
      marketTrendsScore = 0.3;
    }
  }
  
  // Enhanced scoring with historical data
  const baseScore = 
    (Math.max(0, percentageChange) * SCORE_WEIGHTS.PRICE_CHANGE) +
    (Math.max(0, profitMargin) * SCORE_WEIGHTS.PROFIT_MARGIN) +
    (normalizedSellScore * SCORE_WEIGHTS.SELL_SCORE) +
    (recencyScore * SCORE_WEIGHTS.RECENCY) +
    (normalizedMarketVolume * SCORE_WEIGHTS.MARKET_VOLUME);
  
  // Add historical data influence (weighted average)
  const historicalWeight = 0.3; // 30% weight for historical data
  const finalScore = (baseScore * (1 - historicalWeight)) + (historicalScore * historicalWeight);
  
  return Math.min(1, Math.max(0, finalScore)); // Clamp between 0 and 1
}

// Enhanced function to get eBay data with historical analysis
async function getEbayDataWithHistory(userId, itemName, vendorName = null) {
  console.info(`[resaleFeedService] Getting eBay data with history for userId: ${userId}, itemName: "${itemName}", vendorName: "${vendorName}"`);
  
  try {
    // Use the enhanced search function that includes historical data and market trends
    const ebayData = await ebayApiService.searchItemsWithHistory(userId, itemName, 20, vendorName);
    
    if (!ebayData || !ebayData.currentListings || ebayData.currentListings.length === 0) {
      console.warn(`[resaleFeedService] No eBay data found for "${itemName}"${vendorName ? ` from ${vendorName}` : ''}`);
      return null;
    }

    console.info(`[resaleFeedService] Found ${ebayData.currentListings.length} current listings for "${itemName}"${vendorName ? ` from ${vendorName}` : ''}`);
    return ebayData;

  } catch (error) {
    console.error(`[resaleFeedService] Error getting eBay data with history for "${itemName}"${vendorName ? ` from ${vendorName}` : ''}:`, error.message);
    return null;
  }
}

// Helper function to check if all Google accounts are in IDLE status
async function checkGoogleAccountsIdle(userId) {
  const user = await prisma.user.findUnique({ 
    where: { id: userId },
    include: {
      googleAccounts: {
        select: {
          id: true,
          emailAddress: true,
          lastSyncStatus: true
        }
      }
    }
  });
  
  if (!user) {
    throw new Error(`User ${userId} not found.`);
  }

  if (user.googleAccounts.length === 0) {
    throw new Error('No connected Google accounts found. Please connect a Google account first.');
  }

  const nonIdleAccounts = user.googleAccounts.filter(account => account.lastSyncStatus !== 'IDLE' && !account.lastSyncStatus.includes('SUCCESS'));
  
  if (nonIdleAccounts.length > 0) {
    const accountEmails = nonIdleAccounts.map(account => account.emailAddress).join(', ');
    throw new Error(`Cannot proceed while Google accounts are syncing. Please wait for all accounts to finish syncing. Accounts: ${accountEmails}`);
  }

  return true;
}

/**
 * Enhanced helper functions
 */

/**
 * Process item using cached data (no fresh API calls)
 */
async function processItemWithCachedData(item, userId, feedPreferences, behaviorProfile) {
  try {
    logger.info(`Using cached data for item ${item.id}: ${item.itemName}`);
    
    // Use existing resale value and history for analysis
    const marketAnalysis = {
      isValid: item.resaleValue && item.resaleValue > 0,
      priceAnalysis: {
        median: item.resaleValue || item.itemPrice,
        volatility: item.resaleValueHistory?.length > 1 ? calculateVolatility(item.resaleValueHistory) : 0
      },
      marketScore: 0.6 // Default score for cached data
    };

    if (!marketAnalysis.isValid) {
      return null;
    }

    // Calculate personalized score
    const personalizedScore = userPersonalizationService.calculatePersonalizedScore(
      item,
      feedPreferences,
      behaviorProfile
    );

    // Categorize item for personalization
    const categoryTag = userPersonalizationService.categorizeItem(
      item.itemName,
      item.storeName || item.receipt?.vendorName || ''
    );

    // Generate timing recommendation based on cached data
    const timingRecommendation = {
      timing: 'neutral',
      confidence: 'medium',
      recommendation: {
        action: 'consider_selling',
        message: `Current value: $${item.resaleValue || item.itemPrice} (cached data)`,
        urgency: 'normal'
      },
      reasoning: 'Based on cached market data'
    };

    // Calculate enhanced overall score
    const enhancedScore = calculateEnhancedScore({
      personalizedScore,
      marketAnalysis,
      timingRecommendation,
      item,
      behaviorProfile
    });

    // Update timestamp but keep existing data
    await prisma.receiptItem.update({
      where: { id: item.id },
      data: { 
        resaleValueLastChecked: new Date(),
        personalizedScore,
        categoryTag
      }
    });

    // Return enhanced candidate with cached data
    const finalResaleValue = item.resaleValue || item.itemPrice;
    return {
      ...item,
      marketAnalysis,
      timingRecommendation,
      marketInsights: [],
      enhancedScore,
      personalizedScore,
      categoryTag,
      calculatedProfitMargin: finalResaleValue && item.itemPrice ? 
        (finalResaleValue - item.itemPrice) / item.itemPrice : 0,
      calculatedPercentageChange: 0 // No change when using cached data
    };

  } catch (error) {
    logger.error(`Error in cached processing for item ${item.id}: ${error.message}`);
    return null;
  }
}

/**
 * Process individual item with enhanced analysis
 */
async function processItemWithEnhancements(item, userId, feedPreferences, behaviorProfile, forceFreshData = false) {
  try {
    // Skip items that are too old
    const purchaseDate = item.receipt?.transactionDate || item.transactionDate;
    if (purchaseDate && (new Date() - purchaseDate) > MAX_DAYS_SINCE_PURCHASE * 24 * 60 * 60 * 1000) {
      await prisma.receiptItem.update({
        where: { id: item.id },
        data: { resaleValueLastChecked: new Date() }
      });
      return null;
    }

    // Enhanced market analysis using market intelligence service
    const marketAnalysis = await marketIntelligenceService.analyzeMarketTrends(
      item.itemName,
      item.receipt?.vendorName || item.storeName,
      userId
    );

    if (!marketAnalysis.isValid) {
      await prisma.receiptItem.update({
        where: { id: item.id },
        data: { resaleValueLastChecked: new Date() }
      });
      return null;
    }

    // Calculate personalized score
    const personalizedScore = userPersonalizationService.calculatePersonalizedScore(
      item,
      feedPreferences,
      behaviorProfile
    );

    // Categorize item for personalization
    const categoryTag = userPersonalizationService.categorizeItem(
      item.itemName,
      item.storeName || item.receipt?.vendorName || ''
    );

    // Generate smart timing recommendation
    const timingRecommendation = marketIntelligenceService.generateTimingRecommendation(
      marketAnalysis,
      personalizedScore,
      feedPreferences
    );

    // Generate market insights
    const marketInsights = marketIntelligenceService.generateMarketInsights(marketAnalysis);

    // Calculate enhanced overall score
    const enhancedScore = calculateEnhancedScore({
      personalizedScore,
      marketAnalysis,
      timingRecommendation,
      item,
      behaviorProfile
    });

    // Create enhanced history entry
    const enhancedHistoryEntry = {
      date: new Date().toISOString().split('T')[0],
      value: marketAnalysis.priceAnalysis?.median || item.resaleValue || item.itemPrice,
      marketScore: marketAnalysis.marketScore || 0,
      personalizedScore,
      enhancedScore,
      timingRecommendation: timingRecommendation?.timing || 'neutral',
      marketInsights: marketInsights?.length || 0,
      categoryTag
    };

    // Update item with enhanced data
    const updatedHistory = Array.isArray(item.resaleValueHistory) ? [...item.resaleValueHistory] : [];
    updatedHistory.push(enhancedHistoryEntry);
    if (updatedHistory.length > 20) { // Keep more history for analysis
      updatedHistory.splice(0, updatedHistory.length - 20);
    }

    const itemUpdateData = {
      resaleValue: marketAnalysis.priceAnalysis?.median || item.resaleValue || item.itemPrice,
      resaleValueLastChecked: new Date(),
      resaleValueHistory: updatedHistory,
      personalizedScore,
      categoryTag,
      userEngagement: personalizedScore, // Store engagement score
      lastUserInteraction: new Date(),
      feedInteractions: {
        ...(item.feedInteractions || {}),
        lastAnalyzed: new Date(),
        enhancedAnalysisCount: ((item.feedInteractions?.enhancedAnalysisCount) || 0) + 1
      }
    };

    // Update the item in database
    await prisma.receiptItem.update({
      where: { id: item.id },
      data: itemUpdateData
    });

    // Return enhanced candidate
    const finalResaleValue = marketAnalysis.priceAnalysis?.median || item.resaleValue || item.itemPrice;
    return {
      ...item,
      ...itemUpdateData,
      marketAnalysis,
      timingRecommendation,
      marketInsights,
      enhancedScore,
      calculatedProfitMargin: finalResaleValue && item.itemPrice ? 
        (finalResaleValue - item.itemPrice) / item.itemPrice : 0,
      calculatedPercentageChange: item.resaleValue && finalResaleValue ? 
        (finalResaleValue - item.resaleValue) / item.resaleValue : 0.1
    };

  } catch (error) {
    logger.error(`Error in enhanced processing for item ${item.id}: ${error.message}`);
    return null;
  }
}

/**
 * Calculate enhanced scoring with multiple factors
 */
function calculateEnhancedScore({ personalizedScore, marketAnalysis, timingRecommendation, item, behaviorProfile }) {
  const weights = ENHANCED_SCORE_WEIGHTS;
  
  // Personalization score (0-3)
  const personalizedComponent = Math.min(personalizedScore / 3, 1) * weights.PERSONALIZATION;
  
  // Market intelligence score (0-1)
  const marketComponent = marketAnalysis.marketScore * weights.MARKET_INTELLIGENCE;
  
  // Profit potential score
  const resaleValue = marketAnalysis.priceAnalysis?.median || item.resaleValue || item.itemPrice;
  const profitMargin = resaleValue && item.itemPrice ? (resaleValue - item.itemPrice) / item.itemPrice : 0;
  const profitComponent = Math.min(Math.max(profitMargin / 1.0, 0), 1) * weights.PROFIT_POTENTIAL;
  
  // Engagement score based on category preference
  const categoryEngagement = behaviorProfile?.categoryPreferences?.[item.categoryTag || 'other'] || 0.5;
  const engagementComponent = Math.min(categoryEngagement, 1) * weights.ENGAGEMENT;
  
  // Recency score
  const daysSincePurchase = item.receipt?.transactionDate ? 
    (new Date() - item.receipt.transactionDate) / (24 * 60 * 60 * 1000) : 30;
  const recencyComponent = Math.max(0, 1 - (daysSincePurchase / 365)) * weights.RECENCY;
  
  // Timing bonus
  const timingBonus = getTimingBonus(timingRecommendation.timing);
  
  const finalScore = (
    personalizedComponent + 
    marketComponent + 
    profitComponent + 
    engagementComponent + 
    recencyComponent
  ) * timingBonus;
  
  return Math.round(finalScore * 1000) / 1000; // Round to 3 decimals
}

/**
 * Get timing bonus multiplier
 */
function getTimingBonus(timing) {
  const bonuses = {
    excellent: 1.3,
    good: 1.1,
    urgent: 1.4,
    neutral: 1.0,
    poor: 0.8
  };
  return bonuses[timing] || 1.0;
}

/**
 * Enhanced candidate selection - return ALL candidates sorted by score
 */
function selectEnhancedCandidates(candidates, feedPreferences, behaviorProfile) {
  // Sort by enhanced score and return ALL candidates (no limits or diversity filters)
  candidates.sort((a, b) => b.enhancedScore - a.enhancedScore);
  
  // Return all candidates up to the limit (which is now effectively unlimited)
  return candidates.slice(0, RESALE_FEED_CANDIDATE_LIMIT);
}

/**
 * Mark item as enhanced candidate with rich data
 */
async function markItemAsEnhancedCandidate(candidate, userId) {
  const recommendationData = {
    action: candidate.timingRecommendation.recommendation.action,
    message: candidate.timingRecommendation.recommendation.message,
    urgency: candidate.timingRecommendation.recommendation.urgency,
    reasoning: candidate.timingRecommendation.reasoning,
    confidence: candidate.timingRecommendation.confidence,
    marketScore: candidate.marketAnalysis.marketScore,
    personalizedScore: candidate.personalizedScore,
    enhancedScore: candidate.enhancedScore
  };

  await prisma.receiptItem.update({
    where: { id: candidate.id },
    data: {
      lastFeedCandidateAt: new Date(),
      recommendedAction: candidate.timingRecommendation.recommendation.action,
      lastFeedReason: JSON.stringify(recommendationData)
    }
  });
}

/**
 * Generate enhanced feed insights
 */
async function generateEnhancedFeedInsights(userProfile, candidates, processingSummary) {
  const insights = [];
  const { feedPreferences, behaviorProfile, achievements } = userProfile;
  
  // Performance insights
  if (candidates.length > 0) {
    const avgEnhancedScore = candidates.reduce((sum, c) => sum + c.enhancedScore, 0) / candidates.length;
    const highValueItems = candidates.filter(c => c.calculatedProfitMargin > 0.5).length;
    const urgentItems = candidates.filter(c => c.timingRecommendation.timing === 'urgent').length;
    
    insights.push({
      type: 'feed_quality',
      title: '📊 Feed Quality Score',
      description: `Your feed scored ${(avgEnhancedScore * 100).toFixed(0)}/100 with ${highValueItems} high-value opportunities`,
      score: avgEnhancedScore,
      actionable: false
    });
    
    if (urgentItems > 0) {
      insights.push({
        type: 'urgent',
        title: '⚡ Time Sensitive!',
        description: `${urgentItems} items have declining prices - act quickly for maximum profit`,
        actionable: true,
        action: 'prioritize_urgent_items'
      });
    }
  }
  
  // Personalized insights based on user behavior
  const personalizedInsights = userPersonalizationService.generatePersonalizedInsights(
    userProfile,
    [], // We'll get sold items separately
    candidates
  );
  insights.push(...personalizedInsights);
  
  // Market insights
  const marketInsights = candidates.flatMap(c => c.marketInsights || [])
    .slice(0, 3); // Top 3 market insights
  insights.push(...marketInsights);
  
  // Gamification insights
  if (achievements && achievements.level > 1) {
    insights.push({
      type: 'achievement',
      title: `🏆 Level ${achievements.level} Seller!`,
      description: `You've earned ${achievements.points} points. Keep growing your resale success!`,
      actionable: false
    });
  }
  
  return insights;
}

/**
 * Generate empty feed insights for users with no items
 */
function generateEmptyFeedInsights(userProfile) {
  return [
    {
      type: 'onboarding',
      title: '🚀 Build Your Inventory',
      description: 'Add more receipts to discover profitable resale opportunities!',
      actionable: true,
      action: 'add_more_receipts'
    },
    {
      type: 'tip',
      title: '💡 Pro Tip',
      description: 'Items from electronics and clothing categories often have the best resale potential.',
      actionable: false
    }
  ];
}

/**
 * Generate personalized recommendations
 */
function generatePersonalizedRecommendations(userProfile, candidates) {
  const recommendations = [];
  
  // Category recommendations based on user success
  const categoryStats = userProfile.behaviorProfile?.categoryPreferences || {};
  const topCategory = Object.entries(categoryStats)
    .sort((a, b) => b[1] - a[1])[0];
  
  if (topCategory && topCategory[1] > 0.7) {
    recommendations.push({
      type: 'category_focus',
      title: `Focus on ${topCategory[0]}`,
      description: `You've shown great success with ${topCategory[0]} items. Look for more in this category!`,
      priority: 'high'
    });
  }
  
  // Timing recommendations
  const urgentCount = candidates.filter(c => c.timingRecommendation?.timing === 'urgent').length;
  const excellentCount = candidates.filter(c => c.timingRecommendation?.timing === 'excellent').length;
  
  if (urgentCount > 0) {
    recommendations.push({
      type: 'timing',
      title: 'Act on Price Drops',
      description: `${urgentCount} items are seeing price declines. List them soon to maximize value.`,
      priority: 'urgent'
    });
  }
  
  if (excellentCount > 0) {
    recommendations.push({
      type: 'timing',
      title: 'Perfect Market Timing',
      description: `${excellentCount} items have excellent market conditions. Great time to sell!`,
      priority: 'high'
    });
  }
  
  return recommendations;
}

/**
 * Helper functions from enhanced service
 */
async function getUserProfile(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      feedPreferences: true,
      behaviorProfile: true,
      achievements: true,
      sellingStats: true
    }
  });
  
  return user || {};
}

async function getItemsToConsider(userId, feedPreferences) {
  // Process ALL eligible items every refresh for complete curation
  return prisma.receiptItem.findMany({
    where: {
      userId: userId,
      status: { in: ['pending', 'vault', 'swiped_right'] },
      itemPrice: { gte: MIN_RESALE_VALUE },
      // Removed time-based filters - process ALL items every refresh
    },
    include: {
      receipt: {
        select: {
          transactionDate: true,
          vendorName: true,
        }
      }
    },
    orderBy: [
      { personalizedScore: 'desc' }, // Prioritize by personalization
      { resaleValueLastChecked: 'asc' },
      { itemPrice: 'desc' }
    ],
    // Removed take limit - process ALL items for complete curation
  });
}

async function updateUserFeedRefresh(userId, additionalData = {}) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      lastFeedRefresh: new Date(),
      ...additionalData
    }
  });
}

function calculateEngagementScore(behaviorProfile) {
  if (!behaviorProfile || !behaviorProfile.interactionPatterns) {
    return 50; // Default score
  }
  
  const patterns = behaviorProfile.interactionPatterns;
  
  let score = 0;
  
  // Base activity score
  score += Math.min((patterns.feedViews || 0) * 0.1, 10);
  score += Math.min((patterns.itemClicks || 0) * 0.5, 20);
  score += Math.min((patterns.swipeRights || 0) * 2, 30);
  score += Math.min((patterns.actualSales || 0) * 10, 40);
  
  // Conversion rates (higher rates = higher score)
  if (patterns.feedViews > 0) {
    const clickRate = (patterns.itemClicks || 0) / patterns.feedViews;
    score += clickRate * 10;
  }
  
  if (patterns.swipeRights > 0) {
    const saleRate = (patterns.actualSales || 0) / patterns.swipeRights;
    score += saleRate * 20;
  }
  
  return Math.min(score, 100);
}

module.exports = {
  refreshResaleFeedForUser,
  getEbayDataWithHistory,
  checkGoogleAccountsIdle,
  processItemWithEnhancements,
  processItemWithCachedData,
  calculateEnhancedScore,
  selectEnhancedCandidates,
  generateEnhancedFeedInsights
};
