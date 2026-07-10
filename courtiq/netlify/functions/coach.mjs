// Server-side proxy for the CourtIQ coach. Keeps ANTHROPIC_API_KEY out of the
// browser bundle — the client posts the data digest + question here, and this
// function is the only thing that ever talks to Anthropic.
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 600;
const MAX_HISTORY = 10;

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured on this site' }), { status: 500 });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  const { system, digest, messages, question } = body || {};
  if (typeof question !== 'string' || !question.trim()) {
    return new Response(JSON.stringify({ error: 'Missing question' }), { status: 400 });
  }

  const history = Array.isArray(messages) ? messages.slice(-MAX_HISTORY) : [];
  const anthropicMessages = [
    ...history
      .filter((m) => m && typeof m.text === 'string')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text })),
    {
      role: 'user',
      content: `Current data snapshot (JSON, computed directly from the athlete's real session/health data — treat every number as ground truth, never invent or estimate beyond it):\n${digest || '{}'}\n\nAthlete's message: ${question}`,
    },
  ];

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: system || undefined,
        messages: anthropicMessages,
      }),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not reach Anthropic API' }), { status: 502 });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return new Response(JSON.stringify({ error: `Anthropic API error ${upstream.status}`, detail }), { status: 502 });
  }

  const data = await upstream.json();
  const text = (data.content || []).find((b) => b.type === 'text')?.text || '';
  if (!text) {
    return new Response(JSON.stringify({ error: 'Empty response from model' }), { status: 502 });
  }

  return new Response(JSON.stringify({ text }), { status: 200, headers: { 'content-type': 'application/json' } });
};

export const config = { path: '/api/coach' };
