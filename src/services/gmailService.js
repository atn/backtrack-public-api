const { google } = require('googleapis');
const googleAuthService = require('./googleAuthService'); // To get valid token/client
const prisma = require('../lib/prisma'); // For ProcessedEmail model, though not used in this file directly yet
const { batchFetchImplementation } = require('@jrmdayn/googleapis-batcher');

// --- Gmail Client Setup ---

async function getGmailClient(googleAccountId) {
  if (!googleAccountId) {
    throw new Error('googleAccountId is required to get Gmail client.');
  }
  // Use the new service function to get a valid access token for the specific Google Account
  const accessToken = await googleAuthService.getValidAccessTokenForAccount(googleAccountId);
  if (!accessToken) {
    // This case should ideally be handled by getValidAccessTokenForAccount throwing an error
    throw new Error(`Failed to get valid access token for Google Account ID: ${googleAccountId}. Re-authentication might be needed.`);
  }

  // Create a new OAuth2 client instance for this specific request/token.
  // This ensures that if multiple requests are handled (e.g., in a serverless environment or async operations),
  // they don't interfere with each other's credentials.
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
    // Redirect URI is not needed for API calls once tokens are obtained, only for the initial auth flow.
  );
  oauth2Client.setCredentials({ access_token: accessToken });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// --- Email Fetching Functions ---

async function listMessages(googleAccountId, queryOptions = {}) {
  try {
    const gmail = await getGmailClient(googleAccountId);
    const { query = '', maxResults = 10, pageToken } = queryOptions;

    const response = await gmail.users.messages.list({
      userId: 'me', // 'me' refers to the authenticated user whose token is being used
      q: query,
      maxResults: maxResults,
      pageToken: pageToken,
    });

    return {
      messages: response.data.messages || [],
      nextPageToken: response.data.nextPageToken,
      resultSizeEstimate: response.data.resultSizeEstimate,
    };
  } catch (error) {
    console.error(`Error listing Gmail messages for Google Account ID ${googleAccountId}:`, error.response ? error.response.data.error : error.message);
    if (error.message.includes('token') || (error.response && (error.response.status === 401 || error.response.status === 403))) {
        throw new Error(`Failed to list Gmail messages for Google Account ${googleAccountId} due to token/authentication issue. Please re-authenticate.`);
    }
    throw new Error(`Failed to list Gmail messages for Google Account ${googleAccountId}.`);
  }
}

async function getMessageDetails(googleAccountId, messageId, format = 'full') {
  try {
    const gmail = await getGmailClient(googleAccountId);
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: format,
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching Gmail message details for message ${messageId} (Google Account ID ${googleAccountId}):`, error.response ? error.response.data.error : error.message);
    if (error.message.includes('token') || (error.response && (error.response.status === 401 || error.response.status === 403))) {
        throw new Error(`Failed to get Gmail message details for Google Account ${googleAccountId} due to token/authentication issue. Please re-authenticate.`);
    }
    throw new Error(`Failed to get Gmail message details for Google Account ${googleAccountId}.`);
  }
}

// --- Receipt Identification (Initial - Keyword Based) ---

function isPotentialReceipt(messageDetails) {
  // Use the enhanced extractTextFromMessage to get the email body
  const emailBodyText = extractTextFromMessage(messageDetails);

  if (!emailBodyText) {
    console.debug(`[GmailService] No body text found for isPotentialReceipt check for message ID: ${messageDetails.id || 'N/A'}.`);
    return false;
  }

  const lowerCaseBody = emailBodyText.toLowerCase();

  // Define indicators and exclusions for receipt identification
  const indicators = [
    'receipt', 'invoice', 'order confirmation', 'purchase confirmation',
    'payment confirmation', 'order details', 'your order', 'booking confirmation', // Added booking from old keywords
    'e-ticket', 'statement' // Added from old keywords
  ];
  const exclusions = [
    'advertisement', 'promotion', 'special offer', 'discount', 'sale',
    'subscription', 'membership', 'donation', 'newsletter', 'unsubscribe', // Added unsubscribe
    'view this email in your browser', 'if you can\'t see this email' // Common email boilerplate
  ];

  const hasIndicator = indicators.some(term => lowerCaseBody.includes(term));
  const hasExcluded = exclusions.some(term => lowerCaseBody.includes(term));

  // Regex for price: searches for a dollar sign (optional) followed by one or more digits,
  // optionally followed by a decimal point and exactly two digits.
  // Test on original emailBodyText in case currency symbols or formatting are case-sensitive or affected by lowercasing.
  const hasPrice = /\$?(\d{1,3}(,\d{3})*|\d+)(\.\d{2})?/.test(emailBodyText);


  console.debug(`[GmailService] Receipt check for message (ID: ${messageDetails.id || 'N/A'}): hasIndicator=${hasIndicator}, hasExcluded=${hasExcluded}, hasPrice=${hasPrice}`);

  return hasIndicator && hasPrice && !hasExcluded;
}

// Helper function to decode base64 email body (common in Gmail API)
function decodeBase64(encodedString) {
    if (!encodedString) return null;
    return Buffer.from(encodedString, 'base64').toString('utf-8');
}

// Helper function to extract image URLs from HTML content
function extractImageUrlsFromHtml(htmlContent) {
  if (!htmlContent) return [];
  
  const imageUrls = [];
  const imgRegex = /<img[^>]+src="([^">]+)"/g;
  let match;
  
  while ((match = imgRegex.exec(htmlContent)) !== null) {
    const url = match[1];
    // Filter out common tracking pixels and small icons
    if (!url.includes('tracking') && 
        !url.includes('pixel') && 
        !url.includes('icon') && 
        !url.includes('logo') &&
        !url.includes('spacer') &&
        !url.includes('clear') &&
        !url.includes('blank') &&
        !url.includes('transparent')) {
      imageUrls.push(url);
    }
  }
  
  return imageUrls;
}

// Recursive helper function to find text content and images from message parts
function _findContentRecursive(parts) {
  let plainText = "";
  let htmlText = "";
  let imageUrls = [];

  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      plainText += decodeBase64(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
      const htmlContent = decodeBase64(part.body.data);
      htmlText += htmlContent;
      imageUrls.push(...extractImageUrlsFromHtml(htmlContent));
    } else if (part.mimeType && part.mimeType.startsWith('image/') && part.body && part.body.data) {
      // Handle inline images
      const imageUrl = `data:${part.mimeType};base64,${part.body.data}`;
      imageUrls.push(imageUrl);
    } else if (part.parts && part.parts.length > 0) {
      // If a part itself has parts, recurse
      const nestedResult = _findContentRecursive(part.parts);
      // Prioritize plain text from deeper levels
      if (nestedResult.plainText) {
        plainText += nestedResult.plainText;
      }
      // If no plain text found so far in this path, accumulate HTML
      if (!plainText && nestedResult.htmlText) {
        htmlText += nestedResult.htmlText;
      }
      // Accumulate image URLs
      imageUrls.push(...nestedResult.imageUrls);
    }
  }
  
  return {
    plainText: plainText || htmlText,
    htmlText,
    imageUrls
  };
}

// Updated function to extract content from message details
function extractContentFromMessage(messageDetails) {
  if (!messageDetails || !messageDetails.payload) return null;

  const payload = messageDetails.payload;

  // Case 1: Message has parts (e.g., multipart/alternative, multipart/mixed)
  if (payload.parts && payload.parts.length > 0) {
    const foundContent = _findContentRecursive(payload.parts);
    return {
      text: foundContent.plainText || null,
      html: foundContent.htmlText || null,
      imageUrls: foundContent.imageUrls
    };
  }
  // Case 2: Message body is directly in payload (not multipart)
  else if (payload.body && payload.body.data) {
    if (payload.mimeType === 'text/plain') {
      return {
        text: decodeBase64(payload.body.data),
        html: null,
        imageUrls: []
      };
    } else if (payload.mimeType === 'text/html') {
      const htmlContent = decodeBase64(payload.body.data);
      return {
        text: htmlContent,
        html: htmlContent,
        imageUrls: extractImageUrlsFromHtml(htmlContent)
      };
    }
  }

  // Case 3: No obvious content found
  return null;
}

// Update the existing extractTextFromMessage to use the new function
function extractTextFromMessage(messageDetails) {
  const content = extractContentFromMessage(messageDetails);
  return content ? content.text : null;
}

// Helper function to detect authentication errors
function isAuthError(error) {
  return error.message.includes('token') || 
         error.message.includes('authentication') || 
         (error.response && (error.response.status === 401 || error.response.status === 403));
}

module.exports = {
  getGmailClient,
  listMessages,
  getMessageDetails,
  isPotentialReceipt,
  extractTextFromMessage,
  extractContentFromMessage, // Export the new function
  decodeBase64,
  isAuthError,
  getBatchEnabledGmailClient,
};


async function getBatchEnabledGmailClient(googleAccountId, options = {}) {
  if (!googleAccountId) {
    throw new Error('googleAccountId is required to get Batch Enabled Gmail client.');
  }
  const accessToken = await googleAuthService.getValidAccessTokenForAccount(googleAccountId);
  if (!accessToken) {
    throw new Error(`Failed to get valid access token for Google Account ID: ${googleAccountId}. Re-authentication might be needed.`);
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ access_token: accessToken });

  // Default to 50, allow override. Gmail's hard limit for batch is 100.
  // The library handles chunking if more than maxBatchSize requests are made in a tick.
  const { maxBatchSize = 50 } = options; 
  const fetchImpl = batchFetchImplementation({ maxBatchSize });

  return google.gmail({
    version: 'v1',
    auth: oauth2Client,
    fetchImplementation: fetchImpl, // Key change: use the batch fetch implementation
  });
}

// The manual getMultipleMessageDetails function using axios and crypto is removed.
// The @jrmdayn/googleapis-batcher library will transparently handle batching
// for individual gmail.users.messages.get() calls if they are made using the
// client returned by getBatchEnabledGmailClient and occur within the same tick.
