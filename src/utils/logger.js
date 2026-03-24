const pino = require('pino');

function createLogger(serviceName) {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    base: {
      service: serviceName,
    },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
  });
}

module.exports = {
  createLogger,
}; 