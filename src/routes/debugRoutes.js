const debugController = require('../controllers/debugController');

async function debugRoutes(fastify, options) {
  fastify.get('/', (req, res) => {
    res.send({ message: 'Hello World' });
  });
}

module.exports = debugRoutes;
