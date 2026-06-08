// ═══════════════════════════════════════════════════════════════
//  controllers/recruiterController.js
//  Handles: search public profiles, view full profile, bookmark
//
//  All routes require: protect middleware (any logged-in user)
// ═══════════════════════════════════════════════════════════════

const { query } = require('../config/db');


// ══════════════════════════════════════════════════════════════
//  GET /api/recruiter/search
//
//  Query params (all optional):
//    keyword     - string, matches against keywords[] array
//    location    - string, partial match on location field
//    minYears    - number, minimum total experience years
//    maxYears    - number, maximum total experience years
//    role        - string, partial match on job_title
//    page        - number, pagination (default 1)
//    limit       - number, results per page (default 12, max 50)
//
//  Example:
//    GET /api/recruiter/search?keyword=docker&location=karachi&minYears=1
// ══════════════════════════════════════════════════════════════
async function search(req, res) {
  try {
    const {
      keyword   = '',
      location  = '',
      minYears  = 0,
      maxYears  = 99,
      role      = '',
      page      = 1,
      limit     = 12
    } = req.query;

    // Sanitize pagination
    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 12));
    const offset   = (pageNum - 1) * limitNum;

    // Build dynamic WHERE clauses
    const conditions = ['pp.is_visible = TRUE'];
    const params     = [];
    let   paramIdx   = 1;

    // Keyword search: checks keywords array using GIN index
    // Also searches job_title for broader matches
    if (keyword.trim()) {
      const kw = keyword.trim().toLowerCase();
      conditions.push(
        `(pp.keywords && ARRAY[$${paramIdx}]::text[]
          OR pp.job_title ILIKE $${paramIdx + 1})`
      );
      params.push(kw, `%${kw}%`);
      paramIdx += 2;
    }

    // Location: case-insensitive partial match
    if (location.trim()) {
      conditions.push(`pp.location ILIKE $${paramIdx}`);
      params.push(`%${location.trim()}%`);
      paramIdx++;
    }

    // Experience years range
    if (minYears > 0) {
      conditions.push(`pp.experience_years >= $${paramIdx}`);
      params.push(parseFloat(minYears));
      paramIdx++;
    }
    if (maxYears < 99) {
      conditions.push(`pp.experience_years <= $${paramIdx}`);
      params.push(parseFloat(maxYears));
      paramIdx++;
    }

    // Role/title search
    if (role.trim()) {
      conditions.push(`pp.job_title ILIKE $${paramIdx}`);
      params.push(`%${role.trim()}%`);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    // ── COUNT query for pagination ─────────────────────────────
    const countResult = await query(
      `SELECT COUNT(*) FROM public_profiles pp WHERE ${whereClause}`,
      params
    );
    const totalCount = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalCount / limitNum);

    // ── MAIN search query ──────────────────────────────────────
    const searchResult = await query(
      `SELECT
         pp.id               AS profile_id,
         pp.user_id,
         pp.cv_id,
         pp.full_name,
         pp.job_title,
         pp.location,
         pp.keywords,
         pp.experience_years,
         pp.updated_at,
         -- Include top 5 keywords for display chips
         (pp.keywords)[1:5]  AS top_keywords
       FROM public_profiles pp
       WHERE ${whereClause}
       ORDER BY pp.experience_years DESC, pp.updated_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limitNum, offset]
    );

    res.status(200).json({
      success: true,
      data: {
        results:    searchResult.rows,
        pagination: {
          page:       pageNum,
          limit:      limitNum,
          total:      totalCount,
          totalPages,
          hasNext:    pageNum < totalPages,
          hasPrev:    pageNum > 1
        },
        filters: { keyword, location, minYears, maxYears, role }
      }
    });

  } catch (err) {
    console.error('[Recruiter] search error:', err.message);
    res.status(500).json({ success: false, error: 'Search failed. Please try again.' });
  }
}


// ══════════════════════════════════════════════════════════════
//  GET /api/recruiter/profile/:cvId
//  Returns the full public CV for a specific profile.
//  Only returns profiles where is_visible = TRUE.
// ══════════════════════════════════════════════════════════════
async function getProfile(req, res) {
  try {
    const { cvId } = req.params;

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(cvId)) {
      return res.status(400).json({ success: false, error: 'Invalid profile ID.' });
    }

    // Check profile is publicly visible
    const visCheck = await query(
      'SELECT is_visible FROM public_profiles WHERE cv_id = $1',
      [cvId]
    );
    if (!visCheck.rows.length || !visCheck.rows[0].is_visible) {
      return res.status(404).json({ success: false, error: 'Profile not found or is private.' });
    }

    // Fetch full CV data using the cv_full view
    // Exclude sensitive fields (user email, internal IDs)
    const result = await query(
      `SELECT
         cv_id,
         full_name,
         job_title,
         location,
         summary,
         linkedin_url,
         github_url,
         keywords,
         job_preferences,
         updated_at,
         experience,
         education,
         skills,
         projects,
         certifications
       FROM cv_full
       WHERE cv_id = $1 AND is_public = TRUE`,
      [cvId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, error: 'Profile not found.' });
    }

    // Log the view (for future analytics)
    // Non-blocking — don't await so it doesn't slow the response
    query(
      `INSERT INTO pdf_downloads (user_id, cv_id, user_agent)
       VALUES ($1, $2, $3)`,
      [req.user?.id || null, cvId, req.headers['user-agent'] || '']
    ).catch(() => {}); // silently ignore analytics errors

    res.status(200).json({
      success: true,
      data:    result.rows[0]
    });

  } catch (err) {
    console.error('[Recruiter] getProfile error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch profile.' });
  }
}


// ══════════════════════════════════════════════════════════════
//  GET /api/recruiter/stats
//  Returns summary stats for the search page header.
//  (total public profiles, top locations, top skills)
// ══════════════════════════════════════════════════════════════
async function getStats(req, res) {
  try {
    const [totalResult, locResult, kwResult] = await Promise.all([

      // Total visible profiles
      query('SELECT COUNT(*) AS total FROM public_profiles WHERE is_visible = TRUE'),

      // Top 5 locations
      query(`
        SELECT location, COUNT(*) AS count
        FROM public_profiles
        WHERE is_visible = TRUE AND location != ''
        GROUP BY location
        ORDER BY count DESC
        LIMIT 5
      `),

      // Top 15 keywords (unnest the keywords array, count occurrences)
      query(`
        SELECT kw, COUNT(*) AS count
        FROM public_profiles pp, unnest(pp.keywords) AS kw
        WHERE pp.is_visible = TRUE
        GROUP BY kw
        ORDER BY count DESC
        LIMIT 15
      `)
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalProfiles: parseInt(totalResult.rows[0].total),
        topLocations:  locResult.rows,
        topKeywords:   kwResult.rows
      }
    });

  } catch (err) {
    console.error('[Recruiter] getStats error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch stats.' });
  }
}

module.exports = { search, getProfile, getStats };
