const receiptProcessingController = require('../controllers/receiptProcessingController');
const authenticateToken = require('../middleware/authMiddleware');

async function receiptProcessingRoutes(fastify, options) {
  // All routes in this file will be protected by the authenticateToken middleware
  fastify.addHook('preHandler', authenticateToken);

  fastify.post(
    '/extract-pending',
    {
      schema: {
        body: {
          type: 'object',
          nullable: true
        }
      }
    },
    receiptProcessingController.processPendingReceipts
  );
}

module.exports = receiptProcessingRoutes;
