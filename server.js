const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

const { PORT = 3000, FIREBASE_API_KEY, GEMINI_API_KEY, GEMINI_MODEL } = process.env;

const app = express();
app.set('trust proxy', 1);

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

const DEFAULT_PROMPT = {
  image: 'Describe this image and help the user with it.',
  video: 'Watch this video and describe what happens in it.',
  audio: 'The user sent this voice message. Listen to it and reply to what they said, in the same language.'
};
const usage = new Map(); // daily message cap per user (protects the free quota)

app.post('/api/chat', rateLimit({ windowMs: 60000, max: 30 }), verify, express.json({ limit: '30mb' }), async (req, res) => {
  const cap = req.user.guest ? 20 : 50;
  const dayKey = req.user.uid + new Date().toISOString().slice(0, 10);
  usage.set(dayKey, (usage.get(dayKey) || 0) + 1);
  if (usage.get(dayKey) > cap) return res.status(429).json({ error: `Indru ${cap} messages limit mudinjuduchu. Naalaikku vaa machi.` });

  const messages = (Array.isArray(req.body.messages) ? req.body.messages : []).slice(-20)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Bad request.' });

  let inline = null;
  const media = req.body.media;
  if (media && media.data) {
    const mime = String(media.mime || '').toLowerCase().replace('video/quicktime', 'video/mov');
    if (!/^(image\/(jpeg|png|webp|heic|heif)|video\/(mp4|mpeg|mov|webm|3gpp|avi|wmv|x-flv)|audio\/(wav|mp3|aac|ogg|flac|aiff))$/.test(mime)) return res.status(400).json({ error: 'Indha file type support illa.' });
    if (String(media.data).length > 27e6) return res.status(413).json({ error: 'File romba periya machi (max 20MB).' });
    inline = { mime, data: String(media.data) };
  }

  try {
    const payload = JSON.stringify({
        systemInstruction: { parts: [{ text: `You are Eagle AI, a helpful, accurate and friendly assistant. The user's name is ${req.user.name}. Always reply in the same language as the user's latest message, whatever that language is (English, Tamil, Hindi, Telugu, Malayalam, Kannada, Arabic, Spanish, French, Chinese and any other). Match the writing style too: if the user writes in their own script, reply in that script; if they write in English letters (like Tanglish or Hinglish), reply in natural, correctly spelled romanized text of that language. For voice messages, reply in the language that was spoken. If a message has no text (only a photo or video), use the language of the user's earlier messages, or English if there are none. Never invent odd words or mix languages unnaturally. Give correct and useful answers: explain clearly, stay concise unless the user asks for detail, use short paragraphs or simple lists, and use plain text without markdown symbols.` }] },
        contents: messages.map((m, i) => {
          if (inline && i === messages.length - 1) return { role: 'user', parts: [{ inlineData: { mimeType: inline.mime, data: inline.data } }, { text: m.content || DEFAULT_PROMPT[inline.mime.split('/')[0]] }] };
          return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content || '.' }] };
        })
    });
    const models = [...new Set([GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'].filter(Boolean))];
    let up = null, last = 0;
    for (const model of models) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'x-goog-api-key': GEMINI_API_KEY || '', 'content-type': 'application/json' },
        body: payload
      });
      last = r.status;
      if (r.ok) { up = r; console.log('Gemini model used:', model); break; }
      let msg = ''; try { const j = await r.json(); msg = (j.error && j.error.message) || ''; } catch (e) {}
      console.error('Gemini error', model, r.status, msg);
      if (![404, 429, 500, 503].includes(r.status)) break;
    }
    if (!up) return res.status(last === 429 ? 429 : 502).json({ error: last === 429 ? 'Free AI limit nirambiduchu. Oru nimisham kalichu try pannu.' : 'AI konjam busy. Thirumba try pannu.' });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const dec = new TextDecoder();
    let buf = '', sent = false;
    try {
      for await (const chunk of up.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          let j; try { j = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
          const t = parts.map(p => (p.thought ? '' : (p.text || ''))).join('');
          if (t) { res.write(t); sent = true; }
        }
      }
    } catch (e) { console.error('stream error', e.message); }
    if (!sent) res.write('Pathil varala machi, thirumba try pannu.');
    res.end();
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ error: 'AI konjam busy. Thirumba try pannu.' });
  }
});

app.listen(PORT, () => console.log(`Eagle AI running on http://localhost:${PORT}`));
