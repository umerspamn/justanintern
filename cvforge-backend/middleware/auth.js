// ═══════════════════════════════════════════════════════════════
//  middleware/auth.js — JWT Verification Middleware
//
//  Usage in routes:
//    const { protect, requireRole } = require('../middleware/auth');
//
//    router.get('/search', protect, recruiterController.search);
//    router.get('/admin',  protect, requireRole('admin'), ...);
// ═══════════════════════════════════════════════════════════════

const jwt  = require('jsonwebtoken');
const { query } = require('../config/db');

// ── PROTECT: verify JWT, attach user to req ──────────────────────
async function protect(req, res, next) {
  try {
    let token = null;

    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        error:   'Not authenticated. Please log in.'
      });
    }

    // Verify signature and expiry
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: 'Session expired. Please log in again.'
        });
      }
      return res.status(401).json({
        success: false,
        error: 'Invalid token.'
      });
    }

    // Check token has not been revoked
    if (decoded.jti) {
      const revoked = await query(
        'SELECT revoked FROM sessions WHERE jti = $1',
        [decoded.jti]
      );
      if (revoked.rows[0]?.revoked === true) {
        return res.status(401).json({
          success: false,
          error: 'Session has been revoked. Please log in again.'
        });
      }
    }

    // Load fresh user from DB
    const userResult = await query(
      'SELECT id, email, full_name, role, is_active FROM users WHERE id = $1',
      [decoded.id]
    );

    if (!userResult.rows.length || !userResult.rows[0].is_active) {
      return res.status(401).json({
        success: false,
        error: 'User no longer exists or is deactivated.'
      });
    }

    req.user = userResult.rows[0];
    next();

  } catch (err) {
    console.error('[Auth] protect middleware error:', err.message);
    res.status(500).json({ success: false, error: 'Authentication error.' });
  }
}

// ── REQUIRE ROLE ─────────────────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Not authenticated.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Access denied. Required role: ${roles.join(' or ')}.`
      });
    }
    next();
  };
}

// ── OPTIONAL AUTH ─────────────────────────────────────────────────
async function optionalAuth(req, res, next) {
  try {
    let token = null;
    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userResult = await query(
      'SELECT id, email, full_name, role, is_active FROM users WHERE id = $1',
      [decoded.id]
    );
    if (userResult.rows.length && userResult.rows[0].is_active) {
      req.user = userResult.rows[0];
    }
    next();
  } catch {
    next();
  }
}

module.exports = { protect, requireRole, optionalAuth };