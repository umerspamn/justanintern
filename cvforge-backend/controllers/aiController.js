// ── Groq AI proxy controller ──────────────────────────────────────
// Keeps API keys server-side and provides a single endpoint for UI.
// Groq exposes an OpenAI-compatible chat completions API.

function extractTextFromGroq(payload) {
  // OpenAI-compatible shape: choices[0].message.content (a string)
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();

  // Some variants return content as an array of blocks
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (typeof b?.text === 'string' ? b.text : ''))
      .join('\n')
      .trim();
    if (text) return text;
  }

  // Fallbacks for any shape variation
  if (typeof payload?.text === 'string') return payload.text;
  return '';
}

function tryParseJson(raw) {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch (_) {}

  // Strip markdown code fences if present, then retry
  const fenced = text.replace(/```(?:json)?/gi, '').trim();
  if (fenced !== text) {
    try {
      return JSON.parse(fenced);
    } catch (_) {}
  }

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

async function groqGenerate(req, res) {
  try {
    const { prompt, expectJson = false, temperature = 0.5 } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ success: false, error: 'Prompt is required.' });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: 'GROQ_API_KEY is missing on server.' });
    }

    const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

    const body = {
      model,
      temperature,
      messages: [{ role: 'user', content: prompt }]
    };

    // Ask Groq to guarantee valid JSON when the caller expects it.
    // NOTE: json_object mode requires the word "JSON" in the prompt,
    // which all of this app's expectJson prompts already include.
    if (expectJson) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const payload = await response.json();
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        (typeof payload?.error === 'string' ? payload.error : null) ||
        payload?.message ||
        'Groq request failed.';
      return res.status(response.status).json({ success: false, error: message });
    }

    const text = extractTextFromGroq(payload);
    if (!text) {
      return res.status(502).json({ success: false, error: 'Empty response from Groq.' });
    }

    if (!expectJson) {
      return res.status(200).json({ success: true, text });
    }

    const json = tryParseJson(text);
    if (!json) {
      return res.status(502).json({
        success: false,
        error: 'Groq response was not valid JSON.',
        raw: text
      });
    }

    // json_object mode forces an object, but some prompts ask for an array
    // (e.g. [{...}]). Groq then wraps it like {"schedule":[...]}. If the
    // object has exactly one property and that value is an array, unwrap it
    // so array-expecting callers receive the array directly.
    let result = json;
    if (json && !Array.isArray(json) && typeof json === 'object') {
      const keys = Object.keys(json);
      if (keys.length === 1 && Array.isArray(json[keys[0]])) {
        result = json[keys[0]];
      }
    }

    return res.status(200).json({ success: true, json: result, raw: text });
  } catch (err) {
    console.error('[AI] groqGenerate error:', err.message);
    return res.status(500).json({ success: false, error: 'AI request failed.' });
  }
}

module.exports = { groqGenerate };