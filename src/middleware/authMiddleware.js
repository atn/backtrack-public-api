const jwtService = require('../services/jwtService');
const prisma = require('../lib/prisma');

async function authenticateToken(req, reply) { // Changed 'done' to 'reply' for Fastify error handling
  try {
    let token;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[1]) {
        token = parts[1];
      } else {
        // Malformed Bearer token in header
        return reply.status(401).send({ 
          success: false,
          error: 'Unauthorized: Token format is invalid',
          code: 'INVALID_TOKEN_FORMAT'
        });
      }
    } else if (req.query.token) {
      token = req.query.token;
    }

    // If no token was found in either header or query parameter
    if (!token) {
      return reply.status(401).send({ 
        success: false,
        error: 'Unauthorized: No token provided',
        code: 'MISSING_TOKEN'
      });
    }

    const decoded = jwtService.verifyToken(token); // verifyToken will throw if invalid/expired

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
    });

    if (!user) {
      return reply.status(401).send({ 
        success: false,
        error: 'Unauthorized: User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    // Attach user to the request object
    req.user = user;

    // No need to call done() explicitly if not using it for control flow here.
    // Fastify hooks proceed to the next handler or route handler if no error response is sent.

  } catch (error) {
    if (error.message === 'Token expired') {
      return reply.status(401).send({ 
        success: false,
        error: `Unauthorized: ${error.message}`,
        code: 'TOKEN_EXPIRED'
      });
    }
    if (error.message === 'Invalid token') {
      return reply.status(403).send({ 
        success: false,
        error: `Forbidden: ${error.message}`,
        code: 'INVALID_TOKEN'
      });
    }
    // Log other unexpected errors
    console.error('Authentication error in middleware:', error);
    return reply.status(500).send({ 
      success: false,
      error: 'Internal Server Error during authentication',
      code: 'INTERNAL_ERROR'
    });
  }
}

module.exports = authenticateToken;
