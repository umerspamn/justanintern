// ═══════════════════════════════════════════════════════════════
//  routes/certificates.js — Public certificate verification
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const { pool } = require('../config/db');

// GET /api/certificates/verify/:certId — PUBLIC (no auth)
router.get('/verify/:certId', async (req, res) => {
  try {
    const { certId } = req.params;

    // Get certificate + course — NO join to users table (avoids uuid/int mismatch)
    const { rows: [cert] } = await pool.query(
      `SELECT c.cert_uuid, c.quiz_score, c.issued_at, c.is_valid,
              c.user_id,
              co.title AS course_title, co.category, co.difficulty, co.channel_name
       FROM certificates c
       JOIN courses co ON c.course_id = co.id
       WHERE c.cert_uuid = $1`,
      [certId.trim().toUpperCase()]
    );

    if (!cert) {
      return res.status(404).json({
        success: false,
        valid: false,
        error: 'Certificate not found. It may be invalid or the ID is incorrect.'
      });
    }

    // Get user name separately using INT cast to avoid uuid mismatch
    let holderName = 'Certificate Holder';
    try {
      const { rows: [user] } = await pool.query(
        `SELECT full_name FROM users WHERE id = $1::int`,
        [parseInt(cert.user_id)]
      );
      if (user?.full_name) holderName = user.full_name;
    } catch (_) {}

    res.json({
      success: true,
      valid: cert.is_valid,
      certificate: {
        id:          cert.cert_uuid,
        holderName,
        courseTitle: cert.course_title,
        category:    cert.category,
        difficulty:  cert.difficulty,
        channel:     cert.channel_name,
        score:       cert.quiz_score,
        issuedAt:    cert.issued_at,
        status:      cert.is_valid ? 'VALID' : 'REVOKED'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;