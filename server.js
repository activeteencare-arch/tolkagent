// tolkagent/server.js
// NL → GR realtime tolkagent met Michiels gekloonde stem
// Node.js 18+ vereist (native fetch + Readable.fromWeb)

require('dotenv').config();
const express = require('express');
const path = require('path');
const { Readable } = require('stream');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY  = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const PORT     = process.env.PORT || 3000;

if (!API_KEY || !AGENT_ID || !VOICE_ID) {
  console.error('[tolkagent] Vul ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID en ELEVENLABS_VOICE_ID in .env in.');
  process.exit(1);
}

// ── Stem-modus: geeft een signed WebSocket-URL terug voor ElevenLabs Conversational AI ──
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

// ── Tekst-modus: NL-tekst → Griekse audio in Michiels stem ──
// Stap 1: gratis Google Translate (nl → el, geen API-sleutel nodig)
// Stap 2: ElevenLabs TTS met Michiels voice ID
app.post('/vertaal', async (req, res) => {
  const { tekst, vanTaal = 'nl', naarTaal = 'el' } = req.body;
  if (!tekst || !tekst.trim()) {
    return res.status(400).json({ error: 'Geen tekst meegegeven.' });
  }

  try {
    // ── Vertaling ──
    const trUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${vanTaal}&tl=${naarTaal}&dt=t&q=${encodeURIComponent(tekst)}`;
    const tr = await fetch(trUrl);
    if (!tr.ok) throw new Error('Google Translate antwoordde niet: ' + tr.status);
    const trData = await tr.json();
    // trData[0] = array van [vertaald_segment, origineel_segment, ...]
    const grieks = trData[0].map(s => s[0]).join('');
    if (!grieks) throw new Error('Lege vertaling teruggekregen.');

    // ── ElevenLabs TTS ──
    const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: grieks,
        model_id: 'eleven_flash_v2_5',       // laagste latentie
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

    // Griekse tekst als HTTP-header meesturen (URL-encoded voor non-ASCII)
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Griekse-Tekst', encodeURIComponent(grieks));
    res.setHeader('Access-Control-Expose-Headers', 'X-Griekse-Tekst');

    // Stream de audio door zonder te bufferen
    Readable.fromWeb(tts.body).pipe(res);

  } catch (e) {
    // Als headers nog niet verstuurd zijn, stuur JSON-fout
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`\n✓ Tolkagent draait op http://localhost:${PORT}`);
  console.log(`  Agent : ${AGENT_ID}`);
  console.log(`  Stem  : ${VOICE_ID}\n`);
});
