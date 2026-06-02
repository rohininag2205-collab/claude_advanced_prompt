const Anthropic = require('@anthropic-ai/sdk');

const MODEL_MAP = {
  haiku:    'claude-haiku-4-5-20251001',
  sonnet45: 'claude-sonnet-4-5',
  sonnet46: 'claude-sonnet-4-6',
  opus:     'claude-opus-4-8'
};

function detectTaskType(goal) {
  const g = (goal || '').toLowerCase();
  if (/\b(job|jobs|role|roles|position|hire|career|employ|opportunit|apply|applicat|recrui|salary|lpa|opening)\b/.test(g)) return 'jobsearch';
  if (/\b(prototype|screen|app|ui|ux|design|html|interface|wireframe|figma)\b/.test(g)) return 'prototype';
  if (/\b(resume|cv|rewrite|document|write|draft|email|letter|report|essay|blog|article|copy)\b/.test(g)) return 'document';
  return 'generic';
}

function buildSystemPrompt(stakes, role, con, taskType) {
  const stakesNote = {
    low:  'LOW stakes — be concise. Fewer caveats. Just get it done.',
    med:  'MEDIUM stakes — balance thoroughness with speed. Flag any genuine uncertainties.',
    high: 'HIGH stakes — be thorough. Explicitly call out anything uncertain, any guess, any number that needs verification. When in doubt, flag it.'
  }[stakes] || '';

  const protoInstructions = taskType === 'prototype' ? `
TASK TYPE: Prototype / UI Design

You are producing HTML screens for an interactive prototype. Split the prototype into 2–3 key screens or views.

For each output section (one screen):
- title: short screen name (e.g. Dashboard, Login Screen, Product Detail)
- body: complete, self-contained HTML snippet for that screen with all inline CSS
  - Use modern, clean styling with a consistent colour palette across all screens
  - Include realistic placeholder content (text, unicode icons, buttons)
  - Do NOT rely on external CSS frameworks — inline everything
  - The snippet is a single div containing the screen layout (not a full HTML page)
  - CRITICAL FOR VALID JSON: Use ONLY single quotes for ALL HTML attributes inside the body value.
    Write style='...' NOT style="...". Write class='foo' NOT class="foo".
    Double quotes inside a JSON string value will break the JSON.
- badge: bv for primary screens, br for secondary screens
- badgeText: Screen ready or Review layout

The user will accept individual screens. Accepted screens are combined into one navigable HTML prototype file.
` : '';

  const protoShape = taskType === 'prototype' ? `
Return this exact JSON shape (one entry per screen):

{
  "outputs": [
    {
      "title": "Screen name",
      "body": "<div style='...'> ...complete HTML for this screen... </div>",
      "badge": "bv",
      "badgeText": "✓ Screen ready",
      "reasonKey": "r1"
    }
  ],
  "reasons": {
    "r1": "<strong>Design choices:</strong> explain layout decisions for screen 1",
    "r2": "<strong>Design choices:</strong> explain layout decisions for screen 2"
  },
  "references": []
}
` : null;

  const jobSearchInstructions = taskType === 'jobsearch' ? `
TASK TYPE: Job/Career Search Analysis

You are acting as a career strategist doing a structured analysis based on what the user has shared about themselves (background, resume details, goals, constraints). Do NOT search the web or invent live job postings. Instead, provide:

OUTPUT 1 — "Best-fit roles & sectors" (badge: "bv")
- Based on the user's background and constraints, list the 3–5 job titles/roles that are the strongest match
- For each role: title, why it fits their profile, typical salary range (mention if constrained by their stated minimum), sectors/industries to target
- Format each as: <strong>[Job Title]</strong><br>Why it fits: ...<br>Salary range: ...<br>Target sectors: ...

OUTPUT 2 — "Companies & application strategy" (badge: "br")
- Types/sizes of companies that hire for these roles (not specific company names unless very well-known)
- What to emphasise in applications given their background
- Any gaps or areas to address before applying
- Format as structured bullets

OUTPUT 3 — "What Claude isn't sure about" (badge: "bd") — include ONLY if there are genuine uncertainties
- Specific things Claude couldn't determine from the information provided (e.g., exact current salary, location preference details, visa status)
- Questions the user should answer to get better recommendations
- Omit this section entirely if you have enough context

Use real salary ranges relevant to their location/market if mentioned. If salary constraints were stated (e.g. "minimum 15 LPA"), anchor ALL salary mentions to that constraint.
` : '';

  const baseShape = protoShape || (taskType === 'jobsearch' ? `
Return this exact JSON shape:

{
  "outputs": [
    {
      "title": "Best-fit roles & sectors",
      "body": "HTML content with structured role recommendations",
      "badge": "bv",
      "badgeText": "✓ Strong matches from your profile",
      "reasonKey": "r1"
    },
    {
      "title": "Companies & application strategy",
      "body": "HTML content with company types and application advice",
      "badge": "br",
      "badgeText": "⚠ Strategy — based on inferred market fit",
      "reasonKey": "r2"
    }
  ],
  "reasons": {
    "r1": "<strong>Why these roles fit:</strong> explanation based on profile analysis",
    "r2": "<strong>Application strategy:</strong> reasoning behind recommendations"
  },
  "references": []
}

Add a third output with badge "bd" and reasonKey "r3" ONLY if there are genuine unknowns the user needs to clarify.
` : `
Split the result into 2–3 logical sections. Return this exact JSON shape:

{
  "outputs": [
    {
      "title": "Section title",
      "body": "Content as HTML — use <strong>, <br>, bullet points with •, numbered lists etc. Be thorough.",
      "badge": "bv",
      "badgeText": "✓ High confidence",
      "reasonKey": "r1"
    }
  ],
  "reasons": {
    "r1": "<strong>Why I'm confident:</strong> explanation of confidence or uncertainty for section 1",
    "r2": "<strong>Worth checking:</strong> explanation for section 2"
  },
  "references": [
    { "name": "filename or source name", "type": "file" }
  ]
}
`);

  return `You are Claude completing a task via the Advanced Prompting tool.

Complete the task described by the user and return the result as JSON.

${stakesNote}
${role ? `\nACT AS: ${role}` : ''}
${con ? `\nHARD CONSTRAINTS (never violate):\n${con}` : ''}
${protoInstructions}${jobSearchInstructions}
${baseShape}

Badge values:
- "bv" = high confidence (verified, factual, straightforward)
- "br" = review recommended (style choices made, interpretation involved)
- "bd" = needs validation (numbers, facts, legal/financial items to check)

badgeText examples:
- bv: "✓ High confidence"
- br: "⚠ Check — 2 style choices made"
- bd: "⚠ Validate — figures to verify"

reasonKey must match the output index: r1 for first output, r2 for second, r3 for third.
references: only include files/sources actually referenced.

IMPORTANT: Return ONLY valid JSON. No markdown code blocks, no preamble, no explanation outside the JSON.`;
}

function extractJSON(text) {
  // Strip markdown code blocks if present
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = match ? match[1].trim() : (() => {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    return start >= 0 && end > start ? text.slice(start, end + 1) : text.trim();
  })();

  // First try direct parse
  try { return JSON.parse(raw); } catch {}

  // Fallback: replace HTML attribute double quotes with single quotes inside JSON string values
  // This handles cases where Claude used style="..." instead of style='...' in the body field
  const sanitized = raw.replace(/"body"\s*:\s*"([\s\S]*?)(?<!\\)"/g, (m, inner) => {
    const fixed = inner.replace(/(?<!\\)"/g, "'");
    return `"body": "${fixed}"`;
  });
  try { return JSON.parse(sanitized); } catch {}

  // Last resort: strip any literal newlines inside string values
  const stripped = raw.replace(/(?<=:\s*")([\s\S]*?)(?="[,\n}\]])/g, s => s.replace(/\n/g, '\\n').replace(/\r/g, ''));
  return JSON.parse(stripped);
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

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { goal, ctx, fmt, role, con, stakes, model, interpretation, answers, files, taskType: clientTaskType, extraContext } = body;
  const taskType = clientTaskType || detectTaskType(goal);

  if (!goal) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'goal field is required' }) };
  }

  const selectedModel = MODEL_MAP[model] || 'claude-sonnet-4-6';
  const maxTokens = taskType === 'prototype' ? 8192 : 4096;

  const answersText = answers && answers.length > 0
    ? answers.map(a => {
        let line = `• ${a.question} → ${a.answer}`;
        if (a.clarification) line += ` (user note: ${a.clarification})`;
        return line;
      }).join('\n')
    : '';

  const filesText = files && files.length > 0
    ? '\n\nFiles / references provided: ' + files.join(', ')
    : '';

  const userMessage =
    `TASK: ${goal}\n\n` +
    `CONTEXT: ${ctx || 'None provided'}\n\n` +
    `OUTPUT FORMAT: ${fmt || 'Use the most appropriate format for this task'}\n\n` +
    `BASE INTERPRETATION: ${interpretation || goal}` +
    (answersText ? `\n\nUSER CONFIRMED / CLARIFIED IN REVIEW:\n${answersText}\n\nINSTRUCTION: The user confirmations above OVERRIDE the base interpretation where they conflict. Incorporate them directly into your output — do not treat them as suggestions.` : '') +
    (extraContext ? `\n\nADDITIONAL CONTEXT FROM USER: ${extraContext}` : '') +
    filesText;

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: selectedModel,
      max_tokens: maxTokens,
      system: buildSystemPrompt(stakes, role, con, taskType),
      messages: [{ role: 'user', content: userMessage }]
    });

    const raw = message.content[0].text;
    const parsed = extractJSON(raw);

    // Validate output shape
    if (!parsed.outputs || !Array.isArray(parsed.outputs)) {
      throw new Error('Response missing outputs array');
    }

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  } catch (e) {
    console.error('claude-generate error:', e.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: `Generation failed: ${e.message}` })
    };
  }
};
