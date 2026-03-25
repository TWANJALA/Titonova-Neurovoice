const AAC_INTENTS = {
  REQUEST: "request",
  NEED: "need",
  EMOTION: "emotion",
  ACTION: "action",
  RESPONSE: "response",
  SOCIAL: "social",
  UNKNOWN: "unknown",
};

const AAC_DEFAULT_TEMPLATES = {
  [AAC_INTENTS.REQUEST]: ["I want {word}", "Can I have {word}", "I need {word}"],
  [AAC_INTENTS.NEED]: ["I need {word}", "Please help with {word}"],
  [AAC_INTENTS.EMOTION]: ["I feel {word}", "I am {word}"],
  [AAC_INTENTS.ACTION]: ["I want to {word}", "Can we {word}"],
  [AAC_INTENTS.RESPONSE]: ["{word}", "Okay {word}"],
  [AAC_INTENTS.SOCIAL]: ["Hello", "Thank you", "{word}"],
  [AAC_INTENTS.UNKNOWN]: ["I want {word}", "I need {word}"],
};

const AAC_CONCEPT_GRAPH = {
  water: ["drink", "thirsty", "more"],
  tired: ["sleep", "rest"],
  hungry: ["eat", "food"],
  help: ["assist", "support", "now"],
  sad: ["upset", "comfort"],
};

const INTENT_RULES = [
  { intent: AAC_INTENTS.REQUEST, phrases: ["i want", "can i have", "give me"], words: ["want", "water", "food"] },
  { intent: AAC_INTENTS.NEED, phrases: ["i need", "help me"], words: ["need", "help", "bathroom", "hurt"] },
  { intent: AAC_INTENTS.EMOTION, phrases: ["i feel", "i am"], words: ["happy", "sad", "tired", "mad"] },
  { intent: AAC_INTENTS.ACTION, phrases: ["i want to", "let us"], words: ["go", "play", "open", "close"] },
  { intent: AAC_INTENTS.RESPONSE, phrases: ["yes", "no", "okay"], words: ["yes", "no", "okay"] },
  { intent: AAC_INTENTS.SOCIAL, phrases: ["hello", "thank you", "goodbye"], words: ["hello", "thanks", "bye"] },
];

function normalizeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function tokenizeText(value) {
  return normalizeToken(value)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function clamp01(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed <= 0) return 0;
  if (parsed >= 1) return 1;
  return parsed;
}

function avg(values = []) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + Number(value ?? 0), 0);
  return total / values.length;
}

function sentenceIntent(sentence) {
  const tokens = tokenizeText(sentence);
  const tappedWord = tokens[tokens.length - 1] ?? "";
  return detectIntent({ tappedWord, currentSentence: tokens.slice(0, -1) });
}

function detectIntent({ tappedWord = "", currentSentence = [] } = {}) {
  const tokens = [...(Array.isArray(currentSentence) ? currentSentence : []), tappedWord]
    .map((token) => normalizeToken(token))
    .filter(Boolean);
  const text = tokens.join(" ");

  for (let index = 0; index < INTENT_RULES.length; index += 1) {
    const rule = INTENT_RULES[index];
    const phraseHit = rule.phrases.some((phrase) => text.includes(normalizeToken(phrase)));
    if (phraseHit) return rule.intent;
    const wordHit = tokens.some((token) => rule.words.includes(token));
    if (wordHit) return rule.intent;
  }

  return AAC_INTENTS.UNKNOWN;
}

function getSequenceScore(candidateSentence = "", transitions = {}) {
  const tokens = tokenizeText(candidateSentence);
  if (tokens.length < 2) return 0;

  let sum = 0;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const from = tokens[index];
    const to = tokens[index + 1];
    const value = Number(transitions?.[from]?.[to] ?? 0);
    if (!Number.isFinite(value) || value <= 0) continue;
    sum += Math.log1p(value);
  }

  return clamp01(sum / Math.max(1.25, tokens.length * 1.2));
}

function applyTemplates({ tappedWord = "", intent = AAC_INTENTS.UNKNOWN, templatesByIntent = AAC_DEFAULT_TEMPLATES } = {}) {
  const word = normalizeToken(tappedWord);
  if (!word) return [];
  const templates = templatesByIntent?.[intent] ?? templatesByIntent?.[AAC_INTENTS.UNKNOWN] ?? [];

  return templates
    .map((template) => String(template ?? "").replace("{word}", word))
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function getConceptExpansions({ tappedWord = "", currentSentence = [], conceptGraph = AAC_CONCEPT_GRAPH } = {}) {
  const trigger = normalizeToken(tappedWord || currentSentence[currentSentence.length - 1] || "");
  if (!trigger) return [];
  const related = Array.isArray(conceptGraph?.[trigger]) ? conceptGraph[trigger] : [];

  return related
    .map((value) => normalizeToken(value))
    .filter(Boolean)
    .map((token) => `I want ${token}`);
}

function frequencyScore(candidateSentence, model = {}) {
  const phraseToken = normalizeToken(candidateSentence);
  const phraseValue = Number(model?.phraseFrequency?.[phraseToken] ?? 0);
  const words = tokenizeText(candidateSentence);
  const wordScore = avg(words.map((word) => Number(model?.wordFrequency?.[word] ?? 0)));
  return clamp01((Math.log1p(phraseValue) * 0.7 + Math.log1p(wordScore) * 0.3) / 4.2);
}

function recencyScore(candidateSentence, context = {}) {
  const recentSentences = Array.isArray(context?.recentSentences) ? context.recentSentences : [];
  const normalizedCandidate = normalizeToken(candidateSentence);
  if (!normalizedCandidate || recentSentences.length === 0) return 0;

  const idx = recentSentences
    .map((entry) => normalizeToken(entry))
    .lastIndexOf(normalizedCandidate);
  if (idx < 0) return 0;

  const recency = (idx + 1) / recentSentences.length;
  return clamp01(recency);
}

function intentScore(candidateSentence, expectedIntent = AAC_INTENTS.UNKNOWN) {
  if (expectedIntent === AAC_INTENTS.UNKNOWN) return 0;
  return sentenceIntent(candidateSentence) === expectedIntent ? 1 : 0;
}

function timeRelevanceScore(candidateSentence, context = {}, model = {}) {
  const timeOfDay = normalizeToken(context?.timeOfDay);
  const patterns = model?.timePatterns?.[timeOfDay];
  if (!Array.isArray(patterns) || patterns.length === 0) return 0;

  const tokens = new Set(tokenizeText(candidateSentence));
  const hits = patterns.filter((token) => tokens.has(normalizeToken(token))).length;
  return clamp01(hits / Math.max(1, patterns.length));
}

function speedScore(candidate = {}) {
  const rawTapCount = Number(candidate?.tapCount ?? tokenizeText(candidate?.sentence ?? "").length ?? 1);
  const tapCount = Math.max(1, Number.isFinite(rawTapCount) ? rawTapCount : 1);
  return clamp01(1 / tapCount);
}

function computeScore({ candidate = {}, context = {}, intent = AAC_INTENTS.UNKNOWN, model = {} } = {}) {
  const sentence = String(candidate?.sentence ?? candidate ?? "").trim();
  if (!sentence) return 0;

  const sequence = getSequenceScore(sentence, model?.transitions ?? {});
  const score =
    0.25 * frequencyScore(sentence, model) +
    0.2 * recencyScore(sentence, context) +
    0.3 * intentScore(sentence, intent) +
    0.2 * sequence +
    0.15 * timeRelevanceScore(sentence, context, model) +
    0.2 * speedScore(candidate);

  return clamp01(score);
}

function rankCandidates({ candidates = [], context = {}, intent = AAC_INTENTS.UNKNOWN, model = {}, limit = 5 } = {}) {
  return candidates
    .map((candidate) => {
      const sentence = String(candidate?.sentence ?? candidate ?? "").trim();
      if (!sentence) return null;
      return {
        ...(typeof candidate === "object" && candidate !== null ? candidate : { sentence }),
        score: computeScore({ candidate: { ...(candidate ?? {}), sentence }, context, intent, model }),
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0) || String(a.sentence).localeCompare(String(b.sentence)))
    .slice(0, Math.max(1, Number(limit ?? 5)));
}

function learnFromUsage(sentence = "", model = {}) {
  const phrase = normalizeToken(sentence);
  if (!phrase) return model;

  const next = {
    wordFrequency: { ...(model.wordFrequency ?? {}) },
    transitions: { ...(model.transitions ?? {}) },
    phraseFrequency: { ...(model.phraseFrequency ?? {}) },
  };

  next.phraseFrequency[phrase] = Number(next.phraseFrequency[phrase] ?? 0) + 1;
  const tokens = tokenizeText(phrase);

  tokens.forEach((token) => {
    next.wordFrequency[token] = Number(next.wordFrequency[token] ?? 0) + 1;
  });

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const from = tokens[index];
    const to = tokens[index + 1];
    const nextMap = { ...(next.transitions[from] ?? {}) };
    nextMap[to] = Number(nextMap[to] ?? 0) + 1;
    next.transitions[from] = nextMap;
  }

  return next;
}

function penalizeSuggestion(sentence = "", model = {}, factor = 0.95) {
  const phrase = normalizeToken(sentence);
  if (!phrase) return model;
  const safeFactor = Math.max(0.4, Math.min(0.999, Number(factor ?? 0.95)));

  const current = Number(model?.phraseFrequency?.[phrase] ?? 0);
  return {
    ...model,
    phraseFrequency: {
      ...(model?.phraseFrequency ?? {}),
      [phrase]: current * safeFactor,
    },
  };
}

function decayModel(model = {}, factor = 0.98) {
  const safeFactor = Math.max(0.8, Math.min(0.999, Number(factor ?? 0.98)));
  const decayMap = (value = {}) => {
    const next = {};
    Object.entries(value).forEach(([key, raw]) => {
      const decayed = Number(raw ?? 0) * safeFactor;
      if (decayed <= 0.03) return;
      next[key] = decayed;
    });
    return next;
  };

  const transitions = {};
  Object.entries(model?.transitions ?? {}).forEach(([from, mapping]) => {
    const decayed = decayMap(mapping ?? {});
    if (Object.keys(decayed).length > 0) {
      transitions[from] = decayed;
    }
  });

  return {
    ...model,
    wordFrequency: decayMap(model?.wordFrequency ?? {}),
    phraseFrequency: decayMap(model?.phraseFrequency ?? {}),
    transitions,
  };
}

function precomputeSuggestions({ words = [], getSuggestions } = {}) {
  const cache = {};
  if (!Array.isArray(words) || typeof getSuggestions !== "function") return cache;

  words.forEach((word) => {
    const token = normalizeToken(word?.text ?? word);
    if (!token) return;
    const suggestions = getSuggestions({ tappedWord: token });
    if (!Array.isArray(suggestions) || suggestions.length === 0) return;
    cache[token] = suggestions;
  });

  return cache;
}

export {
  AAC_INTENTS,
  AAC_DEFAULT_TEMPLATES,
  AAC_CONCEPT_GRAPH,
  applyTemplates,
  computeScore,
  decayModel,
  detectIntent,
  getConceptExpansions,
  getSequenceScore,
  learnFromUsage,
  penalizeSuggestion,
  precomputeSuggestions,
  rankCandidates,
};
