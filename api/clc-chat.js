// api/clc-chat.js — minimal probe (no OpenAI yet)
module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, version: 'probe-1' });
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // Robust body parsing (works even if req.body isn't auto-parsed)
  let raw = '';
  await new Promise((resolve) => {
    req.on('data', (c) => (raw += c));
    req.on('end', resolve);
  });

  let text = '';
  try {
    const json = raw ? JSON.parse(raw) : (req.body || {});
    text = typeof json.text === 'string' ? json.text : '';
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!text) return res.status(400).json({ error: 'Missing text' });

  // Echo back for now
  return res.status(200).json({ ok: true, version: 'probe-1', echo: text });
};
