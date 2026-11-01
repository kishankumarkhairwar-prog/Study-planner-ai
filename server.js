const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '400kb' })); // bigger limit so a pasted transcript fits
app.use(express.static(path.join(__dirname, 'public')));

// ---- Groq settings (free key from https://console.groq.com) ----
const BASE = 'https://api.groq.com/openai/v1';
const KEY = (process.env.GROQ_KEY || '').trim();
const keyBad = !KEY || /\s/.test(KEY) || KEY.includes('your-key');
const KEY_MSG = 'No valid Groq key found. Get a free key at console.groq.com, put it after GROQ_KEY= in the .env file (one line, no spaces), save it, and restart.';
let model = (process.env.GROQ_MODEL || '').trim() || 'openai/gpt-oss-120b';
let checked = false;

if (keyBad) {
  console.warn('\nWARNING: no valid GROQ_KEY in .env. The planner will open, but the AI chat will not work.');
  console.warn('Get a free key at https://console.groq.com, put it after GROQ_KEY= in .env, save, then restart.\n');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CACHE = path.join(__dirname, 'cache'); // saved transcripts live here
try { fs.mkdirSync(CACHE, { recursive: true }); } catch (e) {}

class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status || 502; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fail(res, err) {
  if (err instanceof ApiError) return res.status(err.status).json(Object.assign({ error: err.message }, err.extra || {}));
  console.error(err && err.message);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// If the chosen model no longer exists, pick a working one automatically.
async function checkModel() {
  if (checked || keyBad) return;
  checked = true;
  try {
    const r = await fetch(BASE + '/models', { headers: { Authorization: 'Bearer ' + KEY } });
    if (!r.ok) return;
    const d = await r.json();
    const ids = (d.data || []).map(m => m.id);
    if (!ids.length || ids.includes(model)) return;
    const prefer = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'];
    const pick = prefer.find(x => ids.includes(x)) || ids.find(x => !/whisper|tts|guard|playai|embed/i.test(x));
    if (pick) { console.log('Model "' + model + '" is not available. Using "' + pick + '" instead.'); model = pick; }
  } catch (e) { checked = false; }
}

// One place that talks to Groq. Retries on the free-tier rate limit.
async function groq(messages, maxTokens) {
  await checkModel();
  const body = { model, max_tokens: maxTokens, messages };
  if (/gpt-oss/.test(model)) body.reasoning_effort = 'low'; // faster, leaves more tokens for the answer
  for (let i = 0; i < 3; i++) {
    let r;
    try {
      r = await fetch(BASE + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) { throw new ApiError('Could not reach Groq. Check your internet connection.', 500); }
    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (e) {}
    if (r.ok) {
      return ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
    }
    if (r.status === 400 && body.reasoning_effort) { delete body.reasoning_effort; continue; }
    if (r.status === 429 && i < 2) {
      const wait = Math.min(25, Math.max(4, parseFloat(r.headers.get('retry-after')) || 10));
      await sleep(wait * 1000);
      continue;
    }
    const d = data && data.error && data.error.message;
    console.error('Groq error', r.status, d || raw.slice(0, 200));
    let msg;
    if (r.status === 401) msg = 'Groq rejected the key (401). Create a new key at console.groq.com and put it after GROQ_KEY= in .env, then restart.';
    else if (r.status === 429) msg = 'Free limit reached. Wait a minute and try again.';
    else msg = 'Groq error (' + r.status + '): ' + (d ? String(d).slice(0, 180) : 'request failed');
    throw new ApiError(msg, 502);
  }
  throw new ApiError('Free limit reached. Wait a minute and try again.', 502);
}

/* ---------------- general study chat (unchanged behaviour) ---------------- */
app.post('/api/chat', async (req, res) => {
  if (keyBad) return res.status(400).json({ error: KEY_MSG });
  const { messages, subject } = req.body;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'No messages' });
  const clean = messages.slice(-8).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 2000)
  }));
  if (clean[0].role !== 'user') clean.shift();
  const system = 'You are a friendly study helper for a college student' +
    (subject ? ' studying ' + String(subject).slice(0, 40) : '') +
    '. Explain clearly and briefly, step by step when solving problems. Use plain text only, with no markdown symbols.';
  try {
    const text = await groq([{ role: 'system', content: system }, ...clean], 1200);
    res.json({ text: text || 'Sorry, I could not find an answer. Try rephrasing.', sources: [] });
  } catch (err) { fail(res, err); }
});

/* ---------------- YouTube helpers ---------------- */
function videoId(u) {
  u = String(u || '').trim();
  if (/^[\w-]{11}$/.test(u)) return u;
  try {
    const x = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u);
    const h = x.hostname.replace(/^(www|m)\./, '');
    let id = '';
    if (h === 'youtu.be') id = x.pathname.slice(1).split('/')[0];
    else if (h.endsWith('youtube.com') || h.endsWith('youtube-nocookie.com')) {
      if (x.pathname === '/watch') id = x.searchParams.get('v') || '';
      else { const m = x.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/); if (m) id = m[1]; }
    }
    return /^[\w-]{11}$/.test(id) ? id : null;
  } catch (e) { return null; }
}

function dec(s) {
  const one = t => t.replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return one(one(s));
}

// Handles both caption formats YouTube returns: <text ...> and <p ...><s>..</s></p>
function parseCaptions(xml) {
  const parts = [];
  let m, re = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = re.exec(xml))) parts.push(m[1]);
  if (!parts.length) { re = /<p\b[^>]*>([\s\S]*?)<\/p>/g; while ((m = re.exec(xml))) parts.push(m[1]); }
  return parts.map(p => dec(p.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
}

async function oembed(id) {
  try {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id));
    if (r.status === 404) throw new ApiError('This video was not found or is private. Check the link.', 404);
    if (!r.ok) return null;
    const d = await r.json();
    return { title: d.title, channel: d.author_name };
  } catch (e) { if (e instanceof ApiError) throw e; return null; }
}

function captionTracks(p) {
  return p && p.captions && p.captions.playerCaptionsTracklistRenderer && p.captions.playerCaptionsTracklistRenderer.captionTracks;
}

async function getTranscript(id) {
  let p = null, tracks = null, det = null;
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip', 'Accept-Language': 'en-US,en;q=0.9' },
      body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'IN' } }, videoId: id })
    });
    if (r.ok) { p = await r.json(); tracks = captionTracks(p); det = p.videoDetails; }
  } catch (e) {}
  if (!tracks || !tracks.length) { // fallback: read the normal watch page
    try {
      const r = await fetch('https://www.youtube.com/watch?v=' + id + '&hl=en', { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' } });
      const html = await r.text();
      const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});\s*(?:var\s|<\/script>)/);
      if (m) { const pr = JSON.parse(m[1]); tracks = captionTracks(pr); det = det || pr.videoDetails; }
    } catch (e) {}
  }
  if (!tracks || !tracks.length) {
    const e = new ApiError('This video has no captions I can read. Open the video on YouTube, click "...more", then "Show transcript", copy all of it and paste it in the "Paste transcript" box here.', 422);
    e.extra = { needTranscript: true };
    throw e;
  }
  const pref = ['en', 'en-IN', 'hi'];
  const track = tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
    tracks.find(t => pref.includes(t.languageCode)) ||
    tracks.find(t => /^en/.test(t.languageCode)) || tracks[0];
  const r = await fetch(track.baseUrl.replace(/&fmt=\w+/, ''), { headers: { 'User-Agent': UA } });
  const text = parseCaptions(await r.text());
  if (!text) {
    const e = new ApiError('Captions came back empty. Paste the transcript manually instead.', 422);
    e.extra = { needTranscript: true };
    throw e;
  }
  return { title: det && det.title, channel: det && det.author, text, lang: track.languageCode };
}

const cpath = id => path.join(CACHE, id + '.json');
function readCache(id) { try { return JSON.parse(fs.readFileSync(cpath(id), 'utf8')); } catch (e) { return null; } }
function writeCache(id, d) { try { fs.writeFileSync(cpath(id), JSON.stringify(d)); } catch (e) {} }

function chunk(text, size) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let j = Math.min(text.length, i + size);
    if (j < text.length) { const k = text.lastIndexOf(' ', j); if (k > i + size * 0.6) j = k; }
    out.push(text.slice(i, j).trim());
    i = j;
  }
  return out;
}

// For Q&A: pick the transcript pieces that best match the question.
function pickContext(text, q) {
  const chunks = chunk(text, 1500);
  if (chunks.length <= 4) return text.slice(0, 6000);
  const stop = new Set(['the', 'and', 'what', 'how', 'why', 'who', 'when', 'where', 'this', 'that', 'with', 'from', 'about', 'video', 'explain', 'does', 'are', 'for', 'you', 'can', 'tell', 'mean', 'means']);
  const ws = (q.toLowerCase().match(/[a-z0-9\u0900-\u097f]{3,}/g) || []).filter(w => !stop.has(w));
  const scored = chunks.map((c, i) => { const l = c.toLowerCase(); let s = 0; ws.forEach(w => { if (l.includes(w)) s++; }); return { c, i, s }; });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, 4).sort((a, b) => a.i - b.i).map(x => x.c).join('\n...\n');
}

/* ---------------- AI notes ---------------- */
const CHUNK = 9000, MAX_CHUNKS = 5;
const FORMAT = 'Format rules: plain text only. Headings start with "## ". Bullets start with "- ". Put key terms in **double asterisks**. No tables and no other markdown.';
function noteSystem(lang) {
  const style = lang === 'Hinglish'
    ? 'Write in Hinglish (Hindi in Roman script mixed with English, the way Indian students talk). Keep technical terms in English.'
    : 'Write in simple, clear English.';
  return 'You are an expert note-maker for a B.Tech student. Turn the video transcript into clean, exam-ready study notes. ' + style +
    ' The transcript is auto-captioned and may misspell technical terms, so fix obvious mistakes. Use only what the transcript says and do not invent facts. Skip greetings, ads and "like and subscribe". ' + FORMAT;
}

async function makeNotes(text, title, lang) {
  const sys = noteSystem(lang);
  const parts = chunk(text, CHUNK);
  const partial = parts.length > MAX_CHUNKS;
  const use = parts.slice(0, MAX_CHUNKS);
  if (use.length === 1) {
    const ask = 'Video title: ' + title + '\n\nWrite these sections in order:\n## Summary (2 to 3 lines)\n## Key concepts (bullets: term and its meaning)\n## Detailed notes (go topic by topic, give each topic its own "## " heading, include formulas, steps and examples)\n## Remember for exams (5 to 8 bullets)\n## Quick revision questions (4 to 6 questions, no answers)\n\nTRANSCRIPT:\n' + use[0];
    return { notes: await groq([{ role: 'system', content: sys }, { role: 'user', content: ask }], 2800), partial };
  }
  const notes = [];
  for (let i = 0; i < use.length; i++) {
    const ask = 'This is part ' + (i + 1) + ' of ' + use.length + ' of a long video titled "' + title + '". Write concise notes for this part only. Start with a heading line "## Part ' + (i + 1) + ': <short topic>". Then bullets, formulas, steps and examples. No summary.\n\nTRANSCRIPT:\n' + use[i];
    notes.push(await groq([{ role: 'system', content: sys }, { role: 'user', content: ask }], 1600));
  }
  const joined = notes.join('\n\n');
  const fin = await groq([{ role: 'system', content: sys }, { role: 'user', content: 'Here are notes of a long video titled "' + title + '". Write only these sections:\n## Summary (3 to 4 lines)\n## Remember for exams (6 to 8 bullets)\n## Quick revision questions (5 questions, no answers)\n\nNOTES:\n' + joined.slice(0, 12000) }], 1200);
  const k = fin.search(/^## Remember/m);
  const head = (k > 0 ? fin.slice(0, k) : fin).trim();
  const tail = k > 0 ? fin.slice(k).trim() : '';
  return { notes: head + '\n\n' + joined + (tail ? '\n\n' + tail : ''), partial };
}

app.post('/api/video/notes', async (req, res) => {
  if (keyBad) return res.status(400).json({ error: KEY_MSG });
  try {
    const b = req.body || {};
    const lang = b.lang === 'Hinglish' ? 'Hinglish' : 'English';
    let id = videoId(b.url);
    let pasted = String(b.transcript || '')
      .replace(/^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*$/gm, ' ') // lines that are only timestamps
      .replace(/\s+/g, ' ').trim();
    let title = '', channel = '', text = '';

    if (pasted.length > 200) {
      text = pasted;
      const meta = id ? await oembed(id) : null;
      title = (meta && meta.title) || 'Pasted transcript';
      channel = (meta && meta.channel) || '';
      if (!id) id = 'm' + crypto.randomBytes(5).toString('hex');
    } else {
      if (!id) throw new ApiError('That does not look like a YouTube link. Paste the full video link.', 400);
      const c = readCache(id);
      if (c && c.text) { title = c.title; channel = c.channel; text = c.text; }
      else {
        const meta = await oembed(id);
        const t = await getTranscript(id);
        title = (meta && meta.title) || t.title || 'YouTube video';
        channel = (meta && meta.channel) || t.channel || '';
        text = t.text;
      }
    }
    if (text.length < 80) throw new ApiError('The transcript is too short to make notes from.', 422);
    writeCache(id, { title, channel, text });
    const out = await makeNotes(text, title, lang);
    res.json({ id, title, channel, notes: out.notes || 'Could not write notes. Try again.', partial: out.partial, url: /^m/.test(id) && !b.url ? '' : 'https://www.youtube.com/watch?v=' + id });
  } catch (err) { fail(res, err); }
});

app.post('/api/video/ask', async (req, res) => {
  if (keyBad) return res.status(400).json({ error: KEY_MSG });
  try {
    const b = req.body || {};
    const q = String(b.question || '').trim().slice(0, 500);
    if (!q) throw new ApiError('Type a question first.', 400);
    const id = /^[\w-]{11}$/.test(String(b.id || '')) ? String(b.id) : null;
    const c = id ? readCache(id) : null;
    const ctx = c && c.text ? pickContext(c.text, q) : '';
    const notes = String(b.notes || '').slice(0, 4000);
    const title = String(b.title || '').slice(0, 120);
    const system = 'You are a friendly study helper for a college student who is studying a YouTube video' + (title ? ' titled "' + title + '"' : '') +
      '. Answer using the notes and transcript excerpts below. If the answer is not in them, say so in one line, then answer from your general knowledge and mark that part "(extra, not from the video)". ' +
      'Explain clearly and briefly, step by step for problems. Reply in the same language style as the question (English, Hindi or Hinglish). Plain text only, use "- " for bullets, no other markdown.' +
      '\n\nNOTES:\n' + notes + (ctx ? '\n\nTRANSCRIPT EXCERPTS:\n' + ctx : '');
    let hist = (Array.isArray(b.history) ? b.history : []).slice(-6).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 1500)
    }));
    while (hist.length && hist[0].role !== 'user') hist.shift();
    const text = await groq([{ role: 'system', content: system }, ...hist, { role: 'user', content: q }], 1400);
    res.json({ text: text || 'Sorry, I could not find an answer. Try rephrasing.' });
  } catch (err) { fail(res, err); }
});

/* ---------------- YouTube search (no API key needed) ---------------- */
const searchCache = new Map();
async function ytSearch(q) {
  const hit = searchCache.get(q);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.v;
  const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=EgIQAQ%253D%253D', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' }
  });
  const html = await r.text();
  const m = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!m) throw new Error('no data');
  const data = JSON.parse(m[1]);
  const out = [], seen = new Set();
  const txt = o => o && (o.simpleText || (o.runs && o.runs.map(x => x.text).join(''))) || '';
  (function walk(o) {
    if (!o || typeof o !== 'object' || out.length >= 8) return;
    const v = o.videoRenderer;
    if (v && v.videoId) {
      if (!seen.has(v.videoId)) {
        seen.add(v.videoId);
        out.push({ id: v.videoId, title: txt(v.title), channel: txt(v.ownerText), dur: txt(v.lengthText), views: txt(v.viewCountText), when: txt(v.publishedTimeText) });
      }
      return;
    }
    for (const k in o) walk(o[k]);
  })(data);
  searchCache.set(q, { t: Date.now(), v: out });
  return out;
}

app.get('/api/videos', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (!q) return res.status(400).json({ error: 'Type a subject or topic first.' });
  try {
    const videos = await ytSearch(q);
    res.json({ videos });
  } catch (e) {
    console.error('YouTube search failed:', e.message);
    res.status(502).json({ error: 'Could not load YouTube results right now. Use the YouTube search link instead.' });
  }
});

function start(port, tries) {
  const s = app.listen(port, () => {
    console.log('\nSmart Study is running at http://localhost:' + port + '\nAI: Groq (' + model + ')\nKeep this window open. Press Ctrl+C to stop.\n');
    checkModel();
  });
  s.on('error', e => {
    if (e.code === 'EADDRINUSE' && tries < 10) { console.log('Port ' + port + ' is busy, trying ' + (port + 1) + '...'); start(port + 1, tries + 1); }
    else { console.error(e.message); process.exit(1); }
  });
}
start(Number(process.env.PORT) || 3000, 0);
