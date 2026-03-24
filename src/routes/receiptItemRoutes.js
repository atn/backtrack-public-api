const receiptItemController = require('../controllers/receiptItemController');
const authenticateToken = require('../middleware/authMiddleware');

async function receiptItemRoutes(fastify, options) {
  // Apply authentication middleware to all routes in this file
  fastify.addHook('preHandler', authenticateToken);

  // Route for swiping a receipt item
  fastify.put(
    '/receipt-items/:id/swipe',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            action: { 
              type: 'string', 
              enum: ['swipe_left', 'swipe_right_to_vault']
            },
          },
          required: ['action'],
        },
      },
    },
    receiptItemController.swipeReceiptItem
  );

  // Route for fetching pending receipt items (legacy)
  fastify.get(
    '/receipt-items/pending',
    receiptItemController.getPendingReceiptItems
  );

  // Route for fetching receipt items by status (new consolidated endpoint)
  fastify.get(
    '/receipt-items/status/:status',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            status: { 
              type: 'string',
              enum: ['pending', 'vault', 'swiped_left', 'swiped_right']
            },
          },
          required: ['status'],
        },
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    receiptItemController.getReceiptItemsByStatus
  );
}

module.exports = receiptItemRoutes;
