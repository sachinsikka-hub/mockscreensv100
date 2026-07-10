// Server-side proxy for the CourtIQ coach. Keeps ANTHROPIC_API_KEY out of the
// browser bundle — the client posts the data digest + question here, and this
// function is the only thing that ever talks to Anthropic.
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 400;
const MAX_HISTORY = 6;
const MAX_HISTORY_CHARS = 400;

export default async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('[coach] ANTHROPIC_API_KEY is not configured on this site');
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured on this site' }), { status: 500 });
    }

    let body;
    try {
      body = await req.json();
    } catch (e) {
      console.error('[coach] invalid JSON body:', e.message);
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
    }

    const { system, digest, messages, question } = body || {};
    if (typeof question !== 'string' || !question.trim()) {
      console.error('[coach] missing question in body:', JSON.stringify(body));
      return new Response(JSON.stringify({ error: 'Missing question' }), { status: 400 });
    }

    const truncate = (s) => (s.length > MAX_HISTORY_CHARS ? `${s.slice(0, MAX_HISTORY_CHARS)}…` : s);
    let history = Array.isArray(messages) ? messages.slice(-MAX_HISTORY) : [];
    history = history.filter((m) => m && typeof m.text === 'string');
    // Anthropic requires the conversation to open on a user turn — the app's
    // hardcoded assistant greeting bubble would otherwise lead the history.
    while (history.length && history[0].role !== 'user') history = history.slice(1);
    const anthropicMessages = [
      ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: truncate(m.text) })),
      {
        role: 'user',
        content: `Current data snapshot (JSON, computed directly from the athlete's real session/health data — treat every number as ground truth, never invent or estimate beyond it):\n${digest || '{}'}\n\nAthlete's message: ${question}`,
      },
    ];

    console.log('[coach] request:', JSON.stringify({ model: MODEL, historyLen: anthropicMessages.length, question }));

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
      console.error('[coach] fetch to Anthropic threw:', e.message);
      return new Response(JSON.stringify({ error: 'Could not reach Anthropic API' }), { status: 502 });
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error(`[coach] Anthropic API error ${upstream.status}:`, detail);
      return new Response(JSON.stringify({ error: `Anthropic API error ${upstream.status}`, detail }), { status: 502 });
    }

    const data = await upstream.json();
    const text = (data.content || []).find((b) => b.type === 'text')?.text || '';
    if (!text) {
      console.error('[coach] empty response from model, raw data:', JSON.stringify(data));
      return new Response(JSON.stringify({ error: 'Empty response from model' }), { status: 502 });
    }

    return new Response(JSON.stringify({ text }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    console.error('[coach] unhandled exception:', e && e.stack ? e.stack : e);
    return new Response(JSON.stringify({ error: 'Unhandled error in coach function' }), { status: 500 });
  }
};

export const config = { path: '/api/coach' };
