const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

const { PORT = 3000, FIREBASE_API_KEY, GEMINI_API_KEY, GEMINI_MODEL } = process.env;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/config', (req, res) => res.json({ key: FIREBASE_API_KEY || '' }));

// Verify the Firebase login token (Google checks the password / guest session for us)
const cache = new Map();
async function verify(req, res, next) {
  const tok = (req.headers.authorization || '').slice(7);
  if (!tok || !FIREBASE_API_KEY) return res.status(401).json({ error: 'Login venum.' });
  let c = cache.get(tok);
  if (!c || c.exp < Date.now()) {
    try {
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: tok })
      });
      const d = await r.json();
      const u = r.ok && d.users && d.users[0];
      if (!u) return res.status(401).json({ error: 'Login venum.' });
      c = { uid: u.localId, name: u.displayName || 'friend', guest: !u.email, exp: Date.now() + 5 * 60000 };
      if (cache.size > 1000) cache.clear();
      cache.set(tok, c);
    } catch (e) { return res.status(401).json({ error: 'Login venum.' }); }
  }
  req.user = c;
  next();
}

const usage = new Map(); // daily message cap per user (protects the free quota)

app.post('/api/chat', rateLimit({ windowMs: 60000, max: 30 }), verify, async (req, res) => {
  const cap = req.user.guest ? 20 : 50;
  const dayKey = req.user.uid + new Date().toISOString().slice(0, 10);
  usage.set(dayKey, (usage.get(dayKey) || 0) + 1);
  if (usage.get(dayKey) > cap) return res.status(429).json({ error: `Indru ${cap} messages limit mudinjuduchu. Naalaikku vaa machi.` });

  const messages = (Array.isArray(req.body.messages) ? req.body.messages : []).slice(-20)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Bad request.' });

  try {
    const model = GEMINI_MODEL || 'gemini-2.5-flash-lite';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_API_KEY || '', 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `You are Eagle AI, a friendly AI assistant. The user's name is ${req.user.name}. Reply in the language the user writes in (Tanglish is fine). Keep answers short and clear, in plain text.` }] },
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || 'API error ' + r.status);
    const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    const text = parts.map(p => p.text || '').join('');
    res.json({ text: text || 'Pathil varala machi, thirumba try pannu.' });
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ error: 'AI konjam busy. Thirumba try pannu.' });
  }
});

app.listen(PORT, () => console.log(`Eagle AI running on http://localhost:${PORT}`));
