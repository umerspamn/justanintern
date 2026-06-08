// ═══════════════════════════════════════════════════════════════
//  config/db.js — PostgreSQL Connection Pool
//  Uses the 'pg' library (node-postgres).
//  All database queries go through this pool.
// ═══════════════════════════════════════════════════════════════

const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5433,
  database: process.env.DB_NAME     || 'cvforge',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,

  // Connection pool settings
  max:             20,    // max simultaneous connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Log connection errors (don't crash the app)
pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// Test the connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('[DB] ✗ Connection failed:', err.message);
    console.error('    Check DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD in .env');
  } else {
    client.query('SELECT current_database()', (err, result) => {
      release();
      if (!err) {
        console.log(`[DB] ✓ Connected to PostgreSQL — database: ${result.rows[0].current_database}`);
      }
    });
  }
});

// Helper: run a query with automatic error logging
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    if (process.env.NODE_ENV === 'development') {
      const duration = Date.now() - start;
      if (duration > 500) {
        console.warn(`[DB] Slow query (${duration}ms):`, text.slice(0, 80));
      }
    }
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err.message);
    console.error('[DB] Query:', text.slice(0, 120));
    throw err;
  }
}

// Helper: run multiple queries in a transaction
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, transaction };
