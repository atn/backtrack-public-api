const prisma = require('../lib/prisma');
const passwordService = require('../services/passwordService');
const jwtService = require('../services/jwtService');
const googleAuthService = require('../services/googleAuthService');
const { syncPastEmailsForAccount } = require('../services/backgroundGmailService'); // Added for initial email sync
const ebayAuthService = require('../services/ebayAuthService'); // Added eBay service
const { google } = require('googleapis');
const crypto = require('crypto'); // Added for state generation
require('dotenv').config(); // Ensure .env is loaded for JWT_SECRET etc.

// --- Existing Email/Password Functions ---

async function signup(req, reply) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return reply.status(400).send({ 
        success: false,
        error: 'Email and password are required',
        code: 'MISSING_CREDENTIALS'
      });
    }

    // Basic email validation
    if (!/\S+@\S+\.\S+/.test(email)) {
        return reply.status(400).send({ 
          success: false,
          error: 'Invalid email format',
          code: 'INVALID_EMAIL'
        });
    }

    // Basic password validation (e.g., minimum length)
    if (password.length < 8) {
        return reply.status(400).send({ 
          success: false,
          error: 'Password must be at least 8 characters long',
          code: 'WEAK_PASSWORD'
        });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return reply.status(409).send({ 
        success: false,
        error: 'User already exists with this email',
        code: 'USER_EXISTS'
      });
    }

    const hashedPassword = await passwordService.hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
      },
    });

    const token = jwtService.generateToken({ userId: user.id, email: user.email });
    req.log.info({ userId: user.id, email: user.email }, 'User signup successful');
    return reply.status(201).send({ 
      success: true,
      data: { token }
    });

  } catch (error) {
    req.log.error({ err: error, body: req.body }, 'Error during user signup');
    return reply.status(500).send({
      success: false,
      error: 'An error occurred during signup',
      code: 'INTERNAL_ERROR'
    });
  }
}

async function handleGoogleMobileSignIn(req, reply) {
  try {
    const { idToken, serverAuthCode } = req.body;

    if (!idToken && !serverAuthCode) {
      return reply.status(400).send({ 
        success: false,
        error: 'Google ID token or server authorization code is required.',
        code: 'MISSING_GOOGLE_TOKEN'
      });
    }

    let authenticatedUserId = null;
    if (req.user && req.user.id) {
      authenticatedUserId = req.user.id;
    }

    req.log.info({ body: req.body, authenticatedUserId }, '[authController] Attempting Google mobile sign-in/link.');

    const result = await googleAuthService.handleMobileGoogleAuth({
      idToken,
      serverAuthCode,
      authenticatedUserId
    });

    if (!result || !result.user || !result.user.id) {
      req.log.error({ resultFromService: result }, '[authController] Google mobile sign-in did not return a valid user object.');
      return reply.status(500).send({ 
        success: false,
        error: 'Failed to process Google sign-in: User data not found.',
        code: 'INVALID_USER_DATA'
      });
    }

    // Generate application JWT for the user
    const appToken = jwtService.generateToken({ userId: result.user.id, email: result.user.email });

    req.log.info({ userId: result.user.id, googleEmail: result.googleAccount.emailAddress }, '[authController] Google mobile sign-in successful.');

    return reply.status(200).send({
      success: true,
      data: {
        token: appToken,
        user: {
          id: result.user.id,
          email: result.user.email,
          googleEmail: result.googleAccount.emailAddress
        }
      }
    });

  } catch (error) {
    req.log.error({ err: error, body: req.body }, '[authController] Error during Google mobile sign-in.');
    if (error.message.includes('already linked to a different user')) {
      return reply.status(409).send({ 
        success: false,
        error: error.message,
        code: 'ACCOUNT_ALREADY_LINKED'
      });
    }
    if (error.message.includes('Invalid Google ID token') || error.message.includes('Failed to process Google server authorization code')) {
      return reply.status(401).send({ 
        success: false,
        error: error.message,
        code: 'INVALID_GOOGLE_TOKEN'
      });
    }
    throw error;
  }
}

async function login(req, reply) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return reply.status(400).send({ 
        success: false,
        error: 'Email and password are required',
        code: 'MISSING_CREDENTIALS'
      });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return reply.status(401).send({ 
        success: false,
        error: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS'
      }); // Generic message for security
    }

    const isPasswordValid = await passwordService.comparePassword(password, user.password);
    if (!isPasswordValid) {
      return reply.status(401).send({ 
        success: false,
        error: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS'
      }); // Generic message
    }

    const token = jwtService.generateToken({ userId: user.id, email: user.email });
    req.log.info({ userId: user.id, email: user.email }, 'User login successful');
    return reply.status(200).send({ 
      success: true,
      data: { token }
    });

  } catch (error) {
    req.log.error({ err: error, email: req.body.email }, 'Error during user login');
    return reply.status(500).send({
      success: false,
      error: 'An error occurred during login',
      code: 'INTERNAL_ERROR'
    });
  }
}

// --- Google OAuth Functions ---

async function redirectToGoogleAuth(req, reply) {
  try {
    const { token, state } = req.query;
    if (!token) {
      return reply.status(401).send({ 
        success: false,
        error: 'Token is required',
        code: 'MISSING_TOKEN'
      });
    }

    // Verify the state exists
    const storedState = await prisma.oAuthState.findUnique({
      where: { state: state }
    });

    if (!storedState) {
      return reply.status(401).send({ 
        success: false,
        error: 'Invalid state',
        code: 'INVALID_STATE'
      });
    }

    // Generate Google OAuth URL with state
    const authUrl = googleAuthService.generateAuthUrl({ state });
    reply.redirect(authUrl);
  } catch (error) {
    req.log.error({ err: error }, 'Error redirecting to Google Auth');
    throw error;
  }
}

async function handleGoogleCallback(req, reply) {
  try {
    const { code, state, error: oauthError, error_description: oauthErrorDescription } = req.query;

    if (oauthError) {
      req.log.warn({ oauthError, oauthErrorDescription, state }, 'Google OAuth callback error reported by Google.');
      return reply.status(401).send({ 
        success: false,
        error: `Google authentication failed: ${oauthError}`,
        code: 'GOOGLE_AUTH_FAILED'
      });
    }

    if (!code) {
      return reply.status(400).send({ 
        success: false,
        error: 'Missing authorization code from Google',
        code: 'MISSING_AUTH_CODE'
      });
    }

    if (!state) {
      return reply.status(400).send({ 
        success: false,
        error: 'Invalid request: State parameter missing.',
        code: 'MISSING_STATE'
      });
    }

    // Verify the state
    const storedState = await prisma.oAuthState.findUnique({
      where: { state: state }
    });

    if (!storedState) {
      return reply.status(401).send({ 
        success: false,
        error: 'Invalid or expired state. Please try linking again.',
        code: 'INVALID_STATE'
      });
    }

    // Check if state is expired
    if (storedState.expiresAt <= new Date()) {
      return reply.status(401).send({ 
        success: false,
        error: 'State expired. Please try linking again.',
        code: 'STATE_EXPIRED'
      });
    }

    // Verify this is a Google OAuth state
    if (storedState.type !== 'google') {
      return reply.status(401).send({ 
        success: false,
        error: 'Invalid state type. Please try linking again.',
        code: 'INVALID_STATE_TYPE'
      });
    }

    const userId = storedState.userId;

    // Exchange authorization code for Google tokens
    const result = await googleAuthService.exchangeCodeForTokensAndStore(code, userId);

    // Clean up the OAuth state
    await prisma.oAuthState.delete({ where: { state: state } });

    req.log.info({ userId }, 'Google account linked successfully');
    
    return reply.status(200).send({ 
      success: true,
      message: 'Google account linked successfully.',
      data: {
        googleAccount: result.googleAccount
      }
    });

  } catch (error) {
    req.log.error({ err: error, query: req.query }, 'Error in Google OAuth callback');
    return reply.status(500).send({
      success: false,
      error: 'An error occurred during Google authentication',
      code: 'INTERNAL_ERROR'
    });
  }
}

async function generateGoogleState(req, reply) {
  try {
    const userId = req.user.id;
    if (!userId) {
      return reply.status(401).send({ 
        success: false,
        error: 'User authentication required.',
        code: 'NO_USER_ID'
      });
    }

    const state = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes expiry

    await prisma.oAuthState.create({
      data: {
        state: state,
        userId: userId,
        type: 'google',
        expiresAt: expiresAt,
      },
    });

    req.log.info({ userId, state }, 'Generated Google OAuth state');
    
    return reply.status(200).send({
      success: true,
      data: { state }
    });
  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id }, 'Error generating Google OAuth state');
    return reply.status(500).send({
      success: false,
      error: 'An error occurred while generating OAuth state',
      code: 'INTERNAL_ERROR'
    });
  }
}

module.exports = {
  signup,
  login,
  redirectToGoogleAuth,
  handleGoogleCallback,
  redirectToEbayAuth,
  handleEbayCallback,
  getMe,
  generateGoogleState, // Add the new function to exports
  handleGoogleMobileSignIn,
};

async function getMe(req, reply) {
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      // Optionally include linked accounts info if needed directly, or just check existence
      // include: { googleAccounts: true } // This would fetch all googleAccounts
    });

    if (!user) {
      return reply.status(404).send({ 
        success: false,
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    // Check if the user has any Google accounts linked
    const googleAccountCount = await prisma.googleAccount.count({
      where: { userId: userId },
    });
    const hasGoogleConnection = googleAccountCount > 0;

    const hasEbayConnection = !!(user.ebayAccessToken && user.ebayRefreshToken);

    // For frontend, it might be useful to know which Google emails are connected
    let connectedGoogleEmails = [];
    if (hasGoogleConnection) {
        const googleAccounts = await prisma.googleAccount.findMany({
            where: { userId: userId },
            select: { emailAddress: true }
        });
        connectedGoogleEmails = googleAccounts.map(acc => acc.emailAddress);
    }

    return reply.status(200).send({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        hasGoogleConnection,
        connectedGoogleEmails, // Provide list of connected Google emails
        hasEbayConnection,
        // Add any other non-sensitive user details needed by the frontend
      }
    });
  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id }, 'Error in getMe handler');
    return reply.status(500).send({
      success: false,
      error: 'An error occurred while fetching user info',
      code: 'INTERNAL_ERROR'
    });
  }
}

// --- eBay OAuth Functions ---

async function redirectToEbayAuth(req, reply) {
  try {
    const userId = req.user.id;
    if (!userId) {
      req.log.error('User ID not found in request. Ensure authenticateToken middleware is used for this route.');
      return reply.status(401).send({ 
        success: false,
        error: 'User authentication required.',
        code: 'NO_USER_ID'
      });
    }

    const state = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes expiry

    await prisma.oAuthState.create({
      data: {
        state: state,
        userId: userId,
        type: 'ebay',
        expiresAt: expiresAt,
      },
    });

    const ebayAuthService = require('../services/ebayAuthService');
    const authUrl = await ebayAuthService.generateAuthUrl({ state });
    reply.redirect(authUrl);
  } catch (error) {
    req.log.error({ err: error, userId: req.user?.id }, 'Error redirecting to eBay Auth');
    return reply.status(500).send({
      success: false,
      error: 'An error occurred during eBay authentication',
      code: 'INTERNAL_ERROR'
    });
  }
}

async function handleEbayCallback(req, reply) {
  try {
    const { code, state, error: oauthError, error_description: oauthErrorDescription } = req.query;

    if (oauthError) {
      req.log.warn({ oauthError, oauthErrorDescription, state }, 'eBay OAuth callback error reported by eBay.');
      return reply.status(401).send({ 
        success: false,
        error: `eBay authentication failed: ${oauthErrorDescription || oauthError}`,
        code: 'EBAY_AUTH_FAILED'
      });
    }

    if (!code) {
      req.log.warn({ state }, 'eBay OAuth callback called without a code.');
      return reply.status(400).send({ 
        success: false,
        error: 'Missing authorization code from eBay',
        code: 'MISSING_AUTH_CODE'
      });
    }

    if (!state) {
      req.log.warn('eBay OAuth callback called without a state parameter.');
      return reply.status(400).send({ 
        success: false,
        error: 'Invalid request: State parameter missing.',
        code: 'MISSING_STATE'
      });
    }

    const storedState = await prisma.oAuthState.findUnique({
      where: { state: state },
    });

    if (!storedState) {
      req.log.warn({ state }, 'Invalid or expired state received in eBay OAuth callback.');
      return reply.status(401).send({ 
        success: false,
        error: 'Invalid or expired state. Please try linking again.',
        code: 'INVALID_STATE'
      });
    }

    if (new Date() > new Date(storedState.expiresAt)) {
      req.log.warn({ state, storedStateId: storedState.id }, 'Expired state received in eBay OAuth callback.');
      await prisma.oAuthState.delete({ where: { id: storedState.id } });
      return reply.status(401).send({ 
        success: false,
        error: 'State expired. Please try linking again.',
        code: 'STATE_EXPIRED'
      });
    }

    if (storedState.type !== 'ebay') {
      req.log.warn({ state, storedStateId: storedState.id, type: storedState.type }, 'Invalid state type received in eBay OAuth callback.');
      // Potentially delete it as it's a mismatched state
      await prisma.oAuthState.delete({ where: { id: storedState.id } });
      return reply.status(401).send({ 
        success: false,
        error: 'Invalid state type. Please try linking again.',
        code: 'INVALID_STATE_TYPE'
      });
    }

    const appUserId = storedState.userId;
    // State is valid and used, delete it
    await prisma.oAuthState.delete({ where: { id: storedState.id } });
    req.log.info({ userId: appUserId, state }, 'eBay OAuth callback: State validated, attempting to get tokens.');

    const ebayAuthService = require('../services/ebayAuthService');
    const ebayTokens = await ebayAuthService.getTokens(code); // code is from req.query
    req.log.info({ userId: appUserId }, 'eBay OAuth callback: Successfully obtained eBay tokens.');

    if (!ebayTokens || !ebayTokens.access_token) {
      req.log.error({ userId: appUserId }, 'Failed to retrieve valid access token from eBay after getting tokens.');
      return reply.status(500).send({ 
        success: false,
        error: 'Failed to retrieve valid tokens from eBay',
        code: 'TOKEN_EXCHANGE_FAILED'
      });
    }

    const now = new Date();
    const ebayTokenExpiry = ebayTokens.expires_in ? new Date(now.getTime() + ebayTokens.expires_in * 1000) : null;
    const ebayRefreshTokenExpiry = ebayTokens.refresh_token_expires_in ? new Date(now.getTime() + ebayTokens.refresh_token_expires_in * 1000) : null;

    await prisma.user.update({
      where: { id: appUserId }, // Use appUserId obtained from the validated state
      data: {
        ebayAccessToken: ebayTokens.access_token,
        ebayRefreshToken: ebayTokens.refresh_token,
        ebayTokenExpiry: ebayTokenExpiry,
        ebayRefreshTokenExpiry: ebayRefreshTokenExpiry,
        // ebayId might be fetched and set here in a more complete implementation
      },
    });

    req.log.info({ userId: appUserId }, 'eBay account linked successfully.');
    // In a real app, you might redirect to a frontend URL indicating success
    // e.g., reply.redirect(`${process.env.FRONTEND_URL}/settings/integrations?ebay_linked=true`);
    return reply.status(200).send({ 
      success: true,
      message: 'eBay account linked successfully.'
    });

  } catch (error) {
    // Ensure userId from state is logged if available, otherwise it might be null if state validation failed early
    const userIdFromState = req.query.state ? (await prisma.oAuthState.findUnique({ where: { state: req.query.state } }))?.userId : null;
    req.log.error({ err: error, userId: userIdFromState, code: req.query.code, state: req.query.state }, 'Error during eBay OAuth callback');
    return reply.status(500).send({
      success: false,
      error: 'An error occurred during eBay authentication',
      code: 'INTERNAL_ERROR'
    });
  }
}
