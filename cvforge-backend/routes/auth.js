// ═══════════════════════════════════════════════════════════════
//  routes/auth.js
//
//  POST   /api/auth/register        ← create account
//  POST   /api/auth/login           ← get JWT token
//  POST   /api/auth/logout          ← revoke token
//  GET    /api/auth/me              ← get current user profile
//  POST   /api/auth/change-password ← update password
// ═══════════════════════════════════════════════════════════════

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { protect } = require('../middleware/auth');
const {
  register,
  login,
  logout,
  me,
  changePassword
} = require('../controllers/authController');

const router = express.Router();

// ── Strict rate limit for auth endpoints ─────────────────────────
// Prevents brute-force login attacks
const authLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX)  || 10,
  message:  { success: false, error: 'Too many attempts. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// ── Public routes (no token required) ────────────────────────────
router.post('/register',        authLimiter, register);
router.post('/login',           authLimiter, login);

// ── Protected routes (token required) ────────────────────────────
router.post('/logout',          protect, logout);
router.get( '/me',              protect, me);
router.post('/change-password', protect, changePassword);

module.exports = router;
