const jwt = require('jsonwebtoken');
require('dotenv').config(); // To load JWT_SECRET from .env

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('FATAL ERROR: JWT_SECRET is not defined in .env file.');
  process.exit(1); // Exit if JWT_SECRET is not set
}

function generateToken(payload) {
  try {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
  } catch (error) {
    console.error('Error generating JWT token:', error);
    throw new Error('Token generation failed');
  }
}

function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded;
  } catch (error) {
    console.error('Error verifying JWT token:', error);
    // Differentiate between expired token and invalid token for better error handling downstream
    if (error.name === 'TokenExpiredError') {
      throw new Error('Token expired');
    }
    throw new Error('Invalid token');
  }
}

module.exports = {
  generateToken,
  verifyToken,
};
