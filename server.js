// tolkagent/server.js
// NL <-> GR tolk in Michiels gekloonde stem.
// Audio in, audio uit. Spraakherkenning via ElevenLabs Scribe, vertaling via Google Translate,
// stem via ElevenLabs TTS. Node.js 18+ (native fetch, FormData, Blob, Readable.fromWeb).

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { Readable } = require('stream');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Audio-upload in geheugen, ruim genoeg voor een spraakbericht.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const API_KEY  = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const PORT     = process.env.PORT || 3000;
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5';

if (!API_KEY || !AGENT_ID || !VOICE_ID) {
  console.error('[tolkagent] Vul ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID en ELEVENLABS_VOICE_ID in .env in.');
  process.exit(1);
}

// ── Toegangsbeveiliging: de tolk privé houden (cookie-login) ──
// Bewust GEEN Basic Auth: dat geeft een zwart scherm in een iOS-webapp op het
// beginscherm. Een inlogpagina die een cookie zet werkt daar wél, en de cookie
// blijft bewaard zodat je maar één keer hoeft in te loggen.
// Eén of meer accounts. Wachtwoorden staan altijd in de omgeving (Railway),
// nooit in de code/repo.
//   Legacy: APP_USER + APP_PASSWORD  -> één account.
//   Extra:  APP_ACCOUNTS = JSON-array, bv. [{"user":"naam@mail.nl","password":"geheim"}]
// Beide mogen samen; alle accounts werken dan.
function laadAccounts() {
  const lijst = [];
  if (process.env.APP_PASSWORD) {
    lijst.push({ user: process.env.APP_USER || 'tolk', password: process.env.APP_PASSWORD });
  }
  if (process.env.APP_ACCOUNTS) {
    try {
      let extra = JSON.parse(process.env.APP_ACCOUNTS);
      if (!Array.isArray(extra)) extra = [extra]; // sta ook één los account-object toe, niet alleen een lijst
      for (const a of extra) {
        if (a && a.user && a.password) lijst.push({ user: String(a.user).trim(), password: String(a.password) });
      }
    } catch (e) {
      console.error('[tolkagent] APP_ACCOUNTS is geen geldige JSON, wordt genegeerd.');
    }
  }
  return lijst;
}
const ACCOUNTS = laadAccounts();
const AUTH_AAN = ACCOUNTS.length > 0;
const tokenVoor = (u, p) => crypto.createHash('sha256').update(u + '|' + p + '|tolk-v1').digest('hex');
const GELDIGE_TOKENS = new Set(ACCOUNTS.map(a => tokenVoor(a.user, a.password)));

function cookieGeldig(req) {
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|;\s*)tolk_auth=([^;]+)/);
  return !!(m && GELDIGE_TOKENS.has(m[1]));
}

function loginPagina(fout) {
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0d1117"><title>Tolk · inloggen</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#c9d1d9;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;padding:24px}
.box{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:28px;width:100%;max-width:360px}
h1{font-size:20px;margin:0 0 4px}p{color:#8b949e;font-size:14px;margin:0 0 8px}
label{display:block;font-size:12px;color:#8b949e;margin:14px 0 6px}
input{width:100%;padding:12px;background:#0d1117;border:1px solid #30363d;border-radius:10px;color:#c9d1d9;font-size:16px}
button{width:100%;margin-top:22px;padding:12px;background:#58a6ff;color:#0d1117;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer}
.fout{color:#f85149;font-size:13px;margin-top:14px;text-align:center}</style></head>
<body><form class="box" method="POST" action="/login">
<h1>🇳🇱 ↔ 🇬🇷 Tolk</h1><p>Log in om de tolk te gebruiken.</p>
<label>E-mail</label><input name="user" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" required>
<label>Wachtwoord</label><input name="password" type="password" autocomplete="current-password" required>
<button type="submit">Inloggen</button>
${fout ? '<div class="fout">' + fout + '</div>' : ''}
</form></body></html>`;
}

if (AUTH_AAN) {
  app.get('/login', (req, res) => res.type('html').send(loginPagina('')));
  app.post('/login', (req, res) => {
    const u = (req.body.user || '').trim();
    const p = req.body.password || '';
    const account = ACCOUNTS.find(a => a.user === u && a.password === p);
    if (account) {
      res.setHeader('Set-Cookie',
        `tolk_auth=${tokenVoor(account.user, account.password)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
      return res.redirect('/');
    }
    res.status(401).type('html').send(loginPagina('E-mail of wachtwoord klopt niet.'));
  });
  app.use((req, res, next) => {
    if (req.path === '/login') return next();
    if (cookieGeldig(req)) return next();
    if ((req.headers.accept || '').includes('text/html')) return res.redirect('/login');
    return res.status(401).json({ error: 'Niet ingelogd.' });
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// ── Vertaling ──
// Primair de gratis Google-endpoint, met herhaalpogingen, en een reservedienst
// (MyMemory) als Google hapert. De gratis Google-route geeft af en toe een 500;
// daarom nooit op één poging vertrouwen voor iets wat moet werken.
const slaap = ms => new Promise(r => setTimeout(r, ms));

async function vertaalGoogle(tekst, vanTaal, naarTaal) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${vanTaal}&tl=${naarTaal}&dt=t&q=${encodeURIComponent(tekst)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('google ' + r.status);
  const data = await r.json();
  const out = (data[0] || []).map(s => s[0]).join('');
  if (!out) throw new Error('google lege vertaling');
  return out;
}

async function vertaalMyMemory(tekst, vanTaal, naarTaal) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(tekst)}&langpair=${vanTaal}|${naarTaal}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('mymemory ' + r.status);
  const d = await r.json();
  const out = d && d.responseData && d.responseData.translatedText;
  if (!out) throw new Error('mymemory lege vertaling');
  return out;
}

async function vertaal(tekst, vanTaal, naarTaal) {
  let laatste;
  for (let poging = 0; poging < 3; poging++) {
    try { return await vertaalGoogle(tekst, vanTaal, naarTaal); }
    catch (e) { laatste = e; await slaap(250 * (poging + 1)); }
  }
  // Reservedienst
  try { return await vertaalMyMemory(tekst, vanTaal, naarTaal); }
  catch (e) {
    throw new Error('Vertaling lukte niet (Google: ' + (laatste && laatste.message) + ', reserve: ' + e.message + ')');
  }
}

// ── Helper: tekst naar spraak in Michiels stem, geeft een fetch-Response terug (audio-stream) ──
async function spreekUit(tekst) {
  const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: 'POST',
    headers: {
      'xi-api-key': API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text: tekst,
      model_id: TTS_MODEL,            // meertalig, lage latentie (NL en GR)
      voice_settings: {
        stability: 0.50,
        similarity_boost: 0.85,
        style: 0.20,
        use_speaker_boost: true
      }
    })
  });
  if (!tts.ok) {
    const body = await tts.text();
    throw new Error('ElevenLabs TTS fout: ' + body);
  }
  return tts;
}

// ── Helper: bepaal richting uit een gedetecteerde taalcode ──
// Scribe geeft ISO-639-1 (nl, el) of soms 639-3 (nld, ell) terug.
function isGrieks(code) {
  const c = (code || '').toLowerCase();
  return c.startsWith('el') || c.startsWith('gr'); // el, ell, gre
}

// ── Helper: zet vertaalde tekst in een veilige HTTP-header (non-ASCII -> URL-encoded) ──
function zetTekstHeaders(res, bron, vertaald, vanTaal, naarTaal) {
  res.setHeader('X-Bron-Tekst',      encodeURIComponent(bron || ''));
  res.setHeader('X-Vertaalde-Tekst', encodeURIComponent(vertaald || ''));
  res.setHeader('X-Van-Taal',  vanTaal);
  res.setHeader('X-Naar-Taal', naarTaal);
  res.setHeader('Access-Control-Expose-Headers',
    'X-Bron-Tekst, X-Vertaalde-Tekst, X-Van-Taal, X-Naar-Taal');
}

// ── Stem-modus (live gesprek): signed WebSocket-URL voor de ElevenLabs Conversational AI agent ──
app.get('/signed-url', async (req, res) => {
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${AGENT_ID}`,
      { headers: { 'xi-api-key': API_KEY } }
    );
    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: body });
    }
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tolk-flow (audio in, audio uit) ──
// Ontvangt een opgenomen of geüpload audiobestand, herkent de taal met Scribe,
// vertaalt naar de andere taal en spreekt het uit in Michiels stem.
// Richting is automatisch op basis van de gedetecteerde taal; een 'richting'-veld
// (nl-gr of gr-nl) overschrijft dat indien meegegeven.
app.post('/tolk', upload.single('audio'), async (req, res) => {
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    return res.status(400).json({ error: 'Geen audio meegegeven.' });
  }

  try {
    // ── Stap 1: spraak naar tekst (Scribe) ──
    const fd = new FormData();
    fd.append('model_id', STT_MODEL);
    fd.append('tag_audio_events', 'false');
    const type = req.file.mimetype || 'audio/webm';
    fd.append('file', new Blob([req.file.buffer], { type }), req.file.originalname || 'audio.webm');

    const sttRes = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': API_KEY },
      body: fd
    });
    if (!sttRes.ok) {
      const body = await sttRes.text();
      throw new Error('Spraakherkenning (Scribe) fout: ' + body);
    }
    const stt = await sttRes.json();
    const bronTekst = (stt.text || '').trim();
    if (!bronTekst) {
      return res.status(422).json({ error: 'Geen spraak herkend in de audio.' });
    }

    // ── Stap 2: richting bepalen ──
    let vanTaal, naarTaal;
    if (req.body.richting === 'nl-gr') {
      vanTaal = 'nl'; naarTaal = 'el';
    } else if (req.body.richting === 'gr-nl') {
      vanTaal = 'el'; naarTaal = 'nl';
    } else {
      // automatisch op de gedetecteerde taal: Grieks -> Nederlands, anders Nederlands -> Grieks
      const grieks = isGrieks(stt.language_code);
      vanTaal  = grieks ? 'el' : 'nl';
      naarTaal = grieks ? 'nl' : 'el';
    }

    // ── Stap 3: vertalen ──
    const vertaaldeTekst = await vertaal(bronTekst, vanTaal, naarTaal);

    // ── Stap 4: uitspreken in Michiels stem ──
    const tts = await spreekUit(vertaaldeTekst);

    // ── Antwoord: audio + transcripties in headers ──
    res.setHeader('Content-Type', 'audio/mpeg');
    zetTekstHeaders(res, bronTekst, vertaaldeTekst, vanTaal, naarTaal);
    Readable.fromWeb(tts.body).pipe(res);

  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── Tekst-modus: getypte tekst in, vertaalde audio uit ──
// Richting automatisch: Grieks schrift (alfabet) -> Nederlands, anders Nederlands -> Grieks.
app.post('/tolk-tekst', async (req, res) => {
  const tekst = (req.body.tekst || '').trim();
  if (!tekst) return res.status(400).json({ error: 'Geen tekst meegegeven.' });
  try {
    const grieks = /[Ͱ-Ͽ]/.test(tekst);
    const vanTaal  = grieks ? 'el' : 'nl';
    const naarTaal = grieks ? 'nl' : 'el';
    const vertaaldeTekst = await vertaal(tekst, vanTaal, naarTaal);
    const tts = await spreekUit(vertaaldeTekst);
    res.setHeader('Content-Type', 'audio/mpeg');
    zetTekstHeaders(res, tekst, vertaaldeTekst, vanTaal, naarTaal);
    Readable.fromWeb(tts.body).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});
