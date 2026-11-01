const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Groq settings (free key from https://console.groq.com) ----
const BASE = 'https://api.groq.com/openai/v1';
const KEY = (process.env.GROQ_KEY || '').trim();
const keyBad = !KEY || /\s/.test(KEY) || KEY.includes('your-key');
let model = (process.env.GROQ_MODEL || '').trim() || 'openai/gpt-oss-120b';
let checked = false;

if (keyBad) {
  console.warn('\nWARNING: no valid GROQ_KEY in .env. The planner will open, but the AI chat will not work.');
  console.warn('Get a free key at https://console.groq.com, put it after GROQ_KEY= in .env, save, then restart.\n');
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

app.post('/api/chat', async (req, res) => {
  if (keyBad) {
    return res.status(400).json({ error: 'No valid Groq key found. Get a free key at console.groq.com, put it after GROQ_KEY= in the .env file (one line, no spaces), save it, and restart.' });
  }
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
    await checkModel();
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1000, messages: [{ role: 'system', content: system }, ...clean] })
    });
    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (e) {}
    if (!r.ok) {
      const d = data && data.error && data.error.message;
      console.error('Groq error', r.status, d || raw.slice(0, 200));
      let msg;
      if (r.status === 401) msg = 'Groq rejected the key (401). Create a new key at console.groq.com and put it after GROQ_KEY= in .env, then restart.';
      else if (r.status === 429) msg = 'Free limit reached. Wait a minute and try again.';
      else msg = 'Groq error (' + r.status + '): ' + (d ? String(d).slice(0, 180) : 'request failed');
      return res.status(502).json({ error: msg });
    }
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    res.json({ text: text || 'Sorry, I could not find an answer. Try rephrasing.', sources: [] });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not reach Groq. Check your internet connection.' });
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
