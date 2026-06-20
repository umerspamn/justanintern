// ═══════════════════════════════════════════════════════════════
//  routes/courses.js — Courses, Quizzes, Transcripts, AI MCQs
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const { pool } = require('../config/db');
const { protect: verifyToken } = require("../middleware/auth");
const { v4: uuidv4 } = require('uuid');

// ── AI HELPERS ────────────────────────────────────────────────

// Smart router: tries Gemini first, falls back to Groq
async function generateWithAI(prompt) {
  try {
    const text = await callGemini(prompt);
    if (text) return { text, provider: 'gemini' };
  } catch (e) { console.warn('[AI] Gemini failed:', e.message); }
  try {
    const text = await callGroq(prompt);
    if (text) return { text, provider: 'groq' };
  } catch (e) { console.warn('[AI] Groq failed:', e.message); }
  throw new Error('All AI providers failed');
}

// Gemini — 1M token context, ideal for large transcripts
async function callGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GeminiAPIKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 4096 }
      })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(`Gemini: ${data.error.message}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

// Groq — fast, but limited to ~6k words input
async function callGroq(prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
      temperature: 0.4
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`Groq: ${data.error.message}`);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned empty response');
  return text;
}

function parseAIJson(text) {
  try {
    const clean = text.replace(/```json\n?/gi, '').replace(/```\n?/gi, '').trim();
    return JSON.parse(clean);
  } catch {
    const arrMatch = text.match(/\[[\s\S]*\]/);
    const objMatch = text.match(/\{[\s\S]*\}/);
    try { if (arrMatch) return JSON.parse(arrMatch[0]); } catch {}
    try { if (objMatch) return JSON.parse(objMatch[0]); } catch {}
    return null;
  }
}

// Smart chunker — splits on sentence boundaries
function chunkText(text, maxWords = 3500) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = [];
  let wordCount = 0;
  for (const s of sentences) {
    const wc = s.split(/\s+/).length;
    if (wordCount + wc > maxWords && current.length > 0) {
      chunks.push(current.join(' '));
      current = [s];
      wordCount = wc;
    } else {
      current.push(s);
      wordCount += wc;
    }
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks.filter(c => c.split(/\s+/).length > 100);
}

// Generate cert UUID: JAI-YYYY-XXXXXX
function genCertId() {
  const year = new Date().getFullYear();
  const hex  = uuidv4().replace(/-/g, '').slice(0, 6).toUpperCase();
  return `JAI-${year}-${hex}`;
}

// ── COURSES ──────────────────────────────────────────────────

// GET /api/courses — list all approved courses
router.get('/', async (req, res) => {
  try {
    const { category, difficulty, search, limit = 20, offset = 0 } = req.query;
    let query = `
      SELECT c.*,
        (SELECT COUNT(*) FROM quizzes q WHERE q.course_id = c.id) AS has_quiz
      FROM courses c
      WHERE c.is_approved = TRUE
    `;
    const params = [];
    if (category)   { params.push(category);     query += ` AND c.category = $${params.length}`; }
    if (difficulty) { params.push(difficulty);    query += ` AND c.difficulty = $${params.length}`; }
    if (search)     { params.push(`%${search}%`); query += ` AND (c.title ILIKE $${params.length} OR c.description ILIKE $${params.length})`; }
    query += ` ORDER BY c.relevance_score DESC, c.view_count DESC, c.created_at DESC`;
    params.push(parseInt(limit));  query += ` LIMIT $${params.length}`;
    params.push(parseInt(offset)); query += ` OFFSET $${params.length}`;
    const { rows } = await pool.query(query, params);
    res.json({ success: true, courses: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/courses/fetch — manually trigger course fetch (admin/dev only)
router.post('/fetch', verifyToken, async (req, res) => {
  try {
    const secret = process.env.CRON_SECRET || '';
    const { cronSecret } = req.body;
    if (cronSecret !== secret) {
      return res.status(403).json({ success: false, error: 'Invalid cron secret' });
    }
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `http://localhost:${process.env.PORT || 3000}`;
    const cronRes = await fetch(`${baseUrl}/api/cron/fetch-courses`, {
      headers: { 'Authorization': `Bearer ${secret}` }
    });
    const data = await cronRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── YOUTUBE PROXY ─────────────────────────────────────────────
// IMPORTANT: all /youtube/* and /my/* routes MUST come before /:id
// otherwise Express catches them as course IDs

// GET /api/courses/youtube/search?q=python
router.get('/youtube/search', verifyToken, async (req, res) => {
  try {
    const { q, maxResults = 10 } = req.query;
    if (!q) return res.status(400).json({ success: false, error: 'q is required' });
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('q', `${q} full course tutorial`);
    url.searchParams.set('type', 'video');
    url.searchParams.set('videoDuration', 'long');
    url.searchParams.set('order', 'relevance');
    url.searchParams.set('maxResults', maxResults);
    url.searchParams.set('key', process.env.YoutubeAPIKey);
    const data = await fetch(url).then(r => r.json());
    if (data.error) throw new Error(data.error.message);
    const results = (data.items || []).map(item => ({
      youtube_id: item.id.videoId,
      title:      item.snippet.title,
      channel:    item.snippet.channelTitle,
      thumbnail:  item.snippet.thumbnails?.medium?.url,
      published:  item.snippet.publishedAt
    }));
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/courses/youtube/playlist?playlistId=PL...
router.get('/youtube/playlist', verifyToken, async (req, res) => {
  try {
    const { playlistId } = req.query;
    if (!playlistId) return res.status(400).json({ success: false, error: 'playlistId required' });
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.searchParams.set('part', 'snippet,contentDetails');
    url.searchParams.set('playlistId', playlistId);
    url.searchParams.set('maxResults', '50');
    url.searchParams.set('key', process.env.YoutubeAPIKey);
    const data = await fetch(url).then(r => r.json());
    if (data.error) throw new Error(data.error.message);
    const videos = (data.items || []).map((item, i) => ({
      youtube_id:  item.contentDetails.videoId,
      title:       item.snippet.title,
      order_index: i,
      thumbnail:   item.snippet.thumbnails?.medium?.url
    }));
    res.json({ success: true, videos, total: videos.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/courses/youtube/transcript/:videoId
router.get('/youtube/transcript/:videoId', verifyToken, async (req, res) => {
  const { videoId } = req.params;
  const { lang = 'en' } = req.query;

  // Method 1: youtube-transcript npm package (most reliable)
  try {
    const { YoutubeTranscript } = require('youtube-transcript');
    const items = await YoutubeTranscript.fetchTranscript(videoId, { lang });
    if (items && items.length > 0) {
      const text = items.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
      if (text.length > 100) {
        return res.json({ success: true, transcript: text, wordCount: text.split(/\s+/).length, source: 'youtube-transcript' });
      }
    }
  } catch (_) {}

  // Method 2: JSON timedtext endpoint
  try {
    const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    const r   = await fetch(`https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}&fmt=json3`, { headers: HEADERS });
    const raw = await r.text();
    if (raw && raw.trim().startsWith('{')) {
      const data = JSON.parse(raw);
      const text = (data.events || [])
        .filter(e => e.segs)
        .map(e => e.segs.map(s => s.utf8 || '').join(''))
        .join(' ').replace(/\s+/g, ' ').trim();
      if (text.length > 100)
        return res.json({ success: true, transcript: text, wordCount: text.split(/\s+/).length, source: 'timedtext-json' });
    }
  } catch (_) {}

  // Method 3: XML timedtext
  try {
    const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    for (const kind of ['', 'asr']) {
      const url = `https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}${kind ? `&kind=${kind}` : ''}`;
      const r   = await fetch(url, { headers: HEADERS });
      const xml = await r.text();
      if (xml && xml.includes('<text')) {
        const text = xml
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ').trim();
        if (text.length > 100)
          return res.json({ success: true, transcript: text, wordCount: text.split(/\s+/).length, source: `timedtext-xml-${kind||'manual'}` });
      }
    }
  } catch (_) {}

  res.json({
    success: false,
    error: 'No captions found for this video. This video may have captions disabled by the creator. Try another video from the course — freeCodeCamp and Traversy Media videos always have captions.'
  });
});

// GET /api/courses/my/certificates
router.get('/my/certificates', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.cert_uuid, c.quiz_score, c.issued_at, c.is_valid,
              co.title AS course_title, co.category, co.difficulty
       FROM certificates c
       JOIN courses co ON c.course_id = co.id
       WHERE c.user_id = $1
       ORDER BY c.issued_at DESC`,
      [parseInt(req.user.id)]
    );
    res.json({ success: true, certificates: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── COURSE BY ID — must be last to avoid catching named routes ──

// GET /api/courses/:id — single course with videos
router.get('/:id', async (req, res) => {
  try {
    const { rows: [course] } = await pool.query(
      `SELECT c.* FROM courses c WHERE c.id = $1 AND c.is_approved = TRUE`,
      [req.params.id]
    );
    if (!course) return res.status(404).json({ success: false, error: 'Course not found' });

    const { rows: videos } = await pool.query(
      `SELECT * FROM course_videos WHERE course_id = $1 ORDER BY order_index`,
      [req.params.id]
    );
    const { rows: [quiz] } = await pool.query(
      `SELECT id, title, passing_score, time_limit,
        (SELECT COUNT(*) FROM quiz_questions WHERE quiz_id = quizzes.id) AS question_count
       FROM quizzes WHERE course_id = $1`,
      [req.params.id]
    );
    res.json({ success: true, course, videos, quiz: quiz || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── QUIZ & QUESTION GENERATION ───────────────────────────────

// POST /api/courses/:id/generate-questions
router.post('/:id/generate-questions', verifyToken, async (req, res) => {
  try {
    const courseId = parseInt(req.params.id);
    const { transcript, videoTitle } = req.body;
    if (!transcript) return res.status(400).json({ success: false, error: 'transcript required' });

    const words     = transcript.split(/\s+/);
    const wordCount = words.length;
    // Groq safe limit: ~6000 words per call (leaves room for prompt + response)
    const GROQ_SAFE_WORDS   = 5000;
    // Gemini safe limit: 600k words
    const GEMINI_SAFE_WORDS = 600000;

    let allQuestions = [];
    let provider     = 'groq';

    // Strategy 1: Try Gemini with full transcript (handles 50k words easily)
    if (wordCount <= GEMINI_SAFE_WORDS) {
      try {
        const count  = Math.min(15, Math.max(5, Math.ceil(wordCount / 3000)));
        const prompt = buildMCQPrompt(transcript, videoTitle, count);
        const result = await callGemini(prompt);
        if (result) {
          const parsed = parseAIJson(result);
          if (parsed?.questions?.length) {
            allQuestions = parsed.questions;
            provider     = 'gemini';
          }
        }
      } catch (e) {
        console.warn('[MCQ] Gemini full transcript failed:', e.message);
      }
    }

    // Strategy 2: Gemini failed or transcript too large — chunk and use Groq
    if (!allQuestions.length) {
      console.log(`[MCQ] Chunking ${wordCount} words for Groq...`);
      const chunks = [];
      for (let i = 0; i < words.length; i += GROQ_SAFE_WORDS) {
        chunks.push(words.slice(i, i + GROQ_SAFE_WORDS).join(' '));
      }

      // Only process first 4 chunks max to stay within Vercel timeout
      const chunksToProcess = chunks.slice(0, 4);
      const qPerChunk = Math.ceil(10 / chunksToProcess.length);

      for (const chunk of chunksToProcess) {
        try {
          const prompt = buildMCQPrompt(chunk, videoTitle, qPerChunk);
          const result = await callGroq(prompt);
          if (result) {
            const parsed = parseAIJson(result);
            if (parsed?.questions) allQuestions.push(...parsed.questions);
          }
        } catch (e) {
          console.warn('[MCQ] Groq chunk failed:', e.message);
        }
        await new Promise(r => setTimeout(r, 300));
      }
      provider = 'groq';
    }

    if (!allQuestions.length) {
      return res.status(500).json({ success: false, error: 'Could not generate questions. Try again in a moment.' });
    }

    // Cap at 15 questions
    allQuestions = allQuestions.slice(0, 15);

    // Ensure quiz exists
    let { rows: [quiz] } = await pool.query(
      `SELECT id FROM quizzes WHERE course_id = $1`, [courseId]
    );
    if (!quiz) {
      const { rows: [newQuiz] } = await pool.query(
        `INSERT INTO quizzes (course_id, title, passing_score, time_limit, generated_by)
         VALUES ($1, $2, 80, 1800, $3) RETURNING *`,
        [courseId, `${videoTitle || 'Course'} Quiz`, provider]
      );
      quiz = newQuiz;
    }

    // Replace questions
    await pool.query(`DELETE FROM quiz_questions WHERE quiz_id = $1`, [quiz.id]);
    for (const q of allQuestions) {
      await pool.query(
        `INSERT INTO quiz_questions (quiz_id, question, options, correct_index, explanation, difficulty)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [quiz.id, q.question, JSON.stringify(q.options),
         q.correct ?? q.correct_index ?? 0,
         q.explanation || '', q.difficulty || 'medium']
      );
    }
    await pool.query(`UPDATE quizzes SET generated_by=$1 WHERE id=$2`, [provider, quiz.id]);

    res.json({ success: true, count: allQuestions.length, provider, quizId: quiz.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function buildMCQPrompt(transcript, videoTitle, count = 10) {
  return `You are an expert educator creating quiz questions for tech students.

Based on this video transcript, generate exactly ${count} multiple choice questions.
Video: "${videoTitle || 'Tech Course'}"

Transcript:
${transcript.slice(0, 80000)}

Rules:
- Questions must be directly answerable from the transcript
- 4 options each
- Mix difficulty: ${Math.ceil(count*0.3)} easy, ${Math.ceil(count*0.5)} medium, ${Math.floor(count*0.2)} hard
- No trick questions — test genuine understanding
- Options should be plausible but with one clearly correct answer
- Keep questions concise (under 20 words)

Return ONLY valid JSON, no markdown, no explanation:
{
  "questions": [
    {
      "question": "Question text here?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correct": 1,
      "explanation": "Brief explanation of why this is correct.",
      "difficulty": "medium"
    }
  ]
}`;
}

// GET /api/courses/:id/quiz — get quiz questions (randomized, no answers)
router.get('/:id/quiz', verifyToken, async (req, res) => {
  try {
    const { rows: [quiz] } = await pool.query(
      `SELECT * FROM quizzes WHERE course_id = $1`, [req.params.id]
    );
    if (!quiz) return res.status(404).json({ success: false, error: 'No quiz for this course yet' });

    const { rows: questions } = await pool.query(
      `SELECT id, question, options, difficulty FROM quiz_questions
       WHERE quiz_id = $1 ORDER BY RANDOM() LIMIT 15`,
      [quiz.id]
    );

    res.json({
      success: true,
      quiz: { id: quiz.id, title: quiz.title, passing_score: quiz.passing_score, time_limit: quiz.time_limit },
      questions
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/courses/:id/quiz/submit — grade quiz attempt
router.post('/:id/quiz/submit', verifyToken, async (req, res) => {
  try {
    const { answers, timeTaken } = req.body;
    const courseId = parseInt(req.params.id);
    const userId   = parseInt(req.user.id);   // cast — JWT may return string or uuid

    const { rows: [quiz] } = await pool.query(
      `SELECT * FROM quizzes WHERE course_id = $1`, [courseId]
    );
    if (!quiz) return res.status(404).json({ success: false, error: 'Quiz not found' });

    const { rows: questions } = await pool.query(
      `SELECT id, correct_index, explanation FROM quiz_questions WHERE quiz_id = $1`,
      [quiz.id]
    );

    let correct = 0;
    const feedback = {};
    for (const q of questions) {
      const selected = answers[q.id];
      const isCorrect = parseInt(selected) === q.correct_index;
      if (isCorrect) correct++;
      feedback[q.id] = { correct: isCorrect, correct_index: q.correct_index, explanation: q.explanation };
    }

    const score  = Math.round((correct / questions.length) * 100);
    const passed = score >= quiz.passing_score;

    await pool.query(
      `INSERT INTO quiz_attempts (user_id, quiz_id, score, passed, answers, time_taken)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, quiz.id, score, passed, JSON.stringify(answers), timeTaken || 0]
    );

    let certificate = null;
    if (passed) {
      const { rows: [existing] } = await pool.query(
        `SELECT * FROM certificates WHERE user_id = $1 AND course_id = $2`,
        [userId, courseId]
      );

      if (!existing) {
        const certUuid = genCertId();
        const { rows: [cert] } = await pool.query(
          `INSERT INTO certificates (cert_uuid, user_id, course_id, quiz_score)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [certUuid, userId, courseId, score]
        );
        certificate = cert;
      } else {
        certificate = existing;
      }
    }

    res.json({ success: true, score, passed, correct, total: questions.length, feedback, certificate });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PROGRESS TRACKING ─────────────────────────────────────────

// POST /api/courses/:id/progress — mark a video watched
router.post('/:id/progress', verifyToken, async (req, res) => {
  try {
    const { videoId } = req.body;
    const userId = parseInt(req.user.id);   // cast to INT

    await pool.query(
      `INSERT INTO video_progress (user_id, video_id, watched, watched_at)
       VALUES ($1,$2,TRUE,NOW())
       ON CONFLICT (user_id, video_id) DO UPDATE SET watched=TRUE, watched_at=NOW()`,
      [userId, parseInt(videoId)]
    );

    await pool.query(
      `INSERT INTO enrollments (user_id, course_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [userId, parseInt(req.params.id)]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/courses/:id/progress — get user's progress for a course
router.get('/:id/progress', verifyToken, async (req, res) => {
  try {
    const userId = parseInt(req.user.id);   // cast to INT
    const { rows: watched } = await pool.query(
      `SELECT vp.video_id FROM video_progress vp
       JOIN course_videos cv ON vp.video_id = cv.id
       WHERE vp.user_id = $1 AND cv.course_id = $2 AND vp.watched = TRUE`,
      [userId, parseInt(req.params.id)]
    );
    const { rows: [cert] } = await pool.query(
      `SELECT cert_uuid, issued_at FROM certificates WHERE user_id=$1 AND course_id=$2`,
      [userId, parseInt(req.params.id)]
    );
    res.json({ success: true, watchedVideoIds: watched.map(r => r.video_id), certificate: cert || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── END ───────────────────────────────────────────────────────
module.exports = router;