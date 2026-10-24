require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const { PORT = 3000, JWT_SECRET, ANTHROPIC_API_KEY, BREVO_API_KEY, MAIL_FROM, TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM } = process.env;
if (!JWT_SECRET) { console.error('Set JWT_SECRET in .env'); process.exit(1); }

const app = express();
app.use(express.json({ limit: '50kb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const otps = new Map(); // id -> { hash, exp, tries, last }
const USERS = path.join(__dirname, 'data', 'users.json');
const loadUsers = () => { try { return JSON.parse(fs.readFileSync(USERS, 'utf8')); } catch { return {}; } };
const saveUsers = (u) => { fs.mkdirSync(path.dirname(USERS), { recursive: true }); fs.writeFileSync(USERS, JSON.stringify(u, null, 2)); };
const hash = (id, code) => crypto.createHmac('sha256', JWT_SECRET).update(id + ':' + code).digest('hex');

function normalize(raw) {
  const v = String(raw || '').trim();
  if (/^\S+@\S+\.\S+$/.test(v)) return { id: v.toLowerCase(), kind: 'email' };
  const d = v.replace(/[\s\-()]/g, '');
  if (/^\+\d{10,14}$/.test(d)) return { id: d, kind: 'phone' };
  if (/^\d{10}$/.test(d)) return { id: '+91' + d, kind: 'phone' }; // 10 digits = India
  return null;
}

const otpLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

app.post('/api/otp/send', otpLimit, async (req, res) => {
  const t = normalize(req.body.id);
  if (!t) return res.status(400).json({ error: 'Correct phone number (country code oda) illa email kudu.' });
  const prev = otps.get(t.id);
  if (prev && Date.now() - prev.last < 30000) return res.status(429).json({ error: '30 seconds kalichu thirumba try pannu.' });
  const code = String(crypto.randomInt(100000, 1000000));
  try {
    if (t.kind === 'email') {
      if (!BREVO_API_KEY || !MAIL_FROM) throw new Error('Email not configured');
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: 'Eagle Chat Box', email: MAIL_FROM },
          to: [{ email: t.id }],
          subject: 'Eagle Chat Box OTP',
          textContent: `Your Eagle Chat Box OTP is ${code}. It expires in 5 minutes.`
        })
      });
      if (!r.ok) throw new Error('Email failed: ' + r.status + ' ' + (await r.text()));
    } else {
      if (!TWILIO_SID) throw new Error('SMS not configured');
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: t.id, From: TWILIO_FROM, Body: `Your Eagle Chat Box OTP is ${code}` })
      });
      if (!r.ok) throw new Error('SMS failed: ' + r.status);
    }
  } catch (e) {
    console.error(e.message);
    return res.status(502).json({ error: 'OTP anuppa mudiyala. Server setup (.env) check pannu.' });
  }
  otps.set(t.id, { hash: hash(t.id, code), exp: Date.now() + 5 * 60000, tries: 0, last: Date.now() });
  res.json({ ok: true, id: t.id });
});

app.post('/api/otp/verify', otpLimit, (req, res) => {
  const t = normalize(req.body.id);
  const rec = t && otps.get(t.id);
  if (!rec || Date.now() > rec.exp) return res.status(400).json({ error: 'OTP expire aaiduchu. Thirumba anuppu.' });
  if (++rec.tries > 5) { otps.delete(t.id); return res.status(429).json({ error: 'Nerama thappu. Pudhu OTP kelu.' }); }
  const a = Buffer.from(rec.hash), b = Buffer.from(hash(t.id, String(req.body.code || '').trim()));
  if (!crypto.timingSafeEqual(a, b)) return res.status(400).json({ error: 'OTP thappu machi.' });
  otps.delete(t.id);
  const ticket = jwt.sign({ id: t.id, step: 'verified' }, JWT_SECRET, { expiresIn: '10m' });
  res.json({ ticket });
});

app.post('/api/register', (req, res) => {
  let p;
  try { p = jwt.verify(String(req.body.ticket || ''), JWT_SECRET); } catch { return res.status(401).json({ error: 'Session expire. Thirumba login pannu.' }); }
  if (p.step !== 'verified') return res.status(401).json({ error: 'Invalid ticket.' });
  const name = String(req.body.name || '').trim().slice(0, 24);
  if (name.length < 2) return res.status(400).json({ error: 'Nice name 2 letters venum.' });
  const users = loadUsers();
  users[p.id] = { name, createdAt: (users[p.id] && users[p.id].createdAt) || Date.now() };
  saveUsers(users);
  const token = jwt.sign({ id: p.id, step: 'session' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: p.id, name } });
});

function auth(req, res, next) {
  try {
    const p = jwt.verify((req.headers.authorization || '').slice(7), JWT_SECRET);
    if (p.step !== 'session') throw new Error('bad');
    req.uid = p.id;
    next();
  } catch { res.status(401).json({ error: 'Login venum.' }); }
}

app.post('/api/chat', auth, rateLimit({ windowMs: 60000, max: 20 }), async (req, res) => {
  const messages = (Array.isArray(req.body.messages) ? req.body.messages : []).slice(-20)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Bad request.' });
  const name = (loadUsers()[req.uid] || {}).name || 'friend';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 1000,
        system: `You are Eagle Chat Box, a friendly AI assistant. The user's name is ${name}. Reply in the language the user writes in (Tanglish is fine). Keep answers short and clear, in plain text.`,
        messages
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || 'API error ' + r.status);
    res.json({ text: d.content.filter(b => b.type === 'text').map(b => b.text).join('') });
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ error: 'AI konjam busy. Thirumba try pannu.' });
  }
});

app.listen(PORT, () => console.log(`Eagle Chat Box running on http://localhost:${PORT}`));
