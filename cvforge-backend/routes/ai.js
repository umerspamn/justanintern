const express = require('express');
const rateLimit = require('express-rate-limit');
const { groqGenerate } = require('../controllers/aiController');

const router = express.Router();

const aiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.AI_RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many AI requests. Please slow down.' }
});

// New canonical path
router.post('/groq/generate', aiLimiter, groqGenerate);
// Backwards-compatible alias so the existing frontend keeps working
router.post('/cohere/generate', aiLimiter, groqGenerate);

module.exports = router;