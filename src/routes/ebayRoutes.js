const ebayController = require('../controllers/ebayController');
const authenticateToken = require('../middleware/authMiddleware');

async function ebayRoutes(fastify, options) {
  // Get vault items (items with status 'vault')
  fastify.get('/vault-items', { 
    preHandler: authenticateToken,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
  }, ebayController.getVaultItems);
  
  fastify.post('/list-item', { preHandler: authenticateToken }, ebayController.listItemOnEbay);

  fastify.get('/policies/fulfillment', { preHandler: authenticateToken }, ebayController.getFulfillmentPolicies);
  fastify.get('/policies/payment', { preHandler: authenticateToken }, ebayController.getPaymentPolicies);
  fastify.get('/policies/return', { preHandler: authenticateToken }, ebayController.getReturnPolicies);
  
  // Test endpoint for eBay Marketplace Insights API
  fastify.get('/test-marketplace-insights', { 
    preHandler: authenticateToken,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          itemName: { type: 'string', default: 'iphone' },
          vendorName: { type: 'string' },
        },
      },
    },
  }, ebayController.testEbayMarketplaceInsights);
  
  // Future eBay routes will be added here
}

module.exports = ebayRoutes;
