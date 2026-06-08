// ═══════════════════════════════════════════════════════════════
//  routes/cv.js
//
//  GET  /api/cv         ← load full CV for current user
//  PUT  /api/cv         ← save (full replace) CV for current user
//  POST /api/cv/public  ← toggle public visibility
//
//  All routes require a valid JWT (candidate role).
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { protect } = require('../middleware/auth');
const { getCV, saveCV, setPublic } = require('../controllers/cvController');

const router = express.Router();

// All CV routes require authentication
router.use(protect);

router.get('/',        getCV);
router.put('/',        saveCV);
router.post('/public', setPublic);

module.exports = router;
