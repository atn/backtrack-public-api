const prisma = require('../lib/prisma');
const EBAY_MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

async function getVaultItems(req, reply) {
  const userId = req.user.id;
  const { page = 1, limit = 20 } = req.query;
  const skip = (page - 1) * limit;

  try {
    // Query ReceiptItems with status 'vault' instead of VaultItem table
    const vaultItems = await prisma.receiptItem.findMany({
      where: {
        userId,
        status: 'vault',
      },
      include: {
        receipt: {
          select: {
            vendorName: true,
            transactionDate: true,
          }
        }
      },
      skip,
      take: parseInt(limit),
      orderBy: { sellScore: 'desc' }, // Order by sell score
    });
//
    // Get metadata for pagination
    const [totalCount, totalValue] = await Promise.all([
      prisma.receiptItem.count({
        where: {
          userId,
          status: 'vault',
        },
      }),
      prisma.receiptItem.aggregate({
        where: {
          userId,
          status: 'vault',
        },
        _sum: { resaleValue: true },
      }),
    ]);

    const totalPages = Math.ceil(totalCount / limit);
    const hasMore = page < totalPages;

    req.log.info({ userId, count: vaultItems.length }, 'Fetched vault items for user.');
    return reply.status(200).send({
      success: true,
      data: {
        items: vaultItems,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalItems: totalCount,
          itemsPerPage: parseInt(limit),
          hasMore,
        },
        summary: {
          totalValue: totalValue._sum.resaleValue || 0,
          itemCount: totalCount,
        },
      }
    });
  } catch (error) {
    req.log.error({ err: error, userId }, 'Error fetching vault items.');
    throw error;
  }
}

const ebayApiService = require('../services/ebayApiService'); // Added import

async function getFulfillmentPolicies(req, reply) {
  try {
    const userId = req.user.id;
    const policies = await ebayApiService.getFulfillmentPolicies(userId);
    
    return reply.status(200).send({
      success: true,
      data: { policies }
    });
  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id }, 'Error fetching fulfillment policies');
    return reply.status(500).send({ 
      success: false,
      error: 'Failed to fetch fulfillment policies.',
      code: 'FULFILLMENT_POLICIES_ERROR'
    });
  }
}

async function getPaymentPolicies(req, reply) {
  try {
    const userId = req.user.id;
    const policies = await ebayApiService.getPaymentPolicies(userId);
    
    return reply.status(200).send({
      success: true,
      data: { policies }
    });
  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id }, 'Error fetching payment policies');
    return reply.status(500).send({ 
      success: false,
      error: 'Failed to fetch payment policies.',
      code: 'PAYMENT_POLICIES_ERROR'
    });
  }
}

async function getReturnPolicies(req, reply) {
  try {
    const userId = req.user.id;
    const policies = await ebayApiService.getReturnPolicies(userId);
    
    return reply.status(200).send({
      success: true,
      data: { policies }
    });
  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id }, 'Error fetching return policies');
    return reply.status(500).send({ 
      success: false,
      error: 'Failed to fetch return policies.',
      code: 'RETURN_POLICIES_ERROR'
    });
  }
}

async function listItemOnEbay(req, reply) {
  try {
    const userId = req.user.id;
    const { receiptItemId, title, description, price, categoryId, condition } = req.body;

    // Validate required fields
    const requiredFields = { receiptItemId, title, description, price, categoryId, condition };
    for (const [field, value] of Object.entries(requiredFields)) {
      if (!value) {
        return reply.status(400).send({ 
          success: false,
          error: `Missing required field: ${field}.`,
          code: 'MISSING_REQUIRED_FIELD'
        });
      }
    }

    if (typeof price !== 'number' || price <= 0) {
      return reply.status(400).send({ 
        success: false,
        error: 'Price must be a positive number.',
        code: 'INVALID_PRICE'
      });
    }

    // Verify the receipt item belongs to the user
    const receiptItem = await prisma.receiptItem.findFirst({
      where: {
        id: receiptItemId,
        userId: userId,
      },
    });

    if (!receiptItem) {
      return reply.status(404).send({ 
        success: false,
        error: 'Item not found or access denied.',
        code: 'ITEM_NOT_FOUND'
      });
    }

    req.log.info({ userId, receiptItemId, title, price }, 'Attempting to list item on eBay');

    try {
      const listingResult = await ebayApiService.listItem(userId, {
        title,
        description,
        price,
        categoryId,
        condition,
        // Add any other necessary fields
      });

      req.log.info({ userId, receiptItemId, listingId: listingResult.listingId }, 'Successfully listed item on eBay');
      
      return reply.status(201).send({
        success: true,
        message: 'Item listed successfully on eBay.',
        data: {
          listingId: listingResult.listingId,
          listingUrl: listingResult.listingUrl,
          fees: listingResult.fees
        }
      });

    } catch (ebayError) {
      req.log.error({ err: ebayError, userId, receiptItemId }, 'eBay API error during listing');
      
      // Handle eBay-specific errors
      if (ebayError.message && ebayError.message.includes('account not ready')) {
        return reply.status(400).send({
          success: false,
          error: 'Your eBay account is not ready for listing. Please complete your eBay seller setup first.',
          code: 'EBAY_ACCOUNT_NOT_READY'
        });
      }
      
      if (ebayError.response) {
        return reply.status(502).send({ 
          success: false,
          error: 'Error communicating with eBay.',
          code: 'EBAY_API_ERROR',
          details: ebayError.message
        });
      }

      const generalErrorMessage = 'An unexpected error occurred while listing on eBay.';
      return reply.status(500).send({ 
        success: false,
        error: generalErrorMessage,
        code: 'INTERNAL_ERROR'
      });
    }

  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id, body: req.body }, 'Error in listItemOnEbay controller');
    return reply.status(500).send({
      success: false,
      error: 'An error occurred while processing your request.',
      code: 'INTERNAL_ERROR'
    });
  }
}

// Test endpoint to verify eBay Browse API
async function testEbayMarketplaceInsights(req, reply) {
  try {
    const userId = req.user.id;
    const { itemName = 'iphone', vendorName = null } = req.query;

    req.log.info({ userId, itemName, vendorName }, 'Testing eBay Browse API');

    // Test the historical price data function
    const historicalData = await ebayApiService.getHistoricalPriceData(userId, itemName, 30, vendorName);
    
    // Test the market trends function
    const marketTrends = await ebayApiService.getMarketTrends(userId, itemName, null, 90, vendorName);
    
    // Test the search with history function
    const searchWithHistory = await ebayApiService.searchItemsWithHistory(userId, itemName, 5, vendorName);

    return reply.status(200).send({
      success: true,
      data: {
        message: 'eBay Browse API test completed',
        testData: {
          itemName,
          vendorName,
          historicalData,
          marketTrends,
          searchWithHistory
        }
      }
    });

  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id }, 'Error testing eBay Browse API');
    return reply.status(500).send({ 
      message: 'Failed to test eBay Browse API.', 
      error: error.message,
      details: error.response?.data || null
    });
  }
}

module.exports = {
  getVaultItems,
  listItemOnEbay,
  getFulfillmentPolicies,
  getPaymentPolicies,
  getReturnPolicies,
  testEbayMarketplaceInsights,
};