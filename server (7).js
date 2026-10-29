const express = require('express'), crypto = require('crypto'), path = require('path');
const { ANTHROPIC_API_KEY: AK, FIREBASE_API_KEY: FK, SESSION_SECRET: SS } = process.env;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const GK = process.env.GEMINI_API_KEY, GM = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'; // free option: if GEMINI_API_KEY is set, chat uses Gemini
const SYS = "You are Eagle AI, a smart and friendly assistant. Keep replies SHORT by default. For greetings, small talk and casual or emotional messages reply in 1 to 3 short sentences like a caring friend, with no lists and no lecture. For factual or how-to questions give a direct answer in a few lines, and add steps, bullets or examples only if the user asks for detail, says explain, or the question truly needs it. Never repeat the question and never add long closing offers. Reply in the user's language: English -> English, Tamil -> Tamil, Tanglish (Tamil in English letters) -> simple natural Tanglish, keeping technical terms in English. Do not claim to have human feelings, a body or food needs. If the user seems very sad, be warm and brief, ask one gentle question, and suggest a trusted person or a professional only if the pain seems serious; if they mention self-harm, urge them to contact local emergency services or a crisis line. If you are unsure, say so and never invent facts. Use Markdown only when it helps: bold key terms, short bullets, code blocks for code.";
const SYS_STUDY = "You are Eagle AI Study Helper for students (school, college and competitive exams). First understand exactly what the student asked and answer THAT directly, do not force a fixed template. Use the full format (## Important Points, ## Likely Exam Questions with correct model answers, ## Quick Tips) only when they ask for important questions, notes or revision for a subject or topic. If they ask for a question paper: you cannot provide official past papers, say so in one short line, tell them where to get the official papers (the state board or education department website, textbook back exercises), then offer to create a practice question paper in the same style and ask which units or chapters to cover. Never claim a question came from a specific year paper unless you are certain. If the class, board or subject is missing, ask ONE short question first instead of guessing. No filler openings, no repeated greetings, no cheering lines. Keep answers clear and organized. Be accurate and follow standard textbook content; if you are unsure of a fact, date, formula or number say so and never invent it. If the student asks for previous years questions and the expected questions for the next exam: (1) give the questions that are repeated most often over the years, mention a year only when you are certain or a search source supports it, otherwise say it is a frequently repeated question and do not name a year; (2) then give Expected Important Questions for the next exam based on repeated patterns and chapter weightage, each with a short correct model answer; (3) clearly say these are predictions and not guaranteed; (4) never invent a year-wise question paper. If the user says quiz me, ask one question at a time, wait for the answer, then check it and explain. Reply in the user's language (English, Tamil or Tanglish) but keep technical terms in English.";
const SYS_WEB = "You are Eagle AI Website Creator. Build a complete, beautiful, modern, mobile-first website from the user description. Output ONLY one complete HTML document inside a single ```html code block, with no explanation before or after. Rules: one single file with inline CSS and JavaScript; start with <!DOCTYPE html>; include the viewport meta tag; fully responsive; a good color palette, spacing and typography; real relevant sample content in the language the user asks for (Tamil or English), no lorem ipsum; if Tamil text is used include Noto Sans Tamil in the font stack; use CSS gradients, emoji or inline SVG for visuals; do not use external images, external scripts or external CSS (a Google Fonts link is allowed); make buttons, menus and sections work with small inline JavaScript (smooth scroll, mobile menu, a simple form that only shows a thank-you message and sends no data). When the user gives the current HTML and asks for a change, apply the change and return the full updated HTML document. Never include real personal data and never collect passwords or card numbers.";
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
  try { let { messages, max_tokens, raw, mode } = req.body; const SP = mode === 'study' ? SYS_STUDY : mode === 'website' ? SYS_WEB : SYS; const MT = Math.min(+max_tokens || (mode === 'study' || mode === 'website' ? 2048 : 1024), mode === 'website' ? 8192 : 4096);
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'Message illa.' });
    const okImg = i => i && /^image\/(jpeg|png|webp)$/.test(i.mime) && typeof i.data === 'string' && i.data.length < 6e6 && /^[A-Za-z0-9+/=]+$/.test(i.data);
    messages = messages.slice(-30).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, mode === 'website' ? 60000 : 8000), images: Array.isArray(m.images) ? m.images.filter(okImg).slice(0, 12) : [] }));
    if (GK) {
      const gemCall = useSearch => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GM}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': GK, 'content-type': 'application/json' },
        body: JSON.stringify({ ...(raw ? {} : { systemInstruction: { parts: [{ text: SP }] } }), contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [...m.images.map(i => ({ inlineData: { mimeType: i.mime, data: i.data } })), { text: m.content || ' ' }] })), ...(useSearch ? { tools: [{ google_search: {} }] } : {}), generationConfig: { maxOutputTokens: MT } }) });
      const wantSearch = mode === 'study' && process.env.STUDY_SEARCH === '1'; // optional: Google Search for study answers
      let gr = await gemCall(wantSearch);
      if (!gr.ok && wantSearch) { console.error('Gemini search tool failed, retrying without it', gr.status); gr = await gemCall(false); }
      const gj = await gr.json(); if (!gr.ok) { console.error('Gemini', gr.status, gj); return res.status(502).json({ error: gr.status === 429 ? 'Romba fast machi, oru nimisham wait pannu.' : 'AI busy machi, marubadi try pannu.' }); }
      const parts = (gj.candidates && gj.candidates[0] && gj.candidates[0].content && gj.candidates[0].content.parts) || [];
      return res.json({ text: parts.map(p => p.text || '').join('') || 'Pathil kidaikkala machi, vera maadhiri kelu.' });
    }
    messages = messages.map(m => m.images.length ? { role: m.role, content: [...m.images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), { type: 'text', text: m.content || ' ' }] } : { role: m.role, content: m.content });
    const body = { model: MODEL, max_tokens: MT, messages }; if (!raw) body.system = SP;
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': AK, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) { console.error('Anthropic', r.status, j); return res.status(502).json({ error: 'AI busy machi, marubadi try pannu.' }); }
    res.json({ text: j.content.filter(c => c.type === 'text').map(c => c.text).join('') });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server problem aachu.' }); } });

app.get('/health', (q, r) => r.send('ok'));
app.listen(process.env.PORT || 3000, () => console.log('Eagle AI running'));
