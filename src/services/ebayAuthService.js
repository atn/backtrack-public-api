const EbayApi = require('ebay-api'); // Import the new SDK
const prisma = require('../lib/prisma');
require('dotenv').config();

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;
const EBAY_REDIRECT_URI = process.env.EBAY_REDIRECT_URI;
const EBAY_RU_NAME = process.env.EBAY_RU_NAME; // RuName is often required for eBay
const EBAY_ENVIRONMENT = process.env.EBAY_ENVIRONMENT || 'SANDBOX'; // Default to SANDBOX

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_REDIRECT_URI || !EBAY_RU_NAME) {
  console.error('FATAL ERROR: eBay OAuth credentials (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, RU_NAME) are not defined in .env file.');
  // This service will not function correctly, potentially throw to prevent startup
}

// Initialize ebayApi client
const ebayApi = new EbayApi({
  appId: EBAY_CLIENT_ID,
  certId: EBAY_CLIENT_SECRET,
  devid: process.env.EBAY_DEV_ID, // Optional: Developer ID if you have one
  sandbox: EBAY_ENVIRONMENT === 'SANDBOX',
  siteId: 0, // 0 = US, adjust for other marketplaces
  ruName: EBAY_RU_NAME
});

// Default scopes for eBay API
const DEFAULT_EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.marketing',
  'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.account',  // Added for account policies
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly'  // Added for read-only account access
];

async function generateAuthUrl({ state } = {}) {
  try {
    // Set the scopes first
    ebayApi.OAuth2.setScope(DEFAULT_EBAY_SCOPES);
    
    // Generate the auth URL with state
    const baseUrl = EBAY_ENVIRONMENT === 'SANDBOX' 
      ? 'https://auth.sandbox.ebay.com/oauth2/authorize'
      : 'https://auth.ebay.com/oauth2/authorize';

    const params = new URLSearchParams({
      client_id: EBAY_CLIENT_ID,
      redirect_uri: EBAY_RU_NAME,
      response_type: 'code',
      state: state || '',
      scope: DEFAULT_EBAY_SCOPES.join(' ')
    });

    const authUrl = `${baseUrl}?${params.toString()}`;
    console.log('Generated eBay auth URL:', authUrl);

    return authUrl;
  } catch (error) {
    console.error('Error generating eBay auth URL:', error);
    throw new Error('Failed to generate eBay authentication URL');
  }
}

async function getTokens(code) {
  try {
    const tokenData = await ebayApi.OAuth2.getToken(code);
    
    if (!tokenData || !tokenData.access_token) {
      throw new Error('Invalid token data received from eBay');
    }

    // Set the credentials for future use
    ebayApi.OAuth2.setCredentials(tokenData);

    return {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      refresh_token_expires_in: tokenData.refresh_token_expires_in
    };
  } catch (error) {
    console.error('Error exchanging eBay authorization code for tokens:', error);
    throw new Error(`Failed to get tokens from eBay: ${error.message}`);
  }
}

async function refreshAccessToken(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user || !user.ebayRefreshToken) {
    console.error(`User ${userId} not found or no eBay refresh token available.`);
    throw new Error('No eBay refresh token available for user.');
  }

  // Log partial refresh token and scopes
  const partialRefreshToken = user.ebayRefreshToken.length > 12
    ? `${user.ebayRefreshToken.substring(0, 8)}...${user.ebayRefreshToken.substring(user.ebayRefreshToken.length - 4)}`
    : user.ebayRefreshToken;
  console.log(`Attempting to refresh eBay access token for user ${userId} with refreshToken (partial): ${partialRefreshToken} and scopes: ${JSON.stringify(DEFAULT_EBAY_SCOPES)}`);

  if (user.ebayRefreshTokenExpiry && new Date() > new Date(user.ebayRefreshTokenExpiry)) {
    console.error(`eBay refresh token for user ${userId} has expired. Re-authentication required.`);
    await prisma.user.update({
      where: { id: userId },
      data: {
        ebayAccessToken: null,
        ebayRefreshToken: null,
        ebayTokenExpiry: null,
        ebayRefreshTokenExpiry: null,
      },
    });
    throw new Error('eBay refresh token expired. Please re-authenticate with eBay.');
  }

  try {
    // Set the scopes first
    ebayApi.OAuth2.setScope(DEFAULT_EBAY_SCOPES);
    
    // Set the current credentials
    ebayApi.OAuth2.setCredentials({
      access_token: user.ebayAccessToken,
      refresh_token: user.ebayRefreshToken,
      expires_in: user.ebayTokenExpiry ? Math.floor((new Date(user.ebayTokenExpiry).getTime() - new Date().getTime()) / 1000) : 0
    });

    // Now refresh the token
    const refreshedTokenData = await ebayApi.OAuth2.refreshToken({
      refreshToken: user.ebayRefreshToken,
      scopes: DEFAULT_EBAY_SCOPES
    });

    if (!refreshedTokenData || !refreshedTokenData.access_token) {
      console.error(`Error refreshing eBay access token for user ${userId}: Refresh token exchange did not return a new access token. Response: ${JSON.stringify(refreshedTokenData)}`);
      throw new Error('Refresh token exchange did not return a new access token.');
    }

    console.log(`Successfully refreshed eBay access token for user ${userId}. Full response: ${JSON.stringify(refreshedTokenData)}`);

    const now = new Date();
    const newEbayTokenExpiry = refreshedTokenData.expires_in ? new Date(now.getTime() + refreshedTokenData.expires_in * 1000) : null;

    const updateData = {
      ebayAccessToken: refreshedTokenData.access_token,
      ebayTokenExpiry: newEbayTokenExpiry,
    };

    // eBay might or might not return a new refresh token. Update if provided.
    if (refreshedTokenData.refresh_token) {
      updateData.ebayRefreshToken = refreshedTokenData.refresh_token;
      // Update refresh token expiry if that's also provided with a new refresh token
      if (refreshedTokenData.refresh_token_expires_in) {
        updateData.ebayRefreshTokenExpiry = new Date(now.getTime() + refreshedTokenData.refresh_token_expires_in * 1000);
      }
    }

    await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    return refreshedTokenData.access_token;

  } catch (error) {
    // Ensure detailed error logging
    const detailedError = error.response?.data || error.message || error;
    console.error(`Error refreshing eBay access token for user ${userId}:`, detailedError);

    const errorMessage = error.response?.data?.error_description || error.response?.data?.error || error.message;
    if (errorMessage && errorMessage.toLowerCase().includes('invalid_grant')) {
      console.warn(`eBay refresh token for user ${userId} is invalid or revoked. Re-authentication required.`);
      await prisma.user.update({
        where: { id: userId },
        data: {
          ebayAccessToken: null,
          ebayRefreshToken: null,
          ebayTokenExpiry: null,
          ebayRefreshTokenExpiry: null,
        },
      });
      throw new Error('eBay refresh token invalid. Please re-authenticate with eBay.');
    }
    throw new Error(`Failed to refresh eBay access token: ${errorMessage}`);
  }
}

async function getValidEbayToken(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user || !user.ebayAccessToken || !user.ebayTokenExpiry) {
    console.log(`getValidEbayToken: No existing access token found or it's null for user ${userId}.`);
    if (user && user.ebayRefreshToken) {
      console.log(`getValidEbayToken: Initiating token refresh for user ${userId} as no valid access token was found.`);
      try {
        const newAccessToken = await refreshAccessToken(userId);
        console.log(`getValidEbayToken: Successfully refreshed token for user ${userId} during initial check.`);
        return newAccessToken;
      } catch (refreshError) {
        console.error(`getValidEbayToken: Error refreshing token for user ${userId} during initial check: ${refreshError.message}`);
        throw refreshError; // Re-throw error from refreshAccessToken
      }
    } else {
      console.error(`getValidEbayToken: User ${userId} not linked with eBay or no refresh token available for initial token fetch.`);
      throw new Error('User not linked with eBay or no refresh token available for initial token fetch.');
    }
  }

  const bufferTime = 5 * 60 * 1000; // 5 minutes in milliseconds
  const tokenLifeRemaining = new Date(user.ebayTokenExpiry).getTime() - new Date().getTime();

  if (tokenLifeRemaining < bufferTime) {
    console.log(`getValidEbayToken: Access token for user ${userId} is within buffer time (expires in ${Math.round(tokenLifeRemaining/1000)}s). Initiating refresh.`);
    try {
      const newAccessToken = await refreshAccessToken(userId);
      console.log(`getValidEbayToken: Successfully refreshed token for user ${userId} due to buffer time expiry.`);
      return newAccessToken;
    } catch (error) {
      console.error(`getValidEbayToken: Error refreshing token for user ${userId} due to buffer time expiry: ${error.message}.`);
      // If refresh fails but token is technically still valid (though expiring soon),
      // policy could be to return stale token or throw. Throwing is safer.
      if (tokenLifeRemaining > 0) {
         console.warn(`getValidEbayToken: Returning stale but still valid token for user ${userId} as refresh failed during buffer time check.`);
         return user.ebayAccessToken; // Or throw error as per strict policy
      }
      console.error(`getValidEbayToken: Token for user ${userId} is already past expiry and refresh failed critically.`);
      throw error; // If token is already past expiry or refresh failed critically
    }
  }

  console.log(`getValidEbayToken: Existing, valid (non-expired) token found and returned for user ${userId}.`);
  return user.ebayAccessToken;
}

module.exports = {
  generateAuthUrl,
  getTokens,
  refreshAccessToken,
  getValidEbayToken,
};