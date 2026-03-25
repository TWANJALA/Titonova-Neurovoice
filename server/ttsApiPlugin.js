const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RATE_LIMIT_MAX = 40;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MAX_TEXT_CHARS = 800;

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeLang(value, fallback = "en") {
  const safe = String(value ?? "").trim().toLowerCase();
  if (!safe) return fallback;
  if (safe.includes("-")) {
    const [base] = safe.split("-");
    return /^[a-z]{2,3}$/.test(base) ? base : fallback;
  }
  return /^[a-z]{2,3}$/.test(safe) ? safe : fallback;
}

function toLocale(langCode) {
  const code = normalizeLang(langCode, "en");
  const map = {
    en: "en-US",
    es: "es-ES",
    fr: "fr-FR",
    sw: "sw-KE",
    de: "de-DE",
    it: "it-IT",
    pt: "pt-BR",
  };
  return map[code] ?? `${code}-${code.toUpperCase()}`;
}

function buildAzureVoiceName(langCode, env = {}) {
  const code = normalizeLang(langCode, "en");
  const byEnv = {
    en: String(env.AZURE_TTS_VOICE_EN ?? ""),
    es: String(env.AZURE_TTS_VOICE_ES ?? ""),
    fr: String(env.AZURE_TTS_VOICE_FR ?? ""),
    sw: String(env.AZURE_TTS_VOICE_SW ?? ""),
  };
  if (byEnv[code]?.trim()) return byEnv[code].trim();

  const defaults = {
    en: "en-US-JennyNeural",
    es: "es-ES-ElviraNeural",
    fr: "fr-FR-DeniseNeural",
    sw: "sw-KE-RafikiNeural",
  };
  return defaults[code] ?? defaults.en;
}

function buildGoogleGender(langCode) {
  const code = normalizeLang(langCode, "en");
  if (code === "es" || code === "fr") return "FEMALE";
  return "NEUTRAL";
}

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function binary(res, statusCode, bytes, mimeType = "audio/mpeg") {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Cache-Control", "no-store");
  res.end(bytes);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      resolve(text);
    });
    req.on("error", reject);
  });
}

function getClientIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

function createRateLimiter({ maxRequests, windowMs }) {
  const buckets = new Map();
  return {
    consume(key) {
      const now = Date.now();
      const current = buckets.get(key);
      if (!current || now >= current.resetAt) {
        const next = {
          count: 1,
          resetAt: now + windowMs,
        };
        buckets.set(key, next);
        return { allowed: true, remaining: Math.max(0, maxRequests - 1), resetAt: next.resetAt };
      }

      if (current.count >= maxRequests) {
        return { allowed: false, remaining: 0, resetAt: current.resetAt };
      }

      current.count += 1;
      return {
        allowed: true,
        remaining: Math.max(0, maxRequests - current.count),
        resetAt: current.resetAt,
      };
    },
  };
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("TTS request timed out")), timeoutMs);
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timeoutId);
    },
  };
}

async function ttsWithAzure({ text, lang, rate, pitch, volume, voiceId, env, timeoutMs }) {
  const apiKey = String(env.AZURE_TTS_API_KEY ?? "").trim();
  const region = String(env.AZURE_TTS_REGION ?? "").trim();
  if (!apiKey || !region) {
    throw new Error("AZURE_TTS_API_KEY and AZURE_TTS_REGION are required");
  }

  const locale = toLocale(lang);
  const voiceName = String(voiceId ?? "").trim() || buildAzureVoiceName(lang, env);
  const endpoint = String(env.AZURE_TTS_ENDPOINT ?? "").trim() || `https://${region}.tts.speech.microsoft.com`;
  const url = `${endpoint.replace(/\/+$/, "")}/cognitiveservices/v1`;
  const ratePercent = Math.round((clampNumber(rate, 0.6, 1.8, 1) - 1) * 100);
  const pitchPercent = Math.round((clampNumber(pitch, 0.6, 1.8, 1) - 1) * 100);
  const volumePercent = Math.round(clampNumber(volume, 0, 1, 1) * 100);
  const escapedText = String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const ssml =
    `<speak version="1.0" xml:lang="${locale}">` +
    `<voice name="${voiceName}"><prosody rate="${ratePercent}%" pitch="${pitchPercent}%" volume="${volumePercent}%">` +
    `${escapedText}</prosody></voice></speak>`;

  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": apiKey,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "non-verbal-saas",
      },
      body: ssml,
      signal: timeout.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Azure Neural TTS failed (${response.status}): ${detail || "no detail"}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    timeout.done();
  }
}

async function ttsWithGoogle({ text, lang, rate, pitch, volume, voiceId, env, timeoutMs }) {
  const apiKey = String(env.GOOGLE_CLOUD_TTS_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("GOOGLE_CLOUD_TTS_API_KEY is required");
  }

  const locale = toLocale(lang);
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`;
  const requestBody = {
    input: { text },
    voice: {
      languageCode: locale,
      ...(voiceId ? { name: String(voiceId) } : { ssmlGender: buildGoogleGender(lang) }),
    },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate: clampNumber(rate, 0.25, 2, 1),
      pitch: Math.round((clampNumber(pitch, 0.6, 1.8, 1) - 1) * 20),
      volumeGainDb: Math.round((clampNumber(volume, 0, 1, 1) - 1) * 16),
    },
  };

  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: timeout.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          payload?.message ||
          `Google Cloud TTS failed (${response.status})`
      );
    }

    const audioContent = String(payload?.audioContent ?? "");
    if (!audioContent) throw new Error("Google Cloud TTS returned empty audioContent");
    return Buffer.from(audioContent, "base64");
  } finally {
    timeout.done();
  }
}

async function ttsWithElevenLabs({ text, lang, voiceId, env, timeoutMs }) {
  const apiKey = String(env.ELEVENLABS_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is required");
  }

  const defaultVoice = String(env.ELEVENLABS_DEFAULT_VOICE_ID ?? "").trim();
  const selectedVoiceId = String(voiceId ?? "").trim() || defaultVoice;
  if (!selectedVoiceId) {
    throw new Error("ELEVENLABS_DEFAULT_VOICE_ID or voiceId is required");
  }

  const model = String(env.ELEVENLABS_MODEL_ID ?? "").trim() || "eleven_multilingual_v2";
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(selectedVoiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: model,
          language_code: normalizeLang(lang, "en"),
        }),
        signal: timeout.signal,
      }
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`ElevenLabs TTS failed (${response.status}): ${detail || "no detail"}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    timeout.done();
  }
}

export function ttsApiPlugin(env = {}) {
  const defaultProvider = String(env.TTS_DEFAULT_PROVIDER ?? "azure-neural").trim().toLowerCase();
  const timeoutMs = toInt(env.TTS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxRequests = toInt(env.TTS_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX);
  const windowMs = toInt(env.TTS_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS);
  const maxTextChars = toInt(env.TTS_MAX_TEXT_CHARS, DEFAULT_MAX_TEXT_CHARS);
  const limiter = createRateLimiter({ maxRequests, windowMs });

  const middleware = async (req, res, next) => {
    if (!req.url?.startsWith("/api/tts")) {
      return next();
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    const ip = getClientIp(req);
    const quota = limiter.consume(ip);
    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(quota.remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.floor(quota.resetAt / 1000)));
    if (!quota.allowed) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((quota.resetAt - Date.now()) / 1000))));
      return json(res, 429, { error: "Rate limit exceeded" });
    }

    let payload;
    try {
      const raw = await readRequestBody(req);
      payload = raw.trim() ? JSON.parse(raw) : {};
    } catch (error) {
      return json(res, 400, { error: "Invalid JSON body" });
    }

    const text = String(payload?.text ?? "").trim();
    const lang = normalizeLang(payload?.lang, "en");
    const source = normalizeLang(payload?.source ?? "en", "en");
    const provider = String(payload?.provider ?? defaultProvider).trim().toLowerCase();
    const voiceId = String(payload?.voiceId ?? "").trim();
    const rate = clampNumber(payload?.rate, 0.6, 1.8, 1);
    const pitch = clampNumber(payload?.pitch, 0.6, 1.8, 1);
    const volume = clampNumber(payload?.volume, 0, 1, 1);

    if (!text) {
      return json(res, 400, { error: "Missing required field: text" });
    }
    if (text.length > maxTextChars) {
      return json(res, 400, { error: `Text exceeds max length (${maxTextChars} chars)` });
    }

    try {
      let audioBytes = null;
      let usedProvider = provider;

      if (provider === "azure-neural") {
        audioBytes = await ttsWithAzure({
          text,
          lang,
          source,
          rate,
          pitch,
          volume,
          voiceId,
          env,
          timeoutMs,
        });
      } else if (provider === "google-cloud") {
        audioBytes = await ttsWithGoogle({
          text,
          lang,
          source,
          rate,
          pitch,
          volume,
          voiceId,
          env,
          timeoutMs,
        });
      } else if (provider === "elevenlabs") {
        audioBytes = await ttsWithElevenLabs({
          text,
          lang,
          source,
          rate,
          pitch,
          volume,
          voiceId,
          env,
          timeoutMs,
        });
      } else {
        usedProvider = "unsupported";
        throw new Error(`Unsupported provider "${provider}"`);
      }

      res.setHeader("X-TTS-Provider", usedProvider);
      return binary(res, 200, audioBytes, "audio/mpeg");
    } catch (error) {
      return json(res, 502, {
        error: "TTS upstream request failed",
        detail: String(error?.message ?? error),
      });
    }
  };

  return {
    name: "aac-tts-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
