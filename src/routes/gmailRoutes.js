const gmailController = require('../controllers/gmailController');
const authenticateToken = require('../middleware/authMiddleware');

async function gmailRoutes(fastify, options) {
  // All routes in this file will be protected by the authenticateToken middleware
  fastify.addHook('preHandler', authenticateToken);

  // Single consolidated route for processing recent emails (between last sync and now)
  fastify.post(
    '/process-recent-emails',
    {
      schema: {
        body: {
          type: 'object',
          required: ['googleAccountId'],
          properties: {
            googleAccountId: { 
              type: 'string',
              description: 'ID of the Google account to sync emails from'
            },
            forceResyncAll: { 
              type: 'boolean',
              default: false,
              description: 'Whether to resync all emails or just new ones'
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              message: { type: 'string', example: 'Recent email processing completed for Google Account user@example.com.' },
              data: {
                type: 'object',
                properties: {
                  queued_for_processing: { type: 'integer', example: 25 },
                  updated_for_reprocessing: { type: 'integer', example: 5 },
                  skipped_already_processed: { type: 'integer', example: 100 },
                  errors_creating_records: { type: 'integer', example: 0 },
                  pages_processed: { type: 'integer', example: 3 }
                }
              }
            }
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'Google account ID is required.' },
              code: { type: 'string', example: 'MISSING_ACCOUNT_ID' }
            }
          },
          401: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'Your Google account connection has expired. Please reconnect your Google account to continue syncing emails.' },
              code: { type: 'string', example: 'GOOGLE_AUTH_EXPIRED' },
              requiresReconnection: { type: 'boolean', example: true }
            }
          },
          403: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'You do not have permission to access this Google account.' },
              code: { type: 'string', example: 'ACCESS_DENIED' }
            }
          },
          404: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'Google account not found. The account may have been removed.' },
              code: { type: 'string', example: 'ACCOUNT_NOT_FOUND' }
            }
          },
          429: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'Google API rate limit reached. Please try again in a few minutes.' },
              code: { type: 'string', example: 'RATE_LIMIT_EXCEEDED' },
              retryAfter: { type: 'integer', example: 300 }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'An unexpected error occurred during email sync. Please try again later.' },
              code: { type: 'string', example: 'INTERNAL_ERROR' }
            }
          },
          503: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'Network connection issue. Please check your internet connection and try again.' },
              code: { type: 'string', example: 'NETWORK_ERROR' },
              retryable: { type: 'boolean', example: true }
            }
          }
        }
      },
    },
    gmailController.processRecentEmails
  );

  // List all Google accounts linked by the authenticated user
  fastify.get(
    '/accounts',
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
                  accounts: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        emailAddress: { type: 'string', format: 'email' },
                        lastSyncAt: { type: ['string', 'null'], format: 'date-time' },
                        lastSyncStatus: { type: ['string', 'null'] },
                        createdAt: { type: 'string', format: 'date-time' }
                      }
                    }
                  },
                  totalCount: { type: 'integer', example: 2 }
                }
              }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'An error occurred while fetching Google accounts.' },
              code: { type: 'string', example: 'INTERNAL_ERROR' }
            }
          }
        }
      }
    },
    gmailController.listGoogleAccounts
  );

  // Unlink a specific Google account
  fastify.delete(
    '/accounts/:accountId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            accountId: { 
              type: 'string',
              description: 'ID of the Google account to unlink'
            },
          },
          required: ['accountId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              message: { type: 'string', example: 'Google account unlinked successfully.' }
            }
          },
          403: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'You do not have permission to unlink this Google account.' },
              code: { type: 'string', example: 'ACCESS_DENIED' }
            }
          },
          404: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'Google account not found.' },
              code: { type: 'string', example: 'ACCOUNT_NOT_FOUND' }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'An error occurred while unlinking the Google account.' },
              code: { type: 'string', example: 'INTERNAL_ERROR' }
            }
          }
        }
      },
    },
    gmailController.unlinkGoogleAccount
  );

  // Trigger full historical sync for a Google Account
  fastify.post(
    '/accounts/:googleAccountId/trigger-full-sync',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            googleAccountId: { 
              type: 'string',
              description: 'ID of the Google account to sync'
            },
          },
          required: ['googleAccountId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              message: { type: 'string', example: 'Full sync triggered successfully. This may take several minutes to complete.' }
            }
          },
          403: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'You do not have permission to sync this Google account.' },
              code: { type: 'string', example: 'ACCESS_DENIED' }
            }
          },
          404: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'Google account not found.' },
              code: { type: 'string', example: 'ACCOUNT_NOT_FOUND' }
            }
          },
          409: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'A sync is already in progress for this account.' },
              code: { type: 'string', example: 'SYNC_IN_PROGRESS' }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'An error occurred while triggering the sync.' },
              code: { type: 'string', example: 'INTERNAL_ERROR' }
            }
          }
        }
      },
    },
    gmailController.triggerFullSyncForAccount
  );
}

module.exports = gmailRoutes;
