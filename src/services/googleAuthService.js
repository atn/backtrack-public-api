const { google } = require('googleapis');
require('dotenv').config();
const prisma = require('../lib/prisma'); // Moved to top

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
  console.error('FATAL ERROR: Google OAuth credentials (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI) are not defined in .env file.');
  // In a real app, you might want to prevent startup or handle this more gracefully
  // For now, we'll let it proceed but log the error. It will fail at runtime.
}

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

function generateAuthUrl(params) {
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/gmail.readonly', // Added as per requirements
  ];

  // Enable offline access to get a refresh token
  // Note: Google only provides a refresh token on the first authorization from the user.
  // Subsequent authorizations for the same user/client may not include a refresh token.
  return oauth2Client.generateAuthUrl({
    access_type: 'offline', // Important for getting a refresh token
    prompt: 'consent',      // Ensures the consent screen is shown, which can help in getting a refresh token
    scope: scopes,
    state: params.state
  });
}

async function getTokens(code) {
  try {
    const { tokens } = await oauth2Client.getToken(code);
    // tokens will include access_token, refresh_token (if granted), expiry_date, id_token, token_type
    return tokens;
  } catch (error) {
    console.error('Error exchanging authorization code for tokens:', error.response ? error.response.data : error.message);
    throw new Error('Failed to get tokens from Google');
  }
}

async function getUserInfo(authClientWithTokens) {
  try {
    const oauth2 = google.oauth2({
      auth: authClientWithTokens,
      version: 'v2',
    });
    const { data } = await oauth2.userinfo.get();
    // data typically includes: id, email, verified_email, name, given_name, family_name, picture, locale
    return {
      googleId: data.id,
      email: data.email,
      name: data.name,
      picture: data.picture,
    };
  } catch (error) {
    console.error('Error fetching user info from Google:', error.response ? error.response.data : error.message);
    throw new Error('Failed to get user info from Google');
  }
}

async function exchangeCodeForTokensAndStore(code, authenticatedUserId) {
  if (!authenticatedUserId) {
    throw new Error('User ID is required to link Google account.');
  }

  const tokens = await getTokens(code); // Uses global oauth2Client to get initial tokens
  if (!tokens.access_token) {
    throw new Error('Failed to obtain access token from Google.');
  }

  // Create a temporary OAuth2 client instance to fetch user profile with the new tokens
  const tempAuthClient = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  tempAuthClient.setCredentials(tokens);

  const googleProfile = await getUserInfo(tempAuthClient);
  if (!googleProfile || !googleProfile.googleId || !googleProfile.email) {
    throw new Error('Failed to fetch user profile information from Google.');
  }

  // Check if this Google account (by googleId) is already linked to a DIFFERENT user
  const existingAccountWithGoogleId = await prisma.googleAccount.findUnique({
    where: { googleId: googleProfile.googleId },
  });

  if (existingAccountWithGoogleId && existingAccountWithGoogleId.userId !== authenticatedUserId) {
    console.error(
      `Google account conflict: Google ID ${googleProfile.googleId} (Email: ${googleProfile.email}) ` +
      `is already linked to user ${existingAccountWithGoogleId.userId}, but current user is ${authenticatedUserId}.`
    );
    throw new Error('This Google account is already linked to a different user. Please use a different Google account or contact support.');
  }

  // Also check if this email is already linked to a different user
  const existingAccountWithEmail = await prisma.googleAccount.findFirst({
    where: authenticatedUserId ? {
      emailAddress: googleProfile.email,
      userId: { not: authenticatedUserId }
    } : {
      emailAddress: googleProfile.email
    }
  });

  if (existingAccountWithEmail) {
    console.error(
      `[googleAuthService] Google email conflict: Email ${googleProfile.email} ` +
      `is already linked to user ${existingAccountWithEmail.userId}, but current authenticated user is ${authenticatedUserId}.`
    );
    throw new Error('This Google email is already linked to a different user.');
  }

  // Proceed to upsert the GoogleAccount information
  // If existingAccountWithGoogleId exists, it means it's for the same authenticatedUserId, so update is safe.
  const expiryDate = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

  const googleAccountData = {
    userId: authenticatedUserId,
    googleId: googleProfile.googleId,
    emailAddress: googleProfile.email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || undefined, // Keep existing if not provided
    tokenExpiry: expiryDate,
  };

  const upsertedGoogleAccount = await prisma.googleAccount.upsert({
    where: {
      // Try to find by googleId first. If it's a new account for this user, this won't match an existing record unless it's a re-link.
      // If the user is linking this googleId for the first time, it creates.
      // If they are re-linking the same googleId they already own, it updates.
      googleId: googleProfile.googleId,
    },
    create: {
      ...googleAccountData,
      lastSyncStatus: 'PENDING_INITIAL_SYNC', // Set initial sync status
      refreshToken: tokens.refresh_token || null, // Ensure it's explicitly null if not provided on create
    },
    update: {
      ...googleAccountData,
      // emailAddress might change if Google allows it, though googleId is immutable
      // lastSyncStatus could be reset or kept depending on policy for re-linking
    },
  });

  return upsertedGoogleAccount;
}

async function getValidAccessTokenForAccount(googleAccountId) {
  if (!googleAccountId) {
    throw new Error('Google Account ID is required.');
  }

  const googleAccount = await prisma.googleAccount.findUnique({
    where: { id: googleAccountId },
  });

  if (!googleAccount) {
    throw new Error(`Google account with ID ${googleAccountId} not found.`);
  }

  if (!googleAccount.accessToken || !googleAccount.tokenExpiry) {
    // This case might happen if there was an issue during initial token storage or if tokens were manually cleared.
    // If there's a refresh token, we can try to get a new access token. Otherwise, re-authentication is needed.
    if (!googleAccount.refreshToken) {
        console.error(`No access token or refresh token available for Google account ${googleAccountId}. Re-authentication required.`);
        throw new Error('Google session invalid, and no refresh token is available. Please re-authenticate the Google account.');
    }
    console.log(`Missing access token for Google account ${googleAccountId}, but refresh token exists. Attempting refresh.`);
  } else {
    // Check if the token is expired or close to expiring (e.g., within 5 minutes)
    const bufferMilliseconds = 5 * 60 * 1000; // 5 minutes
    const isTokenExpired = new Date().getTime() > (new Date(googleAccount.tokenExpiry).getTime() - bufferMilliseconds);

    if (!isTokenExpired) {
      return googleAccount.accessToken; // Token is valid and not expired
    }
    console.log(`Google token expired for account ${googleAccountId}. Attempting refresh.`);
  }

  // Token is expired or was missing, and we need to refresh it
  if (!googleAccount.refreshToken) {
    console.error(`No refresh token available for Google account ${googleAccountId} to refresh expired/missing token. Re-authentication required.`);
    // Update status to indicate auth error
    await prisma.googleAccount.update({
        where: { id: googleAccountId },
        data: { lastSyncStatus: 'ERROR_AUTH', accessToken: null, tokenExpiry: null }, // Invalidate tokens
    });
    throw new Error('Google session expired, and no refresh token is available. Please re-authenticate the Google account.');
  }

  // Use a new OAuth2 client instance for refreshing to avoid conflicts with the global one
  const refreshClient = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  refreshClient.setCredentials({
    refresh_token: googleAccount.refreshToken,
  });

  try {
    const { credentials } = await refreshClient.refreshAccessToken();
    const newAccessToken = credentials.access_token;
    const newExpiryDate = credentials.expiry_date ? new Date(credentials.expiry_date) : null;

    if (!newAccessToken) {
        throw new Error('Refresh token did not return a new access token.');
    }

    // Update the database with the new token and expiry
    await prisma.googleAccount.update({
      where: { id: googleAccountId },
      data: {
        accessToken: newAccessToken,
        tokenExpiry: newExpiryDate,
        // A new refresh token might be provided (rare, but possible). Update if so.
        ...(credentials.refresh_token && { refreshToken: credentials.refresh_token }),
        lastSyncStatus: googleAccount.lastSyncStatus === 'ERROR_AUTH' ? 'PENDING_INITIAL_SYNC' : googleAccount.lastSyncStatus, // Reset status if it was an auth error
      },
    });
    console.log(`Successfully refreshed Google token for account ${googleAccountId}`);
    return newAccessToken;
  } catch (error) {
    console.error(`Error refreshing Google access token for account ${googleAccountId}:`, error.response ? error.response.data : error.message);
    // If refresh fails (e.g., token revoked), user needs to re-authenticate for this specific account
    await prisma.googleAccount.update({
      where: { id: googleAccountId },
      data: { // Invalidate tokens to force re-auth for this account
        accessToken: null,
        // Do not nullify refresh token here if Google didn't explicitly revoke it,
        // but set status to reflect auth error.
        tokenExpiry: null,
        lastSyncStatus: 'ERROR_AUTH',
      },
    });
    throw new Error(`Failed to refresh Google token for account ${googleAccountId}. Please re-authenticate this Google account.`);
  }
}

async function handleMobileGoogleAuth({ idToken, serverAuthCode, authenticatedUserId }) {
  let tokens;
  let googleProfile;

  const currentOauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);

  if (idToken) {
    console.log('[googleAuthService] Handling mobile auth with ID Token.');
    try {
      const ticket = await currentOauth2Client.verifyIdToken({
        idToken: idToken,
        audience: GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      if (!payload) {
        throw new Error('Invalid Google ID token: payload missing.');
      }
      googleProfile = {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
      };
      tokens = { id_token: idToken };
    } catch (error) {
      console.error('[googleAuthService] Error verifying Google ID token:', error.message);
      throw new Error('Invalid Google ID token.');
    }
  } else if (serverAuthCode) {
    console.log('[googleAuthService] Handling mobile auth with Server Auth Code.');
    try {
      const { tokens: exchangedTokens } = await currentOauth2Client.getToken(serverAuthCode);
      if (!exchangedTokens.access_token) {
        throw new Error('Failed to obtain access token from Google using serverAuthCode.');
      }
      tokens = exchangedTokens;

      currentOauth2Client.setCredentials(tokens);
      const userInfo = await getUserInfo(currentOauth2Client);
      if (!userInfo || !userInfo.googleId || !userInfo.email) {
        throw new Error('Failed to fetch user profile information from Google after code exchange.');
      }
      googleProfile = userInfo;
    } catch (error) {
      console.error('[googleAuthService] Error exchanging serverAuthCode or fetching user info:', error.response ? error.response.data : error.message);
      throw new Error('Failed to process Google server authorization code.');
    }
  } else {
    throw new Error('Either idToken or serverAuthCode must be provided.');
  }

  if (!googleProfile || !googleProfile.googleId || !googleProfile.email) {
    throw new Error('Failed to retrieve Google user profile.');
  }

  let user = null;
  let googleAccount = null;

  if (authenticatedUserId) {
    user = await prisma.user.findUnique({ where: { id: authenticatedUserId } });
    if (!user) {
      throw new Error('Authenticated user not found for linking.');
    }
  } else {
    throw new Error('Authentication required to link Google account.');
  }

  // Check if this Google account is already linked to a different user
  const existingAccountWithGoogleId = await prisma.googleAccount.findUnique({
    where: { googleId: googleProfile.googleId },
    include: { user: true },
  });

  if (existingAccountWithGoogleId && existingAccountWithGoogleId.userId !== user.id) {
    console.error(
      `[googleAuthService] Google account conflict: Google ID ${googleProfile.googleId} ` +
      `is already linked to user ${existingAccountWithGoogleId.userId}, but current user is ${user.id}.`
    );
    throw new Error('This Google account is already linked to a different user.');
  }

  // Check if this email is already linked to a different user
  const existingAccountWithEmail = await prisma.googleAccount.findFirst({
    where: {
      emailAddress: googleProfile.email,
      userId: { not: user.id }
    }
  });

  if (existingAccountWithEmail) {
    console.error(
      `[googleAuthService] Google email conflict: Email ${googleProfile.email} ` +
      `is already linked to user ${existingAccountWithEmail.userId}, but current user is ${user.id}.`
    );
    throw new Error('This Google email is already linked to a different user.');
  }

  const expiryDate = tokens.expiry_date ? new Date(tokens.expiry_date) : (tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null);
  googleAccount = await prisma.googleAccount.create({
    data: {
      userId: user.id,
      googleId: googleProfile.googleId,
      emailAddress: googleProfile.email,
      accessToken: tokens.access_token || null,
      refreshToken: tokens.refresh_token || null,
      tokenExpiry: expiryDate,
      lastSyncStatus: 'PENDING_INITIAL_SYNC',
    },
    include: { user: true }
  });
  user = googleAccount.user;

  if (!user) {
    throw new Error('User could not be identified or created.');
  }

  // Initiate full sync in background and trigger feed processing
  const { syncPastEmailsForAccount } = require('./backgroundGmailService');
  const { processUserFeedAutomatically } = require('../controllers/resaleFeedController');
  syncPastEmailsForAccount(googleAccount.id)
    .then(() => {
      console.info(`[googleAuthService] Initial full sync completed for Google Account ${googleAccount.id}`);
      // Trigger automatic feed processing after sync completes
      return processUserFeedAutomatically(user.id);
    })
    .then((feedResult) => {
      if (feedResult.success) {
        console.info(`[googleAuthService] Automatic feed processing completed for user ${user.id}. Items generated: ${feedResult.itemsGenerated}`);
      } else {
        console.info(`[googleAuthService] Automatic feed processing skipped for user ${user.id}: ${feedResult.error}`);
      }
    })
    .catch(error => {
      console.error(`[googleAuthService] Error during initial sync or feed processing for Google Account ${googleAccount.id}:`, error);
      // Don't throw here, as we want to return success to the user even if sync fails
    });

  return {
    user,
    googleAccount,
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
    }
  };
}

module.exports = {
  generateAuthUrl,
  exchangeCodeForTokensAndStore,
  getValidAccessTokenForAccount,
  handleMobileGoogleAuth,
};
