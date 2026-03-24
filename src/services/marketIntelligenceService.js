const prisma = require('../lib/prisma');
const ebayApiService = require('./ebayApiService');
const { createLogger } = require('../utils/logger');

const logger = createLogger('MARKET_INTELLIGENCE_SERVICE');

// Market trend analysis constants
const TREND_ANALYSIS_WINDOW = 30; // days
const SEASONAL_ANALYSIS_WINDOW = 365; // days
const MARKET_VOLATILITY_THRESHOLD = 0.25;
const HIGH_DEMAND_THRESHOLD = 0.7;
const LOW_COMPETITION_THRESHOLD = 0.3;

/**
 * Analyze market trends for an item
 */
async function analyzeMarketTrends(itemName, vendorName, userId) {
  try {
    logger.debug(`Analyzing market trends for "${itemName}" from ${vendorName}`);
    
    // Get fresh eBay data with historical analysis
    const ebayData = await ebayApiService.searchItemsWithHistory(userId, itemName, 20, vendorName);
    
    if (!ebayData || !ebayData.currentListings) {
      return {
        isValid: false,
        reason: 'No market data available'
      };
    }
    
    const currentListings = ebayData.currentListings;
    const historicalData = ebayData.historicalData;
    const marketTrends = ebayData.marketTrends;
    
    // Enhanced price analysis
    const priceAnalysis = analyzeCurrentPricing(currentListings);
    
    // Demand analysis
    const demandAnalysis = analyzeDemandSignals(currentListings, historicalData);
    
    // Competition analysis
    const competitionAnalysis = analyzeCompetition(currentListings, historicalData);
    
    // Trend prediction
    const trendPrediction = predictMarketTrend(historicalData, marketTrends);
    
    // Seasonal analysis
    const seasonalAnalysis = analyzeSeasonality(itemName, historicalData);
    
    return {
      isValid: true,
      priceAnalysis,
      demandAnalysis,
      competitionAnalysis,
      trendPrediction,
      seasonalAnalysis,
      marketScore: calculateMarketScore(priceAnalysis, demandAnalysis, competitionAnalysis),
      lastUpdated: new Date()
    };
    
  } catch (error) {
    logger.error(`Error analyzing market trends for "${itemName}": ${error.message}`);
    return {
      isValid: false,
      reason: error.message
    };
  }
}

/**
 * Analyze current pricing from listings
 */
function analyzeCurrentPricing(listings) {
  const prices = listings.map(listing => listing.price).filter(p => p > 0);
  
  if (prices.length === 0) {
    return { isValid: false };
  }
  
  prices.sort((a, b) => a - b);
  
  const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  const median = prices[Math.floor(prices.length / 2)];
  const min = prices[0];
  const max = prices[prices.length - 1];
  const q1 = prices[Math.floor(prices.length * 0.25)];
  const q3 = prices[Math.floor(prices.length * 0.75)];
  
  // Calculate coefficient of variation for volatility
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
  const standardDeviation = Math.sqrt(variance);
  const coefficientOfVariation = standardDeviation / mean;
  
  return {
    isValid: true,
    mean: Math.round(mean * 100) / 100,
    median: Math.round(median * 100) / 100,
    min,
    max,
    q1,
    q3,
    standardDeviation: Math.round(standardDeviation * 100) / 100,
    volatility: coefficientOfVariation,
    priceRange: {
      conservative: Math.round(q1 * 100) / 100,
      aggressive: Math.round(q3 * 100) / 100
    },
    marketSize: prices.length
  };
}

/**
 * Analyze demand signals
 */
function analyzeDemandSignals(currentListings, historicalData) {
  const currentSupply = currentListings.length;
  const recentSales = historicalData?.totalQuantitySold || 0;
  const totalSoldItems = historicalData?.totalSoldItems || 0;
  
  // Calculate demand indicators
  const salesVelocity = totalSoldItems > 0 ? recentSales / Math.max(totalSoldItems, 1) : 0;
  const supplyDemandRatio = currentSupply / Math.max(recentSales, 1);
  
  let demandLevel = 'unknown';
  let demandScore = 0.5;
  
  if (salesVelocity > 0.8 && supplyDemandRatio < 2) {
    demandLevel = 'high';
    demandScore = 0.9;
  } else if (salesVelocity > 0.5 && supplyDemandRatio < 5) {
    demandLevel = 'medium';
    demandScore = 0.7;
  } else if (salesVelocity > 0.2) {
    demandLevel = 'low';
    demandScore = 0.3;
  } else {
    demandLevel = 'very_low';
    demandScore = 0.1;
  }
  
  return {
    level: demandLevel,
    score: demandScore,
    indicators: {
      salesVelocity: Math.round(salesVelocity * 100) / 100,
      supplyDemandRatio: Math.round(supplyDemandRatio * 100) / 100,
      currentSupply,
      recentSales,
      totalSoldItems
    }
  };
}

/**
 * Analyze competition levels
 */
function analyzeCompetition(currentListings, historicalData) {
  const activeListings = currentListings.length;
  const averageConditions = analyzeListingConditions(currentListings);
  const priceDistribution = analyzePriceDistribution(currentListings);
  
  let competitionLevel = 'medium';
  let competitionScore = 0.5;
  
  if (activeListings < 10 && priceDistribution.concentration > 0.7) {
    competitionLevel = 'low';
    competitionScore = 0.2;
  } else if (activeListings < 25 && priceDistribution.concentration > 0.5) {
    competitionLevel = 'medium';
    competitionScore = 0.5;
  } else if (activeListings > 50) {
    competitionLevel = 'high';
    competitionScore = 0.8;
  } else {
    competitionLevel = 'very_high';
    competitionScore = 0.9;
  }
  
  return {
    level: competitionLevel,
    score: competitionScore,
    indicators: {
      activeListings,
      averageConditions,
      priceDistribution,
      marketSaturation: Math.min(activeListings / 50, 1.0)
    }
  };
}

/**
 * Analyze listing conditions
 */
function analyzeListingConditions(listings) {
  const conditions = {};
  listings.forEach(listing => {
    const condition = listing.condition || 'unknown';
    conditions[condition] = (conditions[condition] || 0) + 1;
  });
  
  return conditions;
}

/**
 * Analyze price distribution
 */
function analyzePriceDistribution(listings) {
  const prices = listings.map(l => l.price).filter(p => p > 0);
  const totalListings = prices.length;
  
  if (totalListings === 0) {
    return { concentration: 0, buckets: {} };
  }
  
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min;
  const bucketSize = range / 5;
  
  const buckets = {};
  let maxBucketCount = 0;
  
  prices.forEach(price => {
    const bucketIndex = Math.min(Math.floor((price - min) / bucketSize), 4);
    const bucketKey = `bucket_${bucketIndex}`;
    buckets[bucketKey] = (buckets[bucketKey] || 0) + 1;
    maxBucketCount = Math.max(maxBucketCount, buckets[bucketKey]);
  });
  
  const concentration = maxBucketCount / totalListings;
  
  return {
    concentration,
    buckets,
    range,
    bucketSize: Math.round(bucketSize * 100) / 100
  };
}

/**
 * Predict market trend direction
 */
function predictMarketTrend(historicalData, marketTrends) {
  if (!historicalData || !marketTrends) {
    return {
      direction: 'unknown',
      confidence: 'low',
      prediction: 'insufficient_data'
    };
  }
  
  const trendDirection = marketTrends.direction || 'stable';
  const trendConfidence = marketTrends.confidence || 'low';
  const trendPercentage = marketTrends.percentageChange || 0;
  
  let prediction = 'stable';
  let confidence = 'medium';
  
  if (Math.abs(trendPercentage) > 15) {
    confidence = 'high';
    if (trendPercentage > 15) {
      prediction = 'rising_strong';
    } else {
      prediction = 'falling_strong';
    }
  } else if (Math.abs(trendPercentage) > 8) {
    confidence = 'medium';
    if (trendPercentage > 8) {
      prediction = 'rising_moderate';
    } else {
      prediction = 'falling_moderate';
    }
  } else if (Math.abs(trendPercentage) > 3) {
    confidence = 'low';
    if (trendPercentage > 3) {
      prediction = 'rising_slight';
    } else {
      prediction = 'falling_slight';
    }
  }
  
  return {
    direction: trendDirection,
    confidence: trendConfidence,
    prediction,
    percentageChange: trendPercentage,
    timeframe: '30_days'
  };
}

/**
 * Analyze seasonality patterns
 */
function analyzeSeasonality(itemName, historicalData) {
  const currentMonth = new Date().getMonth() + 1;
  const currentSeason = getSeason(currentMonth);
  
  // Basic seasonal analysis based on item category
  const seasonalPattern = getSeasonalPattern(itemName, currentSeason);
  
  return {
    currentSeason,
    currentMonth,
    pattern: seasonalPattern,
    recommendation: generateSeasonalRecommendation(seasonalPattern, currentSeason)
  };
}

/**
 * Get current season
 */
function getSeason(month) {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'fall';
  return 'winter';
}

/**
 * Get seasonal pattern for item type
 */
function getSeasonalPattern(itemName, currentSeason) {
  const name = itemName.toLowerCase();
  
  // Holiday items
  if (name.includes('christmas') || name.includes('holiday')) {
    return {
      type: 'holiday',
      peakSeason: 'winter',
      currentSeasonMultiplier: currentSeason === 'winter' ? 1.5 : 
                               currentSeason === 'fall' ? 1.2 : 0.7
    };
  }
  
  // Summer items
  if (name.match(/\b(beach|pool|swim|summer|outdoor|camping|bbq)\b/)) {
    return {
      type: 'summer',
      peakSeason: 'summer',
      currentSeasonMultiplier: currentSeason === 'summer' ? 1.4 : 
                               currentSeason === 'spring' ? 1.1 : 0.8
    };
  }
  
  // Winter items
  if (name.match(/\b(winter|snow|ski|coat|boots|heater)\b/)) {
    return {
      type: 'winter',
      peakSeason: 'winter',
      currentSeasonMultiplier: currentSeason === 'winter' ? 1.3 : 
                               currentSeason === 'fall' ? 1.1 : 0.9
    };
  }
  
  // Back to school items
  if (name.match(/\b(book|backpack|school|student|textbook)\b/)) {
    return {
      type: 'back_to_school',
      peakSeason: 'fall',
      currentSeasonMultiplier: currentSeason === 'fall' ? 1.3 : 
                               currentSeason === 'summer' ? 1.1 : 0.9
    };
  }
  
  // Electronics (generally stable but peak during holidays)
  if (name.match(/\b(iphone|laptop|tablet|gaming|console)\b/)) {
    return {
      type: 'electronics',
      peakSeason: 'winter',
      currentSeasonMultiplier: currentSeason === 'winter' ? 1.2 : 1.0
    };
  }
  
  return {
    type: 'general',
    peakSeason: 'none',
    currentSeasonMultiplier: 1.0
  };
}

/**
 * Generate seasonal recommendation
 */
function generateSeasonalRecommendation(seasonalPattern, currentSeason) {
  const multiplier = seasonalPattern.currentSeasonMultiplier;
  
  if (multiplier > 1.2) {
    return {
      timing: 'excellent',
      message: `Perfect timing! ${seasonalPattern.type} items are in peak demand during ${currentSeason}.`,
      action: 'sell_soon'
    };
  } else if (multiplier > 1.0) {
    return {
      timing: 'good',
      message: `Good timing for ${seasonalPattern.type} items. Moderate seasonal boost expected.`,
      action: 'consider_selling'
    };
  } else if (multiplier < 0.8) {
    return {
      timing: 'poor',
      message: `Off-season for ${seasonalPattern.type} items. Consider waiting for ${seasonalPattern.peakSeason}.`,
      action: 'wait_for_season'
    };
  } else {
    return {
      timing: 'neutral',
      message: `Seasonal timing is neutral for this item type.`,
      action: 'timing_not_critical'
    };
  }
}

/**
 * Calculate overall market score
 */
function calculateMarketScore(priceAnalysis, demandAnalysis, competitionAnalysis) {
  if (!priceAnalysis.isValid) return 0;
  
  const priceStabilityScore = 1 - Math.min(priceAnalysis.volatility, 1.0);
  const demandScore = demandAnalysis.score;
  const competitionScore = 1 - competitionAnalysis.score; // Lower competition = higher score
  
  // Weighted average
  const overallScore = (
    priceStabilityScore * 0.3 +
    demandScore * 0.4 +
    competitionScore * 0.3
  );
  
  return Math.round(overallScore * 100) / 100;
}

/**
 * Generate smart timing recommendation
 */
function generateTimingRecommendation(marketAnalysis, personalizedScore, userPreferences) {
  const marketScore = marketAnalysis.marketScore;
  const demandLevel = marketAnalysis.demandAnalysis.level;
  const competitionLevel = marketAnalysis.competitionAnalysis.level;
  const trendPrediction = marketAnalysis.trendPrediction.prediction;
  const seasonalTiming = marketAnalysis.seasonalAnalysis.recommendation.timing;
  
  let timing = 'neutral';
  let confidence = 'medium';
  let reasoning = [];
  
  // High market score with good demand
  if (marketScore > 0.7 && ['high', 'medium'].includes(demandLevel)) {
    timing = 'excellent';
    confidence = 'high';
    reasoning.push('Strong market conditions with good demand');
  }
  
  // Low competition advantage
  if (competitionLevel === 'low') {
    timing = timing === 'excellent' ? 'excellent' : 'good';
    reasoning.push('Low competition environment');
  }
  
  // Trend considerations
  if (['rising_strong', 'rising_moderate'].includes(trendPrediction)) {
    timing = timing === 'poor' ? 'neutral' : 'good';
    reasoning.push('Positive price trend detected');
  } else if (['falling_strong', 'falling_moderate'].includes(trendPrediction)) {
    timing = 'urgent';
    reasoning.push('Declining price trend - act quickly');
  }
  
  // Seasonal considerations
  if (seasonalTiming === 'excellent') {
    timing = timing === 'poor' ? 'neutral' : 'good';
    reasoning.push('Excellent seasonal timing');
  } else if (seasonalTiming === 'poor') {
    timing = timing === 'excellent' ? 'good' : 'poor';
    reasoning.push('Off-season timing');
  }
  
  // User preference adjustments
  if (userPreferences?.feedStyle?.preferQuickSales && timing === 'neutral') {
    timing = 'good';
    reasoning.push('Quick sale preference applied');
  }
  
  return {
    timing,
    confidence,
    reasoning: reasoning.join('. '),
    marketScore,
    recommendation: generateActionRecommendation(timing, confidence)
  };
}

/**
 * Generate action recommendation based on timing
 */
function generateActionRecommendation(timing, confidence) {
  const recommendations = {
    excellent: {
      action: 'sell_now',
      message: '🔥 Excellent timing! Market conditions are optimal.',
      urgency: 'high'
    },
    good: {
      action: 'consider_selling',
      message: '👍 Good timing. Market conditions are favorable.',
      urgency: 'medium'
    },
    urgent: {
      action: 'sell_immediately',
      message: '⚡ Urgent! Prices are declining - sell quickly.',
      urgency: 'critical'
    },
    neutral: {
      action: 'monitor',
      message: '👀 Neutral timing. Monitor for better conditions.',
      urgency: 'low'
    },
    poor: {
      action: 'wait',
      message: '⏳ Poor timing. Wait for better market conditions.',
      urgency: 'none'
    }
  };
  
  return recommendations[timing] || recommendations.neutral;
}

/**
 * Generate market insights summary
 */
function generateMarketInsights(marketAnalysis) {
  const insights = [];
  
  const { priceAnalysis, demandAnalysis, competitionAnalysis, trendPrediction, seasonalAnalysis } = marketAnalysis;
  
  // Price insights
  if (priceAnalysis.volatility > MARKET_VOLATILITY_THRESHOLD) {
    insights.push({
      type: 'warning',
      title: '⚠️ High Price Volatility',
      description: `Prices vary significantly (${Math.round(priceAnalysis.volatility * 100)}% variation). Consider pricing strategy carefully.`
    });
  } else {
    insights.push({
      type: 'info',
      title: '📊 Stable Pricing',
      description: `Price range is stable ($${priceAnalysis.q1} - $${priceAnalysis.q3}). Good predictability for selling.`
    });
  }
  
  // Demand insights
  if (demandAnalysis.level === 'high') {
    insights.push({
      type: 'success',
      title: '🚀 High Demand Detected',
      description: `Strong buyer interest with ${demandAnalysis.indicators.recentSales} recent sales. Great opportunity!`
    });
  } else if (demandAnalysis.level === 'low') {
    insights.push({
      type: 'caution',
      title: '📉 Low Demand',
      description: 'Limited buyer interest. Consider competitive pricing or wait for better timing.'
    });
  }
  
  // Competition insights
  if (competitionAnalysis.level === 'low') {
    insights.push({
      type: 'opportunity',
      title: '🎯 Low Competition',
      description: `Only ${competitionAnalysis.indicators.activeListings} active listings. Great opportunity for premium pricing!`
    });
  } else if (competitionAnalysis.level === 'high') {
    insights.push({
      type: 'challenge',
      title: '⚔️ High Competition',
      description: `${competitionAnalysis.indicators.activeListings} active listings. Competitive pricing and good photos will be key.`
    });
  }
  
  // Trend insights
  if (trendPrediction.prediction.includes('rising')) {
    insights.push({
      type: 'trend',
      title: '📈 Rising Trend',
      description: `Prices trending upward (${trendPrediction.percentageChange.toFixed(1)}%). Consider waiting for peak or sell soon.`
    });
  } else if (trendPrediction.prediction.includes('falling')) {
    insights.push({
      type: 'urgent',
      title: '📉 Declining Trend',
      description: `Prices falling (${trendPrediction.percentageChange.toFixed(1)}%). Consider selling quickly to maximize value.`
    });
  }
  
  return insights;
}

module.exports = {
  analyzeMarketTrends,
  generateTimingRecommendation,
  generateMarketInsights,
  calculateMarketScore
}; 