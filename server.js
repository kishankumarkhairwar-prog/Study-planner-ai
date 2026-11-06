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
    '. Answer in this exact clean format: line 1 is the direct answer in one short sentence. Then up to 4 short bullet lines, each starting with "- ". ' +
    'For problems, use numbered steps like "1. ". Add one line starting "Example:" only if it really helps. ' +
    'Use **bold** only for up to 3 key terms. No headings, no tables, no long paragraphs. Be specific and keep it under 120 words unless the student asks for detail.';
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

/* ---------------- AI planner: study topics, quiz and flashcards ---------------- */
// Ask the model for JSON and parse it safely (tries twice).
async function askJSON(system, user, maxTokens) {
  for (let i = 0; i < 2; i++) {
    const out = await groq([
      { role: 'system', content: system + ' Reply with valid JSON only: no markdown, no code fences, no commentary.' },
      { role: 'user', content: user }
    ], maxTokens);
    const t = String(out || '').replace(/```json|```/gi, '');
    const a = t.search(/[\[{]/);
    if (a < 0) continue;
    const b = t.lastIndexOf(t[a] === '[' ? ']' : '}');
    if (b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  }
  throw new ApiError('The AI reply could not be read. Please try again.', 502);
}
const half = n => Math.min(4, Math.max(0.5, Math.round((Number(n) || 1.5) * 2) / 2));
const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

// 1) How long does each topic need? (the browser then builds the timetable)
app.post('/api/plan/topics', async (req, res) => {
  if (keyBad) return res.status(400).json({ error: KEY_MSG });
  try {
    const b = req.body || {};
    const subs = (Array.isArray(b.subjects) ? b.subjects : []).slice(0, 10).map(s => ({
      name: str(s.name, 60),
      daysLeft: Number.isFinite(Number(s.daysLeft)) && s.daysLeft !== null ? Math.round(Number(s.daysLeft)) : null,
      units: (Array.isArray(s.units) ? s.units : []).slice(0, 40).map(u => str(u, 80)).filter(Boolean),
      weak: (Array.isArray(s.weak) ? s.weak : []).slice(0, 10).map(u => str(u, 60)).filter(Boolean)
    })).filter(s => s.name);
    if (!subs.length) throw new ApiError('Pick at least one subject.', 400);
    const hours = Math.min(16, Math.max(1, Number(b.hours) || 4));
    const system = 'You are an expert study planner for B.Tech college students in India.';
    const user = 'The student can study ' + hours + ' hours per day.\nSubjects (JSON):\n' + JSON.stringify(subs) + '\n\nRules:\n' +
      '- For each subject, return the topics the student still has to study.\n' +
      '- If "units" is not empty, return exactly those unit names, spelled the same and in the same order.\n' +
      '- If "units" is empty, write 6 to 8 sensible syllabus topics for that subject (short names).\n' +
      '- "hours" is the realistic time for that topic including practice: 0.5 to 4 in steps of 0.5. Harder topics get more.\n' +
      '- "level": 1 easy, 2 medium, 3 hard.\n' +
      '- "weak": true when the topic matches or is closely related to something in that subject\'s "weak" list.\n' +
      '- "tips": exactly 3 short practical study tips for this student (max 18 words each).\n' +
      'Shape: {"subjects":[{"name":"","topics":[{"name":"","hours":1.5,"level":2,"weak":false}]}],"tips":["","",""]}';
    const data = await askJSON(system, user, 2600);
    const got = Array.isArray(data && data.subjects) ? data.subjects : [];
    const out = subs.map(s => {
      const m = got.find(x => str(x && x.name, 60).toLowerCase() === s.name.toLowerCase());
      const topics = (m && Array.isArray(m.topics) ? m.topics : []).slice(0, 14).map(t => ({
        name: str(t && t.name, 80), hours: half(t && t.hours),
        level: Math.min(3, Math.max(1, Math.round(Number(t && t.level) || 2))), weak: !!(t && t.weak)
      })).filter(t => t.name);
      return { name: s.name, topics };
    });
    const tips = (Array.isArray(data && data.tips) ? data.tips : []).slice(0, 3).map(t => str(t, 140)).filter(Boolean);
    res.json({ subjects: out, tips });
  } catch (err) { fail(res, err); }
});

// 2) Quiz from the student's own material
app.post('/api/quiz/generate', async (req, res) => {
  if (keyBad) return res.status(400).json({ error: KEY_MSG });
  try {
    const b = req.body || {};
    const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 9000);
    if (text.length < 80) throw new ApiError('Add a few more lines of notes first.', 400);
    const title = str(b.title, 80) || 'Your notes';
    const count = Math.min(15, Math.max(3, Math.round(Number(b.count) || 8)));
    const system = 'You write clear multiple-choice exam questions for college students. Use ONLY the material given and do not add facts that are not in it.';
    const user = 'Material title: ' + title + '\nMaterial:\n' + text + '\n\nWrite ' + count + ' questions, a mix of easy and medium. Each question has exactly 4 options and only one is correct. ' +
      '"a" is the index (0 to 3) of the correct option. "topic" is a 2 to 4 word topic label from the material. "why" is one short sentence explaining the correct answer.\n' +
      'Shape: {"questions":[{"q":"","o":["","","",""],"a":0,"topic":"","why":""}]}';
    const data = await askJSON(system, user, 3200);
    const arr = Array.isArray(data) ? data : (data && data.questions) || [];
    const qs = arr.map(x => {
      const o = Array.isArray(x && x.o) ? x.o.map(v => str(v, 160)) : [];
      const a = Number(x && x.a);
      return { q: str(x && x.q, 300), o, a, topic: str(x && x.topic, 40), why: str(x && x.why, 220) };
    }).filter(x => x.q && x.o.length === 4 && x.o.every(Boolean) && new Set(x.o).size === 4 && Number.isInteger(x.a) && x.a >= 0 && x.a <= 3).slice(0, count);
    if (qs.length < 3) throw new ApiError('Could not make good questions from that text. Try again with more detailed notes.', 502);
    res.json({ questions: qs });
  } catch (err) { fail(res, err); }
});

// 2b) Quiz for a subject of the student's course (no notes needed)
app.post('/api/quiz/subject', async (req, res) => {
  if (keyBad) return res.status(400).json({ error: KEY_MSG });
  try {
    const b = req.body || {};
    const subject = str(b.subject, 80);
    if (!subject) throw new ApiError('Enter a subject.', 400);
    const course = str(b.course, 60), spec = str(b.spec, 60), uni = str(b.university, 80);
    const year = Math.min(6, Math.max(1, Math.round(Number(b.year) || 1)));
    const count = Math.min(15, Math.max(5, Math.round(Number(b.count) || 10)));
    const system = 'You write clear, factually correct multiple-choice exam questions for Indian college students, matched to the syllabus level of their course and year.';
    const user = 'Course: ' + (course || 'not given') + (spec ? ' (' + spec + ')' : '') + ', year ' + year + (uni ? '\nUniversity: ' + uni : '') + '\nSubject: ' + subject + '\n\n' +
      'Write ' + count + ' questions on the standard syllabus of this subject, a mix of easy and medium. Each question has exactly 4 different options and only one is correct. ' +
      '"a" is the index (0 to 3) of the correct option. "topic" is a 2 to 4 word topic label. "why" is one short sentence explaining the correct answer.\n' +
      'Shape: {"questions":[{"q":"","o":["","","",""],"a":0,"topic":"","why":""}]}';
    const data = await askJSON(system, user, 3200);
    const arr = Array.isArray(data) ? data : (data && data.questions) || [];
    const qs = arr.map(x => {
      const o = Array.isArray(x && x.o) ? x.o.map(v => str(v, 160)) : [];
      const a = Number(x && x.a);
      return { q: str(x && x.q, 300), o, a, topic: str(x && x.topic, 40), why: str(x && x.why, 220) };
    }).filter(x => x.q && x.o.length === 4 && x.o.every(Boolean) && new Set(x.o).size === 4 && Number.isInteger(x.a) && x.a >= 0 && x.a <= 3).slice(0, count);
    if (qs.length < 3) throw new ApiError('Could not make good questions for that subject. Try again.', 502);
    res.json({ questions: qs });
  } catch (err) { fail(res, err); }
});

/* ---------------- more AI providers (used by the assignment writer) ---------------- */
const okKey = k => !!k && !/\s/.test(k) && !k.includes('your-key');
const ENV = n => (process.env[n] || '').trim();
const PROV = {
  groq:       { name: 'Groq (free)',                       env: 'GROQ_KEY',       ready: () => !keyBad },
  gemini:     { name: 'Google Gemini (free tier)',         env: 'GEMINI_KEY',     ready: () => okKey(ENV('GEMINI_KEY')) },
  openrouter: { name: 'OpenRouter (free models)',          env: 'OPENROUTER_KEY', ready: () => okKey(ENV('OPENROUTER_KEY')) },
  openai:     { name: 'ChatGPT / OpenAI (paid API)',       env: 'OPENAI_KEY',     ready: () => okKey(ENV('OPENAI_KEY')) },
  anthropic:  { name: 'Claude / Anthropic (paid API)',     env: 'ANTHROPIC_KEY',  ready: () => okKey(ENV('ANTHROPIC_KEY')) }
};
const pickProvider = b => { const p = String((b && b.provider) || 'groq'); return PROV[p] ? p : 'groq'; };
const providerError = p => PROV[p].ready() ? '' : (p === 'groq' ? KEY_MSG : 'No key found for ' + PROV[p].name + '. Put it after ' + PROV[p].env + '= in the .env file (one line, no spaces), save it, and restart.');
app.get('/api/providers', (req, res) => res.json(Object.keys(PROV).map(id => ({ id, name: PROV[id].name, env: PROV[id].env, ready: PROV[id].ready() }))));

async function httpAI(name, url, headers, body, pick) {
  for (let i = 0; i < 2; i++) {
    let r;
    try { r = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) }); }
    catch (e) { throw new ApiError('Could not reach ' + name + '. Check your internet connection.', 500); }
    const raw = await r.text();
    let d = {}; try { d = JSON.parse(raw); } catch (e) {}
    if (r.ok) { const t = String(pick(d) || '').trim(); if (t) return t; throw new ApiError(name + ' returned an empty reply. Try again.', 502); }
    if (r.status === 429 && i < 1) { await sleep(8000); continue; }
    const m = (d && d.error && (d.error.message || d.error)) || raw.slice(0, 160);
    console.error(name + ' error', r.status, String(m).slice(0, 200));
    let msg;
    if (r.status === 401 || r.status === 403) msg = name + ' rejected the key (' + r.status + '). Check the key in .env and restart.';
    else if (r.status === 429) msg = name + ' free limit or quota reached. Wait a minute or pick another AI.';
    else if (r.status === 404) msg = name + ' says the model was not found. Set a valid model name in .env.';
    else msg = name + ' error (' + r.status + '): ' + String(m).slice(0, 160);
    throw new ApiError(msg, 502);
  }
  throw new ApiError(name + ' limit reached. Try again later.', 502);
}
let orPick = '';
async function openRouterModel() {
  if (ENV('OPENROUTER_MODEL')) return ENV('OPENROUTER_MODEL');
  if (orPick) return orPick;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    const d = await r.json();
    const ids = ((d && d.data) || []).filter(m => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 && /:free$/.test(m.id)).map(m => m.id);
    for (const w of ['gpt-oss', 'llama', 'qwen', 'gemini', 'deepseek', 'mistral']) { const f = ids.find(x => x.includes(w)); if (f) return (orPick = f); }
    if (ids[0]) return (orPick = ids[0]);
  } catch (e) {}
  throw new ApiError('Could not find a free OpenRouter model. Set OPENROUTER_MODEL in .env.', 502);
}
// Ask any provider. messages = [{role:'system'|'user'|'assistant', content}]
async function ask(provider, messages, maxTokens) {
  if (provider === 'gemini') {
    const model = ENV('GEMINI_MODEL') || 'gemini-flash-latest';
    const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    return httpAI('Gemini', 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', { 'x-goog-api-key': ENV('GEMINI_KEY') },
      { systemInstruction: { parts: [{ text: sys }] }, contents, generationConfig: { maxOutputTokens: maxTokens } },
      d => ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).map(x => x.text || '').join(''));
  }
  if (provider === 'openai') {
    const model = ENV('OPENAI_MODEL') || 'gpt-5.4-mini';
    return httpAI('OpenAI', 'https://api.openai.com/v1/chat/completions', { Authorization: 'Bearer ' + ENV('OPENAI_KEY') },
      { model, messages, max_completion_tokens: maxTokens + 1500 }, // extra room for reasoning models
      d => d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
  }
  if (provider === 'anthropic') {
    const model = ENV('ANTHROPIC_MODEL') || 'claude-haiku-5-5';
    const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    return httpAI('Claude', 'https://api.anthropic.com/v1/messages', { 'x-api-key': ENV('ANTHROPIC_KEY'), 'anthropic-version': '2023-06-01' },
      { model, max_tokens: maxTokens, system: sys, messages: messages.filter(m => m.role !== 'system') },
      d => (d.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
  }
  if (provider === 'openrouter') {
    const model = await openRouterModel();
    return httpAI('OpenRouter', 'https://openrouter.ai/api/v1/chat/completions', { Authorization: 'Bearer ' + ENV('OPENROUTER_KEY') },
      { model, messages, max_tokens: maxTokens },
      d => d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
  }
  return groq(messages, maxTokens);
}

/* ---------------- AI assignment writer ---------------- */
app.post('/api/assignment/write', async (req, res) => {
  const provider = pickProvider(req.body), bad = providerError(provider);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const b = req.body || {};
    const improve = b.mode === 'improve';
    const type = str(b.type, 40) || 'Assignment', topic = str(b.topic, 200), subject = str(b.subject, 80);
    const extra = str(b.extra, 600), level = str(b.level, 30) || 'College level';
    const material = String(b.material || '').slice(0, 12000).trim();
    const words = Math.min(2000, Math.max(100, Math.round(Number(b.words) || 500)));
    const course = str(b.course, 60), spec = str(b.spec, 60), uni = str(b.university, 80);
    const year = Math.min(6, Math.max(1, Math.round(Number(b.year) || 1)));
    if (!improve && !topic) throw new ApiError('Enter a topic or title.', 400);
    if (improve && material.split(/\s+/).length < 8) throw new ApiError('Paste the text you want improved.', 400);
    const system = 'You are a writing assistant for Indian college students. Write clear, correct, well-organised academic work in simple English at the requested level. ' +
      'Never invent facts, statistics, citations or web links. Use plain text only: short headings on their own line, numbered points or "- " bullets where helpful, no markdown symbols such as ** or #. ' +
      'For a "Lab file" use this order: Aim, Requirements (software or apparatus), Theory, Algorithm or Procedure, Program or Steps (with code if relevant), Output or Observations, Result, Conclusion. ' +
      'For "Viva answers" write likely viva questions, each followed by a short answer. For a "Report" or "Seminar report" use Title, Introduction, main sections, Conclusion. For "Application / letter" use the standard Indian format.';
    const ctx = (course ? 'Student: ' + course + (spec ? ' (' + spec + ')' : '') + ', year ' + year + (uni ? ', ' + uni : '') + '.\n' : '') + (subject ? 'Subject: ' + subject + '\n' : '');
    const user = improve
      ? ctx + 'Type of work: ' + type + (topic ? '\nTopic: ' + topic : '') + '\nLevel: ' + level + '\n\nImprove the student\'s own text below. Fix grammar, spelling, clarity and structure. Keep the meaning and the student\'s points. Do not add new facts. Keep roughly the same length.' + (extra ? '\nExtra instructions: ' + extra : '') + '\n\nTEXT:\n' + material
      : ctx + 'Type of work: ' + type + '\nTopic: ' + topic + '\nLevel: ' + level + '\nLength: about ' + words + ' words.' + (extra ? '\nExtra instructions: ' + extra : '') + (material ? '\n\nUse these notes or material from the student:\n' + material : '') + '\n\nWrite it now.';
    const text = await ask(provider, [{ role: 'system', content: system }, { role: 'user', content: user }], Math.min(4000, Math.round(words * 2 + 500)));
    if (!text) throw new ApiError('The AI returned nothing. Please try again.', 502);
    res.json({ text });
  } catch (err) { fail(res, err); }
});

/* ---------------- study helpers for a draft: notes, or rebuild it around the student's own details ---------------- */
app.post('/api/assignment/learn', async (req, res) => {
  const provider = pickProvider(req.body), bad = providerError(provider);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const b = req.body || {};
    const mode = b.mode === 'mine' ? 'mine' : 'notes';
    const text = String(b.text || '').slice(0, 12000).trim();
    const details = String(b.details || '').slice(0, 6000).trim();
    const type = str(b.type, 40) || 'Assignment', topic = str(b.topic, 200), subject = str(b.subject, 80);
    if (text.split(/\s+/).length < 20) throw new ApiError('Write or paste a draft first.', 400);
    let system, user, max;
    if (mode === 'notes') {
      system = 'You are a friendly study coach for Indian college students. Turn the draft into study material in plain text, no markdown symbols. Use exactly these sections, each heading on its own line: KEY POINTS (6 to 8 short lines), TERMS TO KNOW (term and one-line meaning), VIVA / EXAM QUESTIONS (8 questions, each followed by a short answer), WHAT TO ADD YOURSELF (3 lines on where the student should put their own example, output or understanding). Be accurate and do not invent facts.';
      user = (subject ? 'Subject: ' + subject + '\n' : '') + 'Type: ' + type + (topic ? '\nTopic: ' + topic : '') + '\n\nDRAFT:\n' + text;
      max = 2200;
    } else {
      if (details.split(/\s+/).length < 8) throw new ApiError('Add your own details first (lab output, class notes, an example you used).', 400);
      system = 'You help a student rebuild a draft around their own work. Rewrite the draft in simple student-level English so it is based on the details the student supplied. ' +
        'Use only the facts, outputs, examples and experiences found in the student\'s details or already correct in the draft. Never invent results, numbers, experiments, names or experiences. ' +
        'Where the student gave nothing for a part, write [add your own example here] or [add your output here]. Keep the same structure and type of work. Plain text only, no markdown symbols.';
      user = (subject ? 'Subject: ' + subject + '\n' : '') + 'Type: ' + type + (topic ? '\nTopic: ' + topic : '') + '\n\nDRAFT:\n' + text + '\n\nSTUDENT\'S OWN DETAILS:\n' + details;
      max = 3500;
    }
    const out = await ask(provider, [{ role: 'system', content: system }, { role: 'user', content: user }], max);
    if (!out) throw new ApiError('The AI returned nothing. Please try again.', 502);
    res.json({ text: out });
  } catch (err) { fail(res, err); }
});

/* ---------------- AI or human check (an estimate, never proof) ---------------- */
const AI_PHRASES = ['moreover', 'furthermore', 'in conclusion', 'in summary', 'it is important to note', 'it is worth noting', 'delve', 'crucial', 'plays a vital role', 'plays a crucial role',
  "in today's", 'landscape', 'tapestry', 'multifaceted', 'comprehensive', 'leverage', 'utilize', 'pivotal', 'seamless', 'robust', 'holistic', 'foster', 'underscores', 'ensures that',
  'a wide range of', 'in the realm of', 'paramount', 'navigate the', 'additionally,', 'overall,'];
function aiStats(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const sents = clean.split(/(?<=[.!?])\s+/).filter(x => x.split(' ').length > 2);
  const lens = sents.map(x => x.split(' ').length), n = lens.length || 1;
  const mean = lens.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const burst = mean ? sd / mean : 0;
  const w = (clean.toLowerCase().match(/[a-z']+/g) || []), total = w.length || 1;
  const low = clean.toLowerCase();
  let hits = 0; const used = [];
  AI_PHRASES.forEach(p => { const m = low.split(p).length - 1; if (m) { hits += m; used.push(p.replace(/,$/, '')); } });
  const per100 = hits / (total / 100);
  const contr = (clean.match(/\b\w+'(t|s|re|ve|ll|d|m)\b/gi) || []).length / (total / 100);
  const first = (clean.match(/\b(I|my|me|we|our)\b/g) || []).length / (total / 100);
  const md = (text.match(/\*\*|^#{1,4}\s/gm) || []).length;
  const lowerI = (clean.match(/(^|\s)i(\s|')/g) || []).length;
  const dbl = (text.match(/[^\n] {2,}[^\n]/g) || []).length;
  let score = 50; const sig = [];
  if (burst < 0.3) { score += 18; sig.push('Sentences are very even in length, which is typical of AI text.'); }
  else if (burst < 0.4) { score += 10; sig.push('Sentence lengths vary little.'); }
  else if (burst < 0.5) score += 4;
  else if (burst > 0.7) { score -= 12; sig.push('Sentence lengths vary a lot, which is typical of human writing.'); }
  else if (burst > 0.55) score -= 6;
  if (per100 >= 2) { score += 16; sig.push('Many stock AI phrases (' + used.slice(0, 4).join(', ') + ').'); }
  else if (per100 >= 1) { score += 9; sig.push('Some stock AI phrases (' + used.slice(0, 3).join(', ') + ').'); }
  else if (per100 > 0.4) score += 4;
  else score -= 4;
  if (total > 150 && contr === 0) { score += 5; sig.push('No contractions anywhere; very formal tone.'); }
  else if (contr > 1) { score -= 8; sig.push('Uses contractions like a casual human writer.'); }
  if (first > 2) { score -= 6; sig.push('Personal voice (I, my, we).'); }
  if (md >= 3) { score += 8; sig.push('Chat-style formatting (bold marks or markdown headings).'); }
  if (lowerI > 0) { score -= 8; sig.push('Small slips such as a lowercase "i".'); }
  if (dbl > 0) { score -= 4; sig.push('Irregular spacing, common in typed human text.'); }
  return { score: Math.max(3, Math.min(97, Math.round(score))), sig, words: total };
}
app.post('/api/ai-detect', async (req, res) => {
  try {
    const text = String((req.body || {}).text || '').slice(0, 20000).trim();
    const wc = (text.match(/\S+/g) || []).length;
    if (wc < 40) throw new ApiError('Paste at least 40 words. 150 or more gives a better estimate.', 400);
    const local = aiStats(text);
    let llm = null, reasons = [], flagged = [];
    if (!keyBad) {
      try {
        const system = 'You are a careful text analyst. Estimate whether a passage was written by an AI language model or by a human student. Consider uniform structure, generic phrasing, no personal detail, flawless grammar, repeated transitions and hedging. ' +
          'Be calibrated: use 40 to 60 when unsure, and never claim certainty. Short or formal texts are hard to judge.';
        const user = 'TEXT:\n' + text.slice(0, 7000) + '\n\nShape: {"ai_percent":0,"reasons":["short reason"],"flagged":["exact phrase copied from the text, max 12 words"]}. Give at most 4 reasons and at most 3 flagged phrases.';
        const d = await askJSON(system, user, 900);
        const v = Number(d && d.ai_percent);
        if (Number.isFinite(v)) llm = Math.max(0, Math.min(100, v));
        reasons = (Array.isArray(d && d.reasons) ? d.reasons : []).map(x => str(x, 140)).filter(Boolean).slice(0, 4);
        const lt = text.toLowerCase();
        flagged = (Array.isArray(d && d.flagged) ? d.flagged : []).map(x => str(x, 120)).filter(x => x && lt.includes(x.toLowerCase())).slice(0, 3);
      } catch (e) { /* fall back to the local check only */ }
    }
    const ai = llm == null ? local.score : Math.round(0.45 * local.score + 0.55 * llm);
    res.json({
      ai, words: wc, conf: wc < 120 || llm == null ? 'low' : 'medium',
      signals: local.sig.concat(reasons).slice(0, 8), flagged,
      note: 'This is an estimate from writing patterns, not proof. Detectors can be wrong, especially on short, formal or non-native English text, so never use this alone to accuse anyone.' +
        (llm == null ? ' The AI part of the check was not available, so only the pattern check was used.' : '')
    });
  } catch (err) { fail(res, err); }
});

// 3) Flashcards from the student's own material
app.post('/api/cards/generate', async (req, res) => {
  if (keyBad) return res.status(400).json({ error: KEY_MSG });
  try {
    const b = req.body || {};
    const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 9000);
    if (text.length < 80) throw new ApiError('Add a few more lines of notes first.', 400);
    const title = str(b.title, 80) || 'Your notes';
    const count = Math.min(25, Math.max(5, Math.round(Number(b.count) || 12)));
    const system = 'You make flashcards for college students from their own study material. Use ONLY the material given.';
    const user = 'Material title: ' + title + '\nMaterial:\n' + text + '\n\nWrite ' + count + ' flashcards. Each card tests one idea. "f" is the front: a short question or a term. "b" is the back: a short clear answer (max 35 words). "topic" is a 2 to 4 word topic label.\n' +
      'Shape: {"cards":[{"f":"","b":"","topic":""}]}';
    const data = await askJSON(system, user, 3200);
    const arr = Array.isArray(data) ? data : (data && data.cards) || [];
    const seen = new Set();
    const cards = arr.map(x => ({ f: str(x && x.f, 200), b: str(x && x.b, 400), topic: str(x && x.topic, 40) }))
      .filter(x => x.f && x.b && !seen.has(x.f.toLowerCase()) && seen.add(x.f.toLowerCase())).slice(0, count);
    if (cards.length < 3) throw new ApiError('Could not make flashcards from that text. Try again with more detailed notes.', 502);
    res.json({ cards });
  } catch (err) { fail(res, err); }
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
