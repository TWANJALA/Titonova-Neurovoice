function sanitizeStringArray(value = [], limit = 200) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function sanitizeNumberMap(value = {}) {
  if (!value || typeof value !== "object") return {};
  const next = {};
  Object.entries(value).forEach(([key, raw]) => {
    const parsed = Number(raw ?? 0);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    next[String(key)] = parsed;
  });
  return next;
}

function sanitizeTransitionMap(value = {}) {
  if (!value || typeof value !== "object") return {};
  const next = {};
  Object.entries(value).forEach(([from, mapping]) => {
    const row = sanitizeNumberMap(mapping ?? {});
    if (Object.keys(row).length === 0) return;
    next[String(from)] = row;
  });
  return next;
}

function sanitizeWordArray(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const text = String(entry.text ?? "").trim();
      if (!text) return null;
      return {
        text,
        emoji: String(entry.emoji ?? "").trim() || "🔤",
        category: String(entry.category ?? "custom").trim() || "custom",
        subBoard: String(entry.subBoard ?? "general").trim() || "general",
      };
    })
    .filter(Boolean);
}

function uniqueStrings(value = []) {
  const seen = new Set();
  const result = [];
  value.forEach((entry) => {
    const raw = String(entry ?? "").trim();
    if (!raw) return;
    const key = raw.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(raw);
  });
  return result;
}

function normalizeCacheMap(value = {}, limitPerKey = 8) {
  if (!value || typeof value !== "object") return {};
  const next = {};
  Object.entries(value).forEach(([key, raw]) => {
    const token = String(key ?? "").trim().toLowerCase();
    if (!token) return;
    if (!Array.isArray(raw)) return;
    const normalized = uniqueStrings(raw).slice(0, limitPerKey);
    if (normalized.length === 0) return;
    next[token] = normalized;
  });
  return next;
}

function buildStats({ usageCounts = {}, sentenceEvents = [], dailySentenceCounts = {}, todayKey = "" } = {}) {
  const totalTaps = Object.values(usageCounts).reduce((sum, value) => sum + Number(value ?? 0), 0);
  const uniqueWords = Object.keys(usageCounts).length;
  const progress = Number(dailySentenceCounts?.[todayKey] ?? 0);
  return {
    totalTaps: Math.max(0, Math.round(totalTaps)),
    uniqueWords: Math.max(0, Math.round(uniqueWords)),
    streak: 0,
    lastActive:
      sentenceEvents.length > 0
        ? String(sentenceEvents[sentenceEvents.length - 1]?.ts ?? "").trim() || null
        : null,
    currentProgress: Math.max(0, Math.round(progress)),
  };
}

function smartModelToStructuredModel(smartModel = {}) {
  const sentenceHistory = sanitizeStringArray(smartModel.sentenceHistory ?? [], 120);
  return {
    wordFrequency: sanitizeNumberMap(smartModel.usageCounts ?? {}),
    transitions: sanitizeTransitionMap(smartModel.transitionCounts ?? {}),
    phraseFrequency: sanitizeNumberMap(smartModel.autoSentenceLearning?.acceptedCounts ?? {}),
    intentWeights: sanitizeNumberMap(smartModel.autoSentenceLearning?.intentAcceptedCounts ?? {}),
    timePatterns: {},
    sentenceHistory,
    sentenceEvents: Array.isArray(smartModel.sentenceEvents) ? smartModel.sentenceEvents.slice(-240) : [],
    speakLatencyMsHistory: Array.isArray(smartModel.speakLatencyMsHistory)
      ? smartModel.speakLatencyMsHistory.slice(-120)
      : [],
    autoSentenceLearning: smartModel.autoSentenceLearning ?? {},
  };
}

function structuredModelToSmartModel(cloudDoc = {}) {
  const legacy = cloudDoc?.smartModel ?? {};
  const model = cloudDoc?.model ?? {};
  const phraseFrequency = sanitizeNumberMap(model.phraseFrequency ?? {});
  const sentenceHistory = sanitizeStringArray(
    model.sentenceHistory ?? legacy.sentenceHistory ?? [],
    120
  );

  return {
    usageCounts: sanitizeNumberMap(model.wordFrequency ?? legacy.usageCounts ?? {}),
    transitionCounts: sanitizeTransitionMap(model.transitions ?? legacy.transitionCounts ?? {}),
    sentenceHistory,
    sentenceEvents: Array.isArray(model.sentenceEvents)
      ? model.sentenceEvents.slice(-240)
      : Array.isArray(legacy.sentenceEvents)
        ? legacy.sentenceEvents.slice(-240)
        : [],
    speakLatencyMsHistory: Array.isArray(model.speakLatencyMsHistory)
      ? model.speakLatencyMsHistory.slice(-120)
      : Array.isArray(legacy.speakLatencyMsHistory)
        ? legacy.speakLatencyMsHistory.slice(-120)
        : [],
    autoSentenceLearning: {
      ...(legacy.autoSentenceLearning ?? {}),
      acceptedCounts: {
        ...(legacy.autoSentenceLearning?.acceptedCounts ?? {}),
        ...phraseFrequency,
      },
      intentAcceptedCounts: {
        ...(legacy.autoSentenceLearning?.intentAcceptedCounts ?? {}),
        ...sanitizeNumberMap(model.intentWeights ?? {}),
      },
    },
  };
}

function mergeCloudPreferences(cloudDoc = {}) {
  const cloudPreferences =
    cloudDoc?.preferences && typeof cloudDoc.preferences === "object" ? cloudDoc.preferences : {};
  const favorites = sanitizeStringArray(cloudDoc?.words?.favorites ?? cloudPreferences.favoriteTokens ?? [], 128).map(
    (entry) => entry.toLowerCase()
  );
  const savedPhrases = sanitizeStringArray(
    cloudDoc?.phrases?.saved ?? cloudPreferences.quickPhrases ?? [],
    32
  );
  const dailyTarget = Number(cloudDoc?.goals?.dailyTarget ?? cloudPreferences.dailySentenceGoal ?? 8);
  return {
    ...cloudPreferences,
    favoriteTokens: favorites,
    quickPhrases: savedPhrases,
    dailySentenceGoal: Number.isFinite(dailyTarget) && dailyTarget > 0 ? Math.round(dailyTarget) : 8,
  };
}

function buildStructuredChildSections({
  profileName = "Child",
  adaptiveDifficulty = "intermediate",
  dailySentenceGoal = 8,
  dailySentenceCounts = {},
  todayKey = "",
  customWords = [],
  favoriteTokens = [],
  quickPhrases = [],
  sentenceHistory = [],
  sentenceEvents = [],
  usageCounts = {},
  smartModel = {},
} = {}) {
  const safeGoal = Number.isFinite(Number(dailySentenceGoal)) && Number(dailySentenceGoal) > 0
    ? Math.round(Number(dailySentenceGoal))
    : 8;
  const stats = buildStats({
    usageCounts,
    sentenceEvents,
    dailySentenceCounts,
    todayKey,
  });

  return {
    profile: {
      name: String(profileName ?? "Child").trim() || "Child",
      level: String(adaptiveDifficulty ?? "intermediate").trim() || "intermediate",
    },
    stats: {
      totalTaps: stats.totalTaps,
      uniqueWords: stats.uniqueWords,
      streak: stats.streak,
      lastActive: stats.lastActive,
    },
    goals: {
      dailyTarget: safeGoal,
      currentProgress: stats.currentProgress,
    },
    model: smartModelToStructuredModel(smartModel),
    phrases: {
      saved: sanitizeStringArray(quickPhrases, 32),
      adaptive: sanitizeStringArray(sentenceHistory, 32),
    },
    words: {
      custom: sanitizeWordArray(customWords),
      favorites: sanitizeStringArray(favoriteTokens, 128).map((entry) => entry.toLowerCase()),
    },
  };
}

function mergeSuggestionCaches(primary = {}, secondary = {}, limitPerKey = 8) {
  const normalizedPrimary = normalizeCacheMap(primary, limitPerKey);
  const normalizedSecondary = normalizeCacheMap(secondary, limitPerKey);
  const keys = new Set([...Object.keys(normalizedPrimary), ...Object.keys(normalizedSecondary)]);
  const merged = {};

  keys.forEach((key) => {
    merged[key] = uniqueStrings([
      ...(normalizedPrimary[key] ?? []),
      ...(normalizedSecondary[key] ?? []),
    ]).slice(0, limitPerKey);
  });

  return merged;
}

function parseLocalBrainCache(raw = "") {
  if (!raw) return { childId: "", cachedSuggestions: {}, lastSync: null };
  try {
    const parsed = JSON.parse(raw);
    return {
      childId: String(parsed?.childId ?? "").trim(),
      cachedSuggestions: normalizeCacheMap(parsed?.cachedSuggestions ?? {}, 10),
      lastSync: parsed?.lastSync ? String(parsed.lastSync) : null,
    };
  } catch (_error) {
    return { childId: "", cachedSuggestions: {}, lastSync: null };
  }
}

function buildLocalBrainCache({ childId = "", cachedSuggestions = {}, lastSync = null } = {}) {
  return {
    childId: String(childId ?? "").trim(),
    cachedSuggestions: normalizeCacheMap(cachedSuggestions, 10),
    lastSync: lastSync ? String(lastSync) : new Date().toISOString(),
  };
}

export {
  buildLocalBrainCache,
  buildStructuredChildSections,
  mergeCloudPreferences,
  mergeSuggestionCaches,
  parseLocalBrainCache,
  smartModelToStructuredModel,
  structuredModelToSmartModel,
};
