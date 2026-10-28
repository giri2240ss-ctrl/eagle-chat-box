const express = require('express'), crypto = require('crypto'), path = require('path');
const { ANTHROPIC_API_KEY: AK, FIREBASE_API_KEY: FK, SESSION_SECRET: SS } = process.env;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const GK = process.env.GEMINI_API_KEY, GM = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'; // free option: if GEMINI_API_KEY is set, chat uses Gemini
const SYS = "You are Eagle AI, a smart, friendly assistant like ChatGPT or Gemini. Answer directly first, then explain clearly and completely with simple steps or examples when useful. Use Markdown: short headings, bullet lists, **bold** for key terms, and code blocks for code. Keep simple questions brief. Reply in the user's language: English -> English, Tamil -> Tamil, Tanglish (Tamil in English letters) -> natural, easy Tanglish (do not overdo slang, keep technical terms in English). If the user seems sad or stressed, respond with warmth and care first, listen, and gently encourage them to talk to someone they trust; if they mention self-harm, urge them to contact local emergency services or a crisis line. If you are unsure, say so and never invent facts.";
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));

// --- static files (files are in repo root, so only these are served) ---
const send = f => (q, r) => r.sendFile(path.join(__dirname, f));
app.get('/', send('index.html'));
['index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'].forEach(f => app.get('/' + f, send(f)));

// --- signed session tokens (30 days) ---
const sign = p => { const d = Buffer.from(JSON.stringify(p)).toString('base64url'); return d + '.' + crypto.createHmac('sha256', SS).update(d).digest('base64url'); };
const verify = t => { try { const [d, s] = String(t).split('.'); const e = crypto.createHmac('sha256', SS).update(d).digest('base64url');
  if (!s || s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  const p = JSON.parse(Buffer.from(d, 'base64url')); return p.exp > Date.now() ? p : null; } catch { return null; } };
const issue = (name, email) => ({ token: sign({ name, email, exp: Date.now() + 30 * 864e5 }), user: { name, email } });

const need = (...k) => (req, res, next) => { const m = k.find(x => !process.env[x]); m ? res.status(500).json({ error: `Server setup pending (${m}).` }) : next(); };
const auth = (req, res, next) => { const p = verify((req.headers.authorization || '').replace('Bearer ', '')); if (!p) return res.status(401).json({ error: 'Login pannu machi.' }); req.u = p; next(); };
const hits = new Map();
const limit = (req, res, next) => { const k = req.u.email === 'guest' ? req.ip : req.u.email, now = Date.now();
  const a = (hits.get(k) || []).filter(t => now - t < 6e4); if (a.length >= 20) return res.status(429).json({ error: 'Romba fast machi, oru nimisham wait pannu.' });
  a.push(now); hits.set(k, a); next(); };

// --- Firebase Auth via REST ---
const fb = async (ep, body) => { const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${ep}?key=${FK}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message || 'ERROR').split(' ')[0]); return j; };
const FBMSG = { EMAIL_EXISTS: 'Email already registered. Login pannu.', INVALID_LOGIN_CREDENTIALS: 'Email illa password thappu machi.', INVALID_PASSWORD: 'Email illa password thappu machi.', EMAIL_NOT_FOUND: 'Email illa password thappu machi.', WEAK_PASSWORD: 'Password minimum 6 characters.', INVALID_EMAIL: 'Valid email kudu.', TOO_MANY_ATTEMPTS_TRY_LATER: 'Romba attempts, konjam neram kazhichu try pannu.', OPERATION_NOT_ALLOWED: 'Firebase-la Email/Password sign-in enable pannala.' };
const fail = (res, e) => res.status(400).json({ error: FBMSG[e.message] || 'Etho problem aachu, marubadi try pannu.' });

// public web key for the browser's Google sign-in (not a secret)
app.get('/api/config', need('FIREBASE_API_KEY'), (q, r) => r.json({ apiKey: FK }));

app.post('/api/signup', need('FIREBASE_API_KEY', 'SESSION_SECRET'), async (req, res) => {
  try { const name = String(req.body.name || '').trim().slice(0, 60), email = String(req.body.email || '').trim().toLowerCase(), password = String(req.body.password || '');
    if (!name) return res.status(400).json({ error: 'Name kudu machi.' });
    const j = await fb('signUp', { email, password, returnSecureToken: true });
    await fb('update', { idToken: j.idToken, displayName: name, returnSecureToken: false });
    res.json(issue(name, email)); } catch (e) { fail(res, e); } });

app.post('/api/login', need('FIREBASE_API_KEY', 'SESSION_SECRET'), async (req, res) => {
  try { const email = String(req.body.email || '').trim().toLowerCase();
    const j = await fb('signInWithPassword', { email, password: String(req.body.password || ''), returnSecureToken: true });
    res.json(issue(j.displayName || email.split('@')[0], email)); } catch (e) { fail(res, e); } });

// Google sign-in: browser sends the Firebase idToken, server verifies it with Firebase
app.post('/api/google', need('FIREBASE_API_KEY', 'SESSION_SECRET'), async (req, res) => {
  try { const j = await fb('lookup', { idToken: String(req.body.idToken || '') }), u = j.users && j.users[0];
    if (!u || !u.email) throw new Error('INVALID');
    res.json(issue(u.displayName || u.email.split('@')[0], u.email.toLowerCase())); } catch (e) { fail(res, e); } });

app.post('/api/guest', need('SESSION_SECRET'), (req, res) => res.json(issue('Guest', 'guest')));

// --- Claude proxy (key never leaves the server) ---
app.post('/api/chat', need(GK ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY', 'SESSION_SECRET'), auth, limit, async (req, res) => {
  try { let { messages, max_tokens, raw } = req.body;
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'Message illa.' });
    const okImg = i => i && /^image\/(jpeg|png|webp)$/.test(i.mime) && typeof i.data === 'string' && i.data.length < 6e6 && /^[A-Za-z0-9+/=]+$/.test(i.data);
    messages = messages.slice(-30).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 8000), images: Array.isArray(m.images) ? m.images.filter(okImg).slice(0, 12) : [] }));
    if (GK) {
      const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GM}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': GK, 'content-type': 'application/json' },
        body: JSON.stringify({ ...(raw ? {} : { systemInstruction: { parts: [{ text: SYS }] } }), contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [...m.images.map(i => ({ inlineData: { mimeType: i.mime, data: i.data } })), { text: m.content || ' ' }] })), generationConfig: { maxOutputTokens: Math.min(+max_tokens || 2048, 4096) } }) });
      const gj = await gr.json(); if (!gr.ok) { console.error('Gemini', gr.status, gj); return res.status(502).json({ error: gr.status === 429 ? 'Romba fast machi, oru nimisham wait pannu.' : 'AI busy machi, marubadi try pannu.' }); }
      const parts = (gj.candidates && gj.candidates[0] && gj.candidates[0].content && gj.candidates[0].content.parts) || [];
      return res.json({ text: parts.map(p => p.text || '').join('') || 'Pathil kidaikkala machi, vera maadhiri kelu.' });
    }
    messages = messages.map(m => m.images.length ? { role: m.role, content: [...m.images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), { type: 'text', text: m.content || ' ' }] } : { role: m.role, content: m.content });
    const body = { model: MODEL, max_tokens: Math.min(+max_tokens || 2048, 4096), messages }; if (!raw) body.system = SYS;
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': AK, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) { console.error('Anthropic', r.status, j); return res.status(502).json({ error: 'AI busy machi, marubadi try pannu.' }); }
    res.json({ text: j.content.filter(c => c.type === 'text').map(c => c.text).join('') });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server problem aachu.' }); } });

app.get('/health', (q, r) => r.send('ok'));
app.listen(process.env.PORT || 3000, () => console.log('Eagle AI running'));
