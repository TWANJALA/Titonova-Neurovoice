const CACHE_STORAGE_KEY = "aac-translation-cache-v1";
const CACHE_SAVE_INTERVAL_MS = 1200;

export const UI_LANGUAGE_OPTIONS = [
  { code: "en", label: "English", ttsLang: "en-US" },
  { code: "es", label: "Spanish", ttsLang: "es-ES" },
  { code: "sw", label: "Swahili", ttsLang: "sw-KE" },
  { code: "fr", label: "French", ttsLang: "fr-FR" },
];

const LANGUAGE_BY_CODE = UI_LANGUAGE_OPTIONS.reduce((lookup, option) => {
  lookup[option.code] = option;
  return lookup;
}, {});

let cacheLoaded = false;
let cacheSaveTimer = null;
const translationCache = {};

function scheduleCachePersist() {
  if (typeof window === "undefined") return;
  if (cacheSaveTimer) return;
  cacheSaveTimer = window.setTimeout(() => {
    cacheSaveTimer = null;
    try {
      window.localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(translationCache));
    } catch (error) {
      console.error("Failed to persist translation cache:", error);
    }
  }, CACHE_SAVE_INTERVAL_MS);
}

function ensureCacheLoaded() {
  if (cacheLoaded || typeof window === "undefined") return;
  cacheLoaded = true;
  try {
    const raw = window.localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    Object.entries(parsed).forEach(([text, byLang]) => {
      if (!text || !byLang || typeof byLang !== "object") return;
      translationCache[text] = {};
      Object.entries(byLang).forEach(([lang, value]) => {
        if (!lang) return;
        const safeValue = String(value ?? "").trim();
        if (!safeValue) return;
        translationCache[text][lang] = safeValue;
      });
    });
  } catch (error) {
    console.error("Failed to load translation cache:", error);
  }
}

export function normalizeLanguageCode(lang) {
  const raw = String(lang ?? "en").trim().toLowerCase();
  if (!raw) return "en";
  if (raw.includes("-")) return raw.split("-")[0];
  return raw;
}

export function getTtsLanguageForCode(lang) {
  const code = normalizeLanguageCode(lang);
  return LANGUAGE_BY_CODE[code]?.ttsLang ?? "en-US";
}

function getCachedTranslation(text, targetLang) {
  ensureCacheLoaded();
  return translationCache[text]?.[targetLang] ?? "";
}

function setCachedTranslation(text, targetLang, translatedText) {
  ensureCacheLoaded();
  if (!translationCache[text]) {
    translationCache[text] = {};
  }
  translationCache[text][targetLang] = translatedText;
  scheduleCachePersist();
}

function readTranslatedText(payload, fallbackText) {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed || fallbackText;
  }
  if (!payload || typeof payload !== "object") return fallbackText;

  const candidates = [
    payload.translatedText,
    payload.translation,
    payload.translated,
    payload.text,
    payload.result,
  ];
  for (const entry of candidates) {
    const safe = String(entry ?? "").trim();
    if (safe) return safe;
  }

  if (typeof payload.data === "object" && payload.data) {
    return readTranslatedText(payload.data, fallbackText);
  }
  return fallbackText;
}

export async function translateText(text, lang, options = {}) {
  const sourceText = String(text ?? "").trim();
  if (!sourceText) return "";

  const targetLang = normalizeLanguageCode(lang);
  const sourceLang = normalizeLanguageCode(options.sourceLang ?? "en");
  if (targetLang === sourceLang) return sourceText;

  const cached = getCachedTranslation(sourceText, targetLang);
  if (cached) return cached;

  const endpoint = String(options.endpoint ?? "/api/translate");
  const query = new URLSearchParams({
    text: sourceText,
    lang: targetLang,
    source: sourceLang,
  });

  try {
    const response = await fetch(`${endpoint}?${query.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Translation request failed (${response.status})`);
    }

    const payload = await response.json();
    const translated = readTranslatedText(payload, sourceText);
    setCachedTranslation(sourceText, targetLang, translated);
    return translated;
  } catch (error) {
    console.error("Translation request failed:", error);
    return sourceText;
  }
}

export async function translateTextBatch(texts, lang, options = {}) {
  const list = Array.isArray(texts) ? texts : [];
  const normalizedTexts = [...new Set(list.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
  const translated = await Promise.all(
    normalizedTexts.map(async (text) => [text, await translateText(text, lang, options)])
  );
  return translated.reduce((lookup, [source, target]) => {
    lookup[source] = target;
    return lookup;
  }, {});
}

export async function speakLocalizedText(text, options = {}) {
  if (typeof window === "undefined" || !window?.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
    return "";
  }

  const sourceText = String(text ?? "").trim();
  if (!sourceText) return "";

  const lang = normalizeLanguageCode(options.lang ?? "en");
  const ttsLang = String(options.ttsLang ?? getTtsLanguageForCode(lang));
  const translatedText =
    options.translate === false ? sourceText : await translateText(sourceText, lang, options);

  const utterance = new SpeechSynthesisUtterance(translatedText);
  utterance.lang = ttsLang;
  utterance.rate = Math.max(0.6, Math.min(1.8, Number(options.rate ?? 1)));
  utterance.pitch = Math.max(0.6, Math.min(1.8, Number(options.pitch ?? 1)));

  const synth = window.speechSynthesis;
  const voices = synth.getVoices?.() ?? [];
  const voiceURI = String(options.voiceURI ?? "").trim();
  const requestedBaseLang = normalizeLanguageCode(ttsLang);

  const selectedVoice =
    (voiceURI ? voices.find((voice) => voice.voiceURI === voiceURI) : null) ??
    voices.find((voice) => normalizeLanguageCode(voice.lang) === requestedBaseLang);

  if (selectedVoice) {
    utterance.voice = selectedVoice;
  }

  synth.speak(utterance);
  return translatedText;
}
