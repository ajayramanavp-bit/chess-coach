const rateLimit = require('express-rate-limit');

const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { error: 'Too many AI requests. Please wait an hour.' }
});

const analysisLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 5,
  message: { error: 'Free tier: max 5 analyses per day.' }
});

module.exports = { chatLimiter, analysisLimiter };