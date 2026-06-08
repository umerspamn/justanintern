// ═══════════════════════════════════════════════════════════════
//  controllers/cvController.js
//  Handles: load CV, save CV, toggle public visibility
//
//  All routes require: protect middleware (candidate role)
// ═══════════════════════════════════════════════════════════════

const { query, transaction } = require('../config/db');


// ── HELPERS ─────────────────────────────────────────────────────

// Extract searchable keywords from skills and experience
function extractKeywords(skills = [], exp = []) {
  const stopwords = new Set([
    'and','the','of','in','at','for','with','a','an','to','on','is','are','i','my','our'
  ]);
  const raw = [];
  skills.forEach(s => {
    if (s.name) s.name.split(/[,/]/).forEach(w => raw.push(w.trim().toLowerCase()));
  });
  exp.forEach(e => {
    if (e.role)    raw.push(...e.role.split(/\s+/).map(w => w.toLowerCase()));
    if (e.company) raw.push(e.company.toLowerCase().split(/\s+/)[0]); // just first word of company
  });
  return [...new Set(raw)]
    .map(w => w.replace(/[^a-z0-9+#.]/g, ''))
    .filter(w => w.length > 1 && !stopwords.has(w))
    .slice(0, 60); // max 60 keywords
}

// Calculate total work experience in years
function calcExpYears(exp = []) {
  const now = new Date();
  let total = 0;
  exp.forEach(e => {
    const start = e.start ? new Date(e.start + '-01') : null;
    const end   = e.present ? now : (e.end ? new Date(e.end + '-01') : null);
    if (!start || !end || isNaN(start) || isNaN(end) || end <= start) return;
    total += (end - start) / (1000 * 60 * 60 * 24 * 365.25);
  });
  return Math.round(Math.max(0, total) * 10) / 10;
}


// ══════════════════════════════════════════════════════════════
//  GET /api/cv
//  Returns the full CV for the currently logged-in user,
//  mapped to the frontend S object format.
// ══════════════════════════════════════════════════════════════
async function getCV(req, res) {
  try {
    const userId = req.user.id;

    // Use the cv_full view which joins all tables
    const result = await query(
      'SELECT * FROM cv_full WHERE user_id = $1',
      [userId]
    );

    if (!result.rows.length) {
      return res.json({ success: true, data: null });
    }

    const row = result.rows[0];

    // Map experience rows to frontend format
    const exp = (row.experience || []).map((e, i) => ({
      id:      i + 1,
      _dbId:   e.id,
      role:    e.role        || '',
      company: e.company     || '',
      loc:     e.location    || '',
      start:   e.start_date  || '',
      end:     e.end_date    || '',
      present: e.is_present  ? 1 : 0,
      bullets: e.bullets     || ''
    }));

    // Map education rows to frontend format
    const edu = (row.education || []).map((e, i) => ({
      id:      i + 1,
      degree:  e.degree     || '',
      school:  e.school     || '',
      field:   e.field      || '',
      grade:   e.grade      || '',
      start:   e.start_date || '',
      end:     e.end_date   || '',
      present: e.is_present ? 1 : 0
    }));

    // Map project rows — keep _dbId temporarily for skill link mapping
    const proj = (row.projects || []).map((p, i) => ({
      id:    i + 1,
      _dbId: p.id,
      name:  p.name        || '',
      tech:  p.tech_stack  || '',
      link:  p.project_url || '',
      desc:  p.description || ''
    }));

    // Map certification rows
    const cert = (row.certifications || []).map((c, i) => ({
      id:     i + 1,
      name:   c.name           || '',
      org:    c.issuing_org     || '',
      date:   c.issue_date      || '',
      credId: c.credential_id   || ''
    }));

    // Build UUID → frontend int ID map for project links
    const projUuidToIntId = {};
    proj.forEach(p => { if (p._dbId) projUuidToIntId[p._dbId] = p.id; });

    // Map skill rows — translate project_ids UUIDs back to frontend int IDs
    const skills = (row.skills || []).map((s, i) => ({
      id:    i + 1,
      name:  s.name  || '',
      level: s.level || 3,
      color: s.color || '#4F7AFF',
      pids:  (s.project_ids || [])
               .map(uuid => projUuidToIntId[uuid])
               .filter(Boolean)
    }));

    // Strip internal _dbId before sending to client
    const projClean = proj.map(({ _dbId, ...rest }) => rest);

    res.json({
      success: true,
      data: {
        name:           row.full_name        || '',
        title:          row.job_title        || '',
        phone:          row.phone            || '',
        email:          row.email            || '',
        linkedin:       row.linkedin_url     || '',
        github:         row.github_url       || '',
        location:       row.location         || '',
        summary:        row.summary          || '',
        isPublic:       row.is_public        || false,
        accent:         row.accent_color     || '#0A0C10',
        fs:             row.font_size        || 10,
        jobPreferences: row.job_preferences  || {},
        exp,
        edu,
        proj:   projClean,
        cert,
        skills
      }
    });

  } catch (err) {
    console.error('[CV] getCV error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load CV.' });
  }
}


// ══════════════════════════════════════════════════════════════
//  PUT /api/cv
//  Full replace-save of the entire CV state.
//  Body: the S state object from the frontend (JSON).
//
//  Strategy: delete all child rows then re-insert.
//  Runs in a transaction — atomically safe.
// ══════════════════════════════════════════════════════════════
async function saveCV(req, res) {
  try {
    const userId = req.user.id;
    const data   = req.body;

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid CV data.' });
    }

    const keywords = extractKeywords(data.skills || [], data.exp || []);
    const expYears = calcExpYears(data.exp || []);

    const cvId = await transaction(async (client) => {

      // ── 1. Upsert CV header ─────────────────────────────────
      const existing = await client.query(
        'SELECT id FROM cvs WHERE user_id = $1',
        [userId]
      );

      let cvId;

      if (existing.rows.length) {
        cvId = existing.rows[0].id;
        await client.query(
          `UPDATE cvs SET
             full_name=$1,    email=$2,       phone=$3,
             job_title=$4,    location=$5,    summary=$6,
             linkedin_url=$7, github_url=$8,  accent_color=$9,
             font_size=$10,   job_preferences=$11, keywords=$12, is_public=$13
           WHERE id = $14`,
          [
            data.name     || '',   data.email    || '',  data.phone   || '',
            data.title    || '',   data.location || '',  data.summary || '',
            data.linkedin || '',   data.github   || '',
            data.accent   || '#0A0C10',
            parseInt(data.fs) || 10,
            JSON.stringify(data.jobPreferences || {}),
            keywords,
            !!data.isPublic,
            cvId
          ]
        );
      } else {
        const ins = await client.query(
          `INSERT INTO cvs
             (user_id, full_name, email, phone, job_title, location, summary,
              linkedin_url, github_url, accent_color, font_size, job_preferences,
              keywords, is_public)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING id`,
          [
            userId,
            data.name     || '',   data.email    || '',  data.phone   || '',
            data.title    || '',   data.location || '',  data.summary || '',
            data.linkedin || '',   data.github   || '',
            data.accent   || '#0A0C10',
            parseInt(data.fs) || 10,
            JSON.stringify(data.jobPreferences || {}),
            keywords,
            !!data.isPublic
          ]
        );
        cvId = ins.rows[0].id;
      }

      // ── 2. Delete all child records (order: links → children) ─
      await client.query(
        `DELETE FROM skill_project_links
         WHERE skill_id IN (SELECT id FROM skills WHERE cv_id = $1)`,
        [cvId]
      );
      await client.query('DELETE FROM skills        WHERE cv_id = $1', [cvId]);
      await client.query('DELETE FROM projects       WHERE cv_id = $1', [cvId]);
      await client.query('DELETE FROM experience     WHERE cv_id = $1', [cvId]);
      await client.query('DELETE FROM education      WHERE cv_id = $1', [cvId]);
      await client.query('DELETE FROM certifications WHERE cv_id = $1', [cvId]);

      // ── 3. Re-insert experience ────────────────────────────
      for (let i = 0; i < (data.exp || []).length; i++) {
        const e = data.exp[i];
        await client.query(
          `INSERT INTO experience
             (cv_id, sort_order, role, company, location, start_date, end_date, is_present, bullets)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            cvId, i,
            e.role    || '', e.company || '', e.loc  || '',
            e.start   || '', e.end     || '', !!e.present,
            e.bullets || ''
          ]
        );
      }

      // ── 4. Re-insert education ─────────────────────────────
      for (let i = 0; i < (data.edu || []).length; i++) {
        const e = data.edu[i];
        await client.query(
          `INSERT INTO education
             (cv_id, sort_order, degree, school, field, start_date, end_date, is_present, grade)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            cvId, i,
            e.degree || '', e.school || '', e.field || '',
            e.start  || '', e.end    || '', !!e.present,
            e.grade  || ''
          ]
        );
      }

      // ── 5. Re-insert certifications ────────────────────────
      for (let i = 0; i < (data.cert || []).length; i++) {
        const c = data.cert[i];
        await client.query(
          `INSERT INTO certifications
             (cv_id, sort_order, name, issuing_org, issue_date, credential_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [cvId, i, c.name || '', c.org || '', c.date || '', c.credId || '']
        );
      }

      // ── 6. Re-insert projects (capture frontend-id → UUID map) ─
      const projIdMap = {}; // frontend int id → DB UUID
      for (let i = 0; i < (data.proj || []).length; i++) {
        const p = data.proj[i];
        const r = await client.query(
          `INSERT INTO projects
             (cv_id, sort_order, name, tech_stack, project_url, description)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [cvId, i, p.name || '', p.tech || '', p.link || '', p.desc || '']
        );
        projIdMap[p.id] = r.rows[0].id;
      }

      // ── 7. Re-insert skills (capture frontend-id → UUID map) ─
      const skillIdMap = {}; // frontend int id → DB UUID
      for (let i = 0; i < (data.skills || []).length; i++) {
        const s = data.skills[i];
        const r = await client.query(
          `INSERT INTO skills
             (cv_id, sort_order, name, level, color)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id`,
          [cvId, i, s.name || '', parseInt(s.level) || 3, s.color || '#4F7AFF']
        );
        skillIdMap[s.id] = r.rows[0].id;
      }

      // ── 8. Re-insert skill_project_links ──────────────────
      for (const s of (data.skills || [])) {
        const skillDbId = skillIdMap[s.id];
        if (!skillDbId) continue;
        for (const frontendProjId of (s.pids || [])) {
          const projDbId = projIdMap[frontendProjId];
          if (projDbId) {
            await client.query(
              `INSERT INTO skill_project_links (skill_id, project_id)
               VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [skillDbId, projDbId]
            );
          }
        }
      }

      // ── 9. Sync public_profiles ───────────────────────────
      if (data.isPublic) {
        await client.query(
          `INSERT INTO public_profiles
             (cv_id, user_id, full_name, job_title, location, keywords, experience_years, is_visible)
           VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
           ON CONFLICT (cv_id) DO UPDATE SET
             full_name        = EXCLUDED.full_name,
             job_title        = EXCLUDED.job_title,
             location         = EXCLUDED.location,
             keywords         = EXCLUDED.keywords,
             experience_years = EXCLUDED.experience_years,
             is_visible       = TRUE`,
          [
            cvId, userId,
            data.name     || '',
            data.title    || '',
            data.location || '',
            keywords,
            expYears
          ]
        );
      } else {
        // Hide without deleting (preserves stats history)
        await client.query(
          'UPDATE public_profiles SET is_visible = FALSE WHERE cv_id = $1',
          [cvId]
        );
      }

      return cvId;
    });

    res.json({ success: true, message: 'CV saved.', cvId });

  } catch (err) {
    console.error('[CV] saveCV error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to save CV. Please try again.' });
  }
}


// ══════════════════════════════════════════════════════════════
//  POST /api/cv/public
//  Toggle whether the CV is publicly visible to recruiters.
//  Body: { isPublic: boolean }
//
//  This is a lightweight endpoint — it only flips the visibility
//  flag without re-saving the whole CV.
// ══════════════════════════════════════════════════════════════
async function setPublic(req, res) {
  try {
    const userId   = req.user.id;
    const isPublic = !!req.body.isPublic;

    // Get the CV record
    const cvRow = await query(
      `SELECT id, full_name, job_title, location, keywords
       FROM cvs WHERE user_id = $1`,
      [userId]
    );

    if (!cvRow.rows.length) {
      return res.status(404).json({
        success: false,
        error: 'No CV found. Save your CV at least once before publishing.'
      });
    }

    const cv = cvRow.rows[0];

    // Update is_public on the CV record
    await query(
      'UPDATE cvs SET is_public = $1 WHERE id = $2',
      [isPublic, cv.id]
    );

    if (isPublic) {
      // Calculate current experience years
      const expResult = await query(
        `SELECT start_date AS start, end_date AS end, is_present AS present
         FROM experience WHERE cv_id = $1`,
        [cv.id]
      );
      const expYears = calcExpYears(expResult.rows);

      // Upsert into public_profiles
      await query(
        `INSERT INTO public_profiles
           (cv_id, user_id, full_name, job_title, location, keywords, experience_years, is_visible)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
         ON CONFLICT (cv_id) DO UPDATE SET
           full_name        = EXCLUDED.full_name,
           job_title        = EXCLUDED.job_title,
           location         = EXCLUDED.location,
           keywords         = EXCLUDED.keywords,
           experience_years = EXCLUDED.experience_years,
           is_visible       = TRUE`,
        [
          cv.id, userId,
          cv.full_name, cv.job_title, cv.location,
          cv.keywords, expYears
        ]
      );
    } else {
      // Hide — keep the row for historical stats
      await query(
        'UPDATE public_profiles SET is_visible = FALSE WHERE cv_id = $1',
        [cv.id]
      );
    }

    console.log(`[CV] setPublic: user=${userId} isPublic=${isPublic}`);

    res.json({
      success: true,
      message: isPublic ? 'Profile is now public.' : 'Profile set to private.'
    });

  } catch (err) {
    console.error('[CV] setPublic error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to update visibility.' });
  }
}


module.exports = { getCV, saveCV, setPublic };
