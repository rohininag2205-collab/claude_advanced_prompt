const Anthropic = require('@anthropic-ai/sdk');

const GENERATION_MODEL = 'claude-haiku-4-5-20251001';

const OUTPUT_TOOL = {
  name: 'generate_output',
  description: 'Return the structured output sections for the user\'s task.',
  input_schema: {
    type: 'object',
    properties: {
      outputs: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            title:     { type: 'string', description: 'Short section title' },
            body:      { type: 'string', description: 'Section content as HTML' },
            badge:     { type: 'string', enum: ['bv', 'br', 'bd'] },
            badgeText: { type: 'string', description: 'Badge label shown to user' },
            reasonKey: { type: 'string', description: 'r1, r2, or r3 — matches a key in reasons' }
          },
          required: ['title', 'body', 'badge', 'badgeText', 'reasonKey']
        }
      },
      reasons: {
        type: 'object',
        description: 'Explanations keyed by r1, r2, r3',
        additionalProperties: { type: 'string' }
      },
      references: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string' }
          },
          required: ['name', 'type']
        }
      }
    },
    required: ['outputs', 'reasons', 'references']
  }
};

function detectTaskType(goal) {
  const g = (goal || '').toLowerCase();
  if (/\b(job|jobs|role|roles|position|hire|career|employ|opportunit|apply|applicat|recrui|salary|lpa|opening)\b/.test(g)) return 'jobsearch';
  if (/\b(prototype|screen|app|ui|ux|design|html|interface|wireframe|figma)\b/.test(g)) return 'prototype';
  if (/\b(resume|cv|rewrite|document|write|draft|email|letter|report|essay|blog|article|copy)\b/.test(g)) return 'document';
  return 'generic';
}

function buildFinalPolishPrompt(taskType, role, con) {
  const instructions = {
    prototype: `You are combining user-validated HTML screens into one final polished prototype.
Create a single, complete, navigable HTML prototype that integrates all the accepted screens.
Return ONE output section titled "Final Prototype" with the complete HTML as the body.
Badge: "bv". BadgeText: "✓ Final prototype".`,
    document: `You are creating the final polished document from user-validated sections.
Combine them into one seamless, well-structured final document — smooth out transitions, remove draft markers.
Return ONE output section with the complete document as the body.
Badge: "bv". BadgeText: "✓ Final document".`,
    jobsearch: `You are writing a final career strategy summary from user-validated sections.
Combine them into a clean, professional summary — clear headings, action steps, salary guidance.
Return 1–2 output sections. Badge: "bv".`,
    generic: `You are creating the final polished result from user-validated sections.
Combine and refine them into a single coherent final output.
Return 1–2 output sections. Badge: "bv".`
  };

  return `You are Claude creating a FINAL polished output from user-validated draft sections.
${role ? `\nACT AS: ${role}` : ''}
${con ? `\nHARD CONSTRAINTS (never violate):\n${con}` : ''}

${instructions[taskType] || instructions.generic}

Badge values: bv = high confidence, br = review recommended, bd = needs validation.
Call the generate_output tool with your response.`;
}

function buildSystemPrompt(stakes, role, con, taskType) {
  const stakesNote = {
    low:  'LOW stakes — be concise. Fewer caveats. Just get it done.',
    med:  'MEDIUM stakes — balance thoroughness with speed. Flag genuine uncertainties.',
    high: 'HIGH stakes — be thorough. Call out anything uncertain, any guess, any number needing verification.'
  }[stakes] || '';

  const taskInstructions = {
    prototype: `TASK TYPE: Prototype / UI Design

Produce 2–3 key screens as separate output sections.
For each screen:
- title: short screen name (e.g. Dashboard, Login Screen)
- body: complete self-contained HTML div with all CSS inline. Use modern styling, realistic placeholder content, unicode icons. No external frameworks.
- badge: bv for primary screens, br for secondary
- badgeText: "✓ Screen ready" or "⚠ Review layout"`,

    jobsearch: `TASK TYPE: Job/Career Search Analysis

OUTPUT 1 — "Best-fit roles & sectors" (badge: bv)
List 3–5 job titles that fit the user's profile. For each: title, why it fits, salary range, target sectors.
Format: <strong>[Job Title]</strong><br>Why it fits: ...<br>Salary range: ...<br>Target sectors: ...

OUTPUT 2 — "Companies & application strategy" (badge: br)
Company types/sizes that hire these roles, what to emphasise in applications, gaps to address.

OUTPUT 3 — "What Claude isn't sure about" (badge: bd) — ONLY if genuine unknowns exist. Omit otherwise.`,

    document: `TASK TYPE: Document / Writing
Produce the document split into 2–3 logical sections. Use HTML formatting in body (strong, br, lists).`,

    generic: `Split the result into 2–3 logical sections. Use HTML formatting in body (strong, br, bullet points, numbered lists).`
  }[taskType] || `Split the result into 2–3 logical sections. Use HTML formatting in body.`;

  return `You are Claude completing a task via the Advanced Prompting tool.

${stakesNote}
${role ? `\nACT AS: ${role}` : ''}
${con ? `\nHARD CONSTRAINTS (never violate):\n${con}` : ''}

${taskInstructions}

Badge values:
- "bv" = high confidence (verified, factual, straightforward)
- "br" = review recommended (style choices or interpretation involved)
- "bd" = needs validation (numbers, facts, legal/financial items)

badgeText examples: "✓ High confidence" / "⚠ Check — style choices made" / "⚠ Validate — figures to verify"
reasonKey: r1 for first output, r2 for second, r3 for third.
reasons: one entry per output explaining confidence level.
references: only include files/sources actually used.

Call the generate_output tool with your complete response.`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'API key not configured — add ANTHROPIC_API_KEY to Vercel environment variables' });
  }

  const { goal, ctx, fmt, role, con, stakes, interpretation, answers, files, taskType: clientTaskType, extraContext, finalPolish } = req.body || {};
  const taskType = clientTaskType || detectTaskType(goal);

  if (!goal) {
    return res.status(400).json({ error: 'goal field is required' });
  }

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
    (answersText ? `\n\nUSER CONFIRMED / CLARIFIED IN REVIEW:\n${answersText}\n\nINSTRUCTION: These confirmations OVERRIDE the base interpretation where they conflict. Incorporate them directly.` : '') +
    (extraContext ? `\n\nADDITIONAL CONTEXT FROM USER: ${extraContext}` : '') +
    filesText;

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: GENERATION_MODEL,
      max_tokens: 3000,
      system: finalPolish ? buildFinalPolishPrompt(taskType, role, con) : buildSystemPrompt(stakes, role, con, taskType),
      tools: [OUTPUT_TOOL],
      tool_choice: { type: 'tool', name: 'generate_output' },
      messages: [{ role: 'user', content: userMessage }]
    });

    const toolUse = message.content.find(b => b.type === 'tool_use');
    if (!toolUse) throw new Error('Model did not return structured output');

    const parsed = toolUse.input;
    if (!parsed.outputs || !Array.isArray(parsed.outputs)) {
      throw new Error('Response missing outputs array');
    }

    return res.status(200).json(parsed);
  } catch (e) {
    console.error('claude-generate error:', e.message);
    return res.status(500).json({ error: `Generation failed: ${e.message}` });
  }
};
