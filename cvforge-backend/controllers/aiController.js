// ── Cohere AI proxy controller ────────────────────────────────────
// Keeps API keys server-side and provides a single endpoint for UI.

function extractTextFromCohere(payload) {
  // v2/chat typically returns message.content as an array of blocks.
  const blocks = payload?.message?.content;
  if (Array.isArray(blocks)) {
    const text = blocks
      .map((b) => (typeof b?.text === 'string' ? b.text : ''))
      .join('\n')
      .trim();
    if (text) return text;
  }

  // Fallbacks for any shape variation
  if (typeof payload?.text === 'string') return payload.text;
  if (typeof payload?.message === 'string') return payload.message;
  return '';
}

function tryParseJson(raw) {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch (_) {}

  // Fallback: extract first JSON object/array segment
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try {
      return JSON.parse(text.slice(objStart, objEnd + 1));
    } catch (_) {}
  }

  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      return JSON.parse(text.slice(arrStart, arrEnd + 1));
    } catch (_) {}
  }

  return null;
}

async function cohereGenerate(req, res) {
  try {
    const { prompt, expectJson = false, temperature = 0.5 } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ success: false, error: 'Prompt is required.' });
    }

    const apiKey = process.env.COHERE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: 'COHERE_API_KEY is missing on server.' });
    }

    const model = process.env.COHERE_MODEL || 'command-a-03-2025';

    const response = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      const message = payload?.message || payload?.error || 'Cohere request failed.';
      return res.status(response.status).json({ success: false, error: message });
    }

    const text = extractTextFromCohere(payload);
    if (!text) {
      return res.status(502).json({ success: false, error: 'Empty response from Cohere.' });
    }

    if (!expectJson) {
      return res.status(200).json({ success: true, text });
    }

    const json = tryParseJson(text);
    if (!json) {
      return res.status(502).json({
        success: false,
        error: 'Cohere response was not valid JSON.',
        raw: text
      });
    }

    return res.status(200).json({ success: true, json, raw: text });
  } catch (err) {
    console.error('[AI] cohereGenerate error:', err.message);
    return res.status(500).json({ success: false, error: 'AI request failed.' });
  }
}

module.exports = { cohereGenerate };
