// Server-side proxy for photo-based workout import. Sends an uploaded
// screenshot to Claude's vision API and returns structured fields only --
// the frontend always shows these to the athlete for review/edit before
// they're added to real training data, never auto-imports them.
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 300;
const MAX_IMAGE_BASE64_CHARS = 6_000_000; // ~4.5MB raw, well under function payload limits

const EXTRACTION_SYSTEM = `You extract structured workout data from a photo of a fitness app screen (Apple Health, Apple Watch workout summary, Garmin, Strava, or similar). Look for: date, duration, average heart rate, max heart rate, active calories/energy burned, and whether it looks like a competitive match, a practice/drill session, or casual/social play.

Respond with ONLY a single JSON object, no markdown fences, no commentary, no explanation -- exactly this shape:
{"date": "YYYY-MM-DD" or null, "duration_min": number or null, "avg_hr": number or null, "max_hr": number or null, "calories": number or null, "type": "match" or "drill" or "social" or null}

If the image isn't a workout/fitness summary screen, or you can't confidently read a field, set that field to null rather than guessing. Never fabricate a value you can't actually see in the image -- an athlete will use these numbers to judge injury risk, so a wrong guess is worse than a null.`;

export default async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('[extract-workout] ANTHROPIC_API_KEY is not configured on this site');
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured on this site' }), { status: 500 });
    }

    let body;
    try {
      body = await req.json();
    } catch (e) {
      console.error('[extract-workout] invalid JSON body:', e.message);
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
    }

    const { imageBase64, mimeType } = body || {};
    if (typeof imageBase64 !== 'string' || !imageBase64) {
      return new Response(JSON.stringify({ error: 'Missing imageBase64' }), { status: 400 });
    }
    if (imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
      return new Response(JSON.stringify({ error: 'Image too large -- try a smaller screenshot' }), { status: 400 });
    }
    const media_type = typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';

    console.log('[extract-workout] request received, image bytes (base64):', imageBase64.length);

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
          thinking: { type: 'disabled' },
          system: EXTRACTION_SYSTEM,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type, data: imageBase64 } },
                { type: 'text', text: 'Extract the workout data from this screenshot as JSON.' },
              ],
            },
          ],
        }),
      });
    } catch (e) {
      console.error('[extract-workout] fetch to Anthropic threw:', e.message);
      return new Response(JSON.stringify({ error: 'Could not reach Anthropic API' }), { status: 502 });
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error(`[extract-workout] Anthropic API error ${upstream.status}:`, detail);
      return new Response(JSON.stringify({ error: `Anthropic API error ${upstream.status}`, detail }), { status: 502 });
    }

    const data = await upstream.json();
    const rawText = (data.content || []).find((b) => b.type === 'text')?.text || '';
    if (!rawText) {
      console.error('[extract-workout] empty response from model, raw data:', JSON.stringify(data));
      return new Response(JSON.stringify({ error: 'Empty response from model' }), { status: 502 });
    }

    let extracted;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      extracted = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
    } catch (e) {
      console.error('[extract-workout] could not parse model output as JSON:', rawText);
      return new Response(JSON.stringify({ error: 'Could not parse extracted data' }), { status: 502 });
    }

    return new Response(JSON.stringify({ extracted }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    console.error('[extract-workout] unhandled exception:', e && e.stack ? e.stack : e);
    return new Response(JSON.stringify({ error: 'Unhandled error in extract-workout function' }), { status: 500 });
  }
};

export const config = { path: '/api/extract-workout' };
