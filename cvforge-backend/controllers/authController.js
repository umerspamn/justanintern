// ═══════════════════════════════════════════════════════════════
//  controllers/authController.js
//  Handles: register, login, logout, /me, changePassword
// ═══════════════════════════════════════════════════════════════

const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const validator = require('validator');
const { query, transaction } = require('../config/db');

// ── HELPER: generate JWT ─────────────────────────────────────────
function generateToken(userId, role) {
  const jti = uuidv4(); // unique JWT ID for revocation tracking
  const token = jwt.sign(
    { id: userId, role, jti },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
  return { token, jti };
}

// ── HELPER: save session to DB ───────────────────────────────────
async function saveSession(userId, jti, req) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // matches JWT_EXPIRES_IN

  await query(
    `INSERT INTO sessions (user_id, jti, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      jti,
      expiresAt,
      req.ip || '',
      req.headers['user-agent'] || ''
    ]
  );
}

// ── HELPER: safe user object (no password hash) ──────────────────
function safeUser(user) {
  const { password_hash, ...safe } = user;
  return safe;
}


// ══════════════════════════════════════════════════════════════
//  POST /api/auth/register
//  Body: { email, password, fullName, role? }
// ══════════════════════════════════════════════════════════════
async function register(req, res) {
  try {
    const { email, password, fullName, role } = req.body;

    // ── Validate inputs ────────────────────────────────────────
    const errors = [];
    if (!email         || !validator.isEmail(email))      errors.push('Valid email is required.');
    if (!password      || password.length < 8)            errors.push('Password must be at least 8 characters.');
    if (!fullName      || fullName.trim().length < 2)     errors.push('Full name is required.');
    if (password && !/(?=.*[A-Z])(?=.*[0-9])/.test(password)) {
      errors.push('Password must contain at least one uppercase letter and one number.');
    }

    // Role validation — only allow candidate or recruiter on self-register
    const allowedRoles = ['candidate', 'recruiter'];
    const userRole = allowedRoles.includes(role) ? role : 'candidate';

    if (errors.length) {
      return res.status(400).json({ success: false, errors });
    }

    const cleanEmail = validator.normalizeEmail(email);

    // ── Check email not already taken ─────────────────────────
    const existing = await query(
      'SELECT id FROM users WHERE email = $1',
      [cleanEmail]
    );
    if (existing.rows.length) {
      return res.status(409).json({ success: false, error: 'Email already registered. Please log in.' });
    }

    // ── Hash password ─────────────────────────────────────────
    const rounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const password_hash = await bcrypt.hash(password, rounds);

    // ── Insert user + create empty CV in a transaction ────────
    const newUser = await transaction(async (client) => {
      // Create user
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, full_name, role, created_at`,
        [cleanEmail, password_hash, fullName.trim(), userRole]
      );
      const user = userResult.rows[0];

      // Auto-create an empty CV for candidate users
      if (userRole === 'candidate') {
        await client.query(
          `INSERT INTO cvs (user_id, full_name, email)
           VALUES ($1, $2, $3)`,
          [user.id, fullName.trim(), cleanEmail]
        );
      }

      return user;
    });

    // ── Issue JWT ─────────────────────────────────────────────
    const { token, jti } = generateToken(newUser.id, newUser.role);
    await saveSession(newUser.id, jti, req);

    console.log(`[Auth] New ${newUser.role} registered: ${newUser.email}`);

    res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      token,
      user:    safeUser(newUser)
    });

  } catch (err) {
    console.error('[Auth] register error:', err.message);
    res.status(500).json({ success: false, error: 'Registration failed. Please try again.' });
  }
}


// ══════════════════════════════════════════════════════════════
//  POST /api/auth/login
//  Body: { email, password }
// ══════════════════════════════════════════════════════════════
async function login(req, res) {
  try {
    const { email, password } = req.body;

    // ── Validate inputs ────────────────────────────────────────
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const cleanEmail = validator.normalizeEmail(email);

    // ── Find user ──────────────────────────────────────────────
    const result = await query(
      `SELECT id, email, full_name, role, password_hash, is_active, last_login_at
       FROM users WHERE email = $1`,
      [cleanEmail]
    );

    const user = result.rows[0];

    // Deliberately vague error — don't reveal whether email exists
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, error: 'Account is deactivated. Contact support.' });
    }

    // ── Verify password ────────────────────────────────────────
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    }

    // ── Issue JWT ──────────────────────────────────────────────
    const { token, jti } = generateToken(user.id, user.role);
    await saveSession(user.id, jti, req);

    // Update last login timestamp
    await query(
      'UPDATE users SET last_login_at = NOW() WHERE id = $1',
      [user.id]
    );

    console.log(`[Auth] Login: ${user.email} (${user.role})`);

    res.status(200).json({
      success: true,
      message: 'Logged in successfully.',
      token,
      user:    safeUser(user)
    });

  } catch (err) {
    console.error('[Auth] login error:', err.message);
    res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
  }
}


// ══════════════════════════════════════════════════════════════
//  POST /api/auth/logout
//  Revokes the current JWT so it cannot be reused.
//  Requires: Authorization: Bearer <token>
// ══════════════════════════════════════════════════════════════
async function logout(req, res) {
  try {
    // Decode token to get JTI (middleware already verified it)
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      const decoded = jwt.decode(token);
      if (decoded?.jti) {
        await query(
          'UPDATE sessions SET revoked = TRUE WHERE jti = $1',
          [decoded.jti]
        );
      }
    }

    console.log(`[Auth] Logout: ${req.user?.email}`);

    res.status(200).json({ success: true, message: 'Logged out successfully.' });

  } catch (err) {
    console.error('[Auth] logout error:', err.message);
    res.status(500).json({ success: false, error: 'Logout failed.' });
  }
}


// ══════════════════════════════════════════════════════════════
//  GET /api/auth/me
//  Returns the currently logged-in user's profile.
//  Requires: Authorization: Bearer <token>
// ══════════════════════════════════════════════════════════════
async function me(req, res) {
  try {
    // req.user is set by protect middleware
    // Fetch fresh data including CV info for candidates
    const result = await query(
      `SELECT
         u.id, u.email, u.full_name, u.role,
         u.is_active, u.email_verified,
         u.created_at, u.last_login_at,
         c.id AS cv_id, c.job_title, c.location,
         c.is_public, c.keywords, c.updated_at AS cv_updated_at
       FROM users u
       LEFT JOIN cvs c ON c.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    res.status(200).json({
      success: true,
      user: {
        id:             row.id,
        email:          row.email,
        fullName:       row.full_name,
        role:           row.role,
        isActive:       row.is_active,
        emailVerified:  row.email_verified,
        createdAt:      row.created_at,
        lastLoginAt:    row.last_login_at,
        cv: row.cv_id ? {
          id:         row.cv_id,
          jobTitle:   row.job_title,
          location:   row.location,
          isPublic:   row.is_public,
          keywords:   row.keywords,
          updatedAt:  row.cv_updated_at
        } : null
      }
    });

  } catch (err) {
    console.error('[Auth] me error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch profile.' });
  }
}


// ══════════════════════════════════════════════════════════════
//  POST /api/auth/change-password
//  Body: { currentPassword, newPassword }
//  Requires: Authorization: Bearer <token>
// ══════════════════════════════════════════════════════════════
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Current and new passwords are required.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'New password must be at least 8 characters.' });
    }
    if (!/(?=.*[A-Z])(?=.*[0-9])/.test(newPassword)) {
      return res.status(400).json({ success: false, error: 'New password must contain uppercase letter and number.' });
    }

    // Fetch current hash
    const result = await query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );
    const isMatch = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect.' });
    }

    // Hash and save new password
    const rounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const newHash = await bcrypt.hash(newPassword, rounds);
    await query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, req.user.id]
    );

    // Revoke all existing sessions (force re-login on other devices)
    await query(
      'UPDATE sessions SET revoked = TRUE WHERE user_id = $1',
      [req.user.id]
    );

    console.log(`[Auth] Password changed: ${req.user.email}`);

    res.status(200).json({ success: true, message: 'Password changed. Please log in again.' });

  } catch (err) {
    console.error('[Auth] changePassword error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to change password.' });
  }
}

module.exports = { register, login, logout, me, changePassword };
