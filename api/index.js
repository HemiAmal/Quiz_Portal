// Vercel's serverless entry point. server.js detects it's being `require`d rather than run directly
// and exports an async request handler instead of calling app.listen().
module.exports = require('../server');
