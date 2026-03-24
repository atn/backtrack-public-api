const ebayAuthService = require('./ebayAuthService');
const axios = require('axios');
require('dotenv').config();
const DEFAULT_EBAY_CATEGORY_ID = process.env.EBAY_DEFAULT_CATEGORY_ID || '175672';
const DEFAULT_MERCHANT_LOCATION_KEY = process.env.EBAY_MERCHANT_LOCATION_KEY;
const EBAY_ENVIRONMENT = process.env.EBAY_ENVIRONMENT || 'SANDBOX';
const EBAY_MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
const EBAY_CURRENCY = process.env.EBAY_CURRENCY || 'USD';
const EBAY_CONTENT_LANGUAGE = process.env.EBAY_CONTENT_LANGUAGE || 'en-US';

const EBAY_API_BASE_URL_PRODUCTION = 'https://api.ebay.com';
const EBAY_API_BASE_URL_SANDBOX = 'https://api.sandbox.ebay.com';

// Helper function to parse eBay API errors
function parseEbayApiError(error, defaultMessage = 'An eBay API error occurred.') {
    console.error(`[ebayApiService] eBay API Error:`, error.stack || error);

    if (error.response && error.response.data && error.response.data.errors) {
        const apiErrors = error.response.data.errors;
        const accountNotReadyKeywords = [
            "activation", "verify account", "first listing", "seller requirements",
            "listing privileges", "account setup", "complete registration"
            // Add any specific error codes if known, e.g., by checking e.errorId
        ];

        for (const e of apiErrors) {
            const errorMessage = (e.message || "").toLowerCase();
            const longMessage = (e.longMessage || "").toLowerCase(); // Some APIs use longMessage

            if (accountNotReadyKeywords.some(keyword => errorMessage.includes(keyword) || longMessage.includes(keyword))) {
                // Found a keyword indicating account readiness issues.
                const specificMessage = `eBayAccountNotReadyError: The eBay account requires further setup or a prior listing before this action can be completed. Details: ${e.message}`;
                console.warn(`[ebayApiService] Identified account readiness issue: ${specificMessage}`);
                return new Error(specificMessage); // Return, to be thrown by the caller
            }
        }

        // If no specific account readiness error, format the general API error message
        let message = apiErrors.map(e => {
            let paramStr = '';
            if (e.parameters && e.parameters.length > 0) {
                paramStr = ` (${e.parameters.map(p => `${p.name}: ${p.value}`).join(', ')})`;
            }
            return `${e.errorId ? `${e.errorId} - ` : ''}${e.message}${paramStr}`;
        }).join('; ');
        return new Error(`eBay API Error: ${message}`);
    } else if (error.message) {
        // Check error.message itself for keywords if the structured errors array is not present
        const errorMessageLowerCase = error.message.toLowerCase();

        // Check for "Access Denied"
        if (errorMessageLowerCase.includes('access denied') || errorMessageLowerCase.includes('ebayaccessdenied')) {
            const specificMessage = `eBay API Error: Access Denied. This could be due to an invalid/expired token, insufficient API scopes for this operation, or an eBay account issue (e.g., suspension, pending requirements). Please try re-authenticating with eBay. If the issue persists, check your eBay account status and API application settings. Original error: ${error.message}`;
            console.warn(`[ebayApiService] Identified Access Denied error: ${specificMessage}`);
            return new Error(specificMessage);
        }

        // Existing accountNotReadyKeywords check
        const accountNotReadyKeywords = [
            "activation", "verify account", "first listing", "seller requirements",
            "listing privileges", "account setup", "complete registration"
        ];
        if (accountNotReadyKeywords.some(keyword => errorMessageLowerCase.includes(keyword))) {
            const specificMessage = `eBayAccountNotReadyError: The eBay account requires further setup or a prior listing. Message: ${error.message}`;
            console.warn(`[ebayApiService] Identified account readiness issue from error.message: ${specificMessage}`);
            return new Error(specificMessage);
        }

        // Fallback for other errors within error.message
        return new Error(`eBay API Error: ${error.message}`);
    }
    return new Error(defaultMessage);
}

async function createListing(userId, itemDetails, listingData, policyIds = {}) {
  if (DEFAULT_EBAY_CATEGORY_ID === "ENTER_YOUR_SANDBOX_CATEGORY_ID_HERE") {
    console.error("[ebayApiService] CRITICAL ERROR: eBay default category ID is not configured. Listing cannot proceed.");
    throw new Error("eBay service is not configured (Missing Category ID).");
  }
  if (!policyIds.fulfillmentPolicyId || !policyIds.paymentPolicyId || !policyIds.returnPolicyId) {
    console.error("[ebayApiService] Missing one or more required policy IDs. Cannot create offer.");
    throw new Error("Missing required eBay policy IDs.");
  }

  console.info(`[ebayApiService] Attempting to create listing for userId: ${userId}, itemId: ${itemDetails.id} using direct API calls.`);
  try {
    const ebayTokenString = await ebayAuthService.getValidEbayToken(userId);
    if (!ebayTokenString) {
      console.error(`[ebayApiService] Failed to get valid eBay token string for userId: ${userId} in createListing`);
      throw new Error('Failed to obtain valid eBay token. Cannot proceed.');
    }

    const baseUrl = EBAY_ENVIRONMENT === 'SANDBOX' ? EBAY_API_BASE_URL_SANDBOX : EBAY_API_BASE_URL_PRODUCTION;
    const sku = String(itemDetails.id);

    // 1. Create or Replace Inventory Item
    const inventoryItemPayload = {
      product: {
        title: listingData.title,
        description: listingData.description,
        imageUrls: listingData.imageUrls || ["https://www.example.com/image_placeholder.jpg"],
      },
      condition: listingData.condition || 'USED_GOOD',
      packageWeightAndSize: listingData.packageWeightAndSize || {},
      availability: {
        shipToLocationAvailability: {
          quantity: parseInt(itemDetails.quantity, 10) || 1,
        },
      },
    };
    console.debug(`[ebayApiService] Creating/replacing inventory item with SKU: ${sku}, Payload:`, JSON.stringify(inventoryItemPayload, null, 2));

    const inventoryItemUrl = `${baseUrl}/sell/inventory/v1/inventory_item/${sku}`;
    await axios.put(inventoryItemUrl, inventoryItemPayload, {
      headers: {
        'Authorization': `Bearer ${ebayTokenString}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Language': EBAY_CONTENT_LANGUAGE
      }
    });
    console.log(`[ebayApiService] createOrReplaceInventoryItem successful for SKU: ${sku} via direct call.`);

    // 2. Create Offer
    const offerPayload = {
      sku: sku,
      marketplaceId: EBAY_MARKETPLACE_ID, // Assuming EBAY_MARKETPLACE_ID is globally available as before
      format: 'FIXED_PRICE',
      availableQuantity: parseInt(itemDetails.quantity, 10) || 1,
      categoryId: DEFAULT_EBAY_CATEGORY_ID, // Assuming DEFAULT_EBAY_CATEGORY_ID is globally available
      listingDescription: listingData.description,
      listingPolicies: {
        fulfillmentPolicyId: policyIds.fulfillmentPolicyId,
        paymentPolicyId: policyIds.paymentPolicyId,
        returnPolicyId: policyIds.returnPolicyId,
      },
      pricingSummary: {
        price: {
          value: parseFloat(listingData.price).toFixed(2),
          currency: EBAY_CURRENCY, // Assuming EBAY_CURRENCY is globally available
        },
      },
      ...(DEFAULT_MERCHANT_LOCATION_KEY && { merchantLocationKey: DEFAULT_MERCHANT_LOCATION_KEY }),
    };
    console.debug("[ebayApiService] Creating offer with Payload:", JSON.stringify(offerPayload, null, 2));

    const createOfferUrl = `${baseUrl}/sell/inventory/v1/offer`;
    const createOfferResponse = await axios.post(createOfferUrl, offerPayload, {
      headers: {
        'Authorization': `Bearer ${ebayTokenString}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Language': EBAY_CONTENT_LANGUAGE
      }
    });

    const offerId = createOfferResponse.data.offerId;
    if (!offerId) {
      console.error('[ebayApiService] createOffer (direct call) response did not include an offerId. Response:', createOfferResponse.data);
      throw new Error('Failed to create eBay offer via direct call: No offerId returned.');
    }
    console.log(`[ebayApiService] Offer created with ID: ${offerId} via direct call.`);

    // 3. Publish Offer
    console.log(`[ebayApiService] Publishing offer ID: ${offerId} via direct call.`);
    const publishOfferUrl = `${baseUrl}/sell/inventory/v1/offer/${offerId}/publish`;
    const publishResponse = await axios.post(publishOfferUrl, {}, { // Empty body for publishOffer
      headers: {
        'Authorization': `Bearer ${ebayTokenString}`,
        'Accept': 'application/json'
        // Content-Type and Content-Language not typically required for POST with empty body, but check eBay docs if issues arise
      }
    });

    const listingId = publishResponse.data.listingId;
    if (!listingId) {
        console.error('[ebayApiService] publishOffer (direct call) response did not include a listingId. Response:', publishResponse.data);
        throw new Error('Failed to publish eBay offer via direct call: No listingId returned.');
    }
    console.log(`[ebayApiService] Offer published successfully via direct call. Listing ID: ${listingId}`);

    return { listingId, status: 'ACTIVE', offerId, sku };

  } catch (error) {
    // Enhanced error logging for Axios
    if (error.response) {
        console.error(`[ebayApiService] Axios error in createListing - Endpoint: ${error.config.method.toUpperCase()} ${error.config.url}, Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
        console.error(`[ebayApiService] Network error or no response in createListing - Endpoint: ${error.config.method.toUpperCase()} ${error.config.url}:`, error.message);
    } else {
        console.error(`[ebayApiService] Error setting up request in createListing:`, error.message);
    }
    // Use existing parseEbayApiError, which might need adjustment later (Step 5 of plan)
    throw parseEbayApiError(error, `Error creating listing for userId: ${userId}, itemId: ${itemDetails.id}`);
  }
}

async function getFulfillmentPolicies(userId, marketplaceId) {
  console.info(`[ebayApiService] Fetching fulfillment policies for userId: ${userId}, marketplaceId: ${marketplaceId} using direct API call.`);
  try {
    const ebayTokenString = await ebayAuthService.getValidEbayToken(userId);
    if (!ebayTokenString) {
      // Match existing error style for consistency if preferred
      console.error(`[ebayApiService] Failed to get valid eBay token string for userId: ${userId} in getFulfillmentPolicies`);
      throw new Error('Failed to obtain valid eBay token. Cannot proceed.');
    }

    const baseUrl = EBAY_ENVIRONMENT === 'SANDBOX' ? EBAY_API_BASE_URL_SANDBOX : EBAY_API_BASE_URL_PRODUCTION;
    const apiUrl = `${baseUrl}/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`;

    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${ebayTokenString}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json' // Often good to include Content-Type even for GETs, though less critical
      }
    });

    // eBay API might return empty array directly or an object with a key (e.g., fulfillmentPolicies)
    const policies = response.data.fulfillmentPolicies || response.data.policies || response.data || [];
    console.info(`[ebayApiService] Successfully fetched ${policies.length} fulfillment policies via direct call for userId: ${userId}.`);
    return policies;
  } catch (error) {
    // Log the error structure if it's different from what parseEbayApiError expects
    if (error.response) {
        console.error(`[ebayApiService] Axios error in getFulfillmentPolicies - Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
    } else {
        console.error(`[ebayApiService] Non-Axios error or network error in getFulfillmentPolicies: ${error.message}`);
    }
    throw parseEbayApiError(error, `Error fetching fulfillment policies for userId ${userId}`);
  }
}

async function getPaymentPolicies(userId, marketplaceId) {
  console.info(`[ebayApiService] Fetching payment policies for userId: ${userId}, marketplaceId: ${marketplaceId} using direct API call.`);
  try {
    const ebayTokenString = await ebayAuthService.getValidEbayToken(userId);
    if (!ebayTokenString) {
      console.error(`[ebayApiService] Failed to get valid eBay token string for userId: ${userId} in getPaymentPolicies`);
      throw new Error('Failed to obtain valid eBay token. Cannot proceed.');
    }

    const baseUrl = EBAY_ENVIRONMENT === 'SANDBOX' ? EBAY_API_BASE_URL_SANDBOX : EBAY_API_BASE_URL_PRODUCTION;
    const apiUrl = `${baseUrl}/sell/account/v1/payment_policy?marketplace_id=${marketplaceId}`;

    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${ebayTokenString}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    const policies = response.data.paymentPolicies || response.data.policies || response.data || [];
    console.info(`[ebayApiService] Successfully fetched ${policies.length} payment policies via direct call for userId: ${userId}.`);
    return policies;
  } catch (error) {
    if (error.response) {
        console.error(`[ebayApiService] Axios error in getPaymentPolicies - Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
    } else {
        console.error(`[ebayApiService] Non-Axios error or network error in getPaymentPolicies: ${error.message}`);
    }
    throw parseEbayApiError(error, `Error fetching payment policies for userId ${userId}`);
  }
}

async function getReturnPolicies(userId, marketplaceId) {
  console.info(`[ebayApiService] Fetching return policies for userId: ${userId}, marketplaceId: ${marketplaceId} using direct API call.`);
  try {
    const ebayTokenString = await ebayAuthService.getValidEbayToken(userId);
    if (!ebayTokenString) {
      console.error(`[ebayApiService] Failed to get valid eBay token string for userId: ${userId} in getReturnPolicies`);
      throw new Error('Failed to obtain valid eBay token. Cannot proceed.');
    }

    const baseUrl = EBAY_ENVIRONMENT === 'SANDBOX' ? EBAY_API_BASE_URL_SANDBOX : EBAY_API_BASE_URL_PRODUCTION;
    const apiUrl = `${baseUrl}/sell/account/v1/return_policy?marketplace_id=${marketplaceId}`;

    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${ebayTokenString}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    const policies = response.data.returnPolicies || response.data.policies || response.data || [];
    console.info(`[ebayApiService] Successfully fetched ${policies.length} return policies via direct call for userId: ${userId}.`);
    return policies;
  } catch (error) {
    if (error.response) {
        console.error(`[ebayApiService] Axios error in getReturnPolicies - Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
    } else {
        console.error(`[ebayApiService] Non-Axios error or network error in getReturnPolicies: ${error.message}`);
    }
    throw parseEbayApiError(error, `Error fetching return policies for userId ${userId}`);
  }
}

// Function to search items on eBay using Browse API
async function searchItems(userId, itemName, limit = 5) {
  console.info(`[ebayApiService] Searching items for userId: ${userId}, itemName: "${itemName}", limit: ${limit}`);
  try {
    const ebayTokenString = await ebayAuthService.getValidEbayToken(userId);
    if (!ebayTokenString) {
      console.error(`[ebayApiService] Failed to get valid eBay token string for userId: ${userId} in searchItems`);
      throw new Error('Failed to obtain valid eBay token. Cannot proceed with eBay search.');
    }

    const baseUrl = EBAY_ENVIRONMENT === 'SANDBOX' ? EBAY_API_BASE_URL_SANDBOX : EBAY_API_BASE_URL_PRODUCTION;
    // Ensure itemName is URL-encoded
    const encodedItemName = encodeURIComponent(itemName);
    const searchUrl = `${baseUrl}/buy/browse/v1/item_summary/search?q=${encodedItemName}&limit=${limit}`;

    console.debug(`[ebayApiService] Calling eBay Search API: ${searchUrl}`);

    const response = await axios.get(searchUrl, {
      headers: {
        'Authorization': `Bearer ${ebayTokenString}`,
        'Accept': 'application/json',
        // X-EBAY-C-MARKPLACE-ID is often required for Buy APIs
        'X-EBAY-C-MARKPLACE-ID': EBAY_MARKETPLACE_ID 
      }
    });

    if (response.data && response.data.itemSummaries) {
      console.info(`[ebayApiService] Successfully fetched ${response.data.itemSummaries.length} items from eBay search for "${itemName}".`);
      return response.data.itemSummaries;
    } else {
      console.warn(`[ebayApiService] eBay search for "${itemName}" returned no itemSummaries or unexpected data format. Response:`, response.data);
      return []; // Return empty array if no items found or data is not as expected
    }

  } catch (error) {
    if (error.response) {
      console.error(`[ebayApiService] Axios error in searchItems - Endpoint: ${error.config?.method?.toUpperCase()} ${error.config?.url}, Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error(`[ebayApiService] Network error or no response in searchItems - Endpoint: ${error.config?.method?.toUpperCase()} ${error.config?.url}:`, error.message);
    } else {
      console.error(`[ebayApiService] Error setting up request in searchItems:`, error.message);
    }
    // Use parseEbayApiError for consistent error handling
    throw parseEbayApiError(error, `Error searching items on eBay for itemName "${itemName}" and userId ${userId}`);
  }
}

// Function to get historical price data using basic eBay search
async function getHistoricalPriceData(userId, itemName, daysBack = 90, vendorName = null) {
  console.info(`[ebayApiService] Getting historical price data for userId: ${userId}, itemName: "${itemName}", daysBack: ${daysBack}, vendorName: "${vendorName}"`);
  
  try {
    const ebayTokenString = await ebayAuthService.getValidEbayToken(userId);
    if (!ebayTokenString) {
      console.error(`[ebayApiService] Failed to get valid eBay token string for userId: ${userId} in getHistoricalPriceData`);
      throw new Error('Failed to obtain valid eBay token. Cannot proceed with analytics.');
    }

    const baseUrl = EBAY_ENVIRONMENT === 'SANDBOX' ? EBAY_API_BASE_URL_SANDBOX : EBAY_API_BASE_URL_PRODUCTION;
    
    // Build search query with vendor name if available
    let searchQuery = itemName;
    if (vendorName && vendorName.trim()) {
      // Include vendor name in search to get more targeted results
      searchQuery = `${itemName} ${vendorName}`.trim();
    }
    
    // Use basic Browse API to get current listings
    const encodedItemName = encodeURIComponent(searchQuery);
    const searchUrl = `${baseUrl}/buy/browse/v1/item_summary/search?q=${encodedItemName}&limit=200&filter=conditions:{NEW|USED_EXCELLENT|USED_VERY_GOOD|USED_GOOD}`;

    console.debug(`[ebayApiService] Calling eBay Browse API: ${searchUrl}`);

    const response = await axios.get(searchUrl, {
      headers: {
        'Authorization': `Bearer ${ebayTokenString}`,
        'Accept': 'application/json',
        'X-EBAY-C-MARKPLACE-ID': EBAY_MARKETPLACE_ID
      }
    });

    if (!response.data || !response.data.itemSummaries || response.data.itemSummaries.length === 0) {
      console.warn(`[ebayApiService] No items found for "${searchQuery}"`);
      return null;
    }

    const items = response.data.itemSummaries;
    console.info(`[ebayApiService] Found ${items.length} items for "${searchQuery}"`);

    // Extract and analyze the items data
    const validPricedItems = items.filter(item => 
      item.price && 
      item.price.value && 
      parseFloat(item.price.value) > 0
    );

    if (validPricedItems.length === 0) {
      console.warn(`[ebayApiService] No valid items with prices found for "${searchQuery}"`);
      return null;
    }

    // Calculate price statistics
    const prices = validPricedItems.map(item => parseFloat(item.price.value));
    
    const sortedPrices = prices.sort((a, b) => a - b);
    const medianPrice = sortedPrices.length % 2 === 0 
      ? (sortedPrices[prices.length / 2 - 1] + sortedPrices[prices.length / 2]) / 2
      : sortedPrices[Math.floor(sortedPrices.length / 2)];

    const meanPrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    
    // Calculate price volatility
    const variance = prices.reduce((sum, price) => sum + Math.pow(price - meanPrice, 2), 0) / prices.length;
    const standardDeviation = Math.sqrt(variance);
    const coefficientOfVariation = standardDeviation / meanPrice;

    // Analyze recent vs older listings for trend detection (based on listing date if available)
    const itemsWithDates = validPricedItems.filter(item => item.itemCreationDate);
    const recentItems = itemsWithDates.slice(0, Math.floor(itemsWithDates.length * 0.3)); // Last 30%
    const olderItems = itemsWithDates.slice(Math.floor(itemsWithDates.length * 0.7)); // First 30%
    
    const recentAverage = recentItems.length > 0 ? 
      recentItems.reduce((sum, item) => sum + parseFloat(item.price.value), 0) / recentItems.length : 0;
    const olderAverage = olderItems.length > 0 ? 
      olderItems.reduce((sum, item) => sum + parseFloat(item.price.value), 0) / olderItems.length : 0;
    
    const trendDirection = recentAverage > olderAverage ? 'rising' : 
                          recentAverage < olderAverage ? 'falling' : 'stable';
    const trendPercentage = olderAverage > 0 ? ((recentAverage - olderAverage) / olderAverage) * 100 : 0;

    // Build price history from current listings
    const priceHistory = validPricedItems.map(item => ({
      date: item.itemCreationDate || new Date().toISOString(),
      price: parseFloat(item.price.value),
      itemId: item.itemId,
      title: item.title,
      condition: item.condition || 'unknown'
    })).sort((a, b) => new Date(a.date) - new Date(b.date));

    // Calculate market demand indicators
    const totalListings = validPricedItems.length;
    const demandLevel = totalListings > 50 ? 'high' : 
                       totalListings > 20 ? 'medium' : 'low';

    // Determine competition level based on number of unique sellers
    const uniqueSellers = new Set(validPricedItems.map(item => item.seller?.username).filter(Boolean));
    const competitionLevel = uniqueSellers.size > 20 ? 'high' : 
                            uniqueSellers.size > 10 ? 'medium' : 'low';

    const historicalData = {
      itemName: itemName,
      vendorName: vendorName,
      searchQuery: searchQuery,
      searchTimestamp: new Date().toISOString(),
      dataSource: 'eBay Browse API',
      summary: {
        totalListings: validPricedItems.length,
        uniqueSellers: uniqueSellers.size
      },
      priceAnalysis: {
        medianPrice: medianPrice,
        meanPrice: meanPrice,
        priceRange: {
          min: Math.min(...prices),
          max: Math.max(...prices)
        },
        volatility: {
          standardDeviation: standardDeviation,
          coefficientOfVariation: coefficientOfVariation
        }
      },
      marketTrends: {
        direction: trendDirection,
        percentageChange: trendPercentage,
        recentAverage: recentAverage,
        olderAverage: olderAverage,
        confidence: validPricedItems.length > 10 ? 'high' : 
                   validPricedItems.length > 5 ? 'medium' : 'low'
      },
      marketIndicators: {
        demandLevel: demandLevel,
        competitionLevel: competitionLevel,
        marketActivity: totalListings > 100 ? 'very_active' : 
                       totalListings > 50 ? 'active' : 
                       totalListings > 20 ? 'moderate' : 'low'
      },
      priceHistory: priceHistory,
      timeRange: {
        daysBack: daysBack,
        startDate: new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString(),
        endDate: new Date().toISOString()
      }
    };

    console.info(`[ebayApiService] Successfully analyzed data for "${searchQuery}": ${trendDirection} trend (${trendPercentage.toFixed(1)}%), ${validPricedItems.length} listings`);
    return historicalData;

  } catch (error) {
    if (error.response) {
      console.error(`[ebayApiService] Axios error in getHistoricalPriceData - Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`[ebayApiService] Error in getHistoricalPriceData:`, error.message);
    }
    
    console.warn(`[ebayApiService] eBay Browse API failed for "${itemName}"${vendorName ? ` from ${vendorName}` : ''}`);
    return null;
  }
}

// Function to get market trends using basic eBay search
async function getMarketTrends(userId, searchTerm, categoryId = null, daysBack = 90, vendorName = null) {
  console.info(`[ebayApiService] Getting market trends for userId: ${userId}, searchTerm: "${searchTerm}", categoryId: ${categoryId}, daysBack: ${daysBack}, vendorName: "${vendorName}"`);
  
  try {
    const ebayTokenString = await ebayAuthService.getValidEbayToken(userId);
    if (!ebayTokenString) {
      console.error(`[ebayApiService] Failed to get valid eBay token string for userId: ${userId} in getMarketTrends`);
      throw new Error('Failed to obtain valid eBay token. Cannot proceed with market trends.');
    }

    const baseUrl = EBAY_ENVIRONMENT === 'SANDBOX' ? EBAY_API_BASE_URL_SANDBOX : EBAY_API_BASE_URL_PRODUCTION;
    
    // Build search query with vendor name if available
    let searchQuery = searchTerm;
    if (vendorName && vendorName.trim()) {
      // Include vendor name in search to get more targeted results
      searchQuery = `${searchTerm} ${vendorName}`.trim();
    }
    
    // Use basic Browse API to get current listings
    const encodedItemName = encodeURIComponent(searchQuery);
    const searchUrl = `${baseUrl}/buy/browse/v1/item_summary/search?q=${encodedItemName}&limit=200&filter=conditions:{NEW|USED_EXCELLENT|USED_VERY_GOOD|USED_GOOD}`;

    console.debug(`[ebayApiService] Calling eBay Browse API for trends: ${searchUrl}`);

    const response = await axios.get(searchUrl, {
      headers: {
        'Authorization': `Bearer ${ebayTokenString}`,
        'Accept': 'application/json',
        'X-EBAY-C-MARKPLACE-ID': EBAY_MARKETPLACE_ID
      }
    });

    if (!response.data || !response.data.itemSummaries) {
      console.warn(`[ebayApiService] No market data found for "${searchQuery}"`);
      return null;
    }

    const items = response.data.itemSummaries;
    
    if (items.length === 0) {
      console.warn(`[ebayApiService] No items found for "${searchQuery}"`);
      return null;
    }

    // Analyze items for trends
    const validPricedItems = items.filter(item => 
      item.price && 
      item.price.value && 
      parseFloat(item.price.value) > 0
    );

    if (validPricedItems.length === 0) {
      console.warn(`[ebayApiService] No valid items with prices found for "${searchQuery}"`);
      return null;
    }

    // Calculate comprehensive market statistics
    const prices = validPricedItems.map(item => parseFloat(item.price.value));
    
    const sortedPrices = prices.sort((a, b) => a - b);
    const medianPrice = sortedPrices.length % 2 === 0 
      ? (sortedPrices[sortedPrices.length / 2 - 1] + sortedPrices[sortedPrices.length / 2]) / 2
      : sortedPrices[Math.floor(sortedPrices.length / 2)];

    const meanPrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const variance = prices.reduce((sum, price) => sum + Math.pow(price - meanPrice, 2), 0) / prices.length;
    const standardDeviation = Math.sqrt(variance);

    // Trend analysis based on listing dates
    const itemsWithDates = validPricedItems.filter(item => item.itemCreationDate);
    const recentItems = itemsWithDates.slice(0, Math.floor(itemsWithDates.length * 0.3));
    const olderItems = itemsWithDates.slice(Math.floor(itemsWithDates.length * 0.7));
    
    const recentAverage = recentItems.length > 0 ? 
      recentItems.reduce((sum, item) => sum + parseFloat(item.price.value), 0) / recentItems.length : 0;
    const olderAverage = olderItems.length > 0 ? 
      olderItems.reduce((sum, item) => sum + parseFloat(item.price.value), 0) / olderItems.length : 0;
    
    const trendDirection = recentAverage > olderAverage ? 'rising' : 
                          recentAverage < olderAverage ? 'falling' : 'stable';
    const trendPercentage = olderAverage > 0 ? ((recentAverage - olderAverage) / olderAverage) * 100 : 0;

    // Market structure analysis
    let conditionAnalysis = {};
    let categoryAnalysis = {};
    let buyingOptionAnalysis = {};

    // Analyze conditions
    const conditionCounts = {};
    validPricedItems.forEach(item => {
      const condition = item.condition || 'unknown';
      conditionCounts[condition] = (conditionCounts[condition] || 0) + 1;
    });
    
    Object.keys(conditionCounts).forEach(condition => {
      conditionAnalysis[condition] = {
        count: conditionCounts[condition],
        percentage: (conditionCounts[condition] / validPricedItems.length) * 100
      };
    });

    // Analyze buying options
    const buyingOptionCounts = {};
    validPricedItems.forEach(item => {
      const buyingOptions = item.buyingOptions || ['FIXED_PRICE'];
      buyingOptions.forEach(option => {
        buyingOptionCounts[option] = (buyingOptionCounts[option] || 0) + 1;
      });
    });
    
    Object.keys(buyingOptionCounts).forEach(option => {
      buyingOptionAnalysis[option] = {
        count: buyingOptionCounts[option],
        percentage: (buyingOptionCounts[option] / validPricedItems.length) * 100
      };
    });

    // Seller analysis
    const uniqueSellers = new Set(validPricedItems.map(item => item.seller?.username).filter(Boolean));
    const sellerConcentration = uniqueSellers.size / validPricedItems.length; // Lower = more concentrated

    const marketTrends = {
      searchTerm: searchTerm,
      vendorName: vendorName,
      searchQuery: searchQuery,
      categoryId: categoryId,
      totalItems: items.length,
      validItems: validPricedItems.length,
      priceStatistics: {
        median: medianPrice,
        mean: meanPrice,
        min: Math.min(...prices),
        max: Math.max(...prices),
        standardDeviation: standardDeviation,
        coefficientOfVariation: standardDeviation / meanPrice
      },
      trend: {
        direction: trendDirection,
        percentageChange: trendPercentage,
        recentAverage: recentAverage,
        olderAverage: olderAverage,
        confidence: validPricedItems.length > 10 ? 'high' : 
                   validPricedItems.length > 5 ? 'medium' : 'low'
      },
      volume: {
        totalListings: validPricedItems.length,
        averagePerDay: validPricedItems.length / (daysBack || 30)
      },
      marketStructure: {
        uniqueSellers: uniqueSellers.size,
        sellerConcentration: sellerConcentration,
        conditionBreakdown: conditionAnalysis,
        buyingOptionBreakdown: buyingOptionAnalysis
      },
      timeRange: {
        daysBack: daysBack,
        startDate: new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString(),
        endDate: new Date().toISOString()
      }
    };

    console.info(`[ebayApiService] Successfully analyzed market trends for "${searchQuery}": ${trendDirection} trend (${trendPercentage.toFixed(1)}%), ${validPricedItems.length} items`);
    return marketTrends;

  } catch (error) {
    if (error.response) {
      console.error(`[ebayApiService] Axios error in getMarketTrends - Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`[ebayApiService] Error in getMarketTrends:`, error.message);
    }
    
    console.warn(`[ebayApiService] Market trends analysis failed for "${searchTerm}"${vendorName ? ` from ${vendorName}` : ''}`);
    return null;
  }
}

// Enhanced search function that includes historical data
async function searchItemsWithHistory(userId, itemName, limit = 10, vendorName = null) {
  console.info(`[ebayApiService] Searching items with history for userId: ${userId}, itemName: "${itemName}", limit: ${limit}, vendorName: "${vendorName}"`);
  
  try {
    // Get current listings with vendor name if available
    const currentListings = await searchItems(userId, itemName, limit);
    
    // Get historical price data with vendor name if available
    const historicalData = await getHistoricalPriceData(userId, itemName, 30, vendorName);
    
    // Get market trends with vendor name if available
    const marketTrends = await getMarketTrends(userId, itemName, null, 90, vendorName);
    
    // Combine all data
    const enhancedResults = {
      currentListings: currentListings || [],
      historicalData: historicalData,
      marketTrends: marketTrends,
      searchMetadata: {
        itemName: itemName,
        vendorName: vendorName,
        searchTimestamp: new Date().toISOString(),
        dataSources: {
          currentListings: currentListings ? currentListings.length : 0,
          historicalData: historicalData ? 'available' : 'unavailable',
          marketTrends: marketTrends ? 'available' : 'unavailable'
        }
      }
    };

    console.info(`[ebayApiService] Enhanced search completed for "${itemName}"${vendorName ? ` from ${vendorName}` : ''} with ${currentListings?.length || 0} current listings`);
    return enhancedResults;

  } catch (error) {
    console.error(`[ebayApiService] Error in searchItemsWithHistory:`, error.message);
    
    // Fallback to basic search if enhanced search fails
    console.warn(`[ebayApiService] Enhanced search failed, falling back to basic search for "${itemName}"`);
    try {
      const basicResults = await searchItems(userId, itemName, limit);
      return {
        currentListings: basicResults || [],
        historicalData: null,
        marketTrends: null,
        searchMetadata: {
          itemName: itemName,
          vendorName: vendorName,
          searchTimestamp: new Date().toISOString(),
          dataSources: {
            currentListings: basicResults ? basicResults.length : 0,
            historicalData: 'failed',
            marketTrends: 'failed'
          }
        }
      };
    } catch (fallbackError) {
      console.error(`[ebayApiService] Fallback search also failed for "${itemName}":`, fallbackError.message);
      throw fallbackError;
    }
  }
}

module.exports = {
  createListing,
  getFulfillmentPolicies,
  getPaymentPolicies,
  getReturnPolicies,
  searchItems,
  getHistoricalPriceData,
  getMarketTrends,
  searchItemsWithHistory,
};
