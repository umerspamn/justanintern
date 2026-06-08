const express = require('express');
const rateLimit = require('express-rate-limit');
const { cohereGenerate } = require('../controllers/aiController');

const router = express.Router();

const aiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.AI_RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many AI requests. Please slow down.' }
});

router.post('/cohere/generate', aiLimiter, cohereGenerate);

module.exports = router;
