// ═══════════════════════════════════════════════════════════════
//  server.js — CVForge API Entry Point
//  Start: node server.js
//  Dev:   npx nodemon server.js
// ═══════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');

const authRoutes      = require('./routes/auth');
const recruiterRoutes = require('./routes/recruiter');
const aiRoutes        = require('./routes/ai');
const cvRoutes        = require('./routes/cv');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── SECURITY HEADERS ─────────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5500')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no origin (Postman, curl, mobile apps)
    if (!origin) return callback(null, true);
    // Allow file:// access (origin comes as "null" string from browser)
    if (origin === 'null') return callback(null, true);
    // Allow configured origins
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // In development allow everything
    if (process.env.NODE_ENV === 'development') return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials:  true,
  methods:      ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── BODY PARSER ───────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── GLOBAL RATE LIMITER ───────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)       || 100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many requests. Please slow down.' }
});
app.use(globalLimiter);

// ── TRUST PROXY (needed behind nginx on EC2) ──────────────────────
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}
const jobsRouter = require('./routes/jobs');
app.use('/api/jobs', jobsRouter);

// ── REQUEST LOGGER (development only) ────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({
    status:    'ok',
    service:   'CVForge API',
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV || 'development'
  });
});

// ── API ROUTES ────────────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/recruiter', recruiterRoutes);
app.use('/api/ai',        aiRoutes);
app.use('/api/cv',        cvRoutes);

// ── 404 HANDLER ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error:   `Route not found: ${req.method} ${req.path}`
  });
});

// ── GLOBAL ERROR HANDLER ──────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Server] Unhandled error:', err.message);
  res.status(err.status || 500).json({
    success: false,
    error:   process.env.NODE_ENV === 'production'
               ? 'Internal server error.'
               : err.message
  });
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  CVForge API Server                   ║');
  console.log('╠═══════════════════════════════════════╣');
  console.log(`║  Port    : ${PORT}                         ║`);
  console.log(`║  Env     : ${(process.env.NODE_ENV || 'development').padEnd(26)}║`);
  console.log('╠═══════════════════════════════════════╣');
  console.log('║  Routes:                              ║');
  console.log('║  POST /api/auth/register              ║');
  console.log('║  POST /api/auth/login                 ║');
  console.log('║  POST /api/auth/logout                ║');
  console.log('║  GET  /api/auth/me                    ║');
  console.log('║  GET  /api/cv                         ║');
  console.log('║  PUT  /api/cv                         ║');
  console.log('║  POST /api/cv/public                  ║');
  console.log('║  GET  /api/recruiter/search           ║');
  console.log('║  GET  /api/recruiter/stats            ║');
  console.log('║  GET  /api/recruiter/profile/:id      ║');
  console.log('║  POST /api/ai/groq/generate           ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log('');
});

module.exports = app;