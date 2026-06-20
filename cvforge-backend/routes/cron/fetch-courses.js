// ═══════════════════════════════════════════════════════════════
//  routes/cron/fetch-courses.js
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const { pool } = require('../../config/db');

const CATEGORY_QUERIES = [
  {
    category:   'Python',
    difficulty: 'Beginner',
    tags:       ['python', 'programming', 'beginner'],
    queries:    ['python full course beginners', 'python programming tutorial complete', 'learn python free']
  },
  {
    category:   'Web Dev',
    difficulty: 'Beginner',
    tags:       ['html', 'css', 'javascript', 'web'],
    queries:    ['html css javascript full course', 'web development bootcamp free', 'frontend development tutorial']
  },
  {
    category:   'Web Dev',
    difficulty: 'Intermediate',
    tags:       ['react', 'nodejs', 'fullstack'],
    queries:    ['react js full course 2024', 'nodejs express full course', 'full stack web development free']
  },
  {
    category:   'DSA',
    difficulty: 'Intermediate',
    tags:       ['data structures', 'algorithms', 'leetcode'],
    queries:    ['data structures algorithms full course', 'DSA complete course free', 'algorithms tutorial beginners']
  },
  {
    category:   'SQL',
    difficulty: 'Beginner',
    tags:       ['sql', 'database', 'mysql'],
    queries:    ['sql full course beginners', 'mysql complete tutorial free', 'database sql tutorial']
  },
  {
    category:   'DevOps',
    difficulty: 'Intermediate',
    tags:       ['docker', 'kubernetes', 'devops', 'aws'],
    queries:    ['devops full course free', 'docker kubernetes tutorial', 'aws cloud complete course']
  },
  {
    category:   'AI/ML',
    difficulty: 'Intermediate',
    tags:       ['machine learning', 'ai', 'python ml'],
    queries:    ['machine learning full course free', 'deep learning tutorial complete', 'AI course beginners']
  },
  {
    category:   'Mobile',
    difficulty: 'Beginner',
    tags:       ['flutter', 'react native', 'android'],
    queries:    ['flutter full course free', 'react native complete tutorial', 'android development course']
  },
  {
    category:   'Python',
    difficulty: 'Intermediate',
    tags:       ['django', 'flask', 'fastapi'],
    queries:    ['django full course free', 'flask python tutorial complete', 'fastapi python course']
  },
  {
    category:   'Other',
    difficulty: 'Beginner',
    tags:       ['git', 'linux', 'networking'],
    queries:    ['git github full course free', 'linux command line complete', 'networking fundamentals course']
  }
];

const TRUSTED_CHANNELS = new Set([
  'freecodecamp.org', 'traversy media', 'the net ninja', 'fireship',
  'cs50', 'mit opencourseware', 'programming with mosh', 'techworld with nana',
  'sentdex', 'corey schafer', 'academind', 'clever programmer',
  'web dev simplified', 'derek banas', 'tech with tim', 'bro code',
  'coding with john', 'amigoscode', 'networkchuck',
]);

function scoreVideo(stats, snippet, isTrusted) {
  const views      = parseInt(stats.viewCount  || 0);
  const likes      = parseInt(stats.likeCount  || 0);
  const viewScore  = Math.log10(Math.max(views, 1)) / 8;
  const engagement = views > 0 ? (likes / views) * 1000 : 0;
  const engScore   = Math.min(engagement / 50, 1);
  const published  = new Date(snippet.publishedAt);
  const ageMonths  = (Date.now() - published) / (1000 * 60 * 60 * 24 * 30);
  const recency    = Math.max(0, 1 - ageMonths / 36);
  const trust      = isTrusted ? 0.2 : 0;
  return (viewScore * 0.5) + (engScore * 0.25) + (recency * 0.15) + trust;
}

function parseDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + parseInt(match[3] || 0);
}

async function ytSearch(query, maxResults = 8) {
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part',             'snippet');
  url.searchParams.set('q',               query);
  url.searchParams.set('type',            'video');
  url.searchParams.set('videoDuration',   'long');
  url.searchParams.set('videoEmbeddable', 'true');
  url.searchParams.set('relevanceLanguage', 'en');
  url.searchParams.set('order',           'relevance');
  url.searchParams.set('maxResults',      maxResults);
  url.searchParams.set('key',             process.env.YoutubeAPIKey);
  const res  = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(`YouTube search: ${data.error.message}`);
  return data.items || [];
}

async function ytVideoDetails(videoIds) {
  if (!videoIds.length) return [];
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,contentDetails,statistics');
  url.searchParams.set('id',   videoIds.join(','));
  url.searchParams.set('key',  process.env.YoutubeAPIKey);
  const res  = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(`YouTube details: ${data.error.message}`);
  return data.items || [];
}

async function upsertCourse(client, video, category, difficulty, tags, score) {
  const snippet  = video.snippet;
  const stats    = video.statistics    || {};
  const details  = video.contentDetails || {};
  const duration = parseDuration(details.duration || 'PT0S');
  const views    = parseInt(stats.viewCount || 0);
  const thumb    = snippet.thumbnails?.maxres?.url
                || snippet.thumbnails?.high?.url
                || snippet.thumbnails?.medium?.url || '';

  const { rows: [existing] } = await client.query(
    `SELECT id FROM courses WHERE youtube_id = $1`, [video.id]
  );

  if (existing) {
    await client.query(
      `UPDATE courses SET view_count=$1, relevance_score=$2, thumbnail_url=$3, updated_at=NOW()
       WHERE youtube_id=$4`,
      [views, score, thumb, video.id]
    );
    return 'updated';
  }

  const { rows: [inserted] } = await client.query(
    `INSERT INTO courses
       (youtube_id, title, description, category, difficulty,
        thumbnail_url, channel_name, tags, total_videos,
        total_hours, view_count, relevance_score, is_approved, auto_fetched)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,TRUE)
     RETURNING id`,
    [
      video.id,
      snippet.title,
      (snippet.description || '').slice(0, 500),
      category, difficulty, thumb,
      snippet.channelTitle, tags, 1,
      parseFloat((duration / 3600).toFixed(1)),
      views, score
    ]
  );

  if (inserted) {
    await client.query(
      `INSERT INTO course_videos (course_id, youtube_id, title, duration_secs, order_index)
       VALUES ($1,$2,$3,$4,0) ON CONFLICT DO NOTHING`,
      [inserted.id, video.id, snippet.title, duration]
    );
  }

  return 'inserted';
}

// ── MAIN HANDLER ──────────────────────────────────────────────
router.get('/', async (req, res) => {
  const authHeader   = req.headers['authorization'] || '';
  const cronSecret   = process.env.CRON_SECRET || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isDev        = process.env.NODE_ENV === 'development';

  // Allow in dev without secret, require secret in production
  if (!isDev && !isVercelCron && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const results   = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  const client    = await pool.connect();

  try {
    console.log('[Cron] Starting daily course fetch…');

    for (const group of CATEGORY_QUERIES) {
      for (const query of group.queries) {
        try {
          const searchItems = await ytSearch(query, 8);
          if (!searchItems.length) continue;

          const videoIds = searchItems.map(i => i.id?.videoId).filter(Boolean);
          if (!videoIds.length) continue;

          const videos = await ytVideoDetails(videoIds);

          const qualified = videos
            .filter(v => {
              const dur   = parseDuration(v.contentDetails?.duration || 'PT0S');
              const views = parseInt(v.statistics?.viewCount || 0);
              return dur >= 1800 && views >= 50000;
            })
            .map(v => {
              const isTrusted = TRUSTED_CHANNELS.has((v.snippet.channelTitle || '').toLowerCase());
              return { ...v, score: scoreVideo(v.statistics, v.snippet, isTrusted) };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);

          for (const video of qualified) {
            try {
              const action = await upsertCourse(client, video, group.category, group.difficulty, group.tags, video.score);
              results[action]++;
            } catch (e) {
              results.errors.push(`${video.id}: ${e.message}`);
              results.skipped++;
            }
          }

          await new Promise(r => setTimeout(r, 200));
        } catch (e) {
          results.errors.push(`"${query}": ${e.message}`);
        }
      }
    }

    // Log run (ignore if table missing)
    await client.query(
      `INSERT INTO cron_logs (job_name, inserted, updated, skipped, duration_ms, errors)
       VALUES ('fetch_courses',$1,$2,$3,$4,$5)`,
      [results.inserted, results.updated, results.skipped, Date.now() - startTime, JSON.stringify(results.errors)]
    ).catch(() => {});

    console.log(`[Cron] Done in ${Date.now() - startTime}ms`, results);
    res.json({ success: true, ...results, duration_ms: Date.now() - startTime });

  } catch (err) {
    console.error('[Cron] Fatal:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;