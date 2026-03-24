# API Documentation

This document provides details for the Receipt Parser API.

## Base URL

All API endpoints are prefixed with `/api` unless otherwise noted (e.g., health checks). The actual base URL will depend on your deployment (e.g., `http://localhost:3000` or `https://yourdomain.com`).

## Authentication

Most endpoints require authentication using a JWT Bearer token provided in the `Authorization` header:
`Authorization: Bearer <YOUR_JWT_TOKEN>`

Endpoints that do not require authentication will be explicitly noted.

---

## 1. Authentication (`/api/auth`)

### 1.1. `POST /api/auth/signup`

*   **Description:** Registers a new user.
*   **Authentication:** Not Required.
*   **Request Headers:** `Content-Type: application/json`
*   **Request Body:**
    ```json
    {
      "email": "user@example.com",    // string, required, valid email format
      "password": "securepassword123" // string, required, min 8 characters
    }
    ```
*   **Success Response (`201 Created`):**
    ```json
    {
      "token": "jwt.token.string" // JWT token for the new user session
    }
    ```
*   **Error Responses:**
    *   `400 Bad Request`: Invalid email format, password too short, or missing fields.
      ```json
      { "message": "Email and password are required" }
      // or
      { "message": "Invalid email format" }
      // or
      { "message": "Password must be at least 8 characters long" }
      ```
    *   `409 Conflict`: User already exists with this email.
      ```json
      { "message": "User already exists with this email" }
      ```
    *   `500 Internal Server Error`:
      ```json
      { "message": "Internal Server Error" }
      ```

### 1.2. `POST /api/auth/login`

*   **Description:** Logs in an existing user.
*   **Authentication:** Not Required.
*   **Request Headers:** `Content-Type: application/json`
*   **Request Body:**
    ```json
    {
      "email": "user@example.com",    // string, required
      "password": "securepassword123" // string, required
    }
    ```
*   **Success Response (`200 OK`):**
    ```json
    {
      "token": "jwt.token.string" // JWT token for the user session
    }
    ```
*   **Error Responses:**
    *   `400 Bad Request`: Missing email or password.
      ```json
      { "message": "Email and password are required" }
      ```
    *   `401 Unauthorized`: Invalid credentials.
      ```json
      { "message": "Invalid email or password" }
      ```
    *   `500 Internal Server Error`:
      ```json
      { "message": "Internal Server Error" }
      ```

### 1.3. `GET /api/auth/me`

*   **Description:** Retrieves details for the currently authenticated user, including the status of their linked external accounts.
*   **Authentication:** Required (JWT Bearer token).
*   **Success Response (`200 OK`):**
    ```json
    {
      "id": 1,
      "email": "user@example.com",
      "isGoogleConnected": true, // boolean, true if at least one Google account is linked
      "connectedGoogleEmails": ["user_google_email@gmail.com"], // array of strings (email addresses of linked Google accounts)
      "isEbayConnected": false // boolean
    }
    ```
*   **Error Responses:**
    *   `401 Unauthorized`: Invalid or missing token.
    *   `404 Not Found`: User not found (should not happen if token is valid).
    *   `500 Internal Server Error`.

### 1.4. `GET /api/auth/google`

*   **Description:** Initiates the Google OAuth 2.0 authorization flow. Redirects the user to Google's authentication page.
*   **Authentication:** Required (JWT Bearer token - to associate the Google account with the logged-in user upon callback).
*   **Success Response:** Redirects to Google (e.g., `302 Found`).
*   **Error Responses:**
    *   `401 Unauthorized`.
    *   `500 Internal Server Error`.

### 1.5. `GET /api/auth/google/callback`

*   **Description:** Handles the callback from Google after user authentication. Exchanges the authorization code for tokens and links the Google account to the authenticated user.
*   **Authentication:** Session managed by Google OAuth flow; application user context established via JWT before initiating flow.
*   **Query Parameters:**
    *   `code (string, required)`: Authorization code from Google.
    *   `state (string, optional but recommended)`: State parameter for CSRF protection (if implemented).
    *   `error (string, optional)`: Error code from Google if authentication failed.
*   **Success Response (`200 OK`):**
    ```json
    {
      "message": "Google account linked successfully.",
      "googleAccountId": "cuid_string_for_google_account",
      "email": "user_google_email@gmail.com"
    }
    ```
    *(Note: Often, this endpoint redirects to a frontend page rather than returning JSON directly.)*
*   **Error Responses:**
    *   `400 Bad Request`: Missing authorization code.
    *   `401 Unauthorized`: If Google reports an auth error.
    *   `409 Conflict`: If the Google account is already linked to a different user.
      ```json
      { "error": "This Google account is already linked to a different user." }
      ```
    *   `500 Internal Server Error`: Failure during token exchange or database update.
    *   `502 Bad Gateway`: If communication with Google fails.

### 1.6. `POST /api/auth/google/mobile-signin`

*   **Description:** Handles Google sign-in or linking for mobile (Expo) clients. It accepts a Google ID Token or a Server Authorization Code obtained by the client.
*   **Authentication:** Not Required for the endpoint itself (as it's used for sign-in/initial link).
*   **Request Headers:** `Content-Type: application/json`
*   **Request Body:**
    ```json
    // Provide EITHER idToken OR serverAuthCode
    {
      "idToken": "string_google_id_token"
    }
    // OR
    {
      "serverAuthCode": "string_server_auth_code"
    }
    ```
    One of `idToken` or `serverAuthCode` is required.
*   **Success Response (`200 OK`):**
    ```json
    {
      "token": "your_application_jwt_token_string", // Application's session JWT
      "user": {
        "id": "cuid_user_id",
        "email": "user_app_email@example.com",     // Application user email
        "googleEmail": "user_google_email@gmail.com" // Email from the authenticated Google account
      }
    }
    ```
*   **Error Responses:**
    *   `400 Bad Request`: If neither `idToken` nor `serverAuthCode` is provided. Example: `{ "message": "Google ID token or server authorization code is required." }`
    *   `401 Unauthorized`: If Google token/code verification fails. Example: `{ "message": "Invalid Google ID token." }` or `{ "message": "Failed to process Google server authorization code." }`
    *   `409 Conflict`: If the Google account is already linked to a different user. Example: `{ "message": "This Google account is already linked to a different user." }`
    *   `500 Internal Server Error`: For other server-side issues. Example: `{ "message": "An internal error occurred during Google sign-in." }`

### 1.7. `GET /api/auth/ebay`

*   **Description:** Initiates the eBay OAuth 2.0 authorization flow. Redirects the user to eBay's authentication page.
*   **Authentication:** Required (JWT Bearer token).
*   **Success Response:** Redirects to eBay (e.g., `302 Found`).
*   **Error Responses:**
    *   `401 Unauthorized`.
    *   `500 Internal Server Error`.

### 1.7. `GET /api/auth/ebay/callback`

*   **Description:** Handles the callback from eBay after user authentication. Exchanges the authorization code for tokens and links the eBay account.
*   **Authentication:** Session managed by eBay OAuth flow.
*   **Query Parameters:**
    *   `code (string, required)`: Authorization code from eBay.
    *   `state (string, required)`: State parameter for CSRF protection (must match state sent during initiation).
    *   `error (string, optional)`: Error code from eBay if authentication failed.
*   **Success Response (`200 OK`):**
    ```json
    {
      "message": "eBay account linked successfully."
    }
    ```
    *(Note: Often, this endpoint redirects to a frontend page.)*
*   **Error Responses:**
    *   `400 Bad Request`: Missing authorization code or state.
    *   `401 Unauthorized`: Invalid state, or eBay reports an auth error.
    *   `500 Internal Server Error`.

---

## 2. Gmail Service API (`/api/gmail`)

All endpoints in this section require authentication (JWT Bearer token).

### 2.1. `GET /api/gmail/accounts`

*   **Description:** Lists all Google accounts linked by the authenticated user.
*   **Authentication:** Required.
*   **Success Response (`200 OK`):**
    ```json
    [
      {
        "id": "cuid_google_account_1",
        "emailAddress": "user1@gmail.com",
        "lastSyncAt": "2023-10-26T10:00:00.000Z", // or null
        "lastSyncStatus": "SUCCESS", // or null, PENDING_INITIAL_SYNC, ERROR_AUTH, etc.
        "createdAt": "2023-01-15T12:00:00.000Z"
      },
      // ... more accounts
    ]
    ```
*   **Error Responses:**
    *   `401 Unauthorized`.
    *   `500 Internal Server Error`.

### 2.2. `DELETE /api/gmail/accounts/:accountId`

*   **Description:** Unlinks a specific Google account for the authenticated user and attempts to revoke its token with Google.
*   **Authentication:** Required.
*   **Path Parameters:**
    *   `:accountId (string, required)`: The ID of the `GoogleAccount` record to unlink.
*   **Success Response (`200 OK`):**
    ```json
    {
      "message": "Google account unlinked successfully."
    }
    ```
*   **Error Responses:**
    *   `400 Bad Request`: If `accountId` is missing (though usually caught by path param validation).
    *   `401 Unauthorized`.
    *   `403 Forbidden`: If the user does not own the specified `GoogleAccount`.
    *   `404 Not Found`: If the `GoogleAccount` with the given ID does not exist.
    *   `500 Internal Server Error`.

### 2.3. `POST /api/gmail/process-emails`

*   **Description:** Manually triggers the processing of new (unread, matching criteria) emails for a specific linked Google account. This is an alternative to the background sync.
*   **Authentication:** Required.
*   **Request Headers:** `Content-Type: application/json`
*   **Request Body:**
    ```json
    {
      "googleAccountId": "cuid_of_the_google_account" // string, required
    }
    ```
*   **Success Response (`200 OK`):**
    ```json
    {
      "message": "Email processing task completed for Google Account user@example.com.",
      "found": 1, // Number of new emails found and marked for extraction
      "skipped_already_processed": 0,
      "skipped_not_receipt": 5,
      "errors": 0,
      "next_page_available": false
    }
    ```
    *(Note: The exact fields in the summary might vary.)*
*   **Error Responses:**
    *   `400 Bad Request`: `googleAccountId` missing.
    *   `401 Unauthorized`: If Google token for the account is invalid/revoked.
    *   `403 Forbidden`: User does not own the `googleAccountId`.
    *   `404 Not Found`: `GoogleAccount` not found.
    *   `500 Internal Server Error`.
    *   `502 Bad Gateway`: If communication with Google fails.


### 2.4. `POST /api/gmail/rescan-recent`

*   **Description:** Manually triggers a rescan of the 50 most recent emails for a specific linked Google account, attempting to process them if they haven't been processed before.
*   **Authentication:** Required.
*   **Request Headers:** `Content-Type: application/json`
*   **Request Body:**
    ```json
    {
      "googleAccountId": "cuid_of_the_google_account" // string, required
    }
    ```
*   **Success Response (`200 OK`):**
    ```json
    {
      "message": "Rescan of recent 50 emails task completed for Google Account user@example.com.",
      "processed_for_extraction": 2,
      "skipped_already_processed": 48,
      "skipped_not_receipt": 0,
      "errors": 0
    }
    ```
    *(Note: The exact fields in the summary might vary.)*
*   **Error Responses:** Same as `/api/gmail/process-emails`.

### 2.5. `POST /api/gmail/accounts/:googleAccountId/trigger-full-sync`

*   **Description:** Manually triggers a full historical email sync for the specified Google Account. This process can take a significant amount of time and will run in the background. It fetches all emails (up to system-defined limits per run, if any) and processes them to identify potential receipts.
*   **Authentication:** Required (JWT Bearer token).
*   **Path Parameters:**
    *   `:googleAccountId (string, required)`: The ID of the `GoogleAccount` for which to trigger the full sync.
*   **Request Body:** None.
*   **Success Response (`202 Accepted`):**
    ```json
    {
      "message": "Full sync process initiated for the Google Account. Check account status for updates."
    }
    ```
*   **Error Responses:**
    *   `401 Unauthorized`: Invalid or missing token.
    *   `403 Forbidden`: If the `GoogleAccount` does not belong to the authenticated user.
    *   `404 Not Found`: If the `GoogleAccount` with the given ID does not exist.
    *   `500 Internal Server Error`: If there's an issue initiating the background task.

---

## 3. Receipt Processing & Listing (`/api/receipts` and `/api/user-receipts`)

### 3.1. `POST /api/receipts/extract-pending`

*   **Description:** Triggers the background task to extract structured data from emails that are marked as `PENDING_OPENAI_PROCESSING`. This is an asynchronous trigger; the actual processing happens in the background using a parallelized approach.
*   **Authentication:** Required.
*   **Request Body:** None, or an empty object `{}`.
*   **Success Response (`200 OK` or `202 Accepted`):**
    ```json
    {
      "message": "Receipt extraction process initiated.",
      // The response may include a summary of the immediate batch trigger,
      // but the full processing is asynchronous.
      "emailsConsidered": 10, // Example: Number of emails in the batch picked up by this trigger
      "successfulExtractions": 0, // This will be 0 as processing is async
      // ... other counters related to the batch picked up
    }
    ```
*   **Error Responses:**
    *   `401 Unauthorized`.
    *   `500 Internal Server Error`.

### 3.2. `GET /api/user-receipts`

*   **Description:** Lists receipts for the authenticated user with pagination.
*   **Authentication:** Required.
*   **Query Parameters:**
    *   `page (integer, optional, default: 1)`: Page number for pagination.
    *   `limit (integer, optional, default: 10, max: 100)`: Number of receipts per page.
*   **Success Response (`200 OK`):**
    ```json
    {
      "receipts": [
        {
          "id": "cuid_receipt_1",
          "userId": 1,
          "processedEmailId": "cuid_processed_email_1",
          "vendorName": "Example Store",
          "transactionDate": "2023-10-26T00:00:00.000Z",
          "totalAmount": 123.45,
          "currency": "USD",
          "extractedAt": "2023-10-26T12:00:00.000Z", // This field might be deprecated or renamed, check `createdAt` on Receipt
          "status": "PROCESSED",
          "items": [
            {
              "id": "cuid_item_1",
              "receiptId": "cuid_receipt_1",
              "itemName": "Product A",
              "itemPrice": 50.00,
              "itemQuantity": 2,
              "resaleValue": null // This field might be deprecated or part of a different model
            }
          ],
          "processedEmail": { // Details of the source email
            "id": "cuid_processed_email_1",
            "subject": "Your Example Store Order Confirmation",
            "snippet": "Thank you for your order...",
            "receivedAt": "2023-10-26T09:00:00.000Z",
            "status": "PROCESSED_RECEIPT_VIA_OPENAI", // Status of the email processing itself
            "errorMessage": null, // Error message if processing failed at any stage
            "googleAccount": {
              "id": "cuid_google_account_1",
              "emailAddress": "user@gmail.com"
            }
            // Note: `extractedDataJson` and `rawContent` from ProcessedEmail are not typically returned here for brevity,
            // but are available via debug endpoints.
          }
        }
        // ... more receipts
      ],
      "currentPage": 1,
      "totalPages": 5,
      "totalItems": 50
    }
    ```
*   **Error Responses:**
    *   `400 Bad Request`: Invalid pagination parameters.
    *   `401 Unauthorized`.
    *   `500 Internal Server Error`.

### 3.3. `GET /api/user-receipts/:receiptId`

*   **Description:** Gets a specific receipt by its ID, ensuring it belongs to the authenticated user.
*   **Authentication:** Required.
*   **Path Parameters:**
    *   `:receiptId (string, required)`: The ID of the receipt to retrieve.
*   **Success Response (`200 OK`):**
    *(Same structure as a single receipt object in the `GET /api/user-receipts` response array)*
    ```json
    {
      "id": "cuid_receipt_1",
      // ... other fields as above
    }
    ```
*   **Error Responses:**
    *   `401 Unauthorized`.
    *   `403 Forbidden`: If the receipt does not belong to the authenticated user.
    *   `404 Not Found`: If the receipt with the given ID does not exist.
    *   `500 Internal Server Error`.

---

## 4. eBay Operations (`/api/ebay`)

All endpoints in this section require authentication (JWT Bearer token).

### 4.1. `GET /api/ebay/policies/fulfillment`
### 4.2. `GET /api/ebay/policies/payment`
### 4.3. `GET /api/ebay/policies/return`

*   **Description:** Get eBay business policies (Fulfillment, Payment, Return respectively) for the authenticated user's linked eBay account.
*   **Authentication:** Required.
*   **Query Parameters:**
    *   `marketplace_id (string, required)`: e.g., "EBAY_US".
*   **Success Response (`200 OK`):**
    ```json
    // Example for fulfillment policies
    {
      "policies": [
        {
          "fulfillmentPolicyId": "1234567890",
          "name": "Standard Shipping Policy",
          "description": "Ships within 1 business day.",
          "marketplaceId": "EBAY_US"
          // ... other policy-specific fields
        }
      ]
    }
    ```
*   **Error Responses:**
    *   `400 Bad Request`: Missing `marketplace_id`.
    *   `401 Unauthorized`: User not authenticated or eBay account not linked/token invalid.
    *   `500 Internal Server Error`: Error fetching from eBay API.

### 4.4. `GET /api/ebay/vault-items`

*   **Description:** Lists receipt items from the user's processed receipts that are deemed suitable for listing on eBay (e.g., not already listed, physical goods).
*   **Authentication:** Required.
*   **Query Parameters (Optional for pagination, if implemented):**
    *   `page (integer, optional, default: 1)`
    *   `limit (integer, optional, default: 10)`
*   **Success Response (`200 OK`):**
    ```json
    {
      "items": [
        {
          "id": "cuid_receipt_item_1", // ID of the ReceiptItem
          "itemName": "Specific Product Name",
          "quantity": 1, // Available quantity from the receipt item
          "price": 45.99, // Original purchase price
          "receipt": {
            "vendorName": "Best Buy",
            "transactionDate": "2023-09-15T00:00:00.000Z"
          }
          // Potentially add other fields like suggested eBay category, etc.
        }
      ],
      "currentPage": 1, // If paginated
      "totalPages": 1,  // If paginated
      "totalItems": 1   // If paginated
    }
    ```
*   **Error Responses:**
    *   `401 Unauthorized`.
    *   `500 Internal Server Error`.

### 4.5. `POST /api/ebay/list-item`

*   **Description:** Creates an eBay listing from a specified "vault item" (ReceiptItem).
*   **Authentication:** Required.
*   **Request Headers:** `Content-Type: application/json`
*   **Request Body:**
    ```json
    {
      "receiptItemId": "cuid_receipt_item_to_list", // string, required
      "title": "Custom eBay Listing Title",          // string, required
      "description": "Detailed description of the item for eBay.", // string, required
      "price": 79.99,                               // number, required (listing price on eBay)
      "fulfillmentPolicyId": "ebay_fulfillment_policy_id", // string, required
      "paymentPolicyId": "ebay_payment_policy_id",       // string, required
      "returnPolicyId": "ebay_return_policy_id"          // string, required
      // Potentially: "categoryId": "ebay_category_id" (string, optional)
      // Potentially: "condition": "NEW" or "USED_EXCELLENT" (string, optional)
    }
    ```
*   **Success Response (`201 Created` or `200 OK`):**
    ```json
    {
      "listingId": "ebay_listing_id_string", // ID of the newly created eBay listing
      "status": "LISTING_ACTIVE", // or similar status from eBay
      "viewItemURL": "https://www.ebay.com/itm/..."
    }
    ```
*   **Error Responses:**
    *   `400 Bad Request`: Missing required fields, invalid data.
    *   `401 Unauthorized`: User not authenticated or eBay account not linked/token invalid.
    *   `404 Not Found`: `receiptItemId` not found or not available for listing.
    *   `500 Internal Server Error`: Error creating listing on eBay API.

---

## 5. Debug Endpoints (`/api/debug`)

These endpoints are intended for debugging and development purposes. Access might be restricted in production environments. All endpoints in this section require authentication.

### 5.1. `GET /api/debug/processed-emails`

*   **Description:** Retrieves a paginated list of `ProcessedEmail` records, allowing for filtering by `userId`, `googleAccountId`, and `status`.
*   **Authentication:** Required.
*   **Query Parameters:**
    *   `page (integer, optional, default: 1)`
    *   `limit (integer, optional, default: 10)`
    *   `userId (string, optional)`: Filter by user ID.
    *   `googleAccountId (string, optional)`: Filter by Google Account ID.
    *   `status (string, optional)`: Filter by processing status.
*   **Success Response (`200 OK`):**
    ```json
    {
      "data": [
        {
          "id": "cuid_processed_email_1",
          "userId": "cuid_user_1",
          "googleAccountId": "cuid_google_account_1",
          "googleEmailId": "gmail_id_string_1",
          "status": "PROCESSED_RECEIPT_VIA_OPENAI", // See note below for more statuses
          "subject": "Your Order Confirmation",
          "sender": "store@example.com",
          "receivedAt": "2023-10-27T10:00:00.000Z",
          "createdAt": "2023-10-27T10:00:05.000Z",
          "updatedAt": "2023-10-27T10:00:15.000Z",
          "errorMessage": null, // string, null if no error, or detailed error message
          "extractedDataJson": "{\"vendor\":\"Example Store\",\"items\":[{\"name\":\"Product A\",\"price\":50,\"quantity\":2}]}", // string, null or JSON string of extracted data
          "rawContent": "Email body text or HTML snippet..." // string, null or the raw content processed
        }
        // ... more processed emails
      ],
      "page": 1,
      "totalPages": 3,
      "totalItems": 30
    }
    ```
    **Note on `ProcessedEmail` object:**
    *   The `status` field can have various values indicating the stage or outcome of processing (e.g., `PENDING_GMAIL_FETCH`, `PENDING_OPENAI_PROCESSING`, `PROCESSING_OPENAI`, `PROCESSED_RECEIPT_VIA_OPENAI`, `SKIPPED_ALREADY_PROCESSED`, `SKIPPED_NOT_A_RECEIPT_CANDIDATE`, `EXTRACTION_FAILED_NO_CONTENT`, `EXTRACTION_FAILED_OPENAI_API_ERROR`, `OPENAI_EXTRACTION_EMPTY_RESULT`, `OPENAI_NO_RESELLABLE_ITEMS_FOUND`, `OPENAI_INVALID_DATA_FORMAT`, `EXTRACTION_FAILED_DB_ERROR`, `EXTRACTION_FAILED_PROCESSING_ERROR`). This list may evolve.
    *   `errorMessage`: Provides details if an error occurred during any processing stage.
    *   `extractedDataJson`: Contains the raw JSON string response from OpenAI. Useful for debugging extraction issues.
    *   `rawContent`: The actual text or HTML content of the email that was fed into the extraction process.

*   **Error Responses:**
    *   `400 Bad Request`: Invalid query parameters.
    *   `401 Unauthorized`.
    *   `500 Internal Server Error`.

---

## 6. Health Checks (root path)

These endpoints do not require authentication.

### 6.1. `GET /healthz`

*   **Description:** Liveness probe. Indicates if the application process is running.
*   **Authentication:** Not Required.
*   **Success Response (`200 OK`):**
    ```json
    {
      "status": "OK",
      "timestamp": "YYYY-MM-DDTHH:mm:ss.sssZ",
      "message": "Application is running"
    }
    ```
*   **Error Responses:** Unlikely for this endpoint; if the app is down, it won't respond.

### 6.2. `GET /readyz`

*   **Description:** Readiness probe. Indicates if the application is ready to serve traffic (e.g., critical dependencies like database are available).
*   **Authentication:** Not Required.
*   **Success Response (`200 OK`):**
    ```json
    {
      "status": "OK",
      "timestamp": "YYYY-MM-DDTHH:mm:ss.sssZ",
      "message": "Application is ready to serve traffic"
    }
    ```
*   **Error Responses:**
    *   `503 Service Unavailable`: If a critical dependency (e.g., database, essential config) is not ready.
      ```json
      {
        "status": "UNAVAILABLE",
        "message": "Database connection failed."
        // or "Critical configuration (OpenAI API Key) missing."
      }
      ```

---
