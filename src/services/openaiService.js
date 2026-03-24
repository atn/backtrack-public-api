const OpenAI = require('openai');
require('dotenv').config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('FATAL ERROR: OPENAI_API_KEY is not defined in .env file.');
  // Service will not function without API key
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function extractReceiptDataFromEmail(emailContent) {
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API key is not configured.');
  }
  if (!emailContent || emailContent.trim().length === 0) {
    throw new Error('Email content is empty or missing.');
  }

  // Max context for gpt-3.5-turbo is typically around 4096 tokens.
  // A token is roughly 4 chars. Max content length set based on issue description example.
  const MAX_CONTENT_LENGTH = 16000;
  const truncatedContent = emailContent.length > MAX_CONTENT_LENGTH
    ? emailContent.substring(0, MAX_CONTENT_LENGTH) + "..."
    : emailContent;

  const systemMessageContent = `
You are an expert receipt parser. Extract data on **resellable physical goods only** from email receipts and return **just** this JSON—no commentary:

{
  "vendor": "store name or null",
  "totalAmount": number | null,           // Grand total, if found
  "transactionDate": "YYYY-MM-DD" | null,// Exact format; null if absent
  "items": [
    {
      "itemName": "string",
      "itemPrice": number,                // Positive unit price
      "itemQuantity": integer,            // Positive, default 1
      "sellScore": integer,               // 1-100 (e.g. 76, 41)
      "resaleValue": number | null,       // Conservative estimate
      "imageUrl": "https://….(jpg|png|gif|webp)" | null
    }
  ]
}

### Allowed Categories (everything else must be excluded)
- Electronics & accessories
- Tools
- Books (collectible / textbook / special edition)
- Furniture
- Branded apparel & footwear (no underwear/socks/basic tees)
- Collectibles
- Toys & games hardware (consoles, cards, figures)
- Outdoor & sporting gear
- Musical instruments & pro-audio hardware

### Hard Exclusions  
Food/beverage, restaurants, groceries, alcohol, supplements, vitamins • Tobacco/nicotine • Health/beauty, toiletries, cleaning supplies, consumables • Underwear/socks/low-value intimates • Services, subscriptions, fees, shipping, gift cards, warranties • Digital goods or downloads • Any item with price 0 or missing, unclear name, or non-numeric quantity.

### Validation Step (ZERO non-resellables)
1. Evaluate each line item against the **Allowed Categories**.  
2. If it fails, **do not include it**—do not downgrade or "low-score"; simply drop it.  
3. If every item is excluded, output "items": [].

### Resale-Value Estimation (accuracy)
1. Prefer median of last 90-day *completed/sold* listings on major resale sites.  
2. If no comps, apply category heuristics (55 % of MSRP for electronics, etc.).  
3. Round to nearest dollar; never exceed itemPrice UNLESS item is extremely lucrative; null if uncertain.

### Scoring Rules
80-100 = highly liquid • 50-79 = moderate • 1-49 = niche/slow. Avoid round defaults; pick precise numbers.

### Field Notes
- **vendor**: seller or null.  
- **totalAmount**: null if absent/unclear.  
- **transactionDate**: use receipt timezone if present.  
- **imageUrl**: direct, secure product photo; null if none.

### Critical Shortcut
If the vendor or line items indicate a food-related business, output "items": [] immediately.

Return valid JSON—no trailing commas, comments, or extra text.
`;

  const userMessageContent = `Parse this receipt into JSON format, extracting ONLY resellable physical goods:
${truncatedContent}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemMessageContent },
        { role: "user", content: userMessageContent }
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 1000, // Increased max_tokens to ensure we get a complete response
    });

    const jsonResponseString = completion.choices[0]?.message?.content;
    if (!jsonResponseString) {
      console.error('OpenAI response was empty:', completion);
      throw new Error('OpenAI response content is empty.');
    }

    try {
      const extractedData = JSON.parse(jsonResponseString);
      
      // Validate the response structure
      if (!extractedData || typeof extractedData !== 'object') {
        throw new Error('Invalid response format: not an object');
      }

      // Ensure vendorName is a string or null
      if (extractedData.vendor !== null && typeof extractedData.vendor !== 'string') {
        extractedData.vendor = String(extractedData.vendor);
      }

      // Ensure totalAmount is a number or null
      if (extractedData.totalAmount !== null && typeof extractedData.totalAmount !== 'number') {
         const parsedAmount = parseFloat(extractedData.totalAmount);
         extractedData.totalAmount = isNaN(parsedAmount) ? null : parsedAmount;
      }

      // Ensure transactionDate is a valid date string or null
      if (extractedData.transactionDate !== null && typeof extractedData.transactionDate === 'string') {
        const date = new Date(extractedData.transactionDate);
        if (isNaN(date.getTime())) {
          extractedData.transactionDate = null;
        } else {
          // Format as YYYY-MM-DD
          extractedData.transactionDate = date.toISOString().split('T')[0];
        }
      } else if (extractedData.transactionDate !== null) {
        extractedData.transactionDate = null;
      }

      // Ensure items is an array
      if (!Array.isArray(extractedData.items)) {
        extractedData.items = [];
      }

      // Validate each item
      extractedData.items = extractedData.items.filter(item => {
        if (!item || typeof item !== 'object') return false;
        
        // Ensure required fields exist and are of correct type
        if (typeof item.itemName !== 'string' || !item.itemName.trim()) return false;

        // itemPrice can be a number (per prompt). Must be positive.
        if (typeof item.itemPrice !== 'number' || item.itemPrice <= 0) return false;

        // itemQuantity can be a number (per prompt). Must be a positive integer.
        if (typeof item.itemQuantity !== 'number' || !Number.isInteger(item.itemQuantity) || item.itemQuantity <= 0) return false;

        if (typeof item.resaleValue !== 'number' || item.resaleValue <= 0) return false;

        // Validate sellScore (new)
        if (item.hasOwnProperty('sellScore')) {
          if (typeof item.sellScore === 'number') {
            item.sellScore = Math.round(item.sellScore); // Ensure integer
            if (item.sellScore < 1) item.sellScore = 1;
            if (item.sellScore > 100) item.sellScore = 100;
          } else {
            // If sellScore is present but not a number, set to null
            item.sellScore = null;
          }
        } else {
          // If sellScore is not present at all, set to null
          item.sellScore = null;
        }
        
        return true;
      });
      
      // Deduplicate items with same name and price
      const itemMap = new Map();
      extractedData.items.forEach(item => {
        const key = `${item.itemName.toLowerCase().trim()}-${item.itemPrice}`;
        if (itemMap.has(key)) {
          // Consolidate quantities for duplicate items
          const existingItem = itemMap.get(key);
          existingItem.itemQuantity += item.itemQuantity;
          // Keep the higher sellScore and resaleValue
          if (item.sellScore && (!existingItem.sellScore || item.sellScore > existingItem.sellScore)) {
            existingItem.sellScore = item.sellScore;
          }
          if (item.resaleValue && (!existingItem.resaleValue || item.resaleValue > existingItem.resaleValue)) {
            existingItem.resaleValue = item.resaleValue;
          }
        } else {
          itemMap.set(key, { ...item });
        }
      });
      
      // Convert back to array
      extractedData.items = Array.from(itemMap.values());
      
      return extractedData;
    } catch (parseError) {
      console.error('Failed to parse OpenAI response:', jsonResponseString);
      throw new Error('Failed to parse OpenAI response as valid JSON');
    }

  } catch (error) {
    console.error('Error calling OpenAI API:', error.response ? error.response.data : error.message);
    if (error.response && error.response.status === 401) {
      throw new Error('OpenAI API authentication error. Check your API key.');
    }
    if (error.response && error.response.status === 429) {
      throw new Error('OpenAI API rate limit exceeded.');
    }
    throw new Error(`Failed to extract receipt data using OpenAI: ${error.message}`);
  }
}

async function getEbayCategoryId(itemName, itemDescription = null) {
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API key is not configured.');
  }
  if (!itemName || itemName.trim().length === 0) {
    throw new Error('Item name is required.');
  }

  const systemMessageContent = `
You are an expert at categorizing items for eBay listings. Given an item name and optional description, determine the most appropriate eBay category ID from the US marketplace.

Return ONLY a JSON object with the category ID as a string:

{
  "categoryId": "string"
}

Use these common eBay category IDs for the US marketplace:

Electronics:
- Cell Phones & Smartphones: "9355"
- Computers/Tablets & Networking: "58058"
- Video Games & Consoles: "139973"
- Cameras & Photo: "625"
- Audio: "293"

Clothing & Accessories:
- Men's Clothing: "11450"
- Women's Clothing: "15724"
- Shoes: "3034"
- Jewelry & Watches: "281"

Home & Garden:
- Home & Garden: "11700"
- Tools & Workshop Equipment: "631"
- Books & Magazines: "267"

Sports & Hobbies:
- Sporting Goods: "888"
- Toys & Hobbies: "220"

Collectibles & Art:
- Collectibles: "1"
- Antiques: "20081"

Automotive:
- Auto Parts & Accessories: "6028"

Health & Beauty:
- Health & Beauty: "26395"

Baby & Kids:
- Baby: "2984"

Pet Supplies:
- Pet Supplies: "1281"

Rules:
1. Choose the most specific category that fits the item
2. If the item could fit multiple categories, choose the one where it would be most likely to sell
3. For electronics, prefer the most specific category (e.g., "9355" for phones over "58058" for general electronics)
4. For clothing, consider the target gender if specified
5. If unsure, default to "1" (Collectibles) as it's the most general category

Return valid JSON—no trailing commas, comments, or extra text.
`;

  const userMessageContent = `Determine the eBay category ID for this item:
Item Name: ${itemName}
${itemDescription ? `Description: ${itemDescription}` : ''}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemMessageContent },
        { role: "user", content: userMessageContent }
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 100,
    });

    const jsonResponseString = completion.choices[0]?.message?.content;
    if (!jsonResponseString) {
      console.error('OpenAI response was empty:', completion);
      throw new Error('OpenAI response content is empty.');
    }

    try {
      const result = JSON.parse(jsonResponseString);
      
      // Validate the response structure
      if (!result || typeof result !== 'object') {
        throw new Error('Invalid response format: not an object');
      }

      if (!result.categoryId || typeof result.categoryId !== 'string') {
        throw new Error('Invalid response format: missing or invalid categoryId');
      }

      return result.categoryId;
    } catch (parseError) {
      console.error('Failed to parse OpenAI response:', jsonResponseString);
      throw new Error('Failed to parse OpenAI response as valid JSON');
    }

  } catch (error) {
    console.error('Error calling OpenAI API for category ID:', error.response ? error.response.data : error.message);
    if (error.response && error.response.status === 401) {
      throw new Error('OpenAI API authentication error. Check your API key.');
    }
    if (error.response && error.response.status === 429) {
      throw new Error('OpenAI API rate limit exceeded.');
    }
    throw new Error(`Failed to get eBay category ID using OpenAI: ${error.message}`);
  }
}

module.exports = {
  extractReceiptDataFromEmail,
  getEbayCategoryId,
};
