const prisma = require('../lib/prisma');
const { createLogger } = require('../utils/logger');

const logger = createLogger('USER_PERSONALIZATION_SERVICE');

// Default user preferences structure
const DEFAULT_PREFERENCES = {
  categories: {
    electronics: { weight: 1.0, interested: true },
    clothing: { weight: 1.0, interested: true },
    accessories: { weight: 1.0, interested: true },
    home: { weight: 1.0, interested: true },
    books: { weight: 1.0, interested: true },
    toys: { weight: 1.0, interested: true },
    sports: { weight: 1.0, interested: true },
    other: { weight: 1.0, interested: true }
  },
  priceRanges: {
    under25: { weight: 1.0, interested: true },
    range25to50: { weight: 1.0, interested: true },
    range50to100: { weight: 1.0, interested: true },
    range100to250: { weight: 1.0, interested: true },
    over250: { weight: 1.0, interested: true }
  },
  profitMargins: {
    low: { threshold: 20, weight: 0.7 },
    medium: { threshold: 50, weight: 1.0 },
    high: { threshold: 100, weight: 1.3 }
  },
  feedStyle: {
    riskTolerance: 'medium', // low, medium, high
    preferQuickSales: false,
    preferHighValue: false,
    showEducationalContent: true
  }
};

// Default behavior profile structure
const DEFAULT_BEHAVIOR_PROFILE = {
  sellingFrequency: 'new', // new, occasional, regular, frequent
  averageItemPrice: 0,
  averageProfitMargin: 0,
  successfulSales: 0,
  totalItemsConsidered: 0,
  categoryPreferences: {},
  interactionPatterns: {
    avgTimeInFeed: 0,
    clickThroughRate: 0,
    swipeRightRate: 0,
    actualSaleRate: 0
  },
  lastUpdated: new Date()
};

// Achievement definitions
const ACHIEVEMENTS = {
  firstSale: { name: 'First Sale!', description: 'Sold your first item', points: 100 },
  profitable: { name: 'Profitable', description: 'Made $100+ in profit', points: 200 },
  frequent: { name: 'Frequent Seller', description: 'Sold 10+ items', points: 300 },
  highValue: { name: 'High Roller', description: 'Sold an item for $250+', points: 250 },
  streakSeller: { name: 'Streak Seller', description: '5 consecutive profitable sales', points: 400 },
  categoryExpert: { name: 'Category Expert', description: 'Dominated a specific category', points: 300 }
};

/**
 * Initialize user personalization data if not exists
 */
async function initializeUserPersonalization(userId) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { feedPreferences: true, behaviorProfile: true, achievements: true }
    });

    if (!user) throw new Error('User not found');

    const updates = {};
    
    if (!user.feedPreferences) {
      updates.feedPreferences = DEFAULT_PREFERENCES;
    }
    
    if (!user.behaviorProfile) {
      updates.behaviorProfile = DEFAULT_BEHAVIOR_PROFILE;
    }
    
    if (!user.achievements) {
      updates.achievements = { earned: [], points: 0, level: 1 };
    }

    if (Object.keys(updates).length > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: updates
      });
      logger.info(`Initialized personalization data for user ${userId}`);
    }

    return true;
  } catch (error) {
    logger.error(`Error initializing personalization for user ${userId}: ${error.message}`);
    throw error;
  }
}

/**
 * Categorize an item based on its name and store
 */
function categorizeItem(itemName, storeName = '') {
  const name = (itemName || '').toLowerCase();
  const store = (storeName || '').toLowerCase();
  
  // Electronics patterns
  if (name.match(/\b(iphone|samsung|phone|laptop|computer|tablet|headphones|airpods|speaker|camera|tv|monitor|gaming|console|xbox|playstation|nintendo)\b/)) {
    return 'electronics';
  }
  
  // Clothing patterns
  if (name.match(/\b(shirt|pants|dress|shoes|sneakers|jacket|coat|jeans|sweater|hoodie|clothing|apparel)\b/) ||
      store.match(/\b(nike|adidas|zara|h&m|uniqlo|target|walmart)\b/)) {
    return 'clothing';
  }
  
  // Accessories patterns
  if (name.match(/\b(watch|jewelry|bag|wallet|sunglasses|belt|hat|scarf|keychain)\b/)) {
    return 'accessories';
  }
  
  // Home patterns
  if (name.match(/\b(furniture|lamp|decor|kitchen|cookware|bedding|pillow|curtain|rug)\b/) ||
      store.match(/\b(ikea|home depot|lowes|bed bath)\b/)) {
    return 'home';
  }
  
  // Books patterns
  if (name.match(/\b(book|textbook|novel|manual|guide)\b/) ||
      store.match(/\b(amazon|barnes|bookstore)\b/)) {
    return 'books';
  }
  
  // Toys patterns
  if (name.match(/\b(toy|lego|doll|action figure|board game|puzzle)\b/) ||
      store.match(/\b(toys r us|target)\b/)) {
    return 'toys';
  }
  
  // Sports patterns
  if (name.match(/\b(sports|fitness|gym|exercise|ball|equipment|bike|skateboard)\b/) ||
      store.match(/\b(dick\'s|sports authority|nike|adidas)\b/)) {
    return 'sports';
  }
  
  return 'other';
}

/**
 * Calculate personalized score for an item based on user preferences
 */
function calculatePersonalizedScore(item, userPreferences, behaviorProfile) {
  const category = item.categoryTag || categorizeItem(item.itemName || '', item.storeName || '');
  const priceRange = getPriceRange(item.itemPrice || 0);
  const profitMargin = item.resaleValue && item.itemPrice ? 
    ((item.resaleValue - item.itemPrice) / item.itemPrice) * 100 : 0;
  
  let score = 1.0;
  
  // Category preference weight
  const categoryPref = userPreferences.categories[category];
  if (categoryPref) {
    score *= categoryPref.interested ? categoryPref.weight : 0.3;
  }
  
  // Price range preference weight
  const pricePref = userPreferences.priceRanges[priceRange];
  if (pricePref) {
    score *= pricePref.interested ? pricePref.weight : 0.5;
  }
  
  // Profit margin bonus
  const profitPrefs = userPreferences.profitMargins;
  if (profitMargin >= profitPrefs.high.threshold) {
    score *= profitPrefs.high.weight;
  } else if (profitMargin >= profitPrefs.medium.threshold) {
    score *= profitPrefs.medium.weight;
  } else if (profitMargin >= profitPrefs.low.threshold) {
    score *= profitPrefs.low.weight;
  } else {
    score *= 0.6; // Below minimum preferred profit
  }
  
  // Behavioral bonuses
  if (behaviorProfile.categoryPreferences[category] > 0.7) {
    score *= 1.2; // User has shown preference for this category
  }
  
  if (userPreferences.feedStyle.preferHighValue && item.itemPrice > 100) {
    score *= 1.3;
  }
  
  if (userPreferences.feedStyle.preferQuickSales && item.sellScore > 70) {
    score *= 1.2;
  }
  
  return Math.min(score, 3.0); // Cap at 3x
}

/**
 * Get price range category
 */
function getPriceRange(price) {
  if (price < 25) return 'under25';
  if (price < 50) return 'range25to50';
  if (price < 100) return 'range50to100';
  if (price < 250) return 'range100to250';
  return 'over250';
}

/**
 * Update user behavior based on action
 */
async function updateUserBehavior(userId, action, itemData = {}) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { behaviorProfile: true, feedPreferences: true }
    });

    if (!user || !user.behaviorProfile) return;

    const behaviorProfile = user.behaviorProfile;
    const feedPreferences = user.feedPreferences;
    
    // Update interaction patterns
    switch (action) {
      case 'view_feed':
        behaviorProfile.interactionPatterns.feedViews = 
          (behaviorProfile.interactionPatterns.feedViews || 0) + 1;
        break;
        
      case 'click_item':
        behaviorProfile.interactionPatterns.itemClicks = 
          (behaviorProfile.interactionPatterns.itemClicks || 0) + 1;
        break;
        
      case 'swipe_right':
        behaviorProfile.interactionPatterns.swipeRights = 
          (behaviorProfile.interactionPatterns.swipeRights || 0) + 1;
        behaviorProfile.totalItemsConsidered++;
        
        // Update category preferences
        if (itemData.category) {
          behaviorProfile.categoryPreferences[itemData.category] = 
            (behaviorProfile.categoryPreferences[itemData.category] || 0) + 0.1;
        }
        break;
        
      case 'item_sold':
        behaviorProfile.successfulSales++;
        behaviorProfile.interactionPatterns.actualSales = 
          (behaviorProfile.interactionPatterns.actualSales || 0) + 1;
        
        if (itemData.profit) {
          const currentTotal = behaviorProfile.averageProfitMargin * 
            (behaviorProfile.successfulSales - 1);
          behaviorProfile.averageProfitMargin = 
            (currentTotal + itemData.profit) / behaviorProfile.successfulSales;
        }
        
        // Strongly boost category preference
        if (itemData.category) {
          behaviorProfile.categoryPreferences[itemData.category] = 
            Math.min((behaviorProfile.categoryPreferences[itemData.category] || 0) + 0.3, 2.0);
        }
        break;
    }
    
    // Update selling frequency
    if (behaviorProfile.successfulSales === 0) {
      behaviorProfile.sellingFrequency = 'new';
    } else if (behaviorProfile.successfulSales < 3) {
      behaviorProfile.sellingFrequency = 'occasional';
    } else if (behaviorProfile.successfulSales < 10) {
      behaviorProfile.sellingFrequency = 'regular';
    } else {
      behaviorProfile.sellingFrequency = 'frequent';
    }
    
    // Calculate engagement score
    const engagementScore = calculateEngagementScore(behaviorProfile);
    
    behaviorProfile.lastUpdated = new Date();
    
    await prisma.user.update({
      where: { id: userId },
      data: {
        behaviorProfile: behaviorProfile,
        feedEngagementScore: engagementScore
      }
    });
    
    logger.debug(`Updated behavior for user ${userId}, action: ${action}`);
    
  } catch (error) {
    logger.error(`Error updating user behavior for ${userId}: ${error.message}`);
  }
}

/**
 * Calculate user engagement score
 */
function calculateEngagementScore(behaviorProfile) {
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

/**
 * Check and award achievements
 */
async function checkAchievements(userId) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { 
        achievements: true, 
        behaviorProfile: true,
        receiptItems: {
          where: { status: 'sold' },
          select: { itemPrice: true, resaleValue: true, categoryTag: true }
        }
      }
    });

    if (!user || !user.achievements || !user.behaviorProfile) return [];

    const achievements = user.achievements;
    const soldItems = user.receiptItems;
    const newAchievements = [];
    
    // First Sale achievement
    if (!achievements.earned.includes('firstSale') && soldItems.length >= 1) {
      achievements.earned.push('firstSale');
      achievements.points += ACHIEVEMENTS.firstSale.points;
      newAchievements.push(ACHIEVEMENTS.firstSale);
    }
    
    // Profitable achievement
    const totalProfit = soldItems.reduce((sum, item) => {
      return sum + (item.resaleValue - item.itemPrice);
    }, 0);
    
    if (!achievements.earned.includes('profitable') && totalProfit >= 100) {
      achievements.earned.push('profitable');
      achievements.points += ACHIEVEMENTS.profitable.points;
      newAchievements.push(ACHIEVEMENTS.profitable);
    }
    
    // Frequent Seller achievement
    if (!achievements.earned.includes('frequent') && soldItems.length >= 10) {
      achievements.earned.push('frequent');
      achievements.points += ACHIEVEMENTS.frequent.points;
      newAchievements.push(ACHIEVEMENTS.frequent);
    }
    
    // High Value achievement
    const hasHighValueSale = soldItems.some(item => item.resaleValue >= 250);
    if (!achievements.earned.includes('highValue') && hasHighValueSale) {
      achievements.earned.push('highValue');
      achievements.points += ACHIEVEMENTS.highValue.points;
      newAchievements.push(ACHIEVEMENTS.highValue);
    }
    
    // Update level based on points
    const newLevel = Math.floor(achievements.points / 500) + 1;
    achievements.level = newLevel;
    
    if (newAchievements.length > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: { achievements }
      });
      
      logger.info(`User ${userId} earned ${newAchievements.length} new achievements`);
    }
    
    return newAchievements;
    
  } catch (error) {
    logger.error(`Error checking achievements for user ${userId}: ${error.message}`);
    return [];
  }
}

/**
 * Generate personalized insights for user
 */
function generatePersonalizedInsights(userProfile, soldItems, feedItems) {
  const insights = [];
  const behaviorProfile = userProfile.behaviorProfile;
  const feedPreferences = userProfile.feedPreferences;
  
  // Selling performance insights
  if (soldItems.length > 0) {
    const avgProfit = soldItems.reduce((sum, item) => 
      sum + (item.resaleValue - item.itemPrice), 0) / soldItems.length;
    
    if (avgProfit > 50) {
      insights.push({
        type: 'success',
        title: '🎉 Great Profit Margins!',
        description: `You're averaging $${avgProfit.toFixed(2)} profit per sale. Keep it up!`,
        actionable: false
      });
    }
  }
  
  // Category performance insights
  const categoryStats = {};
  soldItems.forEach(item => {
    const category = item.categoryTag || 'other';
    if (!categoryStats[category]) {
      categoryStats[category] = { count: 0, profit: 0 };
    }
    categoryStats[category].count++;
    categoryStats[category].profit += (item.resaleValue - item.itemPrice);
  });
  
  const bestCategory = Object.entries(categoryStats)
    .sort((a, b) => b[1].profit - a[1].profit)[0];
  
  if (bestCategory && bestCategory[1].profit > 100) {
    insights.push({
      type: 'trend',
      title: `📈 ${bestCategory[0]} Expert`,
      description: `You've made $${bestCategory[1].profit.toFixed(2)} in ${bestCategory[0]}. Consider focusing more on this category!`,
      actionable: true,
      action: 'boost_category_preference',
      data: { category: bestCategory[0] }
    });
  }
  
  // Engagement insights
  if (behaviorProfile.interactionPatterns.feedViews > 10) {
    const clickRate = (behaviorProfile.interactionPatterns.itemClicks || 0) / 
      behaviorProfile.interactionPatterns.feedViews;
    
    if (clickRate < 0.2) {
      insights.push({
        type: 'tip',
        title: '💡 Explore More Items',
        description: 'Try exploring more items in your feed to discover hidden gems!',
        actionable: false
      });
    }
  }
  
  return insights;
}

module.exports = {
  initializeUserPersonalization,
  categorizeItem,
  calculatePersonalizedScore,
  updateUserBehavior,
  checkAchievements,
  generatePersonalizedInsights,
  DEFAULT_PREFERENCES,
  DEFAULT_BEHAVIOR_PROFILE
}; 