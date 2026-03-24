require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const cors = require('@fastify/cors');
const prisma = require('./lib/prisma'); // Import Prisma client
const authRoutes = require('./routes/authRoutes');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('FATAL ERROR: JWT_SECRET is not defined in .env file. Please add it.');
  // Create .env from env.example if .env doesn't exist, and prompt user to fill it.
  const fs = require('fs');
  if (!fs.existsSync('.env')) {
    fs.copyFileSync('env.example', '.env');
    console.log("Copied env.example to .env. Please ensure JWT_SECRET and other variables are set.");
  }
  process.exit(1);
}

// Register CORS
fastify.register(cors, {
  origin: true, // Allow all origins in development
  methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true
});

// --- Health Check Endpoints ---
fastify.get('/healthz', async (request, reply) => {
  request.log.info('Health check (/healthz) accessed');
  return { status: 'OK', timestamp: new Date().toISOString(), message: 'Application is running' };
});

fastify.get('/readyz', async (request, reply) => {
  try {
    // 1. Check Database Connection
    await prisma.$queryRaw`SELECT 1`;
    request.log.info('Readiness check (/readyz): DB connection successful.');

    // 2. Check for essential environment variables (e.g., OpenAI API Key)
    if (!process.env.OPENAI_API_KEY) {
      request.log.error('Readiness check (/readyz): OPENAI_API_KEY is not set.');
      reply.status(503).send({ status: 'UNAVAILABLE', message: 'Critical configuration (OpenAI API Key) missing.' });
      return; // Important to return here
    }
    request.log.info('Readiness check (/readyz): OPENAI_API_KEY is present.');

    // Add other critical checks here if needed (e.g., other external services)

    reply.status(200).send({ status: 'OK', timestamp: new Date().toISOString(), message: 'Application is ready to serve traffic' });
  } catch (error) {
    request.log.error({ err: error }, 'Readiness check (/readyz): Failed.');
    if (error.message.includes('Database') || error.code) { // Crude check for DB error
        reply.status(503).send({ status: 'UNAVAILABLE', message: 'Database connection failed.', error: error.message });
    } else {
        reply.status(503).send({ status: 'UNAVAILABLE', message: 'A critical component is not ready.', error: error.message });
    }
  }
});

// --- Application API Routes ---
// Register routes
fastify.register(authRoutes, { prefix: '/api/auth' });

const gmailRoutes = require('./routes/gmailRoutes');
fastify.register(gmailRoutes, { prefix: '/api/gmail' });

const receiptProcessingRoutes = require('./routes/receiptProcessingRoutes'); // Added Receipt Processing routes
fastify.register(receiptProcessingRoutes, { prefix: '/api/receipts' }); // Existing Receipt Processing routes

const receiptRoutes = require('./routes/receiptRoutes'); // New routes for listing/getting receipts
fastify.register(receiptRoutes, { prefix: '/api/user-receipts' }); // Registering with a new prefix

const ebayRoutes = require('./routes/ebayRoutes');
fastify.register(ebayRoutes, { prefix: '/api/ebay' });

const debugRoutes = require('./routes/debugRoutes');
fastify.register(debugRoutes, { prefix: '/api/debug' });

const receiptItemRoutes = require('./routes/receiptItemRoutes');
fastify.register(receiptItemRoutes, { prefix: '/api' }); // Registering with prefix /api as routes are /receipt-items/...

const userRoutes = require('./routes/userRoutes');
fastify.register(userRoutes, { prefix: '/api' }); // Registering with prefix /api as routes start with /me/...

const resaleFeedRoutes = require('./routes/resaleFeedRoutes');
fastify.register(resaleFeedRoutes, { prefix: '/api' }); // Registering with prefix /api for /resale-feed/...

const adminRoutes = require('./routes/adminRoutes');
fastify.register(adminRoutes, { prefix: '/api/admin' }); // Admin routes restricted to user ID 1

// Enhanced error handler with consistent response format
fastify.setErrorHandler((error, request, reply) => {
  // Use request.log if available, otherwise fallback to fastify.log
  const logger = request.log || fastify.log;
  logger.error({ err: error, details: error.validation }, 'Error caught by custom error handler');

  let statusCode = error.statusCode || 500;
  let responsePayload = {
    success: false,
    error: error.message || 'Internal Server Error',
    code: 'INTERNAL_ERROR'
  };

  if (error.validation) {
    statusCode = 400; // Bad Request for validation errors
    responsePayload.error = 'Validation Error';
    responsePayload.code = 'VALIDATION_ERROR';
    responsePayload.details = error.validation.map(v => ({
        field: v.dataPath ? v.dataPath.substring(1) : 'unknown',
        message: v.message,
        params: v.params,
    }));
  } else if (error.isPrismaClientKnownRequestError) {
    // Handle known Prisma errors more gracefully
    if (error.code === 'P2002') {
      statusCode = 409; // Conflict
      responsePayload.error = `Unique constraint failed on the fields: ${error.meta?.target?.join(', ')}`;
      responsePayload.code = 'UNIQUE_CONSTRAINT_VIOLATION';
      responsePayload.details = {
          target_fields: error.meta?.target,
          model_name: error.meta?.modelName,
      };
    } else if (error.code === 'P2025') {
      statusCode = 404; // Not Found
      responsePayload.error = 'Record not found';
      responsePayload.code = 'RECORD_NOT_FOUND';
    } else if (error.code === 'P2003') {
      statusCode = 400; // Bad Request
      responsePayload.error = 'Foreign key constraint failed';
      responsePayload.code = 'FOREIGN_KEY_CONSTRAINT';
    } else {
      // For other Prisma errors, use generic database error
      statusCode = 500;
      responsePayload.error = 'Database error occurred';
      responsePayload.code = 'DATABASE_ERROR';
    }
  } else if (statusCode >= 500) {
    // For generic 500 errors, don't send potentially sensitive error messages in production
    if (process.env.NODE_ENV === 'production') {
      responsePayload.error = 'Internal Server Error';
    }
    responsePayload.code = 'INTERNAL_ERROR';
  } else if (statusCode === 401) {
    responsePayload.code = 'UNAUTHORIZED';
  } else if (statusCode === 403) {
    responsePayload.code = 'FORBIDDEN';
  } else if (statusCode === 404) {
    responsePayload.code = 'NOT_FOUND';
  } else if (statusCode === 429) {
    responsePayload.code = 'RATE_LIMITED';
  } else {
    // Generic client error
    responsePayload.code = 'CLIENT_ERROR';
  }

  reply.status(statusCode).send(responsePayload);
});

// Start the server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' }); // Listen on all available network interfaces
    fastify.log.info(`Server listening on ${fastify.server.address().port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
