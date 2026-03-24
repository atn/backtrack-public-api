const authController = require('../controllers/authController');
const authenticateToken = require('../middleware/authMiddleware');

async function authRoutes(fastify, options) {
  // Basic auth routes
  fastify.post('/signup', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { 
            type: 'string', 
            format: 'email',
            description: 'Valid email address'
          },
          password: { 
            type: 'string', 
            minLength: 8,
            description: 'Password must be at least 8 characters long'
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                token: { type: 'string', description: 'JWT authentication token' },
              }
            }
          },
        },
        400: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Invalid email format' },
            code: { type: 'string', example: 'INVALID_EMAIL' }
          }
        },
        409: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'User already exists with this email' },
            code: { type: 'string', example: 'USER_EXISTS' }
          }
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'An error occurred during signup' },
            code: { type: 'string', example: 'INTERNAL_ERROR' }
          }
        }
      },
    },
  }, authController.signup);

  fastify.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { 
            type: 'string', 
            format: 'email',
            description: 'Email address'
          },
          password: { 
            type: 'string',
            description: 'User password'
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                token: { type: 'string', description: 'JWT authentication token' },
              }
            }
          },
        },
        400: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Email and password are required' },
            code: { type: 'string', example: 'MISSING_CREDENTIALS' }
          }
        },
        401: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Invalid email or password' },
            code: { type: 'string', example: 'INVALID_CREDENTIALS' }
          }
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'An error occurred during login' },
            code: { type: 'string', example: 'INTERNAL_ERROR' }
          }
        }
      },
    },
  }, authController.login);

  // User info route
  fastify.get('/me', { 
    preHandler: authenticateToken,
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
                hasEbayConnection: { type: 'boolean' },
                hasGoogleConnection: { type: 'boolean' }
              }
            }
          }
        },
        401: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Unauthorized: No token provided' },
            code: { type: 'string', example: 'NO_TOKEN' }
          }
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'An error occurred while fetching user info' },
            code: { type: 'string', example: 'INTERNAL_ERROR' }
          }
        }
      }
    }
  }, authController.getMe);

  // Google OAuth routes
  fastify.post('/google/state', {
    schema: {
      headers: {
        type: 'object',
        required: ['authorization'],
        properties: {
          authorization: { 
            type: 'string',
            pattern: '^Bearer .+',
            description: 'JWT Bearer token'
          }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                state: { type: 'string', description: 'OAuth state parameter' },
                authUrl: { type: 'string', format: 'uri', description: 'Google OAuth authorization URL' }
              }
            }
          }
        },
        401: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Unauthorized: No token provided' },
            code: { type: 'string', example: 'NO_TOKEN' }
          }
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'An error occurred while generating OAuth state' },
            code: { type: 'string', example: 'INTERNAL_ERROR' }
          }
        }
      }
    },
    preHandler: authenticateToken,
    handler: authController.generateGoogleState
  });

  fastify.get('/google', {
    schema: {
      querystring: {
        type: 'object',
        required: ['token', 'state'],
        properties: {
          token: { 
            type: 'string',
            description: 'JWT token for the authenticated user'
          },
          state: { 
            type: 'string',
            description: 'OAuth state parameter'
          }
        }
      },
      response: {
        302: {
          description: 'Redirect to Google OAuth'
        },
        400: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Invalid token or state parameter' },
            code: { type: 'string', example: 'INVALID_PARAMETERS' }
          }
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'An error occurred during OAuth redirect' },
            code: { type: 'string', example: 'INTERNAL_ERROR' }
          }
        }
      }
    },
    handler: authController.redirectToGoogleAuth
  });

  fastify.get('/google/callback', {
    schema: {
      querystring: {
        type: 'object',
        required: ['state'],
        properties: {
          state: { type: 'string' }
        }
      }
    },
    handler: authController.handleGoogleCallback
  });

  fastify.post('/google/mobile-signin', {
    schema: {
      body: {
        type: 'object',
        properties: {
          idToken: { type: 'string' },
          serverAuthCode: { type: 'string' }
          // We don't make them "required" here because only one is needed.
          // The controller will validate that at least one is present.
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string' }, // Application JWT
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' }, // Or 'integer' if your user ID is int
                email: { type: 'string', format: 'email' },
                googleEmail: { type: 'string', format: 'email' }
              }
            }
          }
        },
        // Add other error responses like 400, 401, 409, 500 to the schema for better documentation
        400: {
            type: 'object', properties: { message: { type: 'string' } }
        },
        401: {
            type: 'object', properties: { message: { type: 'string' } }
        },
        409: {
            type: 'object', properties: { message: { type: 'string' } }
        },
        500: {
            type: 'object', properties: { message: { type: 'string' } }
        }
      }
    },
    preHandler: authenticateToken
  }, authController.handleGoogleMobileSignIn);

  // eBay OAuth routes
  fastify.get('/ebay', { 
    preHandler: authenticateToken 
  }, authController.redirectToEbayAuth);

  fastify.get('/ebay/callback', authController.handleEbayCallback);
}

module.exports = authRoutes;
