const receiptController = require('../controllers/receiptController');
const authenticateToken = require('../middleware/authMiddleware');

async function receiptRoutes(fastify, options) {
  // Apply authentication middleware to all routes in this file
  fastify.addHook('preHandler', authenticateToken);

  fastify.get(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
          },
        },
        // Response schema can be added here for better documentation and validation
      },
    },
    receiptController.listReceipts
  );

  fastify.get(
    '/:receiptId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            receiptId: { type: 'string' }, // Assuming CUIDs are strings
          },
          required: ['receiptId'],
        },
        // Response schema can be added here
      },
    },
    receiptController.getReceiptById
  );
}

module.exports = receiptRoutes;
