const prisma = require('../lib/prisma');

async function getDebugProcessedEmails(req, reply) {
  try {
    const { userId, status, googleAccountId, page = 1, limit = 10 } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const where = {};
    if (userId) where.userId = parseInt(userId, 10);
    if (status) where.status = status;
    if (googleAccountId) where.googleAccountId = googleAccountId;

    const processedEmails = await prisma.processedEmail.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { processedAt: 'desc' },
      include: { // Optional: include related data if useful for debugging
        googleAccount: { select: { emailAddress: true } }
      }
    });
    const totalProcessedEmails = await prisma.processedEmail.count({ where });

    return reply.status(200).send({
      success: true,
      data: {
        data: processedEmails,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalProcessedEmails / limitNum),
        totalItems: totalProcessedEmails,
      }
    });
  } catch (error) {
    req.log.error({ err: error }, 'Error in getDebugProcessedEmails');
    throw error;
  }
}

async function getDebugUsers(req, reply) {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, createdAt: true, updatedAt: true }
    });
    return reply.status(200).send({ 
      success: true,
      data: { 
        users: users, 
        totalItems: users.length 
      }
    });
  } catch (error) {
    req.log.error({ err: error }, 'Error in getDebugUsers');
    throw error;
  }
}

async function getDebugGoogleAccounts(req, reply) {
  try {
    const { userId } = req.query;
    const where = {};
    if (userId) where.userId = parseInt(userId, 10);

    const googleAccounts = await prisma.googleAccount.findMany({
      where,
      select: {
        id: true,
        userId: true,
        emailAddress: true,
        lastSyncStatus: true,
        lastSyncAt: true,
        createdAt: true,
        user: { select: { email: true }}
      }
    });
    return reply.status(200).send({ 
      success: true,
      data: { 
        googleAccounts: googleAccounts, 
        totalItems: googleAccounts.length 
      }
    });
  } catch (error) {
    req.log.error({ err: error }, 'Error in getDebugGoogleAccounts');
    throw error;
  }
}

async function getDebugReceipts(req, reply) {
  try {
    const { userId, page = 1, limit = 10 } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const where = {};
    if (userId) where.userId = parseInt(userId, 10);

    const receipts = await prisma.receipt.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { createdAt: 'desc' }, // Assuming createdAt exists, or use transactionDate
      include: {
        items: true,
        processedEmail: { select: { subject: true, googleEmailId: true }}
      }
    });
    const totalReceipts = await prisma.receipt.count({ where });

    return reply.status(200).send({
      success: true,
      data: {
        receipts: receipts,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalReceipts / limitNum),
        totalItems: totalReceipts,
      }
    });
  } catch (error) {
    req.log.error({ err: error }, 'Error in getDebugReceipts');
    throw error;
  }
}

// Placeholder for ReceiptItems - might not be directly needed if Receipts include them
async function getDebugReceiptItems(req, reply) {
    reply.status(200).send({ 
    success: true,
    data: {
      message: "Placeholder for ReceiptItems. Often included with Receipts."
    }
  });
}


module.exports = {
  getDebugProcessedEmails,
  getDebugUsers,
  getDebugGoogleAccounts,
  getDebugReceipts,
  getDebugReceiptItems
};
