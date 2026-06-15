// tolkagent/server.js
// NL <-> GR tolk in Michiels gekloonde stem.
// Audio in, audio uit. Spraakherkenning via ElevenLabs Scribe, vertaling via Google Translate,
// stem via ElevenLabs TTS. Node.js 18+ (native fetch, FormData, Blob, Readable.fromWeb).

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { Readable } = require('stream');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// ── Helper: vertaal tekst via de gratis Google Translate endpoint ──
async function vertaal(tekst, vanTaal, naarTaal) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${vanTaal}&tl=${naarTaal}&dt=t&q=${encodeURIComponent(tekst)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Vertaaldienst antwoordde niet: ' + r.status);
  const data = await r.json();
  // data[0] is een lijst van [vertaald_segment, origineel_segment, ...]
  const vertaald = (data[0] || []).map(s => s[0]).join('');
  if (!vertaald) throw new Error('Lege vertaling teruggekregen.');
  return vertaald;
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

// ── Tekst-modus (fallback): tekst in, audio uit ──
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

app.listen(PORT, () => {
  console.log(`\n✓ Tolkagent draait op http://localhost:${PORT}`);
  console.log(`  Agent : ${AGENT_ID}`);
  console.log(`  Stem  : ${VOICE_ID}`);
  console.log(`  STT   : ${STT_MODEL}  TTS: ${TTS_MODEL}\n`);
});
