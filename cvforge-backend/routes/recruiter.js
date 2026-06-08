// ═══════════════════════════════════════════════════════════════
//  routes/recruiter.js
//
//  All routes require a valid JWT (any role can access).
//
//  GET  /api/recruiter/search          ← search public profiles
//  GET  /api/recruiter/profile/:cvId   ← view a full public CV
//  GET  /api/recruiter/stats           ← search page header stats
// ═══════════════════════════════════════════════════════════════

const express  = require('express');
const { protect } = require('../middleware/auth');
const {
  search,
  getProfile,
  getStats
} = require('../controllers/recruiterController');

const router = express.Router();

// All recruiter routes require login (any role)
router.use(protect);

router.get('/search',        search);
router.get('/stats',         getStats);
router.get('/profile/:cvId', getProfile);

module.exports = router;
