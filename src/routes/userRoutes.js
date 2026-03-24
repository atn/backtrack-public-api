const userController = require('../controllers/userController');
const authenticateToken = require('../middleware/authMiddleware');

async function userRoutes(fastify, options) {
  // Apply authentication middleware to all routes in this file
  fastify.addHook('preHandler', authenticateToken);

  // Route for updating user's push token
  fastify.put(
    '/me/push-token',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            token: { 
              type: 'string',
              description: 'Expo push notification token',
              pattern: '^ExponentPushToken\\[.+\\]$',
              examples: ['ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]']
            },
          },
          required: ['token'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              message: { type: 'string', example: 'Push token updated successfully.' }
            }
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'Invalid Expo push token format.' },
              code: { type: 'string', example: 'INVALID_TOKEN_FORMAT' }
            }
          },
          404: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'User not found.' },
              code: { type: 'string', example: 'USER_NOT_FOUND' }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'An error occurred while updating push token.' },
              code: { type: 'string', example: 'INTERNAL_ERROR' }
            }
          }
        }
      },
    },
    userController.updatePushToken
  );

  // Get user profile
  fastify.get(
    '/me',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  email: { type: 'string', format: 'email' },
                  createdAt: { type: 'string', format: 'date-time' },
                  lastFeedRefresh: { type: ['string', 'null'], format: 'date-time' },
                  hasEbayConnection: { type: 'boolean' },
                  hasGoogleConnection: { type: 'boolean' },
                  stats: {
                    type: 'object',
                    properties: {
                      totalReceipts: { type: 'integer' },
                      totalItems: { type: 'integer' },
                      feedCandidates: { type: 'integer' }
                    }
                  }
                }
              }
            }
          },
          404: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'User not found.' },
              code: { type: 'string', example: 'USER_NOT_FOUND' }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'An error occurred while fetching user profile.' },
              code: { type: 'string', example: 'INTERNAL_ERROR' }
            }
          }
        }
      }
    },
    userController.getUserProfile
  );
}

module.exports = userRoutes;
