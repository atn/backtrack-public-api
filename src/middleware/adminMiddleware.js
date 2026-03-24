const { createLogger } = require('../utils/logger');

const logger = createLogger('ADMIN_MIDDLEWARE');

// Admin middleware - restricts access to user ID 1 only
async function requireAdmin(req, reply) {
  try {
    // Check if user is authenticated (this should run after authMiddleware)
    if (!req.user || !req.user.id) {
      logger.warn('Admin access attempt without authentication');
      return reply.status(401).send({
        success: false,
        error: 'Authentication required for admin access',
        code: 'ADMIN_AUTH_REQUIRED'
      });
    }

    // Check if user ID is 1 (admin)
    if (req.user.id !== 1) {
      logger.warn(`Admin access denied for user ${req.user.id}`, { 
        userId: req.user.id, 
        email: req.user.email,
        ip: req.ip,
        userAgent: req.headers['user-agent']
      });
      
      return reply.status(403).send({
        success: false,
        error: 'Admin access denied. This endpoint is restricted to administrators only.',
        code: 'ADMIN_ACCESS_DENIED'
      });
    }

    logger.info(`Admin access granted to user ${req.user.id}`, { 
      userId: req.user.id,
      endpoint: req.url,
      method: req.method,
      ip: req.ip
    });

    // User is admin, continue to route handler
  } catch (error) {
    logger.error('Error in admin middleware', { error: error.message, userId: req.user?.id });
    return reply.status(500).send({
      success: false,
      error: 'Admin authentication error',
      code: 'ADMIN_AUTH_ERROR'
    });
  }
}

module.exports = requireAdmin; 