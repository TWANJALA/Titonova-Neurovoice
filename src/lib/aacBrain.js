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

const URGENCY_KEYWORDS = new Set(["help", "stop", "hurt", "emergency", "now", "pain"]);

const GOALS = {
  BALANCED: "balanced",
  EXPAND_VOCABULARY: "expand_vocabulary",
  COMMUNICATION_SPEED: "communication_speed",
};

const SCORE_WEIGHTS = {
  frequency: 0.16,
  recency: 0.08,
  intent: 0.16,
  sequence: 0.13,
  timeRelevance: 0.07,
  speed: 0.08,
  continuation: 0.12,
  adaptation: 0.1,
  goal: 0.05,
  urgency: 0.03,
  environment: 0.02,
};

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
  if (tokens.length === 0) return AAC_INTENTS.UNKNOWN;

  let bestIntent = AAC_INTENTS.UNKNOWN;
  let bestScore = 0;
  const lastToken = tokens[tokens.length - 1] ?? "";

  INTENT_RULES.forEach((rule) => {
    const normalizedPhrases = (rule.phrases ?? []).map((phrase) => normalizeToken(phrase));
    const normalizedWords = new Set((rule.words ?? []).map((word) => normalizeToken(word)));
    const phraseHits = normalizedPhrases.filter((phrase) => phrase && text.includes(phrase)).length;
    const tokenHits = tokens.filter((token) => normalizedWords.has(token)).length;

    const phraseScore = phraseHits * 2.3;
    const tokenScore = tokenHits * 0.9;
    const tapBias = normalizedWords.has(normalizeToken(tappedWord)) ? 0.75 : 0;
    const lastTokenBias = normalizedWords.has(lastToken) ? 0.55 : 0;
    const score = phraseScore + tokenScore + tapBias + lastTokenBias;

    if (score > bestScore) {
      bestScore = score;
      bestIntent = rule.intent;
    }
  });

  return bestScore >= 1.1 ? bestIntent : AAC_INTENTS.UNKNOWN;
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
  const seen = new Set();

  return templates
    .map((template) => String(template ?? "").replace("{word}", word))
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((sentence) => {
      const key = normalizeToken(sentence);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getConceptExpansions({ tappedWord = "", currentSentence = [], conceptGraph = AAC_CONCEPT_GRAPH } = {}) {
  const trigger = normalizeToken(tappedWord || currentSentence[currentSentence.length - 1] || "");
  if (!trigger) return [];
  const related = Array.isArray(conceptGraph?.[trigger]) ? conceptGraph[trigger] : [];
  const intent = detectIntent({ tappedWord, currentSentence });
  const prefixByIntent = {
    [AAC_INTENTS.NEED]: "I need",
    [AAC_INTENTS.EMOTION]: "I feel",
    [AAC_INTENTS.ACTION]: "I want to",
    [AAC_INTENTS.RESPONSE]: "",
    [AAC_INTENTS.SOCIAL]: "",
    [AAC_INTENTS.REQUEST]: "I want",
    [AAC_INTENTS.UNKNOWN]: "I want",
  };
  const prefix = String(prefixByIntent[intent] ?? "I want").trim();

  return related
    .map((value) => normalizeToken(value))
    .filter(Boolean)
    .map((token) => (prefix ? `${prefix} ${token}` : token))
    .map((sentence) => sentence.replace(/\s+/g, " ").trim());
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

function startsWithTokenSequence(tokens = [], sequence = []) {
  if (!Array.isArray(tokens) || !Array.isArray(sequence) || sequence.length === 0) return false;
  if (tokens.length < sequence.length) return false;
  for (let index = 0; index < sequence.length; index += 1) {
    if (tokens[index] !== sequence[index]) return false;
  }
  return true;
}

function includesTokenSequence(tokens = [], sequence = []) {
  if (!Array.isArray(tokens) || !Array.isArray(sequence) || sequence.length === 0) return false;
  if (tokens.length < sequence.length) return false;
  for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
    let ok = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[start + offset] !== sequence[offset]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function continuationScore(candidateSentence = "", context = {}) {
  const prefixTokens = Array.isArray(context?.currentSentence)
    ? context.currentSentence.map((token) => normalizeToken(token)).filter(Boolean)
    : [];
  if (prefixTokens.length === 0) return 0.5;

  const candidateTokens = tokenizeText(candidateSentence);
  if (candidateTokens.length === 0) return 0;
  if (startsWithTokenSequence(candidateTokens, prefixTokens)) return 1;
  if (includesTokenSequence(candidateTokens, prefixTokens)) return 0.74;

  const overlap = prefixTokens.filter((token) => candidateTokens.includes(token)).length;
  if (overlap === 0) return 0.12;
  return clamp01((overlap / prefixTokens.length) * 0.52);
}

function adaptationScore(candidateSentence = "", model = {}) {
  const phrase = normalizeToken(candidateSentence);
  if (!phrase) return 0.5;

  const acceptedCount = Number(model?.acceptedCounts?.[phrase] ?? model?.phraseFrequency?.[phrase] ?? 0);
  const ignoredCount = Number(model?.ignoredCounts?.[phrase] ?? 0);
  const phraseAcceptance = clamp01((acceptedCount + 1) / (acceptedCount + ignoredCount + 2));

  const tokens = tokenizeText(candidateSentence);
  const tokenAcceptedAvg = avg(tokens.map((token) => Number(model?.tokenAcceptedCounts?.[token] ?? model?.wordFrequency?.[token] ?? 0)));
  const tokenIgnoredAvg = avg(tokens.map((token) => Number(model?.tokenIgnoredCounts?.[token] ?? 0)));
  const tokenAcceptance = clamp01((tokenAcceptedAvg + 1) / (tokenAcceptedAvg + tokenIgnoredAvg + 2));

  return clamp01(phraseAcceptance * 0.72 + tokenAcceptance * 0.28);
}

function urgencyAlignmentScore(candidateSentence = "", context = {}) {
  if (!Boolean(context?.urgency)) return 0.5;
  const tokens = tokenizeText(candidateSentence);
  if (tokens.length === 0) return 0;
  const hasUrgentToken = tokens.some((token) => URGENCY_KEYWORDS.has(token));
  return hasUrgentToken ? 1 : 0.15;
}

function environmentRelevanceScore(candidateSentence = "", context = {}, model = {}) {
  const environment = normalizeToken(context?.environment ?? context?.environmentContext);
  if (!environment) return 0.5;
  const patterns = Array.isArray(model?.environmentPatterns?.[environment])
    ? model.environmentPatterns[environment]
    : [];
  if (patterns.length === 0) return 0.5;

  const patternSet = new Set(patterns.map((token) => normalizeToken(token)).filter(Boolean));
  if (patternSet.size === 0) return 0.5;
  const tokens = tokenizeText(candidateSentence);
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((token) => patternSet.has(token)).length;
  return clamp01(hits / Math.max(1, Math.min(4, tokens.length)));
}

function noveltyBalanceScore(candidateSentence = "", model = {}, context = {}) {
  const tokens = tokenizeText(candidateSentence);
  if (tokens.length === 0) return 0.5;

  const rarity = avg(
    tokens.map((token) => {
      const seen = Math.max(0, Number(model?.wordFrequency?.[token] ?? 0));
      return clamp01(1 / (1 + Math.log1p(seen)));
    })
  );

  const recentTail = Array.isArray(context?.recentSentences)
    ? context.recentSentences.slice(-8).map((entry) => normalizeToken(entry))
    : [];
  const repeatedRecently = recentTail.includes(normalizeToken(candidateSentence));
  const repetitionPenalty = repeatedRecently ? 0.25 : 0;
  return clamp01(rarity - repetitionPenalty + 0.2);
}

function goalAlignmentScore(candidate = {}, context = {}, model = {}) {
  const goal = normalizeToken(context?.goal || GOALS.BALANCED);
  const sentence = String(candidate?.sentence ?? candidate ?? "").trim();
  const speed = speedScore({ sentence, tapCount: candidate?.tapCount });
  const novelty = noveltyBalanceScore(sentence, model, context);
  const adaptation = adaptationScore(sentence, model);

  if (goal === GOALS.COMMUNICATION_SPEED) {
    return clamp01(speed * 0.68 + adaptation * 0.32);
  }

  if (goal === GOALS.EXPAND_VOCABULARY) {
    return clamp01(novelty * 0.72 + adaptation * 0.28);
  }

  return clamp01(speed * 0.34 + novelty * 0.33 + adaptation * 0.33);
}

function computeScore({ candidate = {}, context = {}, intent = AAC_INTENTS.UNKNOWN, model = {} } = {}) {
  const sentence = String(candidate?.sentence ?? candidate ?? "").trim();
  if (!sentence) return 0;

  const sequence = getSequenceScore(sentence, model?.transitions ?? {});
  const componentScores = {
    frequency: frequencyScore(sentence, model),
    recency: recencyScore(sentence, context),
    intent: intentScore(sentence, intent),
    sequence,
    timeRelevance: timeRelevanceScore(sentence, context, model),
    speed: speedScore(candidate),
    continuation: continuationScore(sentence, context),
    adaptation: adaptationScore(sentence, model),
    goal: goalAlignmentScore(candidate, context, model),
    urgency: urgencyAlignmentScore(sentence, context),
    environment: environmentRelevanceScore(sentence, context, model),
  };

  const weighted = Object.entries(SCORE_WEIGHTS).reduce((sum, [key, weight]) => {
    const score = Number(componentScores[key] ?? 0);
    return sum + weight * clamp01(score);
  }, 0);

  return clamp01(weighted);
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
