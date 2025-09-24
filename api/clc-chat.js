// api/clc-chat.js — 2-phase answers (offer deep dive) + autoloaded MD + allow-listed search/fetch
// Runtime: Node (Vercel root functions)
const fs = require('fs/promises');
const path = require('path');

const VERSION = 'kb-v7-deepdive-p8';

// Model choices (override in Vercel env if you like)
const MODEL_STANDARD = process.env.OPENAI_MODEL_STANDARD || 'gpt-4o-mini'; // fast, cheap
const MODEL_DEEP     = process.env.OPENAI_MODEL_DEEP     || 'gpt-4o';      // higher quality


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

function isTheologyQuestion(q) {
  const s = q.toLowerCase();
  const terms = [
    // core doctrines
    'baptism','infant baptism','lord’s supper','lords supper','communion','eucharist',
    'justification','sanctification','atonement','original sin','grace','faith alone',
    'law and gospel','repentance','forgiveness','confession','absolution',
    'scripture','bible','inerrancy','creation','evolution','trinity','triune',
    'jesus','christ','holy spirit','sacrament','sacraments','liturgy',
    'predestination','election','good works','means of grace', 'god', 'christian', 'lutheran', 'teaching', 'wels', 'baptize'
  ];
  return terms.some(t => s.includes(t));
}

function isLocalInfoQuestion(q) {
  const s = q.toLowerCase();
  // cover quick church logistics: service time, address, map, staff, events
  return /\b(service time|times?|worship|schedule|when|address|location|directions|parking|map|phone|email|contact|staff|pastor|calendar|event|livestream|live stream)\b/.test(s)
         || s.includes('where are you')
         || s.includes('how do i get there')
         || s.includes('what time is worship');
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

const PRINCIPLES_GUIDE = `
When a question involves current events, politicians, parties, elections, or public policy, answer with principles:
• No endorsements or oppositions.
• Draw from Church & State and Christian Living doctrines (pray for leaders; respect authority; obey God rather than people when they conflict; love neighbor; protect life; clear conscience; Christian freedom).
• Summarize 3–5 principles the asker can use; warm, pastoral tone.
`.trim();

const CIVIC_COMPOSE_TEMPLATE = `
For civic/politics questions, structure the answer as:
1) Brief pastoral preface.
2) 3–5 numbered principles (prayer/respect; no endorsements; freedom of the Christian; weigh character + policy incl. life; charity when Christians differ).
3) Optional short checklist (3–5 items).
4) Gentle close + offer pastoral follow-up.
`.trim();

const DEEP_DIVE_GUIDE = `
Deep-dive mode (theological topics):
• Start with a one-sentence thesis that answers the question.
• Then provide 3–6 brief, numbered points that synthesize doctrine and pastoral application.
• Conclude with a short “discernment” or “next steps” checklist (3–5 bullets).
• Stay non-partisan; avoid speculation; ground everything in the provided context and tool results.
• Always finish with a “Sources consulted” footer listing WELS/WLS page titles or section headings used (no raw URLs).
`.trim();

const SCRIPTURE_CITATION_GUIDE = `
When giving theological answers:
• Where applicable, cite Bible passages (book, chapter:verse) that support the teaching.
• Favor clear, classic passages (e.g., Romans 3:23–24, John 3:16, Ephesians 2:8–9).
• Do not invent verses. Only cite passages that are directly relevant.
• Place citations inline (e.g., "Baptism brings forgiveness (Acts 2:38)"). 
`.trim();

const FORCE_TOOL_RULE = `
Deep-dive for theology or civic:
• First call searchApproved with a concise 2–5 word query.
• Then call fetchApproved on at least one promising WELS/WLS result.
• Only skip this if the Selected Context already contains a direct, citable doctrinal section.
• After fetching, synthesize a fuller answer (250–450 words) and include a “Sources consulted” footer with page titles/section headings (no raw URLs).
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
  // Choose model per request
  const SELECTED_MODEL = deepDive ? MODEL_DEEP : MODEL_STANDARD;
  const MODEL_TEMPERATURE = deepDive ? 0.30 : 0.36;

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
  
  const isTheo = isTheologyQuestion(text);
  const isCivic = isCivicQuestion(text);

  // Base messages
  const baseMessages = [
    { role:'system', content:SYSTEM_PROMPT },
    { role:'system', content:STYLE_GUIDE },
    ...(deepDive && (isTheo || isCivic) ? [{ role: 'system', content: FORCE_TOOL_RULE }] : []),
    ...FEW_SHOT,
    { role:'system', content:`Use this exact refusal line when needed:\n${REFUSAL_LINE}` },
    { role:'system', content:'If sources/context are insufficient, use the refusal line verbatim. Do not improvise.' },
    { role:'system', content:selectedContext },
    { role: 'system', content: PRINCIPLES_GUIDE },
    { role: 'system', content: SCRIPTURE_CITATION_GUIDE },
    { role: 'system', content: CIVIC_COMPOSE_TEMPLATE },
    ...(deepDive ? [{ role:'system', content: 'In deep-dive mode, always conclude with a short "Sources consulted" footer listing the WELS/WLS page titles or section headings you used (no raw URLs).' }] : []),
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

 async function openai(messages, toolResultsSoFar = 0, maxTools = (deepDive ? 6 : 2), toolActivity = []) {
  // choose model & temp as you already do above
  const payload = {
    model: SELECTED_MODEL,
    temperature: MODEL_TEMPERATURE,
    messages,               // ✅ use the evolving messages array
    tools,                  // your tool defs
    ...(deepDive ? { tool_choice: 'auto', max_tokens: 900 } : { max_tokens: 500 })
  };

  const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

const bodyText = await aiRes.text();
if (!aiRes.ok) {
  console.error('OpenAI error', aiRes.status, bodyText); // <— shows in Vercel logs
  return { type:'error', error:`OpenAI ${aiRes.status}`, body: bodyText, toolActivity };
}


  let data; try { data = JSON.parse(bodyText); }
  catch { return { type:'error', error:'JSON parse error', body: bodyText.slice(0,1200), toolActivity }; }

  const msg = data?.choices?.[0]?.message;
  const toolCalls = msg?.tool_calls || [];

  if (toolCalls.length && toolResultsSoFar < maxTools) {
    // include the assistant's tool_calls turn
    let newMessages = messages.concat({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });

    for (const tc of toolCalls) {
      if (tc.type !== 'function') continue;
      const fname = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

      let result;
      if (fname === 'searchApproved') {
        const q = String(args.q ?? args.query ?? '').trim();
        result = await searchApproved(q || 'baptism');  // ensure non-empty so the model can iterate
      } else if (fname === 'fetchApproved') {
        const url = String(args.url ?? '').trim();
        if (!url) {
          result = { ok:false, error:'Missing URL for fetchApproved' };
} else if (!/^https:\/\/(www\.)?(wels\.net|wisluthsem\.org|christlutheran\.com)\//.test(url)) {
          result = { ok:false, error:'URL not on allow-list', url };
        } else {
          try {
            result = await fetchApproved(url, deepDive ? 15000 : 8000);
          } catch (e) {
            result = { ok:false, error:String(e), url };
          }
        }
      } else {
        result = { ok:false, error:'Unknown tool' };
      }

      toolActivity.push({ tool: fname, args, ok: !!result.ok, note: result.url || result.query || null });
      newMessages = newMessages.concat({
        role: 'tool',
        tool_call_id: tc.id,
        name: fname,
        content: JSON.stringify(result)
      });
    }
      if (deepDive) {
    newMessages = newMessages.concat({
      role: 'system',
      content:
        'Compose the final deep-dive answer now. Start with a one-sentence thesis, then 3–6 brief numbered points grounded in the fetched text and Selected Context. Cite relevant Bible passages inline where applicable (e.g., Acts 2:38; Eph 2:8–9). End with a short “Sources consulted” footer listing WELS/WLS page titles or section headings (no raw URLs). Keep a warm, pastoral tone.'
    });
  }
    // recurse so the model can read tool outputs and write the final answer
    return openai(newMessages, toolResultsSoFar + 1, maxTools, toolActivity);
  }

  const finalText = (msg?.content || '').trim();
  if (!finalText) {
    return {
      type: 'final',
      content: 'Sorry—I gathered sources but had trouble composing the answer. Please tap “Dig deeper” again and I’ll try once more.',
      toolActivity
    };
  }
  return { type:'final', content: finalText, toolActivity };
}


  try {
    const result = await openai(baseMessages, 0, MAX_TOOL_CALLS, []);
    if (result.type === 'error') {
      return res.status(502).json({ error:'OpenAI error', details: result.error, body: result.body, version: VERSION, pickedTitles, toolActivity: result.toolActivity });
    }

    const reply = result.content || REFUSAL_LINE;
    const handoff = new RegExp(REFUSAL_LINE.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i').test(reply);

    // Suggest deep dive when appropriate (phase 1 UX hint for your client)
    // NEW: offer deep dive for theology OR civic questions
    // previously: const offerDeepDive = !deepDive && (isTheologyQuestion(text) || isCivicQuestion(text));
// Suggest deep dive when appropriate (legacy var still present for UI)
// Keep legacy deep-dive flag off for now
const offerDeepDive = false;

// canonical text
const content = result?.content || REFUSAL_LINE;

return res.status(200).json({
  // === NEW canonical field ===
  content,

  // === Back-compat for existing UI paths ===
  reply: content,                                  // old key some renderers use
  message: { role: 'assistant', content },         // some UIs expect a message object
  handoff,                                         // you computed this earlier; keep it
  version: VERSION,
  deepDive,                                        // keep if UI reads it
  offerDeepDive,                                   // explicitly false to avoid old branches

  // These three are often referenced in the UI; keep them to avoid undefined errors
  contextSectionsUsed: pickedArr.length,
  pickedTitles,                                    // from earlier in your handler
  toolActivity: result.toolActivity || [],         // safe default

  // === Your new follow-up UI payload ===
  options: [
    { type: 'link', label: 'Ask the full CLC Chatbot', url: 'https://chatgpt.com/g/g-685ca3ef68dc8191ac0f7247a4ece363-clc-chatbot' },
    { type: 'action', label: 'Chat with Pastor Olson', action: 'openHubSpot' } // ensure client handles this action
  ],
  footer: 'For pastoral care you can also call (952) 937-1233 or email info@christlutheran.com.'
});

    
  } catch (e) {
    return res.status(500).json({ error:'Server error', details: String(e), version: VERSION });
  }
};
