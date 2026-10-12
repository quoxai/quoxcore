/**
 * Voice Handlers - Native TTS and STT endpoints
 *
 * Replaces n8n speak.json and transcribe.json workflows.
 * Calls ElevenLabs (TTS) and OpenAI Whisper (STT) directly.
 * Fetches API keys from auth service at runtime.
 */

const https = require('https');
const FormData = require('form-data');
const { buildInternalServiceHeaders } = require('./internalServiceHeaders.js');

// ============================================================================
// Voice key cache (separate from Claude keys)
// ============================================================================

let _voiceKeysCache = null;
let _voiceKeysCacheTime = 0;
const VOICE_KEYS_CACHE_TTL = 30 * 1000; // 30 seconds

async function getVoiceKeys() {
  const now = Date.now();
  if (_voiceKeysCache && (now - _voiceKeysCacheTime) < VOICE_KEYS_CACHE_TTL) {
    return _voiceKeysCache;
  }
  try {
    const authHost = process.env.AUTH_HOST || 'auth';
    const authPort = process.env.AUTH_PORT || '3101';
    const url = `http://${authHost}:${authPort}/api/setup/internal/voice-keys`;
    const resp = await fetch(url, { headers: buildInternalServiceHeaders(), signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      _voiceKeysCache = await resp.json();
      _voiceKeysCacheTime = now;
      return _voiceKeysCache;
    }
    console.error('[Voice Keys] Auth service returned', resp.status);
  } catch (err) {
    console.error('[Voice Keys] Failed to fetch:', err.message);
  }
  return _voiceKeysCache || {};
}

// ============================================================================
// Voice personas (same as n8n speak.json)
// ============================================================================

const VOICE_PERSONAS = {
  jarvis: { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', stability: 0.6, similarity: 0.8, style: 0.3 },
  hal: { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', stability: 0.8, similarity: 0.75, style: 0.1 },
  cyberpunk: { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold', stability: 0.5, similarity: 0.85, style: 0.5 },
  trinity: { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', stability: 0.65, similarity: 0.8, style: 0.2 }
};

// ============================================================================
// Text preprocessing
// ============================================================================

function cleanTextForSpeech(text) {
  return text
    .replace(/\*\*/g, '')
    .replace(/\|/g, ' ')
    .replace(/-{3,}/g, '')
    .replace(/#+\s/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 2000);
}

// ============================================================================
// ElevenLabs TTS
// ============================================================================

// Invalidate cached keys (called on auth/quota failures to force refetch)
function invalidateVoiceKeyCache() {
  _voiceKeysCache = null;
  _voiceKeysCacheTime = 0;
}

function callElevenLabs(apiKey, voiceId, text, modelId, voiceSettings) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability: voiceSettings.stability,
        similarity_boost: voiceSettings.similarity,
        style: voiceSettings.style,
        use_speaker_boost: true
      }
    });

    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode === 200) {
          resolve({ success: true, audio: buffer });
        } else {
          // Invalidate key cache on auth/quota errors so next request refetches
          if (res.statusCode === 401 || res.statusCode === 403) {
            invalidateVoiceKeyCache();
          }
          resolve({ success: false, status: res.statusCode, body: buffer.toString() });
        }
      });
    });

    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.write(postData);
    req.end();
  });
}

// ============================================================================
// Speak Handler (TTS)
// ============================================================================

async function handleSpeak(req, res) {
  const { text, voice_mode, voice_id, model_id } = req.body || {};

  if (!text) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const cleanText = cleanTextForSpeech(text);

  // Fetch API key
  const keys = await getVoiceKeys();
  const apiKey = keys.elevenlabs_api_key;
  if (!apiKey) {
    return res.status(503).json({ error: 'ElevenLabs API key not configured' });
  }

  // Resolve voice
  let voiceId, voiceName, voiceSettings;

  if (voice_id) {
    voiceId = voice_id;
    voiceName = 'Custom';
    const known = Object.values(VOICE_PERSONAS).find(v => v.id === voice_id);
    voiceSettings = known
      ? { stability: known.stability, similarity: known.similarity, style: known.style }
      : { stability: 0.65, similarity: 0.8, style: 0.2 };
    if (known) voiceName = known.name;
  } else {
    const persona = VOICE_PERSONAS[voice_mode] || VOICE_PERSONAS.jarvis;
    voiceId = persona.id;
    voiceName = persona.name;
    voiceSettings = { stability: persona.stability, similarity: persona.similarity, style: persona.style };
  }

  // Try primary model, fallback to turbo
  const primaryModel = model_id || 'eleven_multilingual_v2';
  let result = await callElevenLabs(apiKey, voiceId, cleanText, primaryModel, voiceSettings);

  if (!result.success && primaryModel !== 'eleven_turbo_v2') {
    console.log('[Voice] Primary model failed, trying turbo fallback');
    result = await callElevenLabs(apiKey, voiceId, cleanText, 'eleven_turbo_v2', {
      ...voiceSettings, style: 0
    });
  }

  if (result.success) {
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Voice-Name', voiceName);
    res.set('X-Voice-Id', voiceId);
    return res.send(result.audio);
  }

  console.error('[Voice] TTS failed:', result.body || result.error);
  return res.status(502).json({ error: 'TTS failed', details: result.body || result.error });
}

// ============================================================================
// Streaming Speak Handler (TTS) — QUOX-VOICE P2
// ============================================================================
// Same governed key path as handleSpeak (vault -> auth voice-keys -> here),
// but streams ElevenLabs' chunked mp3 straight to the client instead of
// buffering the whole clip. First audio arrives while synthesis continues
// (measured batch ttfb 1.8-2.6s; the /stream endpoint + optimize_streaming
// starts bytes far sooner). The realtime voice worker consumes this so it
// still holds ZERO provider credentials (plan v2 rule); the key never leaves
// the collector.
async function handleSpeakStream(req, res) {
  const { text, voice_mode, voice_id, model_id } = req.body || {};
  if (!text) {
    return res.status(400).json({ error: 'No text provided' });
  }
  const cleanText = cleanTextForSpeech(text);
  const keys = await getVoiceKeys();
  const apiKey = keys.elevenlabs_api_key;
  if (!apiKey) {
    return res.status(503).json({ error: 'ElevenLabs API key not configured' });
  }

  let voiceId, voiceSettings;
  if (voice_id) {
    voiceId = voice_id;
    const known = Object.values(VOICE_PERSONAS).find((v) => v.id === voice_id);
    voiceSettings = known
      ? { stability: known.stability, similarity: known.similarity, style: known.style }
      : { stability: 0.65, similarity: 0.8, style: 0.2 };
  } else {
    const persona = VOICE_PERSONAS[voice_mode] || VOICE_PERSONAS.jarvis;
    voiceId = persona.id;
    voiceSettings = { stability: persona.stability, similarity: persona.similarity, style: persona.style };
  }

  // flash_v2_5: ~75ms model inference (2026 benchmarks), the right model for
  // conversational streaming; optimize_streaming_latency=3 trades a little
  // quality for earliest first-byte.
  const modelId = model_id || 'eleven_flash_v2_5';
  const postData = JSON.stringify({
    text: cleanText,
    model_id: modelId,
    voice_settings: {
      stability: voiceSettings.stability,
      similarity_boost: voiceSettings.similarity,
      style: voiceSettings.style,
      use_speaker_boost: true,
    },
  });

  const upstream = https.request({
    hostname: 'api.elevenlabs.io',
    path: `/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=mp3_44100_128`,
    method: 'POST',
    headers: {
      Accept: 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
      'Content-Length': Buffer.byteLength(postData),
    },
  }, (upRes) => {
    if (upRes.statusCode !== 200) {
      if (upRes.statusCode === 401 || upRes.statusCode === 403) invalidateVoiceKeyCache();
      const errChunks = [];
      upRes.on('data', (c) => errChunks.push(c));
      upRes.on('end', () => {
        const body = Buffer.concat(errChunks).toString().slice(0, 300);
        if (!res.headersSent) res.status(502).json({ error: 'TTS stream failed', status: upRes.statusCode, details: body });
      });
      return;
    }
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Voice-Id', voiceId);
    res.set('X-Voice-Model', modelId);
    res.set('Cache-Control', 'no-store');
    upRes.pipe(res); // chunk-for-chunk; first byte forwarded as soon as ElevenLabs emits it
  });

  upstream.on('error', (e) => {
    console.error('[Voice] TTS stream upstream error:', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'TTS stream unavailable' });
    else res.end();
  });
  // Client hung up (barge-in / navigate): tear the upstream down so we don't
  // keep synthesising into a dead socket (wasted ElevenLabs quota).
  res.on('close', () => { upstream.destroy(); });
  upstream.write(postData);
  upstream.end();
}

// ============================================================================
// Transcribe Handler (STT)
// ============================================================================

async function handleTranscribe(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio data received', text: '' });
  }

  const audioBuffer = req.file.buffer;
  if (audioBuffer.length < 100) {
    return res.status(400).json({ error: 'Audio too short', text: '' });
  }

  // Fetch API key
  const keys = await getVoiceKeys();
  const apiKey = keys.openai_api_key;
  if (!apiKey) {
    return res.status(503).json({ error: 'OpenAI API key not configured', text: '' });
  }

  const mimeType = req.file.mimetype || 'audio/webm';

  try {
    const result = await callWhisper(apiKey, audioBuffer, mimeType);
    return res.json(result);
  } catch (err) {
    console.error('[Voice] Transcribe error:', err.message);
    return res.status(502).json({ error: err.message, text: '' });
  }
}

function callWhisper(apiKey, audioBuffer, mimeType) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', audioBuffer, {
      filename: 'audio.webm',
      contentType: mimeType
    });
    form.append('model', 'whisper-1');

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...form.getHeaders()
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            resolve({ error: json.error.message, text: '' });
          } else {
            resolve({ text: json.text || '', success: true });
          }
        } catch (e) {
          resolve({ error: 'Failed to parse Whisper response', text: '' });
        }
      });
    });

    req.on('error', (e) => resolve({ error: e.message, text: '' }));
    form.pipe(req);
  });
}

async function getVoiceKeyStatus() {
  const keys = await getVoiceKeys();
  return {
    stt: Boolean(keys.openai_api_key),
    tts: Boolean(keys.elevenlabs_api_key)
  };
}

module.exports = {
  handleSpeak,
  handleSpeakStream,
  handleTranscribe,
  getVoiceKeyStatus,
  getVoiceKeys,
  invalidateVoiceKeyCache,
  VOICE_PERSONAS,
  cleanTextForSpeech,
  // Exported for testing
  callElevenLabs,
  callWhisper
};
