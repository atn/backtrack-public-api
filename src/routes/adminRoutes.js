const adminController = require('../controllers/adminController');
const authenticateToken = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/adminMiddleware');

async function adminRoutes(fastify, options) {
  // Apply authentication middleware first, then admin middleware to all routes
  fastify.addHook('preHandler', authenticateToken);
  fastify.addHook('preHandler', requireAdmin);

  // System Overview & Healthm
  fastify.get('/system/stats', {
    schema: {
      description: 'Get comprehensive system statistics',
      tags: ['admin'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                overview: {
                  type: 'object',
                  properties: {
                    totalUsers: { type: 'integer' },
                    totalReceipts: { type: 'integer' },
                    totalReceiptItems: { type: 'integer' },
                    totalGoogleAccounts: { type: 'integer' },
                    totalProcessedEmails: { type: 'integer' },
                    feedCandidates: { type: 'integer' },
                    soldItems: { type: 'integer' },
                    totalResaleValue: { type: 'number' }
                  }
                },
                recentActivity: {
                  type: 'object',
                  properties: {
                    newUsers: { type: 'integer' },
                    newReceipts: { type: 'integer' },
                    newEmails: { type: 'integer' }
                  }
                },
                syncStatuses: { type: 'object' },
                timestamp: { type: 'string', format: 'date-time' }
              }
            }
          }
        }
      }
    }
  }, adminController.getSystemStats);

  fastify.get('/system/health', {
    schema: {
      description: 'Get system health status',
      tags: ['admin'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                overallStatus: { type: 'string' },
                checks: { type: 'object' },
                issues: { type: 'object' },
                timestamp: { type: 'string', format: 'date-time' }
              }
            }
          }
        }
      }
    }
  }, adminController.getSystemHealth);

  // User Management
  fastify.get('/users', {
    schema: {
      description: 'Get all users with statistics',
      tags: ['admin'],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          search: { type: 'string', description: 'Search users by email' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                users: { type: 'array' },
                pagination: { type: 'object' }
              }
            }
          }
        }
      }
    }
  }, adminController.getAllUsers);

  fastify.get('/users/:userId', {
    schema: {
      description: 'Get detailed user information',
      tags: ['admin'],
      params: {
        type: 'object',
        properties: {
          userId: { type: 'string', pattern: '^[0-9]+$' }
        },
        required: ['userId']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                user: { type: 'object' }
              }
            }
          }
        }
      }
    }
  }, adminController.getUserDetails);


  let test = true;
  fastify.delete('/users/:userId', {
    schema: {
      description: 'Delete user and all associated data',
      tags: ['admin'],
      params: {
        type: 'object',
        properties: {
          userId: { type: 'string', pattern: '^[0-9]+$' }
        },
        required: ['userId']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                deletedUserId: { type: 'integer' },
                deletedEmail: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }, adminController.deleteUser);

  // User Operations
  fastify.post('/users/:userId/refresh-feed', {
    schema: {
      description: 'Manually trigger feed refresh for a user',
      tags: ['admin'],
      params: {
        type: 'object',
        properties: {
          userId: { type: 'string', pattern: '^[0-9]+$' }
        },
        required: ['userId']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                result: { type: 'object' }
              }
            }
          }
        }
      }
    }
  }, adminController.refreshUserFeed);

  fastify.post('/users/:userId/sync-gmail', {
    schema: {
      description: 'Manually trigger Gmail sync for a user',
      tags: ['admin'],
      params: {
        type: 'object',
        properties: {
          userId: { type: 'string', pattern: '^[0-9]+$' }
        },
        required: ['userId']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                results: { type: 'array' }
              }
            }
          }
        }
      }
    }
  }, adminController.syncUserGmail);

  fastify.post('/users/:userId/process-receipts', {
    schema: {
      description: 'Manually trigger receipt processing for a user',
      tags: ['admin'],
      params: {
        type: 'object',
        properties: {
          userId: { type: 'string', pattern: '^[0-9]+$' }
        },
        required: ['userId']
      },
      response: {
        202: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' }
          }
        }
      }
    }
  }, adminController.processUserReceipts);

  // System Operations
  fastify.get('/processing/queue', {
    schema: {
      description: 'Get current processing queue status',
      tags: ['admin'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                queue: { type: 'object' },
                activeProcessing: { type: 'array' },
                recentActivity: { type: 'array' },
                timestamp: { type: 'string', format: 'date-time' }
              }
            }
          }
        }
      }
    }
  }, adminController.getProcessingQueue);

  fastify.post('/system/cleanup', {
    schema: {
      description: 'Perform database cleanup operations',
      tags: ['admin'],
      body: {
        type: 'object',
        properties: {
          operation: { 
            type: 'string', 
            enum: ['cleanup_old_emails', 'reset_stuck_syncs', 'cleanup_oauth_states'],
            description: 'Type of cleanup operation to perform'
          }
        },
        required: ['operation']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                operation: { type: 'string' },
                results: { type: 'object' },
                timestamp: { type: 'string', format: 'date-time' }
              }
            }
          }
        }
      }
    }
  }, adminController.cleanupDatabase);

  // Utility Routes
  fastify.get('/test', {
    schema: {
      description: 'Test admin access',
      tags: ['admin'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                adminUserId: { type: 'integer' },
                timestamp: { type: 'string', format: 'date-time' }
              }
            }
          }
        }
      }
    }
  }, async (req, reply) => {
    return reply.status(200).send({
      success: true,
      data: {
        message: 'Admin access confirmed',
        adminUserId: req.user.id,
        timestamp: new Date().toISOString()
      }
    });
  });
}

module.exports = adminRoutes; 