const prisma = require('../lib/prisma');

// Generate chart data for the frontend
async function generateChartData(userId) {
  try {
    // Get all receipts for the user (for chart calculations)
    const allReceipts = await prisma.receipt.findMany({
      where: { userId: userId },
      include: {
        items: true,
      },
      orderBy: { transactionDate: 'asc' },
    });

    if (allReceipts.length === 0) {
      return {
        monthlySpending: [],
        topVendors: [],
        spendingTrends: [],
        itemCategories: [],
        totalStats: {
          totalSpent: 0,
          totalReceipts: 0,
          averageOrderValue: 0,
          totalItems: 0
        }
      };
    }

    // 1. Monthly Spending Chart
    const monthlySpending = generateMonthlySpending(allReceipts);

    // 2. Top Vendors Chart
    const topVendors = generateTopVendors(allReceipts);

    // 3. Spending Trends (last 30 days vs previous 30 days)
    const spendingTrends = generateSpendingTrends(allReceipts);

    // 4. Item Categories (based on sellScore ranges)
    const itemCategories = generateItemCategories(allReceipts);

    // 5. Total Stats
    const totalStats = generateTotalStats(allReceipts);

    return {
      monthlySpending,
      topVendors,
      spendingTrends,
      itemCategories,
      totalStats
    };

  } catch (error) {
    console.error('Error generating chart data:', error);
    return null;
  }
}

// Generate monthly spending data for the last 12 months
function generateMonthlySpending(receipts) {
  const now = new Date();
  const monthlyData = [];

  // Generate last 12 months
  for (let i = 11; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const month = date.toISOString().substr(0, 7); // YYYY-MM format
    const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    
    const monthReceipts = receipts.filter(receipt => {
      if (!receipt.transactionDate) return false;
      const receiptMonth = receipt.transactionDate.toISOString().substr(0, 7);
      return receiptMonth === month;
    });

    const totalSpent = monthReceipts.reduce((sum, receipt) => sum + (receipt.totalAmount || 0), 0);
    
    monthlyData.push({
      month: monthName,
      amount: Math.round(totalSpent * 100) / 100,
      receipts: monthReceipts.length
    });
  }

  return monthlyData;
}

// Generate top vendors by spending
function generateTopVendors(receipts) {
  const vendorTotals = {};

  receipts.forEach(receipt => {
    const vendor = receipt.vendorName || 'Unknown';
    vendorTotals[vendor] = (vendorTotals[vendor] || 0) + (receipt.totalAmount || 0);
  });

  return Object.entries(vendorTotals)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 10) // Top 10 vendors
    .map(([vendor, amount]) => ({
      vendor,
      amount: Math.round(amount * 100) / 100,
      receipts: receipts.filter(r => (r.vendorName || 'Unknown') === vendor).length
    }));
}

// Generate spending trends comparison
function generateSpendingTrends(receipts) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const last30Days = receipts.filter(receipt => {
    if (!receipt.transactionDate) return false;
    return receipt.transactionDate >= thirtyDaysAgo;
  });

  const previous30Days = receipts.filter(receipt => {
    if (!receipt.transactionDate) return false;
    return receipt.transactionDate >= sixtyDaysAgo && receipt.transactionDate < thirtyDaysAgo;
  });

  const last30Total = last30Days.reduce((sum, receipt) => sum + (receipt.totalAmount || 0), 0);
  const previous30Total = previous30Days.reduce((sum, receipt) => sum + (receipt.totalAmount || 0), 0);

  const percentChange = previous30Total > 0 
    ? ((last30Total - previous30Total) / previous30Total) * 100 
    : last30Total > 0 ? 100 : 0;

  return {
    last30Days: {
      amount: Math.round(last30Total * 100) / 100,
      receipts: last30Days.length
    },
    previous30Days: {
      amount: Math.round(previous30Total * 100) / 100,
      receipts: previous30Days.length
    },
    percentChange: Math.round(percentChange * 100) / 100,
    trend: percentChange > 0 ? 'up' : percentChange < 0 ? 'down' : 'stable'
  };
}

// Generate item categories based on sellScore ranges
function generateItemCategories(receipts) {
  const categories = {
    'High Value (80-100)': { count: 0, value: 0 },
    'Medium Value (50-79)': { count: 0, value: 0 },
    'Low Value (1-49)': { count: 0, value: 0 },
    'Unscored': { count: 0, value: 0 }
  };

  receipts.forEach(receipt => {
    receipt.items.forEach(item => {
      const sellScore = item.sellScore;
      const itemValue = (item.itemPrice || 0) * (item.itemQuantity || 1);

      if (sellScore >= 80) {
        categories['High Value (80-100)'].count++;
        categories['High Value (80-100)'].value += itemValue;
      } else if (sellScore >= 50) {
        categories['Medium Value (50-79)'].count++;
        categories['Medium Value (50-79)'].value += itemValue;
      } else if (sellScore >= 1) {
        categories['Low Value (1-49)'].count++;
        categories['Low Value (1-49)'].value += itemValue;
      } else {
        categories['Unscored'].count++;
        categories['Unscored'].value += itemValue;
      }
    });
  });

  return Object.entries(categories).map(([category, data]) => ({
    category,
    count: data.count,
    value: Math.round(data.value * 100) / 100
  }));
}

// Generate total statistics
function generateTotalStats(receipts) {
  const totalSpent = receipts.reduce((sum, receipt) => sum + (receipt.totalAmount || 0), 0);
  const totalReceipts = receipts.length;
  const totalItems = receipts.reduce((sum, receipt) => 
    sum + receipt.items.reduce((itemSum, item) => itemSum + (item.itemQuantity || 0), 0), 0
  );
  const averageOrderValue = totalReceipts > 0 ? totalSpent / totalReceipts : 0;

  // Calculate theoretical recovery rate
  const totalResaleValue = receipts.reduce((sum, receipt) => 
    sum + receipt.items.reduce((itemSum, item) => 
      itemSum + ((item.resaleValue || 0) * (item.itemQuantity || 1)), 0
    ), 0
  );

  const recoveryRate = totalSpent > 0 ? (totalResaleValue / totalSpent) * 100 : 0;
  
  // Calculate items with resale value vs without
  let itemsWithResaleValue = 0;
  let itemsWithoutResaleValue = 0;
  let totalValueOfSellableItems = 0;
  let totalSpentOnSellableItems = 0;

  receipts.forEach(receipt => {
    receipt.items.forEach(item => {
      const quantity = item.itemQuantity || 1;
      const itemCost = (item.itemPrice || 0) * quantity;
      
      if (item.resaleValue && item.resaleValue > 0) {
        itemsWithResaleValue += quantity;
        totalValueOfSellableItems += (item.resaleValue * quantity);
        totalSpentOnSellableItems += itemCost;
      } else {
        itemsWithoutResaleValue += quantity;
      }
    });
  });

  const sellableItemsRecoveryRate = totalSpentOnSellableItems > 0 
    ? (totalValueOfSellableItems / totalSpentOnSellableItems) * 100 
    : 0;

  return {
    totalSpent: Math.round(totalSpent * 100) / 100,
    totalReceipts,
    averageOrderValue: Math.round(averageOrderValue * 100) / 100,
    totalItems,
    recoveryMetrics: {
      totalResaleValue: Math.round(totalResaleValue * 100) / 100,
      overallRecoveryRate: Math.round(recoveryRate * 100) / 100,
      potentialRecovery: Math.round(totalResaleValue * 100) / 100,
      totalLoss: Math.round((totalSpent - totalResaleValue) * 100) / 100,
      itemsWithResaleValue,
      itemsWithoutResaleValue,
      sellableItemsRecoveryRate: Math.round(sellableItemsRecoveryRate * 100) / 100,
      resaleValueCoverage: totalItems > 0 ? Math.round((itemsWithResaleValue / totalItems) * 100 * 100) / 100 : 0
    }
  };
}

async function listReceipts(req, reply) {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    const receipts = await prisma.receipt.findMany({
      where: { userId: userId },
      skip: skip,
      take: limit,
      orderBy: { transactionDate: 'desc' }, // Or extractedAt, assuming transactionDate is more relevant
      include: {
        items: true, // Include all fields from ReceiptItem
        processedEmail: {
          select: {
            id: true, // Include ID for potential linking or debugging
            subject: true,
            snippet: true,
            receivedAt: true,
            googleAccount: { // Nested include for GoogleAccount via ProcessedEmail
              select: {
                id: true,
                emailAddress: true,
              },
            },
          },
        },
      },
    });

    // Always get these basic stats
    const [totalReceipts, totalValue] = await Promise.all([
      prisma.receipt.count({
        where: { userId: userId },
      }),
      prisma.receipt.aggregate({
        where: { userId: userId },
        _sum: {
          totalAmount: true,
        },
      }),
    ]);

    // Only generate chart data on page 1 for performance
    let chartData = null;
    if (page === 1) {
      chartData = await generateChartData(userId);
    }

    const response = {
      receipts,
      currentPage: page,
      totalPages: Math.ceil(totalReceipts / limit),
      totalItems: totalReceipts, // Renamed from totalReceipts to avoid confusion with the array name
      totalValue: totalValue._sum.totalAmount || 0, // Add total value of all receipts
    };

    // Only include chartData on page 1
    if (chartData) {
      response.chartData = chartData;
    }

    return reply.status(200).send({
      success: true,
      data: response
    });

  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id }, 'Error listing receipts');
    throw error; // Let Fastify's error handler manage the response
  }
}

async function getReceiptById(req, reply) {
  try {
    const userId = req.user.id;
    const { receiptId } = req.params;

    const receipt = await prisma.receipt.findUnique({
      where: { id: receiptId },
      include: {
        items: true,
        processedEmail: {
          select: {
            id: true,
            subject: true,
            snippet: true,
            receivedAt: true,
            googleAccount: {
              select: {
                id: true,
                emailAddress: true,
              },
            },
          },
        },
      },
    });

    if (!receipt) {
      return reply.status(404).send({ 
      success: false,
      error: 'Receipt not found.',
      code: 'RECEIPT_NOT_FOUND'
    });
    }

    // Verify ownership
    if (receipt.userId !== userId) {
      req.log.warn({ userId, receiptId, ownerUserId: receipt.userId }, 'User attempted to access a receipt they do not own.');
      return reply.status(403).send({ 
      success: false,
      error: 'You do not have permission to access this receipt.',
      code: 'ACCESS_DENIED'
    });
    }

    return reply.status(200).send({
      success: true,
      data: receipt
    });

  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id, receiptId: req.params?.receiptId }, 'Error getting receipt by ID');
    throw error;
  }
}

module.exports = {
  listReceipts,
  getReceiptById,
};
