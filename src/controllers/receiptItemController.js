const prisma = require('../lib/prisma');
const { createLogger } = require('../utils/logger');

const logger = createLogger('RECEIPT_ITEM_CONTROLLER');

// Controller function for swiping a receipt item
async function swipeReceiptItem(req, reply) {
  const { receiptItemId } = req.params;
  const { action } = req.body;
  const userId = req.user.id;

  try {
    if (!['swipe_left', 'swipe_right_to_vault'].includes(action)) {
      return reply.status(400).send({ 
        success: false,
        error: 'Invalid swipe action. Must be "swipe_left" or "swipe_right_to_vault".',
        code: 'INVALID_ACTION'
      });
    }

    // Find the receipt item and ensure it belongs to the user
    const receiptItem = await prisma.receiptItem.findUnique({
      where: { id: receiptItemId },
      include: { receipt: true },
    });

    if (!receiptItem) {
      return reply.status(404).send({ 
        success: false,
        error: 'ReceiptItem not found.',
        code: 'ITEM_NOT_FOUND'
      });
    }

    // Verify ownership through receipt
    if (receiptItem.receipt && receiptItem.receipt.userId !== userId) {
      logger.warn(`User ${userId} attempted to swipe item ${receiptItemId} which belongs to user ${receiptItem.receipt.userId}`);
      return reply.status(403).send({ 
        success: false,
        error: 'Forbidden. You do not own this receipt item.',
        code: 'ACCESS_DENIED'
      });
    }

    // Check if item is already processed
    if (receiptItem.status !== 'pending') {
      return reply.status(400).send({ 
        success: false,
        error: `This item has already been processed (status: ${receiptItem.status}).`,
        code: 'ALREADY_PROCESSED'
      });
    }

    let updatedItem;
    let responseMessage;

    if (action === 'swipe_left') {
      // Mark as dismissed
      updatedItem = await prisma.receiptItem.update({
        where: { id: receiptItemId },
        data: { status: 'swiped_left' },
      });
      responseMessage = 'Item swiped left.';
    } else if (action === 'swipe_right_to_vault') {
      // Move to vault with additional metadata
      const updateData = {
        status: 'vault',
        swipedAt: new Date(),
      };

      // If item has a receipt, copy some metadata for vault display
      if (receiptItem.receipt) {
        updateData.storeName = receiptItem.receipt.vendorName;
        updateData.transactionDate = receiptItem.receipt.transactionDate;
      }

      updatedItem = await prisma.receiptItem.update({
        where: { id: receiptItemId },
        data: updateData,
      });
      responseMessage = 'Item swiped right and added to vault.';
    }

    if (!updatedItem) {
      logger.error(`Failed to update receipt item ${receiptItemId} for user ${userId}`);
      return reply.status(404).send({ 
        success: false,
        error: 'ReceiptItem not found or conflict during update.',
        code: 'UPDATE_FAILED'
      });
    }

    logger.info(`User ${userId} successfully swiped item ${receiptItemId} with action: ${action}`);
    
    return reply.status(200).send({
      success: true,
      message: responseMessage,
      data: {
        receiptItem: {
          id: updatedItem.id,
          receiptId: updatedItem.receiptId,
          userId: updatedItem.userId,
          itemName: updatedItem.itemName,
          itemPrice: updatedItem.itemPrice,
          itemQuantity: updatedItem.itemQuantity,
          sellScore: updatedItem.sellScore,
          resaleValue: updatedItem.resaleValue,
          status: updatedItem.status,
          imageUrl: updatedItem.imageUrl,
          storeName: updatedItem.storeName,
          transactionDate: updatedItem.transactionDate,
          swipedAt: updatedItem.swipedAt,
        }
      }
    });

  } catch (error) {
    logger.error(`Error processing swipe for item ${receiptItemId}, user ${userId}: ${error.message}`, {
      receiptItemId,
      userId,
      action,
      error: error.message,
      stack: error.stack,
    });
    
    return reply.status(500).send({
      success: false,
      error: 'An error occurred while processing the swipe.',
      code: 'INTERNAL_ERROR'
    });
  }
}

// Controller function to get pending receipt items
async function getPendingReceiptItems(req, reply) {
  const userId = req.user.id;

  try {
    const pendingItems = await prisma.receiptItem.findMany({
      where: {
        receipt: { userId: userId },
        status: 'pending',
      },
      include: {
        receipt: {
          select: {
            vendorName: true,
            transactionDate: true,
            totalAmount: true,
            currency: true,
          },
        },
      },
      orderBy: {
        id: 'desc', // Most recent first
      },
    });

    const transformedItems = pendingItems.map(item => ({
      id: item.id,
      itemName: item.itemName,
      itemPrice: item.itemPrice,
      itemQuantity: item.itemQuantity,
      sellScore: item.sellScore,
      resaleValue: item.resaleValue,
      status: item.status,
      imageUrl: item.imageUrl,
      storeName: item.receipt.vendorName,
      transactionDate: item.receipt.transactionDate,
      currency: item.receipt.currency,
    }));

    logger.info(`Fetched ${transformedItems.length} pending receipt items for user ${userId}`);
    
    return reply.status(200).send({
      success: true,
      data: {
        items: transformedItems,
        totalCount: transformedItems.length
      }
    });

  } catch (error) {
    logger.error(`Error fetching pending receipt items for user ${userId}: ${error.message}`, {
      userId,
      error: error.message,
      stack: error.stack,
    });
    
    return reply.status(500).send({
      success: false,
      error: 'An error occurred while fetching pending items.',
      code: 'INTERNAL_ERROR'
    });
  }
}

// Controller function to get receipt items by status
async function getReceiptItemsByStatus(req, reply) {
  const userId = req.user.id;
  const { status } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;

  try {
    const validStatuses = ['pending', 'vault', 'swiped_left', 'swiped_right', 'sold'];
    if (!validStatuses.includes(status)) {
      return reply.status(400).send({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        code: 'INVALID_STATUS'
      });
    }

    const whereCondition = {
      userId: userId,
      status: status,
    };

    const [items, totalCount] = await Promise.all([
      prisma.receiptItem.findMany({
        where: whereCondition,
        include: {
          receipt: {
            select: {
              vendorName: true,
              transactionDate: true,
              totalAmount: true,
              currency: true,
            },
          },
        },
        orderBy: {
          id: 'desc',
        },
        skip: offset,
        take: limit,
      }),
      prisma.receiptItem.count({
        where: whereCondition,
      }),
    ]);

    const transformedItems = items.map(item => ({
      id: item.id,
      receiptId: item.receiptId,
      itemName: item.itemName,
      itemPrice: item.itemPrice,
      itemQuantity: item.itemQuantity,
      sellScore: item.sellScore,
      resaleValue: item.resaleValue,
      status: item.status,
      imageUrl: item.imageUrl,
      storeName: item.receipt?.vendorName,
      transactionDate: item.receipt?.transactionDate,
      swipedAt: item.swipedAt,
      soldAt: item.soldAt,
      currency: item.receipt?.currency || 'USD',
      receiptTotalAmount: item.receipt?.totalAmount,
    }));

    const totalPages = Math.ceil(totalCount / limit);
    const hasMore = page < totalPages;

    logger.info(`Fetched ${transformedItems.length} ${status} receipt items for user ${userId} (page ${page})`);
    
    return reply.status(200).send({
      success: true,
      data: {
        items: transformedItems,
        pagination: {
          currentPage: page,
          totalPages: totalPages,
          totalItems: totalCount,
          itemsPerPage: limit,
          hasMore: hasMore,
        },
        status: status
      }
    });

  } catch (error) {
    logger.error(`Error fetching ${status} receipt items for user ${userId}: ${error.message}`, {
      userId,
      status,
      page,
      limit,
      error: error.message,
      stack: error.stack,
    });
    
    return reply.status(500).send({
      success: false,
      error: `An error occurred while fetching ${status} items.`,
      code: 'INTERNAL_ERROR'
    });
  }
}

module.exports = {
  swipeReceiptItem,
  getPendingReceiptItems,
  getReceiptItemsByStatus,
};
