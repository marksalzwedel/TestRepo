// api/clc-chat.js — 2-phase answers (offer deep dive) + autoloaded MD + allow-listed search/fetch
// Runtime: Node (Vercel root functions)
const fs = require('fs/promises');
const path = require('path');

const VERSION = 'kb-v7-deepdive-p1';
const REFUSAL_LINE = 'I’m not sure how to answer that. Would you like to chat with a person?';

// ---------- AUTO-LOAD all .md files from /data ----------
const DATA_DIR = path.join(process.cwd(), 'data');

let KB_CACHE = null; // [{ name, text }]
async function loadKB() {
  if (KB_CACHE) return KB_CACHE;
  let entries = [];
  try { entries = await fs.readdir(DATA_DIR, { withFileTypes: true }); }
  catch { KB_CACHE = []; return KB_CACHE; }

  const mdFiles = entries
    .filter(e => e.isFile() && /\.md$/i.test(e.name) && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));

  const loaded = [];
  for (const fname of mdFiles) {
    try {
      const text = await fs.readFile(path.join(DATA_DIR, fname), 'utf8');
      const name = fname.replace(/\.md$/i, '');
      loaded.push({ name, text });
    } catch { /* skip unreadable */ }
  }
  KB_CACHE = loaded;
  return KB_CACHE;
}

// ---------- Split Markdown into sections by headings ----------
function splitMarkdownIntoSections(md, sourceName) {
  const lines = md.split(/\r?\n/);
  const sections = [];
  let current = { title: `${sourceName}: (intro)`, body: [] };
  const push = () => {
    if (current && current.body.length) {
      const text = current.body.join('\n').trim();
      if (text && text.replace(/\s+/g, '').length > 0) {
        sections.push({ source: sourceName, title: current.title, text });
      }
    }
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      push();
      const level = m[1].length;
      const title = m[2].trim();
      current = { title: `${sourceName}: ${'#'.repeat(level)} ${title}`, body: [] };
    } else {
      current.body.push(line);
    }
  }
  push();
  return sections;
}

// ---------- Selector scoring (no DB) ----------
const STOP = new Set([
  'the','and','or','a','an','of','to','for','in','on','at','is','are','be',
  'with','by','it','we','you','our','from','as','that','this','these','those'
]);
function tokenize(s){ return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => !STOP.has(w)); }
function scoreSection(query, section){
  const q=tokenize(query), t=tokenize(section.text);
  if (!q.length || !t.length) return 0;
  let overlap=0; const tSet=new Set(t);
  for (const w of q) if (tSet.has(w)) overlap++;
  let titleBoost=0; const titleSet=new Set(tokenize(section.title));
  for (const w of q) if (titleSet.has(w)) titleBoost+=0.5;
  const lenPenalty=Math.max(0,(t.length-1200)/1200);
  return overlap + titleBoost - lenPenalty;
}
function selectTopSections(query, allSections, maxSections=3, maxCharsTotal=15000){
  const scored = allSections
    .map(s => ({ s, score: scoreSection(query, s) }))
    .filter(x => x.score > 0)
    .sort((a,b) => b.score - a.score);

  const picked=[]; let charCount=0;
  for (const x of scored) {
    const chunk = `### ${x.s.title}\n${x.s.text}`.trim();
    if (charCount + chunk.length > maxCharsTotal) continue;
    picked.push(chunk);
    charCount += chunk.length;
    if (picked.length >= maxSections) break;
  }
  return picked;
}

// ---------- Heuristics ----------
function isCivicQuestion(q){
  const s = q.toLowerCase();
  return /\b(vote|voting|election|candidate|president|governor|mayor|senator|trump|biden|party|republican|democrat|politic|policy|platform)\b/.test(s);
}
function isTheologyQuestion(q){
  const s = q.toLowerCase();
  return /\b(baptis|communion|eucharist|lord['’]?s supper|sacrament|justif|sanctif|atonement|trinity|triune|scripture|bible|means of grace|law and gospel|sin|grace|church|ministry|eschatology|return of jesus|heaven|hell|marriage|sexual|sanctity of life|abortion|conscience)\b/.test(s);
}
function civicBoostSections(query, allSections){
  if (!isCivicQuestion(query)) return [];
  const preferred = allSections.filter(sec => /churchandstate|christianliving/i.test(sec.source || ''));
  const trimmed=[];
  for (const sec of preferred) {
    const chunk = `### ${sec.source}: ${sec.title}\n${sec.text}`.trim();
    if (chunk.length <= 6000) trimmed.push(chunk);
    if (trimmed.length >= 2) break;
  }
  return trimmed;
}

// ---------- Allow-listed fetch tool ----------
const ALLOWLIST = [
  /^https?:\/\/(www\.)?wels\.net\/[^?]*$/i,
  /^https?:\/\/(www\.)?wisluthsem\.org\/[^?]*$/i,
  /^https?:\/\/(www\.)?christlutheran\.com\/[^?]*$/i
];
function allowedUrl(u){ return ALLOWLIST.some(rx => rx.test(u)); }
function stripHtml(html){
  html = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'');
  let text = html.replace(/<\/?(?:[^>]+)>/g,' ');
  text = text.replace(/\s+/g,' ').trim();
  return text;
}
async function fetchApproved(url, timeoutMs=5000){
  if (!allowedUrl(url)) return { ok:false, error:'URL not allowed', url };
  const controller = new AbortController();
  const t = setTimeout(()=>controller.abort(), timeoutMs);
  try{
    const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'CLC-Chatbot/1.0' } });
    clearTimeout(t);
    if (!r.ok) return { ok:false, error:`HTTP ${r.status}`, url };
    const html = await r.text();
    const txt = stripHtml(html).slice(0, 22000); // cap size
    return { ok:true, url, bytes: txt.length, text: txt };
  } catch(e){
    clearTimeout(t);
    return { ok:false, error:String(e), url };
  }
}

// ---------- Allow-listed search tool (parallel, short timeouts) ----------
const SEARCH_ENDPOINTS = [
  { name: 'wels', base: 'https://wels.net', q: (term) => `https://wels.net/?s=${encodeURIComponent(term)}` },
  { name: 'wisluthsem', base: 'https://www.wisluthsem.org', q: (term) => `https://www.wisluthsem.org/?s=${encodeURIComponent(term)}` },
  { name: 'clc', base: 'https://www.christlutheran.com', q: (term) => `https://www.christlutheran.com/?s=${encodeURIComponent(term)}` }
];
function extractLinks(html, base) {
  const links = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (!/^https?:\/\//i.test(href)) continue;
    if (!href.startsWith(base)) continue; // stay on that site
    if (/#/.test(href)) continue;        // skip jump links
    links.push(href);
    if (links.length >= 10) break;
  }
  return [...new Set(links)];
}
async function searchOne(ep, query, timeoutMs=4000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(ep.q(query), { signal: controller.signal, headers: { 'User-Agent': 'CLC-Chatbot/1.0' } });
    clearTimeout(t);
    if (!r.ok) return { site: ep.name, base: ep.base, links: [] };
    const html = await r.text();
    const links = extractLinks(html, ep.base);
    return { site: ep.name, base: ep.base, links };
  } catch {
    clearTimeout(t);
    return { site: ep.name, base: ep.base, links: [] };
  }
}
async function searchApproved(query) {
  const results = await Promise.all(SEARCH_ENDPOINTS.map(ep => searchOne(ep, query)));
  const trimmed = results.map(r => ({ site:r.site, base:r.base, links: r.links.slice(0,5) }));
  return { ok: true, query, results: trimmed };
}

// ---------- Deep-dive detector ----------
function textWantsDeepDive(q) {
  const s = q.toLowerCase();
  return /\b(deep dive|take your time|very thorough|research this|go deeper|dig deeper|summarize (?:wels|wisluthsem|wisconsin lutheran seminary))\b/i.test(s);
}

// ---------- Prompts (warm tone, strict scope) ----------
const SYSTEM_PROMPT = `
You are the CLC Chatbot for Christ Lutheran Church (Eden Prairie, MN).

MISSION & SCOPE (STRICT)
• Logistics: ONLY use christlutheran.com content and the provided “Selected Context.”
• Theology/ethics/doctrine: ONLY use WELS (wels.net) and Wisconsin Lutheran Seminary (wisluthsem.org) or clearly marked doctrine in “Selected Context.”
• Tools: You MAY use searchApproved to find candidate pages on those domains and fetchApproved to open 1–2 pages (more in deep-dive mode). Never browse beyond those domains or follow links automatically.
• If the answer is not clearly supported by those sources, use the exact refusal line provided by the developer.
• In deep-dive mode, include a short “Sources consulted” footer listing the WELS/WLS page titles (not raw URLs).


TONE & PASTORAL CARE
• Warm, welcoming, and kind. Plain language. Assume good intent.
• Default to concise 2–4 sentences; when context supports it, a short bulleted list is fine.
• Offer: “I can share more details if you’d like.” For sensitive topics, invite pastoral follow-up.

FOOTER (always append):
"(Generated by ChatGPT; may contain occasional errors. For confirmation or pastoral care, please contact Christ Lutheran Church via christlutheran.com.)"
`.trim();

const STYLE_GUIDE = `
Style:
• Begin with a warm micro-greeting when appropriate.
• Answer directly first; then offer one optional next step (link or “would you like more details?”).
• Keep sentences short; avoid jargon; use “we” and “you” where natural.
`.trim();

const DEEP_DIVE_GUIDE = `
Deep-dive mode (theological topics):
• Start with a one-sentence thesis that answers the question.
• Then provide 3–6 brief, numbered points that synthesize doctrine and pastoral application.
• Conclude with a short “discernment” or “next steps” checklist (3–5 bullets).
• Stay non-partisan; avoid speculation; ground everything in the provided context and tool results.
`.trim();

const FEW_SHOT = [
  { role: 'system', content:
`Example Q: What does WELS teach about Baptism?
Example A: Happy to help! Baptism is a means of grace where God gives forgiveness and new life through water and the Word. It's for all nations—including infants—whom God brings to faith. If you'd like, I can share more details.` }
];

// ---------- HTTP handler ----------
module.exports = async function handler(req, res) {
// GET health/version + file list
  if (req.method === 'GET') {
        // allow manual cache bust: /api/clc-chat?reload=1
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.searchParams.get('reload') === '1') {
        KB_CACHE = null;
      }
    } catch { /* ignore */ }
    
    const kb = await loadKB();
    const sizes = Object.fromEntries(kb.map(k => [k.name, k.text.length]));
    return res.status(200).json({
      ok: true,
      version: VERSION,
      hasKey: Boolean(process.env.OPENAI_API_KEY),
      files: kb.map(k => k.name),
      sizes,
      node: process.version
    });
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // Parse JSON body
  let raw=''; await new Promise(r => { req.on('data', c => (raw+=c)); req.on('end', r); });
  let text=''; let deepDiveParam=false;
  try {
    const json = raw ? JSON.parse(raw) : (req.body || {});
    text = typeof json.text==='string' ? json.text : '';
    deepDiveParam = !!json.deepDive;
  } catch {
    return res.status(400).json({ error:'Invalid JSON', version: VERSION });
  }
  if (!text) return res.status(400).json({ error:'Missing text', version: VERSION });

  // Decide deep-dive mode (explicit flag OR textual request)
  const deepDive = deepDiveParam || textWantsDeepDive(text);

  // Model limits
  const MAX_TOOL_CALLS = deepDive ? 6 : 2;
  const MODEL_TEMPERATURE = deepDive ? 0.40 : 0.36;

  // Load KB and sections
  const kb = await loadKB();
  const allSections = kb.flatMap(k => splitMarkdownIntoSections(k.text, k.name));

  // Select context (with civic boost still available)
  const boosted = civicBoostSections(text, allSections);
  const pickedTop = selectTopSections(
    text,
    allSections,
    deepDive ? 5 : (isCivicQuestion(text) ? 4 : 3),
    deepDive ? 22000 : 16000
  );
  const pickedArr = [...boosted, ...pickedTop].slice(0, deepDive ? 6 : 4);
  const pickedTitles = pickedArr.map(s => s.split('\n')[0].replace(/^###\s*/, ''));
  const selectedContext = pickedArr.length
    ? `SELECTED CONTEXT (top ${pickedArr.length} sections):\n\n${pickedArr.join('\n\n---\n\n')}`
    : `SELECTED CONTEXT: (none matched closely)`;

  // Base messages
  const baseMessages = [
    { role:'system', content:SYSTEM_PROMPT },
    { role:'system', content:STYLE_GUIDE },
    ...(deepDive ? [{ role:'system', content: DEEP_DIVE_GUIDE }] : []),
    ...FEW_SHOT,
    { role:'system', content:`Use this exact refusal line when needed:\n${REFUSAL_LINE}` },
    { role:'system', content:'If sources/context are insufficient, use the refusal line verbatim. Do not improvise.' },
    { role:'system', content:selectedContext },
    { role:'user', content:text }
  ];

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error:'OPENAI_API_KEY is not set', version: VERSION });
  }

  // Tools exposed to the model
  const tools = [
    {
      type: 'function',
      function: {
        name: 'searchApproved',
        description: 'Search allowed domains (wels.net, wisluthsem.org, christlutheran.com) and return candidate URLs.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Search terms to use on allowed sites.' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fetchApproved',
        description: 'Fetch an allow-listed web page (wels.net, wisluthsem.org, christlutheran.com), strip HTML to clean text, and return up to ~22k characters.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Absolute URL to fetch (must be allow-listed).' } },
          required: ['url']
        }
      }
    }
  ];

  // OpenAI call with tool orchestration (+ activity log)
  async function openai(messages, toolResultsSoFar = 0, maxTools = MAX_TOOL_CALLS, toolActivity = []) {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ model:'gpt-4o-mini', temperature: MODEL_TEMPERATURE, messages, tools, tool_choice:'auto' })
    });
    const bodyText = await aiRes.text();
    if (!aiRes.ok) {
      return { type:'error', error:`OpenAI ${aiRes.status}`, body: bodyText.slice(0,1200), toolActivity };
    }
    let data;
    try { data = JSON.parse(bodyText); }
    catch { return { type:'error', error:'JSON parse error', body: bodyText.slice(0,1200), toolActivity }; }

    const msg = data?.choices?.[0]?.message;
    const toolCalls = msg?.tool_calls || [];

    if (toolCalls.length && toolResultsSoFar < maxTools) {
      let newMessages = messages.concat(msg);
      for (const tc of toolCalls) {
        if (tc.type === 'function') {
          const fname = tc.function?.name;
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          let result;

          if (fname === 'searchApproved') {
            // hint: if user asked a theology question and not deepDive, prefer short search terms
            result = await searchApproved(String(args.query || ''));
          } else if (fname === 'fetchApproved') {
            result = await fetchApproved(String(args.url || ''), /*timeoutMs*/ deepDive ? 6000 : 4500);
          } else {
            result = { ok:false, error:'Unknown tool' };
          }

          toolActivity.push({ tool: fname, args, ok: !!result.ok, note: result.url || result.query || null });
          newMessages = newMessages.concat({ role:'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
      }
      return openai(newMessages, toolResultsSoFar + 1, maxTools, toolActivity);
    }

    return { type:'final', content: msg?.content?.trim() || '', toolActivity };
  }

  try {
    const result = await openai(baseMessages, 0, MAX_TOOL_CALLS, []);
    if (result.type === 'error') {
      return res.status(502).json({ error:'OpenAI error', details: result.error, body: result.body, version: VERSION, pickedTitles, toolActivity: result.toolActivity });
    }

    const reply = result.content || REFUSAL_LINE;
    const handoff = new RegExp(REFUSAL_LINE.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i').test(reply);

    // Suggest deep dive when appropriate (phase 1 UX hint for your client)
    const offerDeepDive = !deepDive && isTheologyQuestion(text);

    return res.status(200).json({
      reply,
      handoff,
      version: VERSION,
      deepDive,
      offerDeepDive,                                   // <— your UI can show "Dig deeper" button
      deepDiveHint: offerDeepDive
        ? 'Would you like me to dig deeper into this topic for a more thorough answer?'
        : undefined,
      contextSectionsUsed: pickedArr.length,
      pickedTitles,
      toolActivity: result.toolActivity
    });
  } catch (e) {
    return res.status(500).json({ error:'Server error', details: String(e), version: VERSION });
  }
};
