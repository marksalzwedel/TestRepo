// api/clc-chat.js — diagnostic build (safe to leave overnight)
const VERSION = 'diag-v1';

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        version: VERSION,
        hasKey: Boolean(process.env.OPENAI_API_KEY),
        node: process.version
      });
    }
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // robust JSON parse
    let raw = '';
    await new Promise((resolve) => {
      req.on('data', c => (raw += c));
      req.on('end', resolve);
    });
    let text = '';
    try {
      const json = raw ? JSON.parse(raw) : (req.body || {});
      text = typeof json.text === 'string' ? json.text : '';
    } catch {
      return res.status(400).json({ error: 'Invalid JSON', raw, version: VERSION });
    }
    if (!text) return res.status(400).json({ error: 'Missing text', version: VERSION });

    // Early key check
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY is not set', version: VERSION });
    }

    // Call OpenAI with extra diagnostics
    let aiRes;
    try {
      aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'Diagnostic ping' },
            { role: 'user', content: text }
          ]
        })
      });
    } catch (netErr) {
      return res.status(502).json({ error: 'Network error calling OpenAI', details: String(netErr), version: VERSION });
    }

    const textBody = await aiRes.text();
    if (!aiRes.ok) {
      return res.status(502).json({
        error: 'OpenAI error',
        status: aiRes.status,
        statusText: aiRes.statusText,
        body: textBody,
        version: VERSION
      });
    }

    let data;
    try { data = JSON.parse(textBody); }
    catch {
      return res.status(500).json({ error: 'Failed to parse OpenAI JSON', body: textBody.slice(0, 800), version: VERSION });
    }

    const reply = data?.choices?.[0]?.message?.content?.trim() || '(empty reply)';
    return res.status(200).json({ reply, version: VERSION });
  } catch (e) {
    return res.status(500).json({ error: 'Server crash', details: String(e), version: VERSION });
  }
};
