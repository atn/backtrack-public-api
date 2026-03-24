// Import the Expo SDK
const { Expo } = require('expo-server-sdk');

// Create a new Expo SDK client
let expo = new Expo({accessToken: process.env.EXPO_ACCESS_TOKEN});

// In-memory store for push tickets
let tickets = [];

// Function to send push notifications
const sendPushNotifications = async (pushTokens, messagePayload) => {
  // Validate inputs
  if (!Array.isArray(pushTokens) || pushTokens.length === 0) {
    throw new Error('Invalid push tokens: Must be a non-empty array.');
  }
  if (!messagePayload || typeof messagePayload !== 'object') {
    throw new Error('Invalid message payload: Must be an object.');
  }

  let messages = [];
  for (let pushToken of pushTokens) {
    // Each push token looks like ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]

    // Check that all your push tokens appear to be valid Expo push tokens
    if (!Expo.isExpoPushToken(pushToken)) {
      console.error(`Push token ${pushToken} is not a valid Expo push token`);
      continue;
    }

    // Construct a message (see https://docs.expo.io/push-notifications/sending-notifications/)
    messages.push({
      to: pushToken,
      sound: messagePayload.sound || 'default',
      body: messagePayload.body,
      data: messagePayload.data || {},
      title: messagePayload.title, // Add title field
      badge: messagePayload.badge, // Add badge field
    });
  }

  // The Expo push notification service accepts batches of notifications so
  // that you don't need to send 1000 requests to send 1000 notifications. We
  // recommend you send batches of notifications no larger than 100 messages.
  let chunks = expo.chunkPushNotifications(messages);
  let currentTickets = []; // Renamed to avoid conflict with global tickets

  // Send the chunks to the Expo push notification service. There are
  // different strategies you could use. A simple one is to send one chunk at a
  // time, which nicely spreads the load out over time:
  for (let chunk of chunks) {
    try {
      let ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      console.log('Push notification tickets:', ticketChunk);
      currentTickets.push(...ticketChunk); // Use currentTickets
      // NOTE: If a ticket contains an error code in ticket.details.error, you
      // must handle it appropriately. The error codes are listed in the Expo
      // documentation:
      // https://docs.expo.io/push-notifications/sending-notifications/#individual-errors
    } catch (error) {
      console.error('Error sending push notifications:', error);
      // Basic error handling: rethrow or handle specific errors
      if (error.statusCode === 400) {
        throw new Error('Bad request to Expo server. Check message format.');
      }
      // Consider more specific error handling based on Expo's documentation
    }
  }
  // Store tickets in the global tickets array
  tickets.push(...currentTickets); // Add new tickets to the global array
  return currentTickets; // Return the tickets for this batch
};

// Function to check push receipts
const checkPushReceipts = async (ticketIds) => {
  // Validate inputs
  if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
    throw new Error('Invalid ticket IDs: Must be a non-empty array.');
  }
  // The Expo push notification service allows checking receipts in batches of 1000.
  let receiptIdChunks = expo.chunkPushNotificationReceiptIds(ticketIds);

  for (let chunk of receiptIdChunks) {
    try {
      let receipts = await expo.getPushNotificationReceiptsAsync(chunk);
      console.log('Push notification receipts:', receipts);

      // Like sending notifications, there are different strategies you could use
      // to retrieve batches of receipts from the Expo service.
      for (let receiptId in receipts) {
        let { status, message, details } = receipts[receiptId];
        if (status === 'ok') {
          continue;
        } else if (status === 'error') {
          console.error(
            `There was an error sending a notification: ${message}`
          );
          if (details && details.error) {
            // The error codes are listed in the Expo documentation:
            // https://docs.expo.io/push-notifications/sending-notifications/#individual-errors
            // You must handle the errors appropriately.
            console.error(`The error code is ${details.error}`);
            if (details.error === 'DeviceNotRegistered') {
              // Remove the push token from your database
              // This will be implemented later if a database is added
            }
          }
        }
      }
    } catch (error) {
      console.error('Error fetching push receipts:', error);
      // Basic error handling
      if (error.statusCode === 400) {
        throw new Error('Bad request to Expo server. Check ticket IDs.');
      }
      // Consider more specific error handling
    }
  }
  // Remove checked tickets from the in-memory store
  tickets = tickets.filter(ticket => !ticketIds.includes(ticket.id));
  return true; // Indicate success or return receipts if needed
};

module.exports = {
  sendPushNotifications,
  checkPushReceipts,
};
