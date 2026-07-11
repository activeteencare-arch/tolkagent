// tolkagent/server.js
// NL <-> Grieks of Frans tolk in Michiels gekloonde stem.
// Audio in, audio uit. Spraakherkenning via ElevenLabs Scribe, vertaling via Google Translate,
// stem via ElevenLabs TTS. Node.js 18+ (native fetch, FormData, Blob, Readable.fromWeb).
//
// Partnertaal: Nederlands is altijd de ene kant; de andere kant kiest de gebruiker
// (Grieks 'el' of Frans 'fr'). De richting binnen dat paar gaat automatisch op de
// herkende taal. Wil je later nog een taal toevoegen: zet 'm in PARTNERS + TAALNAAM.

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Audio-upload in geheugen, ruim genoeg voor een spraakbericht.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const API_KEY  = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;        // live-agent Grieks (NL<->GR)
const AGENT_ID_FR = process.env.ELEVENLABS_AGENT_ID_FR;  // live-agent Frans  (NL<->FR), optioneel
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// Live-agent per partnertaal. Valt terug op de Griekse agent als er voor een taal
// (nog) geen aparte agent is ingesteld.
const LIVE_AGENTS = { el: AGENT_ID, fr: AGENT_ID_FR };
function liveAgentVoor(partner) {
  return LIVE_AGENTS[partner] || AGENT_ID;
}
const PORT     = process.env.PORT || 3000;
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5';

if (!API_KEY || !AGENT_ID || !VOICE_ID) {
  console.error('[tolkagent] Vul ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID en ELEVENLABS_VOICE_ID in .env in.');
  process.exit(1);
}

// ── Gratis tekstdemo (geen ElevenLabs, geen credits, geen login) ──
// Voor de bewijspagina: typ tekst in, krijg de vertaling terug. Alleen de gratis
// vertaaldienst, geen spraak. Bewust vóór de login-muur geregistreerd (hieronder),
// zodat een uitgelogde bezoeker dit altijd kan openen. Roept vertaal() pas bij een
// verzoek aan; die functie staat verderop in dit bestand (function-hoisting).
function demoPagina() {
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0d1117"><title>Tolk · tekstdemo (NL ↔ GR)</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0d1117;color:#c9d1d9;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;padding:24px;display:flex;justify-content:center}
.wrap{width:100%;max-width:520px}
h1{font-size:22px;margin:8px 0 4px;text-align:center}
.sub{color:#8b949e;font-size:14px;margin:0 0 20px;text-align:center}
.card{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:20px}
textarea{width:100%;min-height:110px;padding:12px;background:#0d1117;border:1px solid #30363d;border-radius:10px;color:#c9d1d9;font-size:16px;resize:vertical;font-family:inherit}
button{width:100%;margin-top:14px;padding:12px;background:#58a6ff;color:#0d1117;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.status{color:#8b949e;font-size:13px;margin-top:12px;min-height:18px;text-align:center}
.out{margin-top:16px;padding:14px;background:#0d1117;border:1px solid #30363d;border-radius:10px}
.label{color:#8b949e;font-size:12px;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
#out{font-size:18px;line-height:1.4;white-space:pre-wrap}
.note{color:#8b949e;font-size:12px;margin:18px 4px 0;line-height:1.5;text-align:center}</style></head>
<body><main class="wrap">
<h1>🇳🇱 ↔ 🇬🇷 Tolk · tekstdemo</h1>
<p class="sub">Typ Nederlands of Grieks. De richting wordt automatisch herkend.</p>
<div class="card">
<textarea id="in" placeholder="Typ Nederlands of Grieks..." maxlength="500"></textarea>
<button id="go">Vertaal</button>
<div id="status" class="status"></div>
<div id="outWrap" class="out" hidden><div class="label" id="outLabel"></div><div id="out"></div></div>
</div>
<p class="note">Dit is de gratis tekstdemo. De echte tolk verstaat en spreekt ook, in een echte stem, en werkt met gesproken berichten (ook WhatsApp). Gemaakt door SkillOpsAI.</p>
</main>
<script>
var inEl=document.getElementById('in');
var out=document.getElementById('out');
var outWrap=document.getElementById('outWrap');
var outLabel=document.getElementById('outLabel');
var statusEl=document.getElementById('status');
var btn=document.getElementById('go');
function doeVertaal(){
  var tekst=inEl.value.trim();
  if(!tekst){inEl.focus();return;}
  btn.disabled=true;statusEl.textContent='Bezig met vertalen...';outWrap.hidden=true;
  fetch('/demo-vertaal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tekst:tekst})})
    .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})
    .then(function(res){
      if(!res.ok){throw new Error(res.d.error||'Er ging iets mis.');}
      outLabel.textContent=(res.d.vanTaal==='el'?'Grieks → Nederlands':'Nederlands → Grieks');
      out.textContent=res.d.vertaald;
      outWrap.hidden=false;statusEl.textContent='';
    })
    .catch(function(e){statusEl.textContent=e.message;})
    .then(function(){btn.disabled=false;});
}
btn.addEventListener('click',doeVertaal);
inEl.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){doeVertaal();}});
</script>
</body></html>`;
}
app.get('/demo', (req, res) => res.type('html').send(demoPagina()));
app.post('/demo-vertaal', async (req, res) => {
  const tekst = (req.body.tekst || '').trim();
  if (!tekst) return res.status(400).json({ error: 'Geen tekst meegegeven.' });
  if (tekst.length > 500) return res.status(400).json({ error: 'Tekst te lang voor de demo (max 500 tekens).' });
  try {
    const grieks = /[Ͱ-Ͽ]/.test(tekst);
    const vanTaal  = grieks ? 'el' : 'nl';
    const naarTaal = grieks ? 'nl' : 'el';
    const vertaaldeTekst = await vertaal(tekst, vanTaal, naarTaal);
    res.json({ bron: tekst, vertaald: vertaaldeTekst, vanTaal, naarTaal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Toegangsbeveiliging: de tolk privé houden (cookie-login) ──
// Bewust GEEN Basic Auth: dat geeft een zwart scherm in een iOS-webapp op het
// beginscherm. Een inlogpagina die een cookie zet werkt daar wél, en de cookie
// blijft bewaard zodat je maar één keer hoeft in te loggen.
// Eén of meer accounts. Wachtwoorden staan altijd in de omgeving (Railway),
// nooit in de code/repo.
//   Legacy: APP_USER + APP_PASSWORD  -> één account.
//   Extra:  APP_ACCOUNTS = JSON, één object {"user":"..","password":".."} of een lijst daarvan.
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

// Het auth-token is per account uniek en stabiel. We gebruiken het als anonieme
// account-sleutel voor de opslag (geen e-mailadres in mappaden).
function accountIdVan(req) {
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|;\s*)tolk_auth=([^;]+)/);
  if (m && GELDIGE_TOKENS.has(m[1])) return m[1];
  return null;
}

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

// ── Vertaalgeschiedenis (per account, in Supabase Storage) ──
// Alles in één private Storage-bucket, geen database/tabel nodig: per account een
// index.json (lijst met de metadata) + losse mp3's. Dependency-vrij, via de Supabase
// REST-API met de service-role-key (alleen server-side, nooit in de client). Staat de
// Supabase-omgeving niet ingesteld, dan is de geschiedenis uit (de vertaling werkt door).
// De app maakt de bucket zelf aan bij het opstarten, dus geen handmatige setup nodig.
const SUPABASE_URL    = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'tolk-geschiedenis';
const GESCH_AAN = !!(SUPABASE_URL && SUPABASE_KEY);
const veiligId  = id => /^[a-z0-9]+$/i.test(id || '');

function supaHeaders(extra = {}) {
  return { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, ...extra };
}
const objectUrl = key => `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${key}`;
const indexKey  = acc => `${acc}/index.json`;
const audioKeyVoor = (acc, id) => `${acc}/audio/${id}.mp3`;

// Zorg dat de private bucket bestaat (idempotent, bij opstart aangeroepen).
async function zorgBucket() {
  if (!GESCH_AAN) return;
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: supaHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: SUPABASE_BUCKET, name: SUPABASE_BUCKET, public: false })
    });
    if (r.ok) console.log('[tolkagent] Supabase-bucket aangemaakt:', SUPABASE_BUCKET);
    else {
      const t = await r.text();
      if (/exist/i.test(t) || r.status === 409) console.log('[tolkagent] Supabase-bucket bestaat al:', SUPABASE_BUCKET);
      else console.error('[tolkagent] bucket aanmaken gaf:', r.status, t);
    }
  } catch (e) { console.error('[tolkagent] zorgBucket fout:', e.message); }
}

// Lees de index.json van een account (chronologisch opgeslagen). Geeft [] als die er nog niet is.
async function leesIndex(accountId) {
  const r = await fetch(objectUrl(indexKey(accountId)), { headers: supaHeaders() });
  if (r.status === 404 || r.status === 400) return [];
  if (!r.ok) throw new Error('Supabase index lezen faalde: ' + r.status + ' ' + (await r.text()));
  try { const j = await r.json(); return Array.isArray(j) ? j : []; } catch { return []; }
}

async function schrijfIndex(accountId, lijst) {
  const r = await fetch(objectUrl(indexKey(accountId)), {
    method: 'POST',
    headers: supaHeaders({ 'Content-Type': 'application/json', 'x-upsert': 'true' }),
    body: JSON.stringify(lijst)
  });
  if (!r.ok) throw new Error('Supabase index schrijven faalde: ' + r.status + ' ' + (await r.text()));
}

// Sla één vertaling op (index-regel + optioneel de mp3). Mag de vertaling nooit breken.
async function bewaarVertaling(accountId, rec, audioBuffer) {
  if (!accountId || !GESCH_AAN) return null;
  try {
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    let audio = null;
    if (audioBuffer && audioBuffer.length) {
      const key = audioKeyVoor(accountId, id);
      const up = await fetch(objectUrl(key), {
        method: 'POST',
        headers: supaHeaders({ 'Content-Type': 'audio/mpeg', 'x-upsert': 'true' }),
        body: audioBuffer
      });
      if (up.ok) audio = key;
      else console.error('[tolkagent] audio-upload Supabase faalde:', up.status, await up.text());
    }
    const lijst = await leesIndex(accountId);
    lijst.push({ id, ts: new Date().toISOString(), van: rec.van, naar: rec.naar, bron: rec.bron || '', vertaling: rec.vertaling || '', audio });
    await schrijfIndex(accountId, lijst);
    return id;
  } catch (e) {
    console.error('[tolkagent] opslaan geschiedenis mislukt:', e.message);
    return null;
  }
}

// Lees alle items van een account, nieuwste eerst.
async function leesGeschiedenis(accountId) {
  if (!accountId || !GESCH_AAN) return [];
  const lijst = await leesIndex(accountId);
  return lijst.slice().reverse();
}

// Eén item ophalen (voor audio-serving).
async function leesItem(accountId, id) {
  if (!accountId || !GESCH_AAN) return null;
  const lijst = await leesIndex(accountId);
  return lijst.find(r => r.id === id) || null;
}

async function verwijderItem(accountId, id) {
  if (!GESCH_AAN) return false;
  const lijst = await leesIndex(accountId);
  const item = lijst.find(r => r.id === id);
  if (!item) return false;
  await schrijfIndex(accountId, lijst.filter(r => r.id !== id));
  if (item.audio) { try { await fetch(objectUrl(item.audio), { method: 'DELETE', headers: supaHeaders() }); } catch {} }
  return true;
}

async function wisAlles(accountId) {
  if (!GESCH_AAN) return;
  try {
    const lijst = await leesIndex(accountId);
    for (const r of lijst) {
      if (r.audio) { try { await fetch(objectUrl(r.audio), { method: 'DELETE', headers: supaHeaders() }); } catch {} }
    }
    try { await fetch(objectUrl(indexKey(accountId)), { method: 'DELETE', headers: supaHeaders() }); } catch {}
  } catch (e) {
    console.error('[tolkagent] wissen geschiedenis mislukt:', e.message);
  }
}

const TAAL_VOL = { nl: 'Nederlands', el: 'Grieks', fr: 'Frans' };

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

// ── Talen ──
// Nederlands is vast; de partnertaal kiest de gebruiker.
const TAALNAAM = { nl: 'Nederlands', el: 'Grieks', fr: 'Frans' };
const PARTNERS = ['el', 'fr'];
function geldigePartner(p) {
  const c = (p || '').toLowerCase();
  return PARTNERS.includes(c) ? c : 'el'; // standaard Grieks (backwards-compatible)
}

// Scribe geeft ISO-639-1 (nl, el, fr) of soms 639-3 (nld, ell, fra) terug.
function isGrieks(code) {
  const c = (code || '').toLowerCase();
  return c.startsWith('el') || c.startsWith('gr'); // el, ell, gre
}
// Past een gedetecteerde taalcode bij de partnertaal?
function codePastBij(code, taal) {
  const c = (code || '').toLowerCase();
  if (taal === 'el') return isGrieks(c);
  if (taal === 'fr') return c.startsWith('fr'); // fr, fra, fre
  return c.startsWith(taal);
}

// ── Taaldetectie voor tekst (Grieks via schrift, Frans via Google auto-detect) ──
async function detecteerGoogle(tekst) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(tekst)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('detect ' + r.status);
  const d = await r.json();
  return (d[2] || '').toLowerCase(); // gedetecteerde brontaal
}
// Bepaalt de brontaal van getypte tekst binnen het paar {nl, partner}.
async function detecteerBron(tekst, partner) {
  if (partner === 'el') {
    return /[Ͱ-Ͽ]/.test(tekst) ? 'el' : 'nl'; // Grieks schrift is eenduidig, geen extra call nodig
  }
  // Frans (Latijns schrift): vertrouw op Google's detectie, val terug op Nederlands.
  try {
    const det = await detecteerGoogle(tekst);
    if (codePastBij(det, partner)) return partner;
    return 'nl';
  } catch (_) {
    return 'nl';
  }
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
// Kiest de live-agent op de gekozen partnertaal (Grieks of Frans).
app.get('/signed-url', async (req, res) => {
  const partner = geldigePartner(req.query.partner);
  const agentId = liveAgentVoor(partner);
  if (!agentId) {
    return res.status(503).json({ error: 'Voor deze taal is nog geen live-agent ingesteld.' });
  }
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
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

// ── Welke partnertalen kent de server (en heeft live-ondersteuning)? ──
// De frontend gebruikt dit om de live-knop wel/niet aan te bieden per taal.
app.get('/talen', (req, res) => {
  res.json({
    partners: PARTNERS.map(p => ({
      code: p,
      naam: TAALNAAM[p],
      live: !!liveAgentVoor(p)
    }))
  });
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
    const partner = geldigePartner(req.body.partner);
    let vanTaal, naarTaal;
    if (req.body.richting === 'nl-partner' || req.body.richting === 'nl-gr') {
      vanTaal = 'nl'; naarTaal = partner;
    } else if (req.body.richting === 'partner-nl' || req.body.richting === 'gr-nl') {
      vanTaal = partner; naarTaal = 'nl';
    } else {
      // automatisch op de gedetecteerde taal: partnertaal -> Nederlands, anders Nederlands -> partnertaal
      const isPartner = codePastBij(stt.language_code, partner);
      vanTaal  = isPartner ? partner : 'nl';
      naarTaal = isPartner ? 'nl' : partner;
    }

    // ── Stap 3: vertalen ──
    const vertaaldeTekst = await vertaal(bronTekst, vanTaal, naarTaal);

    // ── Stap 4: uitspreken in Michiels stem ──
    const tts = await spreekUit(vertaaldeTekst);
    const audioBuf = Buffer.from(await tts.arrayBuffer());

    // ── Stap 5: bewaren in de geschiedenis (mag de vertaling niet breken) ──
    await bewaarVertaling(accountIdVan(req),
      { van: vanTaal, naar: naarTaal, bron: bronTekst, vertaling: vertaaldeTekst }, audioBuf);

    // ── Antwoord: audio + transcripties in headers ──
    res.setHeader('Content-Type', 'audio/mpeg');
    zetTekstHeaders(res, bronTekst, vertaaldeTekst, vanTaal, naarTaal);
    res.end(audioBuf);

  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── Tekst-modus: getypte tekst in, vertaalde audio uit ──
// Richting automatisch binnen het paar {Nederlands, partnertaal}: herkende partnertaal -> Nederlands, anders Nederlands -> partnertaal.
app.post('/tolk-tekst', async (req, res) => {
  const tekst = (req.body.tekst || '').trim();
  if (!tekst) return res.status(400).json({ error: 'Geen tekst meegegeven.' });
  try {
    const partner = geldigePartner(req.body.partner);
    const vanTaal  = await detecteerBron(tekst, partner);
    const naarTaal = vanTaal === 'nl' ? partner : 'nl';
    const vertaaldeTekst = await vertaal(tekst, vanTaal, naarTaal);
    const tts = await spreekUit(vertaaldeTekst);
    const audioBuf = Buffer.from(await tts.arrayBuffer());
    await bewaarVertaling(accountIdVan(req),
      { van: vanTaal, naar: naarTaal, bron: tekst, vertaling: vertaaldeTekst }, audioBuf);
    res.setHeader('Content-Type', 'audio/mpeg');
    zetTekstHeaders(res, tekst, vertaaldeTekst, vanTaal, naarTaal);
    res.end(audioBuf);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── Tekst-modus (oud, vaste richting): tekst in, audio uit ──
app.post('/vertaal', async (req, res) => {
  const { tekst, vanTaal = 'nl', naarTaal = 'el' } = req.body;
  if (!tekst || !tekst.trim()) {
    return res.status(400).json({ error: 'Geen tekst meegegeven.' });
  }
  try {
    const vertaaldeTekst = await vertaal(tekst.trim(), vanTaal, naarTaal);
    const tts = await spreekUit(vertaaldeTekst);
    res.setHeader('Content-Type', 'audio/mpeg');
    zetTekstHeaders(res, tekst.trim(), vertaaldeTekst, vanTaal, naarTaal);
    // Oude clientversie leest nog X-Griekse-Tekst; meesturen voor compatibiliteit.
    res.setHeader('X-Griekse-Tekst', encodeURIComponent(vertaaldeTekst));
    Readable.fromWeb(tts.body).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── Geschiedenis: lijst van eigen vertalingen (nieuwste eerst) ──
app.get('/geschiedenis', async (req, res) => {
  try {
    const rijen = await leesGeschiedenis(accountIdVan(req));
    res.json({ items: rijen.map(r => ({
      id: r.id, ts: r.ts, van: r.van, naar: r.naar,
      vanNaam: TAAL_VOL[r.van] || r.van, naarNaam: TAAL_VOL[r.naar] || r.naar,
      bron: r.bron, vertaling: r.vertaling, heeftAudio: !!r.audio
    })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Geschiedenis: audio van één item ophalen ──
app.get('/geschiedenis/audio/:id', async (req, res) => {
  const accountId = accountIdVan(req);
  const id = req.params.id;
  if (!accountId || !veiligId(id)) return res.status(400).json({ error: 'Ongeldig verzoek.' });
  try {
    const item = await leesItem(accountId, id);
    if (!item || !item.audio) return res.status(404).json({ error: 'Geen audio gevonden.' });
    const obj = await fetch(objectUrl(item.audio), { headers: supaHeaders() });
    if (!obj.ok) return res.status(404).json({ error: 'Audiobestand weg.' });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `inline; filename="vertaling-${id}.mp3"`);
    res.end(Buffer.from(await obj.arrayBuffer()));
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── Geschiedenis: alles downloaden als .txt of .csv ──
app.get('/geschiedenis/download', async (req, res) => {
  try {
    const rijen = (await leesGeschiedenis(accountIdVan(req))).slice().reverse(); // chronologisch
    const formaat = (req.query.formaat || 'txt').toLowerCase();
    const stempel = new Date().toISOString().slice(0, 10);
    if (formaat === 'csv') {
      const esc = s => '"' + String(s || '').replace(/"/g, '""') + '"';
      const regels = [['datum', 'van', 'naar', 'brontekst', 'vertaling'].join(',')];
      for (const r of rijen) regels.push([r.ts, TAAL_VOL[r.van] || r.van, TAAL_VOL[r.naar] || r.naar, r.bron, r.vertaling].map(esc).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="tolk-geschiedenis-${stempel}.csv"`);
      return res.send('﻿' + regels.join('\r\n'));
    }
    const blokken = rijen.map(r => {
      const d = new Date(r.ts).toLocaleString('nl-NL');
      return `[${d}]  ${TAAL_VOL[r.van] || r.van} → ${TAAL_VOL[r.naar] || r.naar}\n${TAAL_VOL[r.van] || r.van}: ${r.bron}\n${TAAL_VOL[r.naar] || r.naar}: ${r.vertaling}`;
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tolk-geschiedenis-${stempel}.txt"`);
    res.send(blokken.join('\n\n────────────────────\n\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Geschiedenis: alles wissen (let op: vóór de :id-route) ──
app.delete('/geschiedenis', async (req, res) => {
  const accountId = accountIdVan(req);
  if (!accountId) return res.status(400).json({ error: 'Niet ingelogd.' });
  await wisAlles(accountId);
  res.json({ ok: true });
});

// ── Geschiedenis: één item wissen ──
app.delete('/geschiedenis/:id', async (req, res) => {
  const accountId = accountIdVan(req);
  const id = req.params.id;
  if (!accountId || !veiligId(id)) return res.status(400).json({ error: 'Ongeldig verzoek.' });
  try {
    const gevonden = await verwijderItem(accountId, id);
    res.json({ ok: gevonden });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✓ Tolkagent draait op http://localhost:${PORT}`);
  console.log(`  Agent : ${AGENT_ID}`);
  console.log(`  Stem  : ${VOICE_ID}`);
  console.log(`  STT   : ${STT_MODEL}  TTS: ${TTS_MODEL}`);
  console.log(`  Geschiedenis: ${GESCH_AAN ? 'Supabase-bucket ' + SUPABASE_BUCKET : 'UIT (geen SUPABASE_URL/KEY)'}\n`);
  zorgBucket();
});
