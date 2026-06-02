const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You are a prompt-parsing assistant for a tool called Claude Advanced Prompting.

The user will give you a plain-language description of a task they want Claude to complete.
Parse it and return a JSON object with ONLY these fields:

{
  "goal": "the specific end result they want (1–3 sentences, clear and concrete)",
  "ctx": "any background information, context, files, or references mentioned (empty string if none)",
  "fmt": "desired output format or structure (empty string if not specified)",
  "role": "expert role or persona to adopt (empty string if not specified)",
  "con": "hard constraints or things Claude must NOT do (empty string if none mentioned)",
  "stakes": "low" | "med" | "high",
  "interpretation": "2–3 sentence plain-language summary of exactly what you will do, starting with a verb",
  "assumptions": [{"text": "assumption text", "risk": false}],
  "questions": [{"id": "q1", "label": "Key question", "q": "question text", "why": "brief reason this matters", "opts": ["option 1", "option 2", "option 3"]}]
}

Stakes guidance:
- "low": brainstorming, rough drafts, experiments, quick notes
- "med": internal documents, personal projects, general tasks
- "high": legal, financial, medical, career-critical, content shared externally

Questions guidance:
- 0 questions for low stakes (just get started)
- 1–2 questions for medium stakes (only what genuinely affects quality)
- 2–3 questions for high stakes (anything that could cause a material mistake)
- Each question must have exactly 3 short options

Assumptions: list 2–5 things you are assuming. Mark risk:true for assumptions that could cause significant problems if wrong.

IMPORTANT: Return ONLY valid JSON. No markdown code blocks, no explanation, no preamble.`;

function extractJSON(text) {
  // Strip markdown code blocks if present
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return JSON.parse(match[1].trim());
  // Try parsing directly
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  return JSON.parse(text.trim());
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ error: 'API key not configured — add ANTHROPIC_API_KEY to Netlify environment variables' })
    };
  }

  let text;
  try {
    ({ text } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!text || !text.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'text field is required' }) };
  }

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text.trim() }]
    });
    console.log('API call succeeded');

    const raw = message.content[0].text;
    const parsed = extractJSON(raw);

    // Validate required fields and provide defaults
    const result = {
      goal: parsed.goal || text.trim().slice(0, 200),
      ctx: parsed.ctx || '',
      fmt: parsed.fmt || '',
      role: parsed.role || '',
      con: parsed.con || '',
      stakes: ['low', 'med', 'high'].includes(parsed.stakes) ? parsed.stakes : 'med',
      interpretation: parsed.interpretation || 'Complete the task as described.',
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions : []
    };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    const detail = e?.status ? `HTTP ${e.status}: ${e.message}` : e.message;
    console.error('claude-understand error:', detail, e?.error || '');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: `Parsing failed: ${detail}`, detail: e?.error })
    };
  }
};
