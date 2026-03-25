import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ROLES } from "../constants/roles";
import { db, usingPlaceholderFirebaseConfig } from "../firebase";
import {
  applyTemplates as applyBrainTemplates,
  getConceptExpansions as getBrainConceptExpansions,
  rankCandidates as rankBrainCandidates,
} from "../lib/aacBrain";
import {
  buildLocalBrainCache,
  buildStructuredChildSections,
  mergeCloudPreferences,
  mergeSuggestionCaches,
  parseLocalBrainCache,
  structuredModelToSmartModel,
} from "../lib/childDataModel";
import {
  UI_LANGUAGE_OPTIONS,
  getTtsLanguageForCode,
  normalizeLanguageCode,
  translateText,
} from "../lib/translation";
import { trackSpeakClickedEvent } from "../lib/analyticsEvents";
import { BILLING_FEATURES, getBillingPlan } from "../lib/billingPlans";

const defaultWords = [
  { text: "I", emoji: "👤", category: "core", subBoard: "pronouns" },
  { text: "want", emoji: "🙏", category: "core", subBoard: "requests" },
  { text: "food", emoji: "🍔", category: "food", subBoard: "meals" },
  { text: "water", emoji: "💧", category: "food", subBoard: "drinks" },
  { text: "help", emoji: "🆘", category: "needs", subBoard: "support" },
  { text: "happy", emoji: "😊", category: "feelings", subBoard: "emotions" },
  { text: "sad", emoji: "😢", category: "feelings", subBoard: "emotions" },
  { text: "stop", emoji: "✋", category: "actions", subBoard: "boundaries" },
];

const DEFAULT_QUICK_PHRASES = [
  "I want water",
  "I want food",
  "I need help",
  "I feel happy",
  "I feel sad",
  "Please stop",
];

const START_WORD_BOOSTS = {
  i: 4,
  help: 2,
  water: 1,
  food: 1,
};

const CONTEXT_BOOSTS = {
  i: { want: 4, help: 2, happy: 1, sad: 1 },
  want: { food: 4, water: 4, help: 2, stop: 1 },
  feel: { happy: 3, sad: 3 },
  am: { happy: 3, sad: 3 },
  help: { stop: 2, water: 1 },
};

const PAIR_CONTEXT_BOOSTS = {
  "i want": { water: 6, food: 6, help: 3 },
  "i feel": { happy: 5, sad: 5 },
  please: { stop: 4, help: 2 },
  "need help": { now: 4, please: 2 },
};

const MAX_PHRASES = 12;
const SUGGESTION_CACHE_LIMIT = 10;
const DEFAULT_CHILD_PROFILE = { id: "child-main", name: "Child 1" };
const DEFAULT_CATEGORY = "all";
const FAVORITES_CATEGORY = "favorites";
const DEFAULT_SUB_BOARD = "all";
const DEFAULT_CUSTOM_CATEGORY = "custom";
const DEFAULT_CUSTOM_SUB_BOARD = "general";
const AUTO_SAVE_PHRASE_MIN_REPEAT = 3;
const HOLD_TO_SELECT_MS = 450;
const PHRASE_LONG_PRESS_MS = 550;
const DEFAULT_SCAN_INTERVAL_MS = 1400;
const MAX_SENTENCE_EVENTS = 220;
const TTS_PROVIDERS = {
  BROWSER: "browser",
  AZURE_NEURAL: "azure-neural",
  GOOGLE_CLOUD: "google-cloud",
  ELEVENLABS: "elevenlabs",
};
const TIME_OF_DAY_TOKEN_BOOSTS = {
  morning: {
    eat: 2.1,
    drink: 1.6,
    water: 1.4,
    school: 2.2,
    bathroom: 1.2,
  },
  afternoon: {
    play: 2.1,
    snack: 1.7,
    water: 1.3,
    help: 1.1,
    outside: 1.4,
  },
  evening: {
    eat: 2,
    dinner: 2.2,
    rest: 1.7,
    home: 1.4,
    family: 1.3,
  },
  night: {
    sleep: 2.3,
    tired: 2,
    bathroom: 1.5,
    water: 1.2,
    stop: 1.1,
  },
};
const AUTO_SENTENCE_TEMPLATES = {
  water: ["i", "want", "water"],
  juice: ["i", "want", "juice"],
  food: ["i", "want", "food"],
  help: ["i", "need", "help"],
  bathroom: ["i", "need", "bathroom"],
  rest: ["i", "need", "rest"],
  happy: ["i", "feel", "happy"],
  sad: ["i", "feel", "sad"],
  tired: ["i", "feel", "tired"],
  calm: ["i", "feel", "calm"],
};
const AUTO_SENTENCE_GENERIC_TEMPLATES = [
  "I want {word}",
  "I need {word}",
  "Can I have {word}",
];
const AUTO_SENTENCE_CATEGORY_TEMPLATE_MAP = {
  food: [
    "I want {word}",
    "Can I have {word}",
    "I need {word}",
  ],
  feelings: [
    "I feel {word}",
    "I am {word}",
  ],
  actions: [
    "I want to {word}",
    "Please {word}",
  ],
  needs: [
    "I need {word}",
    "Please help with {word}",
  ],
  social: [
    "Can we {word}",
    "I want to say {word}",
  ],
  places: [
    "I want to go to {word}",
    "Can I go to {word}",
  ],
  core: [
    "I want {word}",
    "I need {word}",
  ],
  custom: [
    "I want {word}",
    "Please {word}",
  ],
};
const AUTO_SENTENCE_SCORE_WEIGHTS = {
  frequency: 0.14,
  recency: 0.1,
  intentMatch: 0.2,
  contextMatch: 0.14,
  memoryLayers: 0.1,
  conceptMatch: 0.08,
  goalNudge: 0.08,
  sequenceProbability: 0.14,
  timeRelevance: 0.08,
  personalization: 0.12,
  fastPath: 0.08,
  explorationPenalty: 0.04,
  negativePenalty: 0.06,
};
const AUTO_SENTENCE_LAYER_BASE_WEIGHTS = {
  cache: 1.12,
  memory: 1.08,
  template: 1,
  model: 1.03,
};
const AUTO_SENTENCE_LAYER_LABELS = {
  cache: "Cache",
  memory: "Memory",
  template: "Template",
  model: "Model",
};
const AUTO_SENTENCE_REASON_LABELS = {
  precomputed: "Precomputed from this child profile",
  common_phrase: "Common phrase for this child",
  recent_usage: "Recently used",
  intent_match: "Strong intent match",
  sequence_match: "Matches learned sequence flow",
  cluster_match: "Matches active behavior cluster",
  transition_match: "Matches learned transitions",
  context_match: "Matches current sentence context",
  personalization: "Personalized for this child",
  template_match: "Built from category template",
  model_expansion: "Expanded with model transitions",
  fast_path: "Faster path from past usage",
  negative_feedback: "De-prioritized due to recent ignores",
  exploration: "Encourages vocabulary growth",
  time_context: "Matches typical time-of-day usage",
  twin_match: "Matches child digital twin behavior",
  memory_layers: "Matches short/mid/long-term memory",
  concept_match: "Semantically related to current concept",
  goal_nudge: "Aligned to therapy goal",
  urgency_match: "Matches urgent communication context",
  speed_path: "Optimized for fewer taps",
  situation_match: "Matches predicted situation context",
};
const AUTO_SENTENCE_INTENTS = {
  REQUEST: "request",
  NEED: "need",
  EMOTION: "emotion",
  ACTION: "action",
  RESPONSE: "response",
  SOCIAL: "social",
  UNKNOWN: "unknown",
};
const AUTO_SENTENCE_INTENT_KEYWORDS = {
  [AUTO_SENTENCE_INTENTS.REQUEST]: ["want", "can", "have", "more", "get", "please"],
  [AUTO_SENTENCE_INTENTS.NEED]: ["need", "help", "bathroom", "hurt", "rest", "stop"],
  [AUTO_SENTENCE_INTENTS.EMOTION]: ["feel", "am", "happy", "sad", "tired", "calm"],
  [AUTO_SENTENCE_INTENTS.ACTION]: ["go", "play", "do", "open", "close", "come"],
  [AUTO_SENTENCE_INTENTS.RESPONSE]: ["yes", "no", "okay", "ok", "done"],
  [AUTO_SENTENCE_INTENTS.SOCIAL]: ["hello", "thanks", "thank", "bye", "hi", "sorry"],
};
const AUTO_SENTENCE_INTENT_TEMPLATE_MAP = {
  [AUTO_SENTENCE_INTENTS.REQUEST]: ["I want {word}", "Can I have {word}"],
  [AUTO_SENTENCE_INTENTS.NEED]: ["I need {word}", "Please help with {word}"],
  [AUTO_SENTENCE_INTENTS.EMOTION]: ["I feel {word}", "I am {word}"],
  [AUTO_SENTENCE_INTENTS.ACTION]: ["I want to {word}", "Can we {word}"],
  [AUTO_SENTENCE_INTENTS.RESPONSE]: ["{word}", "Okay {word}"],
  [AUTO_SENTENCE_INTENTS.SOCIAL]: ["{word}", "I say {word}"],
  [AUTO_SENTENCE_INTENTS.UNKNOWN]: ["I want {word}", "I need {word}"],
};
const AUTO_SENTENCE_BEHAVIOR_CLUSTERS = {
  drinking: ["water", "juice", "drink", "thirsty", "cup", "milk"],
  food: ["food", "eat", "snack", "hungry", "breakfast", "dinner", "lunch"],
  emotion: ["happy", "sad", "tired", "calm", "angry", "excited"],
  support: ["help", "bathroom", "stop", "rest", "hurt", "break"],
  social: ["hello", "thank", "please", "friend", "play"],
};
const DIGITAL_TWIN_PATTERN_KEYS = ["i want", "i need", "i feel", "i am", "can i", "please"];
const THERAPY_GOALS = {
  BALANCED: "balanced",
  EXPAND_VOCABULARY: "expand_vocabulary",
  COMMUNICATION_SPEED: "communication_speed",
};
const CONCEPT_GRAPH = {
  water: ["drink", "thirsty", "cup", "juice", "milk"],
  juice: ["drink", "water", "cup"],
  milk: ["drink", "water", "cup"],
  tired: ["sleep", "rest", "bed"],
  sleep: ["rest", "tired", "bed"],
  hungry: ["eat", "food", "snack"],
  food: ["eat", "hungry", "snack"],
  help: ["need", "now", "please", "stop"],
  sad: ["feel", "help", "calm"],
  happy: ["feel", "play", "smile"],
  play: ["friend", "go", "outside"],
};
const SITUATION_CONTEXT_KEYWORDS = {
  drinking: ["water", "juice", "milk", "drink", "cup", "thirsty"],
  eating: ["food", "eat", "hungry", "snack", "breakfast", "lunch", "dinner"],
  fatigue: ["tired", "sleep", "rest", "bed", "calm"],
  support: ["help", "bathroom", "stop", "hurt", "break"],
  social: ["hello", "friend", "thank", "please", "play"],
};
const AUTO_SENTENCE_EXPLORATION_RATE = 0.13;
const AUTO_SENTENCE_HIGH_CONFIDENCE_THRESHOLD = 0.95;
const AUTO_SENTENCE_DAILY_DECAY = 0.97;
const AUTO_SENTENCE_SUGGESTION_LIMIT = 5;
const AUTO_SENTENCE_LONG_PRESS_MS = 550;
const AUTO_SENTENCE_SELECTION_MODES = {
  REPLACE: "replace",
  APPEND: "append",
};
const AUTO_SENTENCE_ENVIRONMENTS = {
  HOME: "home",
  SCHOOL: "school",
  CLINIC: "clinic",
  COMMUNITY: "community",
};
const AUTO_SENTENCE_ENVIRONMENT_BOOSTS = {
  home: {
    water: 1.2,
    food: 1.3,
    rest: 1.4,
    family: 1.3,
    bathroom: 1.2,
  },
  school: {
    help: 1.5,
    play: 1.2,
    friend: 1.3,
    stop: 1.1,
    water: 1.1,
  },
  clinic: {
    help: 1.6,
    hurt: 1.6,
    rest: 1.4,
    bathroom: 1.3,
    calm: 1.2,
  },
  community: {
    hello: 1.3,
    thank: 1.3,
    help: 1.2,
    water: 1.1,
    stop: 1.1,
  },
};
const DIFFICULTY_LEVELS = {
  BEGINNER: "beginner",
  INTERMEDIATE: "intermediate",
  ADVANCED: "advanced",
};
const CONTEXT_CATEGORY_BOOSTS = {
  want: { food: 2.2, needs: 1.4, actions: 0.9 },
  need: { needs: 2.5, food: 0.9 },
  feel: { feelings: 2.7 },
  go: { places: 2.3, actions: 1.2 },
};
const CATEGORY_TAB_ORDER = [
  { id: "core", label: "Core" },
  { id: "needs", label: "Needs" },
  { id: "food", label: "Food" },
  { id: "feelings", label: "Feelings" },
  { id: "actions", label: "Actions" },
  { id: "social", label: "Social" },
  { id: "places", label: "Places" },
  { id: "custom", label: "Custom" },
];
const CATEGORY_LABEL_LOOKUP = CATEGORY_TAB_ORDER.reduce((lookup, item) => {
  lookup[item.id] = item.label;
  return lookup;
}, {});
const CHILD_CATEGORY_LABELS = {
  [DEFAULT_CATEGORY]: "All",
  [FAVORITES_CATEGORY]: "⭐ Favorites",
  food: "🍔 Food",
  actions: "⚡ Actions",
  feelings: "🙂 Feelings",
  needs: "🧩 Needs",
  social: "💬 Social",
  places: "📍 Places",
  core: "🧠 Core",
  custom: "🛠️ Custom",
};
const CATEGORY_ACCENT_COLORS = {
  core: "rgba(101, 173, 255, 0.82)",
  needs: "rgba(63, 219, 179, 0.82)",
  food: "rgba(255, 176, 93, 0.84)",
  feelings: "rgba(241, 123, 197, 0.84)",
  actions: "rgba(160, 148, 255, 0.84)",
  social: "rgba(117, 233, 255, 0.82)",
  places: "rgba(159, 223, 113, 0.82)",
  custom: "rgba(178, 193, 214, 0.74)",
  default: "rgba(141, 183, 226, 0.5)",
};
const INSTANT_INTENT_MAP = {
  i: {
    targets: ["want", "need", "feel"],
    reason: "Complete the intent after \"I\"",
  },
  "i want": {
    targets: ["water", "food", "help", "juice"],
    reason: "Common requests after \"I want\"",
  },
  "i need": {
    targets: ["help", "water", "bathroom", "rest"],
    reason: "Common support needs",
  },
  "i feel": {
    targets: ["happy", "sad", "tired", "calm"],
    reason: "Common feeling continuations",
  },
};
const INTENT_WORD_HINTS = {
  want: { emoji: "🙏", category: "core", subBoard: "requests" },
  need: { emoji: "🧩", category: "needs", subBoard: "support" },
  feel: { emoji: "🙂", category: "feelings", subBoard: "emotions" },
  water: { emoji: "💧", category: "food", subBoard: "drinks" },
  food: { emoji: "🍔", category: "food", subBoard: "meals" },
  help: { emoji: "🆘", category: "needs", subBoard: "support" },
  juice: { emoji: "🥤", category: "food", subBoard: "drinks" },
  bathroom: { emoji: "🚻", category: "needs", subBoard: "support" },
  rest: { emoji: "🛏️", category: "needs", subBoard: "support" },
  happy: { emoji: "😊", category: "feelings", subBoard: "emotions" },
  sad: { emoji: "😢", category: "feelings", subBoard: "emotions" },
  tired: { emoji: "🥱", category: "feelings", subBoard: "states" },
  calm: { emoji: "😌", category: "feelings", subBoard: "states" },
};

const STARTER_VOCAB_SETS = [
  {
    id: "daily-needs",
    label: "Daily Needs",
    words: [
      { text: "eat", emoji: "🍽️", category: "food", subBoard: "meals" },
      { text: "drink", emoji: "🥤", category: "food", subBoard: "drinks" },
      { text: "bathroom", emoji: "🚻", category: "needs", subBoard: "support" },
      { text: "rest", emoji: "🛏️", category: "needs", subBoard: "support" },
      { text: "yes", emoji: "✅", category: "core", subBoard: "responses" },
      { text: "no", emoji: "❌", category: "core", subBoard: "responses" },
    ],
  },
  {
    id: "feelings-plus",
    label: "Feelings+",
    words: [
      { text: "scared", emoji: "😨", category: "feelings", subBoard: "emotions" },
      { text: "tired", emoji: "🥱", category: "feelings", subBoard: "states" },
      { text: "excited", emoji: "🤩", category: "feelings", subBoard: "emotions" },
      { text: "calm", emoji: "😌", category: "feelings", subBoard: "states" },
      { text: "frustrated", emoji: "😤", category: "feelings", subBoard: "emotions" },
    ],
  },
  {
    id: "social-starter",
    label: "Social Starter",
    words: [
      { text: "hello", emoji: "👋", category: "social", subBoard: "greetings" },
      { text: "thank you", emoji: "🙏", category: "social", subBoard: "manners" },
      { text: "please", emoji: "✨", category: "social", subBoard: "manners" },
      { text: "play", emoji: "🧩", category: "actions", subBoard: "activities" },
      { text: "friend", emoji: "🧑‍🤝‍🧑", category: "social", subBoard: "people" },
    ],
  },
];

function makeChildId() {
  return `child-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function mergeUniqueStrings(primary = [], secondary = [], limit = 100) {
  const seen = new Set();
  const merged = [];

  [...primary, ...secondary].forEach((entry) => {
    const value = String(entry ?? "").trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(value);
  });

  return merged.slice(0, limit);
}

function mergeNumberMapMax(localMap = {}, cloudMap = {}) {
  const merged = {};
  const keys = new Set([...Object.keys(localMap), ...Object.keys(cloudMap)]);

  keys.forEach((key) => {
    const localValue = Number(localMap[key] ?? 0);
    const cloudValue = Number(cloudMap[key] ?? 0);
    merged[key] = Math.max(localValue, cloudValue);
  });

  return merged;
}

function mergeNumberMapMin(localMap = {}, cloudMap = {}) {
  const merged = {};
  const keys = new Set([...Object.keys(localMap), ...Object.keys(cloudMap)]);

  keys.forEach((key) => {
    const localValue = Number(localMap[key] ?? 0);
    const cloudValue = Number(cloudMap[key] ?? 0);
    if (localValue > 0 && cloudValue > 0) {
      merged[key] = Math.min(localValue, cloudValue);
      return;
    }
    merged[key] = Math.max(localValue, cloudValue);
  });

  return merged;
}

function mergeTransitionMapMax(localMap = {}, cloudMap = {}) {
  const merged = {};
  const outerKeys = new Set([...Object.keys(localMap), ...Object.keys(cloudMap)]);

  outerKeys.forEach((fromToken) => {
    merged[fromToken] = mergeNumberMapMax(localMap[fromToken] ?? {}, cloudMap[fromToken] ?? {});
  });

  return merged;
}

function mergeLatencyHistory(localValues = [], cloudValues = [], limit = 80) {
  return [...(localValues ?? []), ...(cloudValues ?? [])]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .slice(-limit);
}

function sanitizeNumericMap(value = {}) {
  if (!value || typeof value !== "object") return {};
  const next = {};
  Object.entries(value).forEach(([key, rawValue]) => {
    const parsed = Number(rawValue ?? 0);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    next[String(key)] = parsed;
  });
  return next;
}

function createDefaultAutoSentenceLearning() {
  return {
    shownCounts: {},
    acceptedCounts: {},
    ignoredCounts: {},
    sentenceTapCountAvg: {},
    sentenceTapCountSamples: {},
    dailyShownCounts: {},
    dailyAcceptedCounts: {},
    dailyIgnoredCounts: {},
    sentenceSpeedMs: {},
    sentenceSpeedSamples: {},
    intentShownCounts: {},
    intentAcceptedCounts: {},
    layerShownCounts: {
      cache: 0,
      memory: 0,
      template: 0,
      model: 0,
    },
    layerAcceptedCounts: {
      cache: 0,
      memory: 0,
      template: 0,
      model: 0,
    },
    lastDecayDate: getTodayKey(),
  };
}

function normalizeAutoSentenceLearning(value = {}) {
  const fallback = createDefaultAutoSentenceLearning();

  return {
    shownCounts: sanitizeNumericMap(value.shownCounts ?? {}),
    acceptedCounts: sanitizeNumericMap(value.acceptedCounts ?? {}),
    ignoredCounts: sanitizeNumericMap(value.ignoredCounts ?? {}),
    sentenceTapCountAvg: sanitizeNumericMap(value.sentenceTapCountAvg ?? {}),
    sentenceTapCountSamples: sanitizeNumericMap(value.sentenceTapCountSamples ?? {}),
    dailyShownCounts: sanitizeNumericMap(value.dailyShownCounts ?? {}),
    dailyAcceptedCounts: sanitizeNumericMap(value.dailyAcceptedCounts ?? {}),
    dailyIgnoredCounts: sanitizeNumericMap(value.dailyIgnoredCounts ?? {}),
    sentenceSpeedMs: sanitizeNumericMap(value.sentenceSpeedMs ?? {}),
    sentenceSpeedSamples: sanitizeNumericMap(value.sentenceSpeedSamples ?? {}),
    intentShownCounts: sanitizeNumericMap(value.intentShownCounts ?? {}),
    intentAcceptedCounts: sanitizeNumericMap(value.intentAcceptedCounts ?? {}),
    layerShownCounts: {
      cache: Number(value?.layerShownCounts?.cache ?? fallback.layerShownCounts.cache) || 0,
      memory: Number(value?.layerShownCounts?.memory ?? fallback.layerShownCounts.memory) || 0,
      template: Number(value?.layerShownCounts?.template ?? fallback.layerShownCounts.template) || 0,
      model: Number(value?.layerShownCounts?.model ?? fallback.layerShownCounts.model) || 0,
    },
    layerAcceptedCounts: {
      cache: Number(value?.layerAcceptedCounts?.cache ?? fallback.layerAcceptedCounts.cache) || 0,
      memory: Number(value?.layerAcceptedCounts?.memory ?? fallback.layerAcceptedCounts.memory) || 0,
      template: Number(value?.layerAcceptedCounts?.template ?? fallback.layerAcceptedCounts.template) || 0,
      model: Number(value?.layerAcceptedCounts?.model ?? fallback.layerAcceptedCounts.model) || 0,
    },
    lastDecayDate:
      String(value?.lastDecayDate ?? "").trim() || String(fallback.lastDecayDate),
  };
}

function applyDailyDecayToAutoSentenceLearning(value = {}, nowDate = new Date()) {
  const normalized = normalizeAutoSentenceLearning(value);
  const todayKey = getTodayKey();
  if (normalized.lastDecayDate === todayKey) return normalized;

  const last = new Date(`${normalized.lastDecayDate}T00:00:00`);
  const now = new Date(nowDate);
  const rawDays = Math.floor((now.getTime() - last.getTime()) / (24 * 60 * 60 * 1000));
  const days = Math.max(1, Math.min(30, Number.isFinite(rawDays) ? rawDays : 1));
  const decayFactor = Math.pow(AUTO_SENTENCE_DAILY_DECAY, days);

  const decayMap = (map = {}) => {
    const next = {};
    Object.entries(map).forEach(([key, raw]) => {
      const value = Number(raw ?? 0) * decayFactor;
      if (value < 0.04) return;
      next[key] = value;
    });
    return next;
  };

  return {
    ...normalized,
    shownCounts: decayMap(normalized.shownCounts),
    acceptedCounts: decayMap(normalized.acceptedCounts),
    ignoredCounts: decayMap(normalized.ignoredCounts),
    sentenceTapCountAvg: normalized.sentenceTapCountAvg,
    sentenceTapCountSamples: decayMap(normalized.sentenceTapCountSamples),
    dailyShownCounts: normalized.dailyShownCounts,
    dailyAcceptedCounts: normalized.dailyAcceptedCounts,
    dailyIgnoredCounts: normalized.dailyIgnoredCounts,
    sentenceSpeedSamples: decayMap(normalized.sentenceSpeedSamples),
    intentShownCounts: decayMap(normalized.intentShownCounts),
    intentAcceptedCounts: decayMap(normalized.intentAcceptedCounts),
    layerShownCounts: decayMap(normalized.layerShownCounts),
    layerAcceptedCounts: decayMap(normalized.layerAcceptedCounts),
    lastDecayDate: todayKey,
  };
}

function mergeAutoSentenceLearning(localLearning = {}, cloudLearning = {}) {
  const local = applyDailyDecayToAutoSentenceLearning(localLearning);
  const cloud = applyDailyDecayToAutoSentenceLearning(cloudLearning);

  return {
    shownCounts: mergeNumberMapMax(local.shownCounts ?? {}, cloud.shownCounts ?? {}),
    acceptedCounts: mergeNumberMapMax(local.acceptedCounts ?? {}, cloud.acceptedCounts ?? {}),
    ignoredCounts: mergeNumberMapMax(local.ignoredCounts ?? {}, cloud.ignoredCounts ?? {}),
    sentenceTapCountAvg: mergeNumberMapMin(local.sentenceTapCountAvg ?? {}, cloud.sentenceTapCountAvg ?? {}),
    sentenceTapCountSamples: mergeNumberMapMax(
      local.sentenceTapCountSamples ?? {},
      cloud.sentenceTapCountSamples ?? {}
    ),
    dailyShownCounts: mergeNumberMapMax(local.dailyShownCounts ?? {}, cloud.dailyShownCounts ?? {}),
    dailyAcceptedCounts: mergeNumberMapMax(
      local.dailyAcceptedCounts ?? {},
      cloud.dailyAcceptedCounts ?? {}
    ),
    dailyIgnoredCounts: mergeNumberMapMax(local.dailyIgnoredCounts ?? {}, cloud.dailyIgnoredCounts ?? {}),
    sentenceSpeedMs: mergeNumberMapMin(local.sentenceSpeedMs ?? {}, cloud.sentenceSpeedMs ?? {}),
    sentenceSpeedSamples: mergeNumberMapMax(
      local.sentenceSpeedSamples ?? {},
      cloud.sentenceSpeedSamples ?? {}
    ),
    intentShownCounts: mergeNumberMapMax(local.intentShownCounts ?? {}, cloud.intentShownCounts ?? {}),
    intentAcceptedCounts: mergeNumberMapMax(
      local.intentAcceptedCounts ?? {},
      cloud.intentAcceptedCounts ?? {}
    ),
    layerShownCounts: mergeNumberMapMax(local.layerShownCounts ?? {}, cloud.layerShownCounts ?? {}),
    layerAcceptedCounts: mergeNumberMapMax(
      local.layerAcceptedCounts ?? {},
      cloud.layerAcceptedCounts ?? {}
    ),
    lastDecayDate: getTodayKey(),
  };
}

function sumNumericMap(values = {}) {
  return Object.values(values ?? {}).reduce((sum, value) => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? sum + parsed : sum;
  }, 0);
}

function getAutoSentenceImpactSummary(learning = {}) {
  const normalized = normalizeAutoSentenceLearning(learning);
  const shownByLayer = sumNumericMap(normalized.layerShownCounts);
  const shownByPhrase = sumNumericMap(normalized.shownCounts);
  const acceptedTotal = sumNumericMap(normalized.layerAcceptedCounts);
  const ignoredTotal = sumNumericMap(normalized.ignoredCounts);
  const shownTotal = Math.max(shownByLayer, shownByPhrase);

  const acceptanceRate = shownTotal > 0 ? clamp01(acceptedTotal / shownTotal) : 0;
  const ignoreRate = shownByPhrase > 0 ? clamp01(ignoredTotal / shownByPhrase) : 0;

  const acceptedPhraseEntries = Object.entries(normalized.acceptedCounts ?? {})
    .map(([phrase, count]) => ({
      phrase,
      count: Number(count ?? 0),
      tokenLength: tokenizeText(phrase).length,
    }))
    .filter((entry) => entry.count >= 1 && entry.tokenLength > 0);

  const weightedPhraseTotal = acceptedPhraseEntries.reduce((sum, entry) => sum + entry.count, 0);
  const weightedTokenTotal = acceptedPhraseEntries.reduce(
    (sum, entry) => sum + entry.count * entry.tokenLength,
    0
  );
  const avgTokenLength = weightedPhraseTotal > 0 ? weightedTokenTotal / weightedPhraseTotal : 3;
  const averageTapsSavedPerAccept = Math.max(0.9, avgTokenLength - 1);
  const tapsSavedEstimate = Math.round(acceptedTotal * averageTapsSavedPerAccept);

  const layerMetrics = Object.keys(AUTO_SENTENCE_LAYER_BASE_WEIGHTS).map((layerKey) => {
    const shown = Number(normalized.layerShownCounts[layerKey] ?? 0);
    const accepted = Number(normalized.layerAcceptedCounts[layerKey] ?? 0);
    const rate = shown > 0 ? clamp01(accepted / shown) : 0;

    return {
      key: layerKey,
      label: AUTO_SENTENCE_LAYER_LABELS[layerKey] ?? layerKey,
      shown,
      accepted,
      rate,
    };
  });

  const bestLayer = [...layerMetrics]
    .filter((entry) => entry.shown >= 3)
    .sort((a, b) => b.rate - a.rate || b.accepted - a.accepted)[0] ?? null;

  return {
    shownTotal,
    acceptedTotal,
    ignoredTotal,
    acceptanceRate,
    ignoreRate,
    averageTapsSavedPerAccept,
    tapsSavedEstimate,
    layers: layerMetrics,
    bestLayer,
  };
}

function getRecentAutoSentenceRateSeries(learning = {}, days = 14) {
  const normalized = normalizeAutoSentenceLearning(learning);
  const totalDays = Math.max(1, Math.min(30, Number(days ?? 14)));
  const series = [];

  for (let offset = totalDays - 1; offset >= 0; offset -= 1) {
    const key = getDateKeyOffset(offset);
    const shown = Number(normalized.dailyShownCounts[key] ?? 0);
    const accepted = Number(normalized.dailyAcceptedCounts[key] ?? 0);
    const ignored = Number(normalized.dailyIgnoredCounts[key] ?? 0);
    const acceptRate = shown > 0 ? clamp01(accepted / shown) : 0;
    const ignoreRate = shown > 0 ? clamp01(ignored / shown) : 0;
    const [, month = "0", day = "0"] = key.split("-");

    series.push({
      key,
      label: `${Number(month)}/${Number(day)}`,
      shown,
      accepted,
      ignored,
      acceptRate,
      ignoreRate,
    });
  }

  return series;
}

function mergeProfiles(localProfiles = [], cloudProfiles = []) {
  const localById = new Map(localProfiles.map((profile) => [profile.id, profile]));
  const cloudById = new Map(cloudProfiles.map((profile) => [profile.id, profile]));
  const orderedIds = [...new Set([...localProfiles.map((p) => p.id), ...cloudProfiles.map((p) => p.id)])];

  return orderedIds
    .map((id) => {
      const local = localById.get(id);
      const cloud = cloudById.get(id);
      if (!local && !cloud) return null;
      return {
        id,
        name: local?.name?.trim() || cloud?.name?.trim() || "Child",
      };
    })
    .filter(Boolean);
}

function mergeSmartModel(localModel = {}, cloudModel = {}) {
  return {
    usageCounts: mergeNumberMapMax(localModel.usageCounts ?? {}, cloudModel.usageCounts ?? {}),
    transitionCounts: mergeTransitionMapMax(
      localModel.transitionCounts ?? {},
      cloudModel.transitionCounts ?? {}
    ),
    sentenceHistory: mergeUniqueStrings(
      (localModel.sentenceHistory ?? []).slice().reverse(),
      (cloudModel.sentenceHistory ?? []).slice().reverse(),
      50
    ).reverse(),
    sentenceEvents: mergeSentenceEvents(
      localModel.sentenceEvents ?? [],
      cloudModel.sentenceEvents ?? [],
      localModel.sentenceHistory ?? [],
      cloudModel.sentenceHistory ?? [],
      MAX_SENTENCE_EVENTS
    ),
    speakLatencyMsHistory: mergeLatencyHistory(
      localModel.speakLatencyMsHistory ?? [],
      cloudModel.speakLatencyMsHistory ?? []
    ),
    autoSentenceLearning: mergeAutoSentenceLearning(
      localModel.autoSentenceLearning ?? {},
      cloudModel.autoSentenceLearning ?? {}
    ),
  };
}

function mergePreferences(localPrefs = {}, cloudPrefs = {}) {
  return {
    favoriteTokens: mergeUniqueStrings(localPrefs.favoriteTokens ?? [], cloudPrefs.favoriteTokens ?? [], 64).map(
      (token) => token.toLowerCase()
    ),
    quickPhrases: mergeUniqueStrings(
      localPrefs.quickPhrases ?? [],
      cloudPrefs.quickPhrases ?? [],
      MAX_PHRASES
    ),
    autoSpeak: Boolean(localPrefs.autoSpeak ?? cloudPrefs.autoSpeak ?? false),
    dailySentenceGoal:
      Number.isInteger(localPrefs.dailySentenceGoal) && localPrefs.dailySentenceGoal > 0
        ? localPrefs.dailySentenceGoal
        : Number.isInteger(cloudPrefs.dailySentenceGoal) && cloudPrefs.dailySentenceGoal > 0
          ? cloudPrefs.dailySentenceGoal
          : 8,
    dailySentenceCounts: mergeNumberMapMax(
      localPrefs.dailySentenceCounts ?? {},
      cloudPrefs.dailySentenceCounts ?? {}
    ),
    activeCategory:
      normalizeBoardKey(localPrefs.activeCategory, "") ||
      normalizeBoardKey(cloudPrefs.activeCategory, "") ||
      DEFAULT_CATEGORY,
    activeSubBoard:
      normalizeBoardKey(localPrefs.activeSubBoard, "") ||
      normalizeBoardKey(cloudPrefs.activeSubBoard, "") ||
      DEFAULT_SUB_BOARD,
    largeTileMode: Boolean(localPrefs.largeTileMode ?? cloudPrefs.largeTileMode ?? false),
    scanMode: Boolean(localPrefs.scanMode ?? cloudPrefs.scanMode ?? false),
    holdToSelect: Boolean(localPrefs.holdToSelect ?? cloudPrefs.holdToSelect ?? false),
    scanIntervalMs: Math.max(
      600,
      Math.min(
        3500,
        Number(localPrefs.scanIntervalMs ?? cloudPrefs.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS)
      )
    ),
    selectedVoiceURI: String(localPrefs.selectedVoiceURI ?? cloudPrefs.selectedVoiceURI ?? ""),
    speechLanguage: normalizeLanguageCode(localPrefs.speechLanguage ?? cloudPrefs.speechLanguage ?? "en"),
    speechRate: Math.max(0.6, Math.min(1.6, Number(localPrefs.speechRate ?? cloudPrefs.speechRate ?? 0.9))),
    speechPitch: Math.max(0.6, Math.min(1.6, Number(localPrefs.speechPitch ?? cloudPrefs.speechPitch ?? 1))),
    speechVolume: Math.max(0, Math.min(1, Number(localPrefs.speechVolume ?? cloudPrefs.speechVolume ?? 1))),
    dualLanguageMode: Boolean(localPrefs.dualLanguageMode ?? cloudPrefs.dualLanguageMode ?? false),
    autoDetectVoice: Boolean(localPrefs.autoDetectVoice ?? cloudPrefs.autoDetectVoice ?? true),
    ttsProvider: Object.values(TTS_PROVIDERS).includes(String(localPrefs.ttsProvider ?? cloudPrefs.ttsProvider))
      ? String(localPrefs.ttsProvider ?? cloudPrefs.ttsProvider)
      : TTS_PROVIDERS.BROWSER,
    onboardingCompleted: Boolean(localPrefs.onboardingCompleted ?? cloudPrefs.onboardingCompleted ?? false),
    workspaceMode:
      String(localPrefs.workspaceMode ?? cloudPrefs.workspaceMode ?? "child").toLowerCase() === "parent"
        ? "parent"
        : "child",
    tapSoundEnabled: Boolean(localPrefs.tapSoundEnabled ?? cloudPrefs.tapSoundEnabled ?? false),
    tapFlashEnabled: Boolean(localPrefs.tapFlashEnabled ?? cloudPrefs.tapFlashEnabled ?? true),
    pinnedPhraseTokens: mergeUniqueStrings(
      localPrefs.pinnedPhraseTokens ?? [],
      cloudPrefs.pinnedPhraseTokens ?? [],
      MAX_PHRASES
    ).map((token) => token.toLowerCase()),
    phraseUsageCounts: mergeNumberMapMax(
      localPrefs.phraseUsageCounts ?? {},
      cloudPrefs.phraseUsageCounts ?? {}
    ),
    recentPhraseUsage: mergeUniqueStrings(
      localPrefs.recentPhraseUsage ?? [],
      cloudPrefs.recentPhraseUsage ?? [],
      MAX_PHRASES
    ).map((token) => token.toLowerCase()),
    progressiveDisclosureEnabled: Boolean(
      localPrefs.progressiveDisclosureEnabled ?? cloudPrefs.progressiveDisclosureEnabled ?? true
    ),
    topWordsMode: Boolean(localPrefs.topWordsMode ?? cloudPrefs.topWordsMode ?? false),
    smartHidingEnabled: Boolean(localPrefs.smartHidingEnabled ?? cloudPrefs.smartHidingEnabled ?? true),
    adaptiveDifficulty:
      String(localPrefs.adaptiveDifficulty ?? cloudPrefs.adaptiveDifficulty ?? DIFFICULTY_LEVELS.INTERMEDIATE)
        .toLowerCase() === DIFFICULTY_LEVELS.BEGINNER
        ? DIFFICULTY_LEVELS.BEGINNER
        : String(localPrefs.adaptiveDifficulty ?? cloudPrefs.adaptiveDifficulty ?? DIFFICULTY_LEVELS.INTERMEDIATE)
            .toLowerCase() === DIFFICULTY_LEVELS.ADVANCED
          ? DIFFICULTY_LEVELS.ADVANCED
          : DIFFICULTY_LEVELS.INTERMEDIATE,
    therapyGoal:
      String(localPrefs.therapyGoal ?? cloudPrefs.therapyGoal ?? THERAPY_GOALS.BALANCED).toLowerCase() ===
      THERAPY_GOALS.EXPAND_VOCABULARY
        ? THERAPY_GOALS.EXPAND_VOCABULARY
        : String(localPrefs.therapyGoal ?? cloudPrefs.therapyGoal ?? THERAPY_GOALS.BALANCED).toLowerCase() ===
            THERAPY_GOALS.COMMUNICATION_SPEED
          ? THERAPY_GOALS.COMMUNICATION_SPEED
          : THERAPY_GOALS.BALANCED,
    autoSentenceMode: Boolean(localPrefs.autoSentenceMode ?? cloudPrefs.autoSentenceMode ?? true),
    autoSentenceSelectionMode:
      String(
        localPrefs.autoSentenceSelectionMode ??
          cloudPrefs.autoSentenceSelectionMode ??
          AUTO_SENTENCE_SELECTION_MODES.REPLACE
      ).toLowerCase() === AUTO_SENTENCE_SELECTION_MODES.APPEND
        ? AUTO_SENTENCE_SELECTION_MODES.APPEND
        : AUTO_SENTENCE_SELECTION_MODES.REPLACE,
    environmentContext:
      String(
        localPrefs.environmentContext ??
          cloudPrefs.environmentContext ??
          AUTO_SENTENCE_ENVIRONMENTS.HOME
      ).toLowerCase() === AUTO_SENTENCE_ENVIRONMENTS.SCHOOL
        ? AUTO_SENTENCE_ENVIRONMENTS.SCHOOL
        : String(
              localPrefs.environmentContext ??
                cloudPrefs.environmentContext ??
                AUTO_SENTENCE_ENVIRONMENTS.HOME
            ).toLowerCase() === AUTO_SENTENCE_ENVIRONMENTS.CLINIC
          ? AUTO_SENTENCE_ENVIRONMENTS.CLINIC
          : String(
                localPrefs.environmentContext ??
                  cloudPrefs.environmentContext ??
                  AUTO_SENTENCE_ENVIRONMENTS.HOME
              ).toLowerCase() === AUTO_SENTENCE_ENVIRONMENTS.COMMUNITY
            ? AUTO_SENTENCE_ENVIRONMENTS.COMMUNITY
            : AUTO_SENTENCE_ENVIRONMENTS.HOME,
  };
}

function normalizeToken(text) {
  return String(text ?? "").trim().toLowerCase();
}

function normalizeBoardKey(value, fallback = "") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function formatBoardLabel(key, fallback = "") {
  const normalized = normalizeBoardKey(key, "");
  if (!normalized) return fallback;
  if (CATEGORY_LABEL_LOOKUP[normalized]) return CATEGORY_LABEL_LOOKUP[normalized];

  return normalized
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getChildCategoryLabel(id) {
  const normalized = normalizeBoardKey(id, "");
  return CHILD_CATEGORY_LABELS[normalized] ?? formatBoardLabel(normalized, "Category");
}

function normalizeWordRecord(word, fallbackCategory = DEFAULT_CUSTOM_CATEGORY, fallbackSubBoard = DEFAULT_CUSTOM_SUB_BOARD) {
  const text = String(word?.text ?? "").trim();
  if (!text) return null;

  const emoji = String(word?.emoji ?? "").trim() || "🔤";
  const category = normalizeBoardKey(word?.category, fallbackCategory);
  const subBoard = normalizeBoardKey(word?.subBoard, fallbackSubBoard);

  return {
    text,
    emoji,
    category,
    subBoard,
  };
}

function mergeWordLists(primary = [], secondary = []) {
  const merged = [];
  const seen = new Set();

  [...primary, ...secondary].forEach((rawWord) => {
    const word = normalizeWordRecord(rawWord);
    if (!word) return;

    const key = `${normalizeToken(word.text)}::${word.category}::${word.subBoard}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(word);
  });

  return merged;
}

function getTodayKey() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function findBestVoiceForLang(voices = [], langCode = "en", voiceURI = "", autoDetect = true) {
  const normalizedLang = normalizeLanguageCode(langCode);
  const preferredVoiceURI = String(voiceURI ?? "").trim();
  const safeVoices = Array.isArray(voices) ? voices : [];
  const normalizedPrefix = `${normalizedLang}-`;

  if (!autoDetect && preferredVoiceURI) {
    const explicit = safeVoices.find((entry) => entry.voiceURI === preferredVoiceURI);
    if (explicit) return explicit;
  }

  const exactPrimary = safeVoices.find(
    (entry) => normalizeLanguageCode(entry.lang) === normalizedLang
  );
  if (exactPrimary) return exactPrimary;

  const prefixMatch = safeVoices.find((entry) =>
    String(entry.lang ?? "").toLowerCase().startsWith(normalizedPrefix)
  );
  if (prefixMatch) return prefixMatch;

  const includeMatch = safeVoices.find((entry) =>
    String(entry.lang ?? "").toLowerCase().includes(normalizedLang)
  );
  if (includeMatch) return includeMatch;

  if (preferredVoiceURI) {
    const explicit = safeVoices.find((entry) => entry.voiceURI === preferredVoiceURI);
    if (explicit) return explicit;
  }

  return safeVoices[0] ?? null;
}

async function speak(text, options = {}) {
  if (!text?.trim()) return;
  if (typeof window === "undefined" || !window?.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
    return;
  }

  const sourceText = String(text ?? "").trim();
  const langCode = normalizeLanguageCode(options.lang ?? "en");
  const ttsLang = getTtsLanguageForCode(langCode);
  const translatedText =
    options.translate === false || langCode === "en"
      ? sourceText
      : await translateText(sourceText, langCode, { sourceLang: "en" });
  const dualLanguageMode = Boolean(options.dualLanguageMode) && langCode !== "en";
  const autoDetectVoice = options.autoDetectVoice !== false;
  const ttsProvider = String(options.ttsProvider ?? TTS_PROVIDERS.BROWSER);
  if (ttsProvider !== TTS_PROVIDERS.BROWSER) {
    console.info(`TTS provider "${ttsProvider}" selected; browser voice fallback is being used.`);
  }
  const tone = String(options.tone ?? "").toLowerCase();
  const baseRate = Math.max(0.6, Math.min(1.6, Number(options.rate ?? 0.9)));
  const basePitch = Math.max(0.6, Math.min(1.6, Number(options.pitch ?? 1)));
  const baseVolume = Math.max(0, Math.min(1, Number(options.volume ?? 1)));
  const toneRateOffsets = {
    happy: 0.08,
    calm: -0.05,
    emergency: 0.14,
  };
  const tonePitchOffsets = {
    happy: 0.1,
    calm: -0.07,
    emergency: 0.18,
  };
  const availableVoices = window.speechSynthesis.getVoices();

  const queueUtterance = (utteranceText, utteranceLang, utteranceTone = tone) => {
    const utterance = new SpeechSynthesisUtterance(utteranceText);
    utterance.lang = utteranceLang;
    utterance.rate = Math.max(0.6, Math.min(1.8, baseRate + (toneRateOffsets[utteranceTone] ?? 0)));
    utterance.pitch = Math.max(0.6, Math.min(1.8, basePitch + (tonePitchOffsets[utteranceTone] ?? 0)));
    utterance.volume = baseVolume;

    const voice = findBestVoiceForLang(
      availableVoices,
      normalizeLanguageCode(utteranceLang),
      options.voiceURI,
      autoDetectVoice
    );
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  };

  if (dualLanguageMode) {
    queueUtterance(sourceText, "en-US", "");
    queueUtterance(translatedText, ttsLang, tone);
    return;
  }

  queueUtterance(translatedText, ttsLang, tone);
}

function getEmotionalTone(text) {
  const tokens = tokenizeText(text);
  if (tokens.some((token) => ["happy", "excited", "yay", "great"].includes(token))) {
    return { tone: "happy", emoji: "😊" };
  }
  if (tokens.some((token) => ["help", "emergency", "urgent", "stop"].includes(token))) {
    return { tone: "emergency", emoji: "🚨" };
  }
  if (tokens.some((token) => ["calm", "rest", "tired", "sleep"].includes(token))) {
    return { tone: "calm", emoji: "😌" };
  }
  return { tone: "", emoji: "💬" };
}

function tokenizeText(text) {
  return String(text ?? "")
    .split(/\s+/)
    .map((token) => normalizeToken(token))
    .filter(Boolean);
}

function getTimeOfDayLabel(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

function normalizeSentenceEvents(events = []) {
  if (!Array.isArray(events)) return [];
  return events
    .map((entry) => {
      if (typeof entry === "string") {
        const text = entry.trim();
        if (!text) return null;
        return { text, ts: null };
      }

      if (!entry || typeof entry !== "object") return null;
      const text = String(entry.text ?? "").trim();
      if (!text) return null;

      const parsed = entry.ts ? new Date(entry.ts) : null;
      const ts =
        parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;

      return { text, ts };
    })
    .filter(Boolean);
}

function mergeSentenceEvents(
  localEvents = [],
  cloudEvents = [],
  localHistory = [],
  cloudHistory = [],
  limit = MAX_SENTENCE_EVENTS
) {
  const normalizedEvents = [
    ...normalizeSentenceEvents(localEvents),
    ...normalizeSentenceEvents(cloudEvents),
  ];
  const merged = [];
  const seen = new Set();

  normalizedEvents.forEach((event) => {
    const key = `${normalizeToken(event.text)}::${event.ts ?? ""}`;
    if (event.ts && seen.has(key)) return;
    if (event.ts) seen.add(key);
    merged.push(event);
  });

  if (merged.length === 0) {
    const fallbackHistory = [...(localHistory ?? []), ...(cloudHistory ?? [])];
    fallbackHistory.forEach((entry) => {
      const text = String(entry ?? "").trim();
      if (!text) return;
      merged.push({ text, ts: null });
    });
  }

  return merged.slice(-limit);
}

function incrementCounterBy(counterMap, token, amount = 1) {
  return {
    ...counterMap,
    [token]: Number((counterMap[token] ?? 0) + amount),
  };
}

function incrementCounter(counterMap, token) {
  return incrementCounterBy(counterMap, token, 1);
}

function incrementTransitionBy(transitionMap, fromToken, toToken, amount = 1) {
  return {
    ...transitionMap,
    [fromToken]: {
      ...(transitionMap[fromToken] ?? {}),
      [toToken]: Number(((transitionMap[fromToken] ?? {})[toToken] ?? 0) + amount),
    },
  };
}

function incrementTransition(transitionMap, fromToken, toToken) {
  return incrementTransitionBy(transitionMap, fromToken, toToken, 1);
}

function getWeightedRecentTokenCounts(sentenceHistory, maxItems = 16, decay = 0.84) {
  const recent = sentenceHistory.slice(-maxItems);
  const tokenCounts = {};

  for (let offset = 0; offset < recent.length; offset += 1) {
    const entry = recent[recent.length - 1 - offset];
    const weight = Math.pow(decay, offset);

    tokenizeText(entry).forEach((token) => {
      tokenCounts[token] = (tokenCounts[token] ?? 0) + weight;
    });
  }

  return tokenCounts;
}

function getStartTokenCounts(entries) {
  const counts = {};

  entries.forEach((entry) => {
    const first = tokenizeText(entry)[0];
    if (!first) return;
    counts[first] = (counts[first] ?? 0) + 1;
  });

  return counts;
}

function buildContinuationMap(phrases, maxPrefixLength = 4) {
  const continuationMap = {};

  phrases.forEach((phrase) => {
    const tokens = tokenizeText(phrase);
    if (tokens.length < 2) return;

    for (let index = 0; index < tokens.length - 1; index += 1) {
      const nextToken = tokens[index + 1];
      const maxLength = Math.min(maxPrefixLength, index + 1);

      for (let length = 1; length <= maxLength; length += 1) {
        const prefix = tokens.slice(index + 1 - length, index + 1).join(" ");
        if (!continuationMap[prefix]) {
          continuationMap[prefix] = {};
        }
        continuationMap[prefix][nextToken] = (continuationMap[prefix][nextToken] ?? 0) + 1;
      }
    }
  });

  return continuationMap;
}

function getContinuationBoosts(sentenceTokens, continuationMap, maxPrefixLength = 4) {
  const boosts = {};
  if (sentenceTokens.length === 0) return boosts;

  for (let length = Math.min(maxPrefixLength, sentenceTokens.length); length >= 1; length -= 1) {
    const prefix = sentenceTokens.slice(-length).join(" ");
    const nextCounts = continuationMap[prefix];
    if (!nextCounts) continue;

    const total = Object.values(nextCounts).reduce((sum, value) => sum + Number(value ?? 0), 0) || 1;
    Object.entries(nextCounts).forEach(([token, count]) => {
      const normalized = normalizeToken(token);
      if (!normalized) return;
      boosts[normalized] = (boosts[normalized] ?? 0) + (Number(count) / total) * (1.7 + length * 0.5);
    });
  }

  return boosts;
}

function getCooccurrenceBoosts(sentenceHistory, sentenceTokenSet, maxItems = 64, decay = 0.94) {
  const boosts = {};
  if (sentenceTokenSet.size === 0) return boosts;

  const recentEntries = sentenceHistory.slice(-maxItems);
  for (let index = 0; index < recentEntries.length; index += 1) {
    const entry = recentEntries[index];
    const distanceFromLatest = recentEntries.length - 1 - index;
    const weight = Math.pow(decay, distanceFromLatest);
    const uniqueTokens = [...new Set(tokenizeText(entry))];
    const hasMatch = uniqueTokens.some((token) => sentenceTokenSet.has(token));

    if (!hasMatch) continue;

    uniqueTokens.forEach((token) => {
      if (sentenceTokenSet.has(token)) return;
      boosts[token] = (boosts[token] ?? 0) + weight;
    });
  }

  return boosts;
}

function getRecentBehaviorBoosts(sentenceEvents = [], sentenceHistory = [], maxItems = 5) {
  const boosts = {};
  const recentTexts = sentenceEvents.length > 0
    ? sentenceEvents.slice(-maxItems).map((entry) => entry.text)
    : sentenceHistory.slice(-maxItems);

  for (let index = 0; index < recentTexts.length; index += 1) {
    const text = recentTexts[recentTexts.length - 1 - index];
    const weight = Math.max(0.35, 1 - index * 0.18);
    tokenizeText(text).forEach((token) => {
      boosts[token] = (boosts[token] ?? 0) + weight;
    });
  }

  return boosts;
}

function getRoutineHourBoosts(sentenceEvents = [], now = new Date()) {
  const boosts = {};
  const targetHour = now.getHours();
  const timedEvents = normalizeSentenceEvents(sentenceEvents).filter((entry) => Boolean(entry.ts));
  if (timedEvents.length === 0) return boosts;

  timedEvents.forEach((event) => {
    const eventDate = new Date(event.ts);
    if (Number.isNaN(eventDate.getTime())) return;

    const hourDistance = Math.abs(eventDate.getHours() - targetHour);
    if (hourDistance > 2) return;

    const hourWeight = hourDistance === 0 ? 1.25 : hourDistance === 1 ? 0.75 : 0.45;
    tokenizeText(event.text).forEach((token) => {
      boosts[token] = (boosts[token] ?? 0) + hourWeight;
    });
  });

  const maxWeight = Math.max(1, ...Object.values(boosts).map((value) => Number(value ?? 0)));
  Object.keys(boosts).forEach((token) => {
    boosts[token] = (Number(boosts[token] ?? 0) / maxWeight) * 2.2;
  });

  return boosts;
}

function getTopRoutineToken(sentenceEvents = [], now = new Date()) {
  const boosts = getRoutineHourBoosts(sentenceEvents, now);
  const sorted = Object.entries(boosts).sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0));
  if (sorted.length === 0) return null;
  return {
    token: sorted[0][0],
    score: Number(sorted[0][1] ?? 0),
  };
}

function getSmartSuggestions({
  words,
  sentence,
  usageCounts,
  transitionCounts,
  sentenceHistory,
  sentenceEvents = [],
  quickPhrases = [],
  favoriteTokens = [],
  therapyGoal = THERAPY_GOALS.BALANCED,
  activeCategory = DEFAULT_CATEGORY,
  limit = 6,
}) {
  const wordMap = new Map();

  words.forEach((word) => {
    const token = normalizeToken(word.text);
    if (!token || wordMap.has(token)) return;
    wordMap.set(token, word);
  });

  const sentenceTokens = sentence.map((word) => normalizeToken(word.text)).filter(Boolean);
  const sentenceTokenSet = new Set(sentenceTokens);
  const lastToken = sentenceTokens[sentenceTokens.length - 1] ?? "";
  const secondLastToken = sentenceTokens[sentenceTokens.length - 2] ?? "";
  const now = new Date();
  const timeOfDay = getTimeOfDayLabel(now);
  const recentTokenCounts = getWeightedRecentTokenCounts(sentenceHistory);
  const recentBehaviorBoosts = getRecentBehaviorBoosts(sentenceEvents, sentenceHistory, 5);
  const routineHourBoosts = getRoutineHourBoosts(sentenceEvents, now);
  const timeOfDayBoosts = TIME_OF_DAY_TOKEN_BOOSTS[timeOfDay] ?? {};
  const phraseCorpus = [...sentenceHistory.slice(-80), ...quickPhrases.slice(0, MAX_PHRASES)];
  const continuationMap = buildContinuationMap(phraseCorpus);
  const continuationBoosts = getContinuationBoosts(sentenceTokens, continuationMap);
  const cooccurrenceBoosts = getCooccurrenceBoosts(sentenceHistory, sentenceTokenSet);
  const startHistoryCounts = getStartTokenCounts(sentenceHistory.slice(-80));
  const startQuickCounts = getStartTokenCounts(quickPhrases);
  const favoriteSet = new Set(favoriteTokens.map((token) => normalizeToken(token)));
  const maxUsage = Math.max(1, ...Object.values(usageCounts).map((value) => Number(value ?? 0)));
  const pairContextKey = secondLastToken && lastToken ? `${secondLastToken} ${lastToken}` : "";
  const conceptRelatedSet = getConceptRelatedTokens(sentenceTokens);

  const scored = [...wordMap.entries()].map(([token, word]) => {
    const wordCategory = normalizeBoardKey(word.category, DEFAULT_CUSTOM_CATEGORY);
    const usage = Number(usageCounts[token] ?? 0);
    const transitionFromLast = Number((transitionCounts[lastToken] ?? {})[token] ?? 0);
    const transitionFromSecond = Number((transitionCounts[secondLastToken] ?? {})[token] ?? 0);
    const continuation = Number(continuationBoosts[token] ?? 0);
    const cooccurrence = Number(cooccurrenceBoosts[token] ?? 0);
    const recent = Number(recentTokenCounts[token] ?? 0);
    const recentBehavior = Number(recentBehaviorBoosts[token] ?? 0);
    const routineHour = Number(routineHourBoosts[token] ?? 0);
    const timeOfDayBoost = Number(timeOfDayBoosts[token] ?? 0);
    const startAffinity = Number(startHistoryCounts[token] ?? 0) + Number(startQuickCounts[token] ?? 0);
    const explorationBonus = Math.max(0, 1 - usage / Math.max(8, maxUsage)) * 0.45;
    const conceptBoost = conceptRelatedSet.has(token) ? 0.9 : 0;
    const therapyNoveltyBoost =
      therapyGoal === THERAPY_GOALS.EXPAND_VOCABULARY
        ? Math.max(0, 1 - usage / Math.max(4, maxUsage)) * 1.4
        : therapyGoal === THERAPY_GOALS.COMMUNICATION_SPEED
          ? Math.max(0, 1 - token.length / 12) * 0.35
          : Math.max(0, 1 - usage / Math.max(8, maxUsage)) * 0.42;

    let score = 0.8;
    score += Math.log1p(usage) * 1.7;
    score += recent * 0.85;
    score += continuation * 2.2;
    score += cooccurrence * 0.58;
    score += recentBehavior * 0.72;
    score += routineHour * 0.95;
    score += timeOfDayBoost;
    score += explorationBonus;
    score += conceptBoost;
    score += therapyNoveltyBoost;

    if (sentenceTokens.length === 0) {
      score += START_WORD_BOOSTS[token] ?? 0;
      score += Math.log1p(startAffinity) * 1.4;
    } else {
      score += Math.log1p(transitionFromLast) * 2.5;
      score += Math.log1p(transitionFromSecond) * 0.75;
      score += (CONTEXT_BOOSTS[lastToken] ?? {})[token] ?? 0;
      score += (PAIR_CONTEXT_BOOSTS[pairContextKey] ?? {})[token] ?? 0;
      score += (CONTEXT_CATEGORY_BOOSTS[lastToken] ?? {})[wordCategory] ?? 0;
    }

    if (activeCategory !== DEFAULT_CATEGORY && wordCategory === activeCategory) {
      score += 0.9;
    }

    if (favoriteSet.has(token)) score += 1.3;
    if (sentenceTokenSet.has(token)) score -= 1.2;
    if (lastToken && token === lastToken) score -= 2.8;
    if (secondLastToken && token === secondLastToken) score -= 1.2;

    const reasonCandidates = [];
    if (sentenceTokens.length === 0 && (START_WORD_BOOSTS[token] ?? 0) > 0) {
      reasonCandidates.push("Strong sentence starter");
    }
    if (transitionFromLast > 0 && lastToken) {
      reasonCandidates.push(`Often follows "${lastToken}"`);
    }
    if (continuation >= 0.45) {
      reasonCandidates.push("Matches learned phrase patterns");
    }
    if (cooccurrence >= 0.5) {
      reasonCandidates.push("Used with your current words");
    }
    if (recentBehavior >= 0.85) {
      reasonCandidates.push("Matches last 5 spoken sentences");
    }
    if (routineHour >= 0.8) {
      reasonCandidates.push(`Routine match around ${now.getHours()}:00`);
    }
    if (timeOfDayBoost >= 1.4) {
      reasonCandidates.push(`Good ${timeOfDay} context`);
    }
    if (recent >= 0.4) {
      reasonCandidates.push("Recently used");
    }
    if (conceptBoost > 0) {
      reasonCandidates.push("Concept-related to current sentence");
    }
    if (therapyGoal === THERAPY_GOALS.EXPAND_VOCABULARY && therapyNoveltyBoost >= 0.75) {
      reasonCandidates.push("Vocabulary expansion goal");
    }
    if (therapyGoal === THERAPY_GOALS.COMMUNICATION_SPEED && therapyNoveltyBoost >= 0.2) {
      reasonCandidates.push("Speed-focused selection");
    }
    if (favoriteSet.has(token)) {
      reasonCandidates.push("Marked as favorite");
    }
    if (usage >= 2) {
      reasonCandidates.push("Frequently used");
    }

    const details = [];
    details.push({ label: "Usage score", value: Math.log1p(usage).toFixed(2) });
    if (lastToken) {
      details.push({ label: `Transition from "${lastToken}"`, value: Math.log1p(transitionFromLast).toFixed(2) });
    } else {
      details.push({ label: "Starter affinity", value: Math.log1p(startAffinity).toFixed(2) });
    }
    details.push({ label: "Phrase continuation", value: continuation.toFixed(2) });
    details.push({ label: "Recency boost", value: recent.toFixed(2) });
    details.push({ label: "Co-occurrence", value: cooccurrence.toFixed(2) });
    details.push({ label: "Last-5 behavior", value: recentBehavior.toFixed(2) });
    details.push({ label: "Routine-by-hour", value: routineHour.toFixed(2) });
    details.push({ label: `${timeOfDay} boost`, value: timeOfDayBoost.toFixed(2) });
    details.push({ label: "Concept boost", value: conceptBoost.toFixed(2) });
    details.push({ label: "Therapy goal boost", value: therapyNoveltyBoost.toFixed(2) });
    if (favoriteSet.has(token)) {
      details.push({ label: "Favorite boost", value: "+1.30" });
    }

    return {
      word,
      score,
      reasons: [...new Set(reasonCandidates)].slice(0, 3),
      details,
    };
  });

  const ranked = scored
    .sort((a, b) => b.score - a.score || a.word.text.localeCompare(b.word.text))
    .slice(0, limit);
  const maxScore = Math.max(1, ranked[0]?.score ?? 1);

  return ranked.map((entry) => {
    const relative = entry.score / maxScore;
    const confidence =
      entry.score >= 8 || relative >= 0.8 ? "High" : entry.score >= 4 || relative >= 0.55 ? "Medium" : "Low";

    return {
      ...entry,
      confidence,
    };
  });
}

function getInstantIntentSuggestions({
  sentence,
  wordLookup,
  activeCategory = DEFAULT_CATEGORY,
  activeSubBoard = DEFAULT_SUB_BOARD,
  limit = 4,
}) {
  const tokens = sentence.map((word) => normalizeToken(word?.text)).filter(Boolean);
  if (tokens.length === 0) return [];
  const seen = new Set();

  const phraseKey = tokens.slice(-2).join(" ");
  const singleKey = tokens[tokens.length - 1];
  const lastToken = tokens[tokens.length - 1] ?? "";
  const matched =
    INSTANT_INTENT_MAP[phraseKey] ??
    INSTANT_INTENT_MAP[singleKey] ??
    null;
  if (!matched) return [];

  const fallbackCategory =
    activeCategory !== DEFAULT_CATEGORY && activeCategory !== FAVORITES_CATEGORY
      ? activeCategory
      : DEFAULT_CUSTOM_CATEGORY;
  const fallbackSubBoard =
    activeSubBoard !== DEFAULT_SUB_BOARD ? activeSubBoard : DEFAULT_CUSTOM_SUB_BOARD;
  const contextStrength = INSTANT_INTENT_MAP[phraseKey] ? "High" : "Medium";

  return matched.targets
    .map((targetToken) => {
      const normalized = normalizeToken(targetToken);
      if (!normalized) return null;
      if (normalized === lastToken) return null;
      if (seen.has(normalized)) return null;
      seen.add(normalized);

      const hinted = INTENT_WORD_HINTS[normalized] ?? {};
      const word =
        wordLookup[normalized] ??
        normalizeWordRecord(
          {
            text: targetToken,
            emoji: hinted.emoji ?? "🔤",
            category: hinted.category ?? fallbackCategory,
            subBoard: hinted.subBoard ?? fallbackSubBoard,
          },
          fallbackCategory,
          fallbackSubBoard
        );
      if (!word) return null;

      return {
        word,
        confidence: contextStrength,
        reason: matched.reason || "Instant intent completion",
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

function getSmartPhraseSuggestions({
  sentence,
  sentenceHistory,
  quickPhrases = [],
  transitionCounts = {},
  limit = 4,
}) {
  const currentTokens = sentence.map((word) => normalizeToken(word.text)).filter(Boolean);
  const corpus = [...sentenceHistory.slice(-80), ...quickPhrases.slice(0, MAX_PHRASES)];
  const continuationMap = buildContinuationMap(corpus, 4);
  const baseEntries = getAdaptivePhrases(sentenceHistory, quickPhrases, 8);
  const phraseCountMap = {};
  const phraseRecencyMap = {};
  const candidateMap = new Map();

  corpus.forEach((entry, index) => {
    const normalized = normalizeToken(entry);
    if (!normalized) return;
    phraseCountMap[normalized] = (phraseCountMap[normalized] ?? 0) + 1;
    phraseRecencyMap[normalized] = index;
  });

  function addCandidate({
    phrase,
    continuationBoost = 0,
    transitionStrength = 0,
    historyCount = 0,
    recencyIndex = 0,
    startSignal = 0,
    source = "model",
  }) {
    const clean = String(phrase ?? "").trim().replace(/\s+/g, " ");
    if (!clean) return;
    const phraseKey = clean.toLowerCase();

    let score = 0.9;
    score += continuationBoost * 2.1;
    score += Math.log1p(transitionStrength) * 1.2;
    score += Math.log1p(historyCount) * 1.1;
    score += startSignal * 0.7;
    if (source === "quick") score += 0.25;
    if (tokenizeText(clean).length >= 3) score += 0.35;
    if (currentTokens.length > 0 && clean === currentTokens.join(" ")) score -= 2;

    const reasonCandidates = [];
    if (continuationBoost >= 0.45) reasonCandidates.push("Matches current phrase pattern");
    if (transitionStrength >= 2) reasonCandidates.push("Strong next-token transition");
    if (historyCount >= 2) reasonCandidates.push("Repeated in this child profile");
    if (startSignal > 0) reasonCandidates.push("Good sentence starter");
    if (source === "quick") reasonCandidates.push("Saved quick phrase");

    const details = [
      { label: "Continuation signal", value: continuationBoost.toFixed(2) },
      { label: "Transition strength", value: Math.log1p(transitionStrength).toFixed(2) },
      { label: "History frequency", value: historyCount.toFixed(0) },
      { label: "Recency index", value: recencyIndex.toString() },
    ];

    const nextEntry = {
      phrase: clean,
      score,
      reasons: [...new Set(reasonCandidates)].slice(0, 3),
      details,
    };

    const previous = candidateMap.get(phraseKey);
    if (!previous || nextEntry.score > previous.score) {
      candidateMap.set(phraseKey, nextEntry);
    }
  }

  if (currentTokens.length === 0) {
    baseEntries.forEach((entry) => {
      const normalized = normalizeToken(entry);
      const firstToken = tokenizeText(entry)[0] ?? "";
      addCandidate({
        phrase: entry,
        historyCount: Number(phraseCountMap[normalized] ?? 0),
        recencyIndex: Number(phraseRecencyMap[normalized] ?? 0),
        startSignal: Number(START_WORD_BOOSTS[firstToken] ?? 0),
        source: "history",
      });
    });
    quickPhrases.forEach((entry) => {
      const normalized = normalizeToken(entry);
      const firstToken = tokenizeText(entry)[0] ?? "";
      addCandidate({
        phrase: entry,
        historyCount: Number(phraseCountMap[normalized] ?? 0),
        recencyIndex: Number(phraseRecencyMap[normalized] ?? 0),
        startSignal: Number(START_WORD_BOOSTS[firstToken] ?? 0),
        source: "quick",
      });
    });

    const ranked = [...candidateMap.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    const maxScore = Math.max(1, ranked[0]?.score ?? 1);
    return ranked.map((entry) => {
      const relative = entry.score / maxScore;
      const confidence =
        entry.score >= 7 || relative >= 0.8 ? "High" : entry.score >= 3.8 || relative >= 0.55 ? "Medium" : "Low";

      return {
        ...entry,
        confidence,
      };
    });
  }

  const nextBoosts = getContinuationBoosts(currentTokens, continuationMap, 4);
  const nextCandidates = Object.entries(nextBoosts)
    .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
    .slice(0, 6)
    .map(([token]) => token);

  const safeCandidates =
    nextCandidates.length > 0
      ? nextCandidates
      : Object.entries(transitionCounts[currentTokens[currentTokens.length - 1]] ?? {})
          .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
          .slice(0, 6)
          .map(([token]) => normalizeToken(token))
          .filter(Boolean);

  safeCandidates.forEach((candidate) => {
    const generated = [...currentTokens, candidate];
    let last = candidate;
    let transitionStrength = Number((transitionCounts[currentTokens[currentTokens.length - 1]] ?? {})[candidate] ?? 0);

    for (let depth = 0; depth < 2; depth += 1) {
      const options = transitionCounts[last] ?? {};
      const sortedOptions = Object.entries(options)
        .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
        .map(([token, count]) => ({ token: normalizeToken(token), count: Number(count ?? 0) }));
      const pick = sortedOptions.find(
        (entry) => entry.token && entry.token !== generated[generated.length - 1]
      );
      const nextToken = pick?.token;

      if (!nextToken) break;
      generated.push(nextToken);
      transitionStrength += Number(pick?.count ?? 0);
      last = nextToken;
    }

    const phrase = generated.join(" ");
    const normalized = normalizeToken(phrase);
    addCandidate({
      phrase,
      continuationBoost: Number(nextBoosts[candidate] ?? 0),
      transitionStrength,
      historyCount: Number(phraseCountMap[normalized] ?? 0),
      recencyIndex: Number(phraseRecencyMap[normalized] ?? 0),
      source: "model",
    });
  });

  if (candidateMap.size === 0) {
    baseEntries.forEach((entry) => {
      const normalized = normalizeToken(entry);
      addCandidate({
        phrase: entry,
        historyCount: Number(phraseCountMap[normalized] ?? 0),
        recencyIndex: Number(phraseRecencyMap[normalized] ?? 0),
        source: "history",
      });
    });
  }

  const ranked = [...candidateMap.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const maxScore = Math.max(1, ranked[0]?.score ?? 1);

  return ranked.map((entry) => {
    const relative = entry.score / maxScore;
    const confidence =
      entry.score >= 7 || relative >= 0.8 ? "High" : entry.score >= 3.8 || relative >= 0.55 ? "Medium" : "Low";

    return {
      ...entry,
      confidence,
    };
  });
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value ?? 0)));
}

function startsWithTokenSequence(tokens, prefix) {
  if (prefix.length === 0) return true;
  if (tokens.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (tokens[index] !== prefix[index]) return false;
  }
  return true;
}

function includesTokenSequence(tokens, target) {
  if (target.length === 0) return true;
  if (tokens.length < target.length) return false;
  const maxStart = tokens.length - target.length;
  for (let start = 0; start <= maxStart; start += 1) {
    let matches = true;
    for (let index = 0; index < target.length; index += 1) {
      if (tokens[start + index] !== target[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function getAutoSentenceCategory(triggerToken, wordLookup = {}) {
  const hintedCategory = INTENT_WORD_HINTS[triggerToken]?.category;
  const lookupCategory = normalizeBoardKey(wordLookup[triggerToken]?.category, "");
  const normalizedHint = normalizeBoardKey(hintedCategory, "");
  return lookupCategory || normalizedHint || DEFAULT_CUSTOM_CATEGORY;
}

function getAutoSentenceTemplatePhrases(
  triggerToken,
  wordLookup = {},
  currentTokens = [],
  intent = AUTO_SENTENCE_INTENTS.UNKNOWN
) {
  if (!triggerToken) return [];
  const triggerWord = wordLookup[triggerToken]?.text ?? triggerToken;
  const category = getAutoSentenceCategory(triggerToken, wordLookup);
  const categoryTemplates = AUTO_SENTENCE_CATEGORY_TEMPLATE_MAP[category] ?? [];
  const templateCandidates = [
    ...(AUTO_SENTENCE_TEMPLATES[triggerToken] ? [AUTO_SENTENCE_TEMPLATES[triggerToken].join(" ")] : []),
    ...(AUTO_SENTENCE_INTENT_TEMPLATE_MAP[intent] ?? []),
    ...categoryTemplates,
    ...AUTO_SENTENCE_GENERIC_TEMPLATES,
  ];
  const uniqueTemplates = [...new Set(templateCandidates)];
  const prefix = currentTokens.map((token) => normalizeToken(token)).filter(Boolean);
  const results = [];
  const seen = new Set();

  uniqueTemplates.forEach((template) => {
    const sentence = String(template ?? "")
      .replace(/\{word\}/g, triggerWord)
      .replace(/\s+/g, " ")
      .trim();
    if (!sentence) return;

    const normalizedSentence = normalizeToken(sentence);
    if (!normalizedSentence || seen.has(normalizedSentence)) return;
    const tokens = tokenizeText(sentence);
    if (tokens.length < 2) return;

    let contextStrength = 0.55;
    if (prefix.length > 0) {
      if (startsWithTokenSequence(tokens, prefix)) {
        contextStrength = 1;
      } else if (includesTokenSequence(tokens, prefix)) {
        contextStrength = 0.58;
      } else if (tokens.includes(triggerToken)) {
        contextStrength = 0.34;
      } else {
        contextStrength = 0.18;
      }
    }

    seen.add(normalizedSentence);
    results.push({
      sentence,
      source: "template",
      reasonCodes: ["template_match"],
      contextStrength,
    });
  });

  if (prefix.length > 0) {
    const appendTokens =
      prefix[prefix.length - 1] === triggerToken
        ? prefix
        : [...prefix, triggerToken];
    const sentence = appendTokens
      .map((token) => wordLookup[token]?.text ?? token)
      .join(" ")
      .trim();
    const normalizedSentence = normalizeToken(sentence);
    if (sentence && !seen.has(normalizedSentence)) {
      results.push({
        sentence,
        source: "template",
        reasonCodes: ["template_match", "context_match"],
        contextStrength: 0.84,
      });
    }
  }

  return results;
}

function buildAutoSentenceCorpusStats(corpus = []) {
  const countMap = {};
  const recencyMap = {};
  const normalizedCorpus = [];

  corpus.forEach((entry, index) => {
    const clean = String(entry ?? "").trim().replace(/\s+/g, " ");
    if (!clean) return;
    const normalized = normalizeToken(clean);
    if (!normalized) return;
    countMap[normalized] = (countMap[normalized] ?? 0) + 1;
    recencyMap[normalized] = index + 1;
    normalizedCorpus.push(clean);
  });

  const maxCount = Math.max(1, ...Object.values(countMap).map((value) => Number(value ?? 0)));
  const maxRecency = Math.max(1, ...Object.values(recencyMap).map((value) => Number(value ?? 0)));

  return {
    countMap,
    recencyMap,
    maxCount,
    maxRecency,
    normalizedCorpus,
  };
}

function getAutoSentenceConfidenceLabel(score) {
  if (score >= 0.78) return "High";
  if (score >= 0.56) return "Medium";
  return "Low";
}

function getAutoSentenceConfidenceDots(score) {
  if (score >= 0.78) return "●●●";
  if (score >= 0.56) return "●●○";
  return "●○○";
}

function summarizeAutoSentenceReasons(reasonCodes = []) {
  const labels = reasonCodes
    .map((code) => AUTO_SENTENCE_REASON_LABELS[code])
    .filter(Boolean);
  if (labels.length === 0) return "Adaptive full-sentence prediction";
  if (labels.length === 1) return labels[0];
  return `${labels[0]} • ${labels[1]}`;
}

function hashString(value = "") {
  let hash = 0;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function detectIntentFromTokens(tokens = [], tappedToken = "", recentHistory = []) {
  const allTokens = [...tokens, tappedToken].filter(Boolean);
  if (allTokens.length === 0) {
    return { intent: AUTO_SENTENCE_INTENTS.UNKNOWN, confidence: 0.35, reason: "No strong intent signal yet" };
  }

  const scoreByIntent = {
    [AUTO_SENTENCE_INTENTS.REQUEST]: 0,
    [AUTO_SENTENCE_INTENTS.NEED]: 0,
    [AUTO_SENTENCE_INTENTS.EMOTION]: 0,
    [AUTO_SENTENCE_INTENTS.ACTION]: 0,
    [AUTO_SENTENCE_INTENTS.RESPONSE]: 0,
    [AUTO_SENTENCE_INTENTS.SOCIAL]: 0,
  };

  Object.entries(AUTO_SENTENCE_INTENT_KEYWORDS).forEach(([intent, keywords]) => {
    allTokens.forEach((token) => {
      if (keywords.includes(token)) {
        scoreByIntent[intent] += 1.3;
      }
    });
  });

  const pairKey = tokens.slice(-2).join(" ");
  if (pairKey === "i want") scoreByIntent[AUTO_SENTENCE_INTENTS.REQUEST] += 2.6;
  if (pairKey === "i need") scoreByIntent[AUTO_SENTENCE_INTENTS.NEED] += 2.6;
  if (pairKey === "i feel" || pairKey === "i am") scoreByIntent[AUTO_SENTENCE_INTENTS.EMOTION] += 2.6;

  recentHistory.slice(-12).forEach((entry, index) => {
    const historyIntent = detectIntentFromTokens(tokenizeText(entry), "", []).intent;
    const recencyWeight = Math.max(0.15, 1 - (11 - index) * 0.08);
    scoreByIntent[historyIntent] = Number(scoreByIntent[historyIntent] ?? 0) + recencyWeight * 0.32;
  });

  const ranked = Object.entries(scoreByIntent).sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0));
  const topIntent = ranked[0]?.[0] ?? AUTO_SENTENCE_INTENTS.UNKNOWN;
  const topScore = Number(ranked[0]?.[1] ?? 0);
  const secondScore = Number(ranked[1]?.[1] ?? 0);
  const confidence = clamp01((topScore - secondScore + 1) / 4);

  const reason =
    topIntent === AUTO_SENTENCE_INTENTS.UNKNOWN
      ? "Defaulting to general request intent"
      : `Detected ${topIntent} intent from current tokens`;

  return {
    intent: topIntent,
    confidence: Math.max(0.35, confidence),
    reason,
  };
}

function getFrequentIntentCounts(sentenceHistory = []) {
  const counts = {};
  sentenceHistory.slice(-60).forEach((phrase) => {
    const intent = detectIntentFromTokens(tokenizeText(phrase), "", []).intent;
    counts[intent] = Number(counts[intent] ?? 0) + 1;
  });
  return counts;
}

function detectActiveBehaviorCluster(tokens = [], recentHistory = []) {
  const recentTokens = [
    ...tokens,
    ...recentHistory
      .slice(-6)
      .flatMap((entry) => tokenizeText(entry).slice(0, 6)),
  ];
  const clusterScores = {};

  Object.entries(AUTO_SENTENCE_BEHAVIOR_CLUSTERS).forEach(([cluster, keywords]) => {
    let score = 0;
    recentTokens.forEach((token) => {
      if (keywords.includes(token)) score += 1;
    });
    clusterScores[cluster] = score;
  });

  const top = Object.entries(clusterScores).sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))[0];
  if (!top || Number(top[1] ?? 0) <= 0) {
    return { sessionPattern: "general", score: 0 };
  }

  return {
    sessionPattern: top[0],
    score: Number(top[1] ?? 0),
  };
}

function detectSituationContext({
  currentTokens = [],
  sentenceEvents = [],
  sentenceHistory = [],
}) {
  const recentEventTokens = normalizeSentenceEvents(sentenceEvents)
    .slice(-3)
    .flatMap((entry) => tokenizeText(entry.text).slice(0, 6));
  const recentHistoryTokens = sentenceHistory
    .slice(-2)
    .flatMap((entry) => tokenizeText(entry).slice(0, 6));
  const tokenStream = [...currentTokens, ...recentEventTokens, ...recentHistoryTokens];
  if (tokenStream.length === 0) {
    return { situation: "general", score: 0 };
  }

  const scored = Object.entries(SITUATION_CONTEXT_KEYWORDS).map(([situation, keywords]) => {
    const hits = tokenStream.reduce((count, token) => {
      return count + (keywords.includes(token) ? 1 : 0);
    }, 0);
    return {
      situation,
      score: hits / Math.max(1, tokenStream.length),
    };
  });

  const top = scored.sort((a, b) => b.score - a.score)[0];
  if (!top || top.score <= 0.06) {
    return { situation: "general", score: 0 };
  }
  return top;
}

function buildContextStack({
  currentTokens = [],
  sentenceHistory = [],
  sentenceEvents = [],
  timeOfDay = getTimeOfDayLabel(new Date()),
  intent = AUTO_SENTENCE_INTENTS.UNKNOWN,
  environment = AUTO_SENTENCE_ENVIRONMENTS.HOME,
}) {
  const recentSentences = sentenceHistory.slice(-6);
  const frequentIntentCounts = getFrequentIntentCounts(sentenceHistory);
  const sortedIntents = Object.entries(frequentIntentCounts)
    .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
    .map(([key]) => key);
  const activeCluster = detectActiveBehaviorCluster(currentTokens, recentSentences);
  const situation = detectSituationContext({
    currentTokens,
    sentenceEvents,
    sentenceHistory,
  });
  const lastEvent = normalizeSentenceEvents(sentenceEvents).slice(-1)[0];

  return {
    lastWords: currentTokens.slice(-3),
    lastSentences: recentSentences,
    timeOfDay,
    sessionPattern: activeCluster.sessionPattern,
    frequentIntents: sortedIntents.slice(0, 3),
    environment,
    activeIntent: intent,
    situation: situation.situation,
    situationScore: situation.score,
    recentEvent: lastEvent?.text ?? "",
  };
}

function getConceptRelatedTokens(tokens = []) {
  const related = new Set();
  const normalizedTokens = tokens.map((token) => normalizeToken(token)).filter(Boolean);

  normalizedTokens.forEach((token) => {
    (CONCEPT_GRAPH[token] ?? []).forEach((entry) => related.add(normalizeToken(entry)));
    Object.entries(CONCEPT_GRAPH).forEach(([concept, neighbors]) => {
      if ((neighbors ?? []).includes(token)) {
        related.add(normalizeToken(concept));
      }
    });
  });

  normalizedTokens.forEach((token) => related.delete(token));
  return related;
}

function buildTokenMemoryLayers({
  sentenceHistory = [],
  sentenceEvents = [],
  usageCounts = {},
}) {
  const shortTerm = {};
  const midTerm = {};
  const longTerm = {};

  normalizeSentenceEvents(sentenceEvents)
    .slice(-10)
    .forEach((entry, index, array) => {
      const recencyWeight = Math.max(0.2, 1 - (array.length - 1 - index) * 0.11);
      tokenizeText(entry.text).forEach((token) => {
        shortTerm[token] = Number(shortTerm[token] ?? 0) + recencyWeight;
      });
    });

  const cutoffMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
  normalizeSentenceEvents(sentenceEvents)
    .slice(-140)
    .forEach((entry, index, array) => {
      let recencyWeight = Math.max(0.15, 1 - (array.length - 1 - index) * 0.03);
      if (entry.ts) {
        const ts = new Date(entry.ts).getTime();
        if (Number.isFinite(ts) && ts >= cutoffMs) {
          recencyWeight += 0.35;
        }
      }
      tokenizeText(entry.text).forEach((token) => {
        midTerm[token] = Number(midTerm[token] ?? 0) + recencyWeight;
      });
    });

  if (Object.keys(midTerm).length === 0) {
    sentenceHistory.slice(-36).forEach((entry, index, array) => {
      const recencyWeight = Math.max(0.12, 1 - (array.length - 1 - index) * 0.04);
      tokenizeText(entry).forEach((token) => {
        midTerm[token] = Number(midTerm[token] ?? 0) + recencyWeight;
      });
    });
  }

  const maxUsage = Math.max(1, ...Object.values(usageCounts).map((value) => Number(value ?? 0)));
  Object.entries(usageCounts).forEach(([token, rawCount]) => {
    const normalized = normalizeToken(token);
    if (!normalized) return;
    longTerm[normalized] = clamp01(Number(rawCount ?? 0) / maxUsage);
  });

  const normalizeMap = (map = {}, maxValue = 1.8) => {
    const result = {};
    const maxObserved = Math.max(0.0001, ...Object.values(map).map((value) => Number(value ?? 0)));
    Object.entries(map).forEach(([token, rawValue]) => {
      result[token] = clamp01((Number(rawValue ?? 0) / maxObserved) * maxValue);
    });
    return result;
  };

  return {
    shortTerm: normalizeMap(shortTerm, 1),
    midTerm: normalizeMap(midTerm, 1),
    longTerm,
  };
}

function getUrgencySignal({
  sentenceTokens = [],
  recentTapTimestamps = [],
  sentenceEvents = [],
}) {
  const urgencyTokens = new Set(["help", "hurt", "stop", "emergency", "bathroom", "now"]);
  const tokenUrgencyHits = sentenceTokens.reduce((count, token) => {
    return count + (urgencyTokens.has(token) ? 1 : 0);
  }, 0);

  const recentTaps = recentTapTimestamps
    .filter((value) => Number.isFinite(Number(value)))
    .slice(-6)
    .map((value) => Number(value));
  let rapidTapScore = 0;
  if (recentTaps.length >= 2) {
    const intervals = [];
    for (let index = 1; index < recentTaps.length; index += 1) {
      intervals.push(recentTaps[index] - recentTaps[index - 1]);
    }
    const avgInterval = intervals.reduce((sum, value) => sum + value, 0) / Math.max(1, intervals.length);
    rapidTapScore = avgInterval > 0 ? clamp01(1 - avgInterval / 820) : 0;
  }

  const recentTexts = normalizeSentenceEvents(sentenceEvents)
    .slice(-4)
    .map((entry) => normalizeToken(entry.text));
  const repeatedHelp = recentTexts.filter((entry) => entry.includes("help")).length;
  const historyUrgency = repeatedHelp >= 2 ? 0.4 : repeatedHelp === 1 ? 0.2 : 0;
  const score = clamp01(tokenUrgencyHits * 0.28 + rapidTapScore * 0.5 + historyUrgency);

  return {
    score,
    level: score >= 0.78 ? "high" : score >= 0.45 ? "medium" : "low",
  };
}

function getPreferredWordsFromUsage(usageCounts = {}, limit = 8) {
  const fromUsage = Object.entries(usageCounts ?? {})
    .map(([token, count]) => ({
      token: normalizeToken(token),
      count: Number(count ?? 0),
    }))
    .filter((entry) => entry.token && entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.token);

  return [...new Set(fromUsage)].slice(0, Math.max(1, limit));
}

function getMedian(values = []) {
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildChildDigitalTwin({
  sentenceHistory = [],
  sentenceEvents = [],
  usageCounts = {},
  transitionCounts = {},
  speakLatencyMsHistory = [],
}) {
  const recentHistory = sentenceHistory.slice(-120);
  const intentCounts = getFrequentIntentCounts(recentHistory);
  const knownIntents = [
    AUTO_SENTENCE_INTENTS.REQUEST,
    AUTO_SENTENCE_INTENTS.NEED,
    AUTO_SENTENCE_INTENTS.EMOTION,
    AUTO_SENTENCE_INTENTS.ACTION,
    AUTO_SENTENCE_INTENTS.RESPONSE,
    AUTO_SENTENCE_INTENTS.SOCIAL,
  ];
  const totalIntentCount = Math.max(
    1,
    knownIntents.reduce((sum, intent) => sum + Number(intentCounts[intent] ?? 0), 0)
  );
  const intents = knownIntents.reduce((next, intent) => {
    next[intent] = clamp01(Number(intentCounts[intent] ?? 0) / totalIntentCount);
    return next;
  }, {});

  const preferredWords = getPreferredWordsFromUsage(usageCounts, 8);
  const fallbackRoutineWords = preferredWords.slice(0, 4);
  const routineBuckets = {
    morning: {},
    afternoon: {},
    evening: {},
    night: {},
  };

  const normalizedEvents = normalizeSentenceEvents(sentenceEvents).slice(-180);
  normalizedEvents.forEach((entry, index) => {
    const bucket = entry.ts ? getTimeOfDayLabel(new Date(entry.ts)) : "";
    if (!bucket || !routineBuckets[bucket]) return;
    const recencyBoost = clamp01((index + 1) / Math.max(1, normalizedEvents.length));
    tokenizeText(entry.text).forEach((token) => {
      routineBuckets[bucket][token] = Number(routineBuckets[bucket][token] ?? 0) + 1 + recencyBoost * 0.3;
    });
  });

  const routines = Object.fromEntries(
    Object.entries(routineBuckets).map(([bucket, bucketCounts]) => {
      const ranked = Object.entries(bucketCounts)
        .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
        .slice(0, 4)
        .map(([token]) => token);
      return [bucket, ranked.length > 0 ? ranked : fallbackRoutineWords];
    })
  );

  const phrasePatternCounts = {};
  DIGITAL_TWIN_PATTERN_KEYS.forEach((patternKey) => {
    phrasePatternCounts[patternKey] = {};
  });

  recentHistory.forEach((phrase) => {
    const tokens = tokenizeText(phrase);
    if (tokens.length < 3) return;

    DIGITAL_TWIN_PATTERN_KEYS.forEach((patternKey) => {
      const prefixTokens = tokenizeText(patternKey);
      if (prefixTokens.length === 0) return;
      if (!startsWithTokenSequence(tokens, prefixTokens)) return;
      const nextToken = tokens[prefixTokens.length];
      if (!nextToken) return;
      phrasePatternCounts[patternKey][nextToken] =
        Number(phrasePatternCounts[patternKey][nextToken] ?? 0) + 1;
    });
  });

  if (Object.keys(transitionCounts.want ?? {}).length > 0) {
    const iWantNext = Object.entries(transitionCounts.want ?? {})
      .map(([token, count]) => ({ token: normalizeToken(token), count: Number(count ?? 0) }))
      .filter((entry) => entry.token)
      .sort((a, b) => b.count - a.count)
      .slice(0, 4)
      .map((entry) => entry.token);
    if (iWantNext.length > 0 && Object.keys(phrasePatternCounts["i want"]).length === 0) {
      phrasePatternCounts["i want"] = iWantNext.reduce((next, token, index) => {
        next[token] = iWantNext.length - index;
        return next;
      }, {});
    }
  }

  const phrasePatterns = Object.fromEntries(
    Object.entries(phrasePatternCounts)
      .map(([patternKey, counts]) => {
        const ranked = Object.entries(counts)
          .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
          .slice(0, 4)
          .map(([token]) => token);
        return [patternKey, ranked];
      })
      .filter(([, values]) => values.length > 0)
  );

  const speedValues = speakLatencyMsHistory
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const avgSpeedSec =
    speedValues.length > 0
      ? speedValues.reduce((sum, value) => sum + value, 0) / speedValues.length / 1000
      : 0;
  const bestSpeedSec =
    speedValues.length > 0
      ? Math.min(...speedValues) / 1000
      : 0;
  const medianSpeedSec = speedValues.length > 0 ? getMedian(speedValues) / 1000 : 0;

  return {
    intents,
    preferredWords,
    routines,
    phrasePatterns,
    speedProfile: {
      avgTimeToSpeak: Number(avgSpeedSec.toFixed(2)),
      bestTimeToSpeak: Number(bestSpeedSec.toFixed(2)),
      medianTimeToSpeak: Number(medianSpeedSec.toFixed(2)),
      samples: speedValues.length,
    },
    updatedAt: new Date().toISOString(),
  };
}

function getSequenceOutcomeSignals({
  currentTokens = [],
  triggerToken = "",
  sentenceHistory = [],
  quickPhrases = [],
}) {
  const sequenceMap = {};
  const corpus = [...sentenceHistory.slice(-100), ...quickPhrases.slice(0, MAX_PHRASES)];
  const sourceTokens = currentTokens.length > 0 ? currentTokens : [triggerToken].filter(Boolean);

  corpus.forEach((phrase) => {
    const tokens = tokenizeText(phrase);
    if (tokens.length < 2) return;
    for (let prefixLen = 1; prefixLen <= Math.min(3, tokens.length - 1); prefixLen += 1) {
      for (let index = 0; index <= tokens.length - prefixLen - 1; index += 1) {
        const prefix = tokens.slice(index, index + prefixLen).join(" ");
        const nextToken = tokens[index + prefixLen];
        if (!sequenceMap[prefix]) sequenceMap[prefix] = {};
        sequenceMap[prefix][nextToken] = Number(sequenceMap[prefix][nextToken] ?? 0) + 1;
      }
    }
  });

  const outcomeBoosts = {};
  const prefixes = [];
  for (let length = Math.min(3, sourceTokens.length); length >= 1; length -= 1) {
    prefixes.push(sourceTokens.slice(-length).join(" "));
  }

  prefixes.forEach((prefix, idx) => {
    const nextCounts = sequenceMap[prefix];
    if (!nextCounts) return;
    const total = Math.max(1, ...Object.values(nextCounts).map((v) => Number(v ?? 0)).concat([0]));
    Object.entries(nextCounts).forEach(([token, count]) => {
      const normalized = normalizeToken(token);
      if (!normalized) return;
      const boost = (Number(count ?? 0) / total) * (1.2 + (prefixes.length - idx) * 0.4);
      outcomeBoosts[normalized] = Number(outcomeBoosts[normalized] ?? 0) + boost;
    });
  });

  return outcomeBoosts;
}

function intentMatchesSentence(intent, sentenceTokens = []) {
  if (!intent || intent === AUTO_SENTENCE_INTENTS.UNKNOWN) return 0.55;
  const intentKeywords = AUTO_SENTENCE_INTENT_KEYWORDS[intent] ?? [];
  const hits = sentenceTokens.filter((token) => intentKeywords.includes(token)).length;
  if (hits === 0) return 0.25;
  return clamp01(0.4 + hits * 0.22);
}

function getDeterministicExplorationValue(seedParts = []) {
  const seed = seedParts.map((entry) => String(entry ?? "")).join("|");
  const hash = hashString(seed);
  return (hash % 1000) / 1000;
}

function buildAutoSentenceWordCache({
  sentenceHistory = [],
  quickPhrases = [],
  wordLookup = {},
  limitPerWord = AUTO_SENTENCE_SUGGESTION_LIMIT,
}) {
  const corpus = [...sentenceHistory.slice(-120), ...quickPhrases.slice(0, MAX_PHRASES)];
  const stats = buildAutoSentenceCorpusStats(corpus);
  const tokenToPhraseMap = {};

  stats.normalizedCorpus.forEach((phrase) => {
    const uniqueTokens = [...new Set(tokenizeText(phrase))];
    uniqueTokens.forEach((token) => {
      if (!tokenToPhraseMap[token]) {
        tokenToPhraseMap[token] = [];
      }
      tokenToPhraseMap[token].push(phrase);
    });
  });

  const cache = {};
  Object.keys(wordLookup).forEach((token) => {
    const memory = (tokenToPhraseMap[token] ?? [])
      .map((sentence) => {
        const normalized = normalizeToken(sentence);
        const count = Number(stats.countMap[normalized] ?? 0);
        const recency = Number(stats.recencyMap[normalized] ?? 0) / stats.maxRecency;
        return { sentence, score: count + recency * 2 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((entry) => entry.sentence);

    const inferredIntent = detectIntentFromTokens([], token, []).intent;
    const templates = getAutoSentenceTemplatePhrases(token, wordLookup, [], inferredIntent)
      .slice(0, 3)
      .map((entry) => entry.sentence);

    cache[token] = mergeUniqueStrings(memory, templates, limitPerWord);
  });

  return cache;
}

function getModelDrivenAutoSentences({
  triggerToken,
  currentTokens = [],
  transitionCounts = {},
  continuationBoosts = {},
  wordLookup = {},
}) {
  if (!triggerToken) return [];
  const candidates = [];
  const seedTokens = currentTokens.length > 0 ? [...currentTokens] : [];

  if (seedTokens.length === 0) {
    const templateSeed = AUTO_SENTENCE_TEMPLATES[triggerToken];
    if (Array.isArray(templateSeed) && templateSeed.length > 1) {
      seedTokens.push(...templateSeed);
    } else {
      seedTokens.push("i", "want", triggerToken);
    }
  } else if (seedTokens[seedTokens.length - 1] !== triggerToken) {
    seedTokens.push(triggerToken);
  }

  const seedPhrase = seedTokens.map((token) => wordLookup[token]?.text ?? token).join(" ");
  candidates.push({
    sentence: seedPhrase,
    source: "model",
    reasonCodes: ["model_expansion", "context_match"],
    contextStrength: currentTokens.length > 0 ? 0.9 : 0.7,
  });

  const lastToken = seedTokens[seedTokens.length - 1];
  const transitionOptions = Object.entries(transitionCounts[lastToken] ?? {})
    .map(([token, count]) => ({
      token: normalizeToken(token),
      count: Number(count ?? 0),
    }))
    .filter((entry) => entry.token && entry.token !== lastToken)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const continuationOptions = Object.entries(continuationBoosts)
    .map(([token, value]) => ({
      token: normalizeToken(token),
      value: Number(value ?? 0),
    }))
    .filter((entry) => entry.token && entry.token !== lastToken)
    .sort((a, b) => b.value - a.value)
    .slice(0, 2);

  const combinedOptions = [...transitionOptions.map((entry) => entry.token), ...continuationOptions.map((entry) => entry.token)];
  const uniqueNextTokens = [...new Set(combinedOptions)].slice(0, 4);

  uniqueNextTokens.forEach((nextToken) => {
    const phraseTokens = [...seedTokens, nextToken];
    const followOptions = Object.entries(transitionCounts[nextToken] ?? {})
      .map(([token, count]) => ({ token: normalizeToken(token), count: Number(count ?? 0) }))
      .filter((entry) => entry.token && entry.token !== nextToken)
      .sort((a, b) => b.count - a.count);
    const followToken = followOptions[0]?.token;
    if (followToken && followToken !== phraseTokens[phraseTokens.length - 1]) {
      phraseTokens.push(followToken);
    }

    const sentence = phraseTokens
      .map((token) => wordLookup[token]?.text ?? token)
      .join(" ")
      .trim();

    candidates.push({
      sentence,
      source: "model",
      reasonCodes: ["model_expansion", "transition_match"],
      contextStrength: currentTokens.length > 0 ? 0.86 : 0.62,
    });
  });

  return candidates;
}

function getAutoSentences({
  tappedWord = "",
  currentSentence = [],
  history = [],
  sentenceEvents = [],
  timeOfDay = getTimeOfDayLabel(new Date()),
  environment = AUTO_SENTENCE_ENVIRONMENTS.HOME,
  therapyGoal = THERAPY_GOALS.BALANCED,
  childProfile = null,
  digitalTwin = null,
  urgencyScore = 0,
  frequentPhrases = [],
  wordTransitions = {},
  usageCounts = {},
  wordLookup = {},
  cacheByWord = {},
  learning = {},
  limit = AUTO_SENTENCE_SUGGESTION_LIMIT,
}) {
  const currentTokens = currentSentence.map((word) => normalizeToken(word?.text)).filter(Boolean);
  const triggerToken = normalizeToken(tappedWord || currentTokens[currentTokens.length - 1] || "");
  if (!triggerToken) return [];

  const corpus = [...history.slice(-120), ...frequentPhrases.slice(0, MAX_PHRASES)];
  const corpusStats = buildAutoSentenceCorpusStats(corpus);
  const detectedIntent = detectIntentFromTokens(currentTokens, triggerToken, history.slice(-20));
  const contextStack = buildContextStack({
    currentTokens,
    sentenceHistory: history,
    sentenceEvents,
    timeOfDay,
    intent: detectedIntent.intent,
    environment,
  });
  const continuationMap = buildContinuationMap(corpusStats.normalizedCorpus, 4);
  const continuationBoosts = getContinuationBoosts(currentTokens, continuationMap, 4);
  const sequenceOutcomeBoosts = getSequenceOutcomeSignals({
    currentTokens,
    triggerToken,
    sentenceHistory: history,
    quickPhrases: frequentPhrases,
  });
  const learningState = applyDailyDecayToAutoSentenceLearning(learning);
  const recentEventTexts = normalizeSentenceEvents(sentenceEvents)
    .slice(-6)
    .map((entry) => normalizeToken(entry.text));
  const timeBoost = Number((TIME_OF_DAY_TOKEN_BOOSTS[timeOfDay] ?? {})[triggerToken] ?? 0);
  const strictPrefixMode =
    currentTokens.length > 1 ||
    (currentTokens.length === 1 && currentTokens[0] !== triggerToken);
  const deduped = new Map();
  const maxTokenUsage = Math.max(1, ...Object.values(usageCounts).map((value) => Number(value ?? 0)));
  const profileFactor = childProfile?.id ? 1 : 0.95;
  const intentShownCount = Number(learningState.intentShownCounts[detectedIntent.intent] ?? 0);
  const intentAcceptedCount = Number(learningState.intentAcceptedCounts[detectedIntent.intent] ?? 0);
  const intentPreference = (intentAcceptedCount + 1) / (intentShownCount + 2);
  const twinIntentPrior = clamp01(Number(digitalTwin?.intents?.[detectedIntent.intent] ?? 0));
  const twinPreferredSet = new Set(
    Array.isArray(digitalTwin?.preferredWords)
      ? digitalTwin.preferredWords.map((token) => normalizeToken(token)).filter(Boolean)
      : []
  );
  const twinRoutineSet = new Set(
    Array.isArray(digitalTwin?.routines?.[timeOfDay])
      ? digitalTwin.routines[timeOfDay].map((token) => normalizeToken(token)).filter(Boolean)
      : []
  );
  const twinPatternKey = currentTokens.slice(-2).join(" ");
  const twinPatternSet = new Set(
    Array.isArray(digitalTwin?.phrasePatterns?.[twinPatternKey])
      ? digitalTwin.phrasePatterns[twinPatternKey].map((token) => normalizeToken(token)).filter(Boolean)
      : []
  );
  const activeClusterTokens =
    AUTO_SENTENCE_BEHAVIOR_CLUSTERS[contextStack.sessionPattern] ?? [];
  const memoryLayers = buildTokenMemoryLayers({
    sentenceHistory: history,
    sentenceEvents,
    usageCounts,
  });
  const conceptRelatedTokens = getConceptRelatedTokens([...currentTokens, triggerToken]);
  const situationTokens = new Set(
    SITUATION_CONTEXT_KEYWORDS[contextStack.situation] ?? []
  );

  function addCandidate({
    sentence,
    source = "memory",
    reasonCodes = [],
    contextStrength = 0.5,
    seedBoost = 0,
  }) {
    const clean = String(sentence ?? "").trim().replace(/\s+/g, " ");
    if (!clean) return;
    const normalizedPhrase = normalizeToken(clean);
    if (!normalizedPhrase) return;
    const phraseTokens = tokenizeText(clean);
    if (phraseTokens.length < 2) return;
    if (!phraseTokens.includes(triggerToken)) return;
    if (strictPrefixMode && !startsWithTokenSequence(phraseTokens, currentTokens)) return;

    const phraseCount = Number(corpusStats.countMap[normalizedPhrase] ?? 0);
    const phraseRecencyIndex = Number(corpusStats.recencyMap[normalizedPhrase] ?? 0);
    const tokenUsage = Number(usageCounts[triggerToken] ?? 0);
    const usageFrequency = clamp01(
      (phraseCount / Math.max(1, corpusStats.maxCount)) * 0.75 +
        (Math.log1p(tokenUsage) / Math.log1p(Math.max(2, maxTokenUsage))) * 0.25
    );
    const recencyUsage = clamp01(phraseRecencyIndex / Math.max(1, corpusStats.maxRecency));

    let transitionRaw = 0;
    for (let index = 1; index < phraseTokens.length; index += 1) {
      transitionRaw += Math.log1p(Number((wordTransitions[phraseTokens[index - 1]] ?? {})[phraseTokens[index]] ?? 0));
    }
    const continuationSignal = Number(
      continuationBoosts[phraseTokens[currentTokens.length] ?? phraseTokens[phraseTokens.length - 1]] ?? 0
    );
    const sequenceSignalRaw = phraseTokens.reduce((sum, token) => {
      return sum + Number(sequenceOutcomeBoosts[token] ?? 0);
    }, 0);
    const sequenceProbability = clamp01(sequenceSignalRaw / Math.max(1.4, phraseTokens.length * 1.8));
    const transitionSignal = clamp01(
      (transitionRaw / 4.2) * 0.52 +
      clamp01(continuationSignal / 2.2) * 0.24 +
      sequenceProbability * 0.24
    );

    const matchedRecentEvent = recentEventTexts.includes(normalizedPhrase) ? 1 : 0;
    const clusterHits = phraseTokens.filter((token) => activeClusterTokens.includes(token)).length;
    const clusterMatch = clamp01(clusterHits / Math.max(1, phraseTokens.length * 0.5));
    const effectiveContext = clamp01(
      contextStrength * 0.68 +
      matchedRecentEvent * 0.18 +
      clusterMatch * 0.14
    );
    const novelty = clamp01(1 - usageFrequency);
    const intentMatch = intentMatchesSentence(detectedIntent.intent, phraseTokens);
    const timeRelevance = clamp01(
      phraseTokens.reduce((sum, token) => sum + Number((TIME_OF_DAY_TOKEN_BOOSTS[timeOfDay] ?? {})[token] ?? 0), 0) /
        Math.max(1.5, phraseTokens.length * 1.8)
    );
    const environmentRelevance = clamp01(
      phraseTokens.reduce(
        (sum, token) => sum + Number((AUTO_SENTENCE_ENVIRONMENT_BOOSTS[environment] ?? {})[token] ?? 0),
        0
      ) / Math.max(1.4, phraseTokens.length * 1.6)
    );

    const shownCount = Number(learningState.shownCounts[normalizedPhrase] ?? 0);
    const acceptedCount = Number(learningState.acceptedCounts[normalizedPhrase] ?? 0);
    const ignoredCount = Number(learningState.ignoredCounts[normalizedPhrase] ?? 0);
    const ignoreRate = shownCount > 0 ? clamp01((shownCount - acceptedCount) / shownCount) : 0;
    const negativeFeedbackPenalty = clamp01((ignoredCount / Math.max(1, shownCount + 1)) * 1.25);
    const acceptanceRate = (acceptedCount + 1) / (shownCount + 2);
    const preferredHits = phraseTokens.filter((token) => twinPreferredSet.has(token)).length;
    const routineHits = phraseTokens.filter((token) => twinRoutineSet.has(token)).length;
    const patternNextToken = phraseTokens[currentTokens.length] ?? "";
    const patternHit = patternNextToken && twinPatternSet.has(patternNextToken) ? 1 : 0;
    const twinMatch = clamp01(
      (preferredHits / Math.max(2, phraseTokens.length)) * 0.4 +
      (routineHits / Math.max(2, phraseTokens.length)) * 0.24 +
      patternHit * 0.2 +
      twinIntentPrior * 0.28
    );
    const personalization = clamp01(
      usageFrequency * 0.38 +
      acceptanceRate * 0.22 +
      intentPreference * 0.2 +
      twinMatch * 0.2
    );
    const shortTermMemory = clamp01(
      phraseTokens.reduce((sum, token) => sum + Number(memoryLayers.shortTerm[token] ?? 0), 0) /
        Math.max(1.6, phraseTokens.length * 1.3)
    );
    const midTermMemory = clamp01(
      phraseTokens.reduce((sum, token) => sum + Number(memoryLayers.midTerm[token] ?? 0), 0) /
        Math.max(1.7, phraseTokens.length * 1.35)
    );
    const longTermMemory = clamp01(
      phraseTokens.reduce((sum, token) => sum + Number(memoryLayers.longTerm[token] ?? 0), 0) /
        Math.max(1.8, phraseTokens.length * 1.4)
    );
    const memoryBlend = clamp01(shortTermMemory * 0.45 + midTermMemory * 0.35 + longTermMemory * 0.2);
    const conceptHits = phraseTokens.filter((token) => conceptRelatedTokens.has(token)).length;
    const situationHits = phraseTokens.filter((token) => situationTokens.has(token)).length;
    const conceptMatch = clamp01(conceptHits / Math.max(1, phraseTokens.length * 0.6));
    const situationMatch = clamp01(
      contextStack.situation === "general"
        ? 0
        : (situationHits / Math.max(1, phraseTokens.length * 0.55)) * clamp01(contextStack.situationScore + 0.2)
    );
    const speedMs = Number(learningState.sentenceSpeedMs[normalizedPhrase] ?? 0);
    const speedSamples = Number(learningState.sentenceSpeedSamples[normalizedPhrase] ?? 0);
    const tapCountAvg = Number(learningState.sentenceTapCountAvg[normalizedPhrase] ?? 0);
    const tapCountSamples = Number(learningState.sentenceTapCountSamples[normalizedPhrase] ?? 0);
    const expectedTapCount = tapCountAvg > 0 && tapCountSamples > 0 ? tapCountAvg : phraseTokens.length;
    const speedPathScore = clamp01(1 / Math.max(1, expectedTapCount));
    const fastPathScore =
      speedMs > 0 && speedSamples > 0
        ? clamp01((1 - Math.min(2800, speedMs) / 2800) * 0.6 + speedPathScore * 0.4)
        : clamp01(speedPathScore * 0.58 + 0.42);

    const layerShown = Number(learningState.layerShownCounts[source] ?? 0);
    const layerAccepted = Number(learningState.layerAcceptedCounts[source] ?? 0);
    const layerSuccess = (layerAccepted + 1) / (layerShown + 2);
    const layerWeight =
      (AUTO_SENTENCE_LAYER_BASE_WEIGHTS[source] ?? 1) * (0.82 + clamp01(layerSuccess) * 0.5);

    const explorationPenalty = clamp01((1 - novelty) * 0.62 + ignoreRate * 0.28);
    const urgencyMatch = clamp01(
      urgencyScore *
        (phraseTokens.includes("help") || phraseTokens.includes("now") || phraseTokens.includes("stop") ? 1 : 0.35)
    );
    const goalNudge =
      therapyGoal === THERAPY_GOALS.EXPAND_VOCABULARY
        ? clamp01(novelty * 0.55 + conceptMatch * 0.25 + (1 - speedPathScore) * 0.2)
        : therapyGoal === THERAPY_GOALS.COMMUNICATION_SPEED
          ? clamp01(speedPathScore * 0.55 + fastPathScore * 0.35 + (1 - novelty) * 0.1)
          : clamp01((novelty + conceptMatch + speedPathScore) / 3);

    let score =
      AUTO_SENTENCE_SCORE_WEIGHTS.frequency * usageFrequency +
      AUTO_SENTENCE_SCORE_WEIGHTS.recency * recencyUsage +
      AUTO_SENTENCE_SCORE_WEIGHTS.intentMatch * intentMatch +
      AUTO_SENTENCE_SCORE_WEIGHTS.contextMatch * effectiveContext +
      AUTO_SENTENCE_SCORE_WEIGHTS.memoryLayers * memoryBlend +
      AUTO_SENTENCE_SCORE_WEIGHTS.conceptMatch * Math.max(conceptMatch, situationMatch) +
      AUTO_SENTENCE_SCORE_WEIGHTS.goalNudge * goalNudge +
      AUTO_SENTENCE_SCORE_WEIGHTS.sequenceProbability * sequenceProbability +
      AUTO_SENTENCE_SCORE_WEIGHTS.timeRelevance *
        Math.max(timeRelevance, clamp01(timeBoost / 3.1), environmentRelevance) +
      AUTO_SENTENCE_SCORE_WEIGHTS.personalization * personalization +
      AUTO_SENTENCE_SCORE_WEIGHTS.fastPath * fastPathScore -
      AUTO_SENTENCE_SCORE_WEIGHTS.explorationPenalty * explorationPenalty -
      AUTO_SENTENCE_SCORE_WEIGHTS.negativePenalty * negativeFeedbackPenalty;
    score += urgencyMatch * 0.08;

    score = score * layerWeight * profileFactor;
    score += Number(seedBoost ?? 0);
    score = clamp01(score);

    const autoReasons = [...reasonCodes];
    if (source === "cache") autoReasons.push("precomputed");
    if (source === "memory") autoReasons.push("common_phrase");
    if (source === "template") autoReasons.push("template_match");
    if (source === "model") autoReasons.push("model_expansion");
    if (intentMatch >= 0.65) autoReasons.push("intent_match");
    if (sequenceProbability >= 0.52) autoReasons.push("sequence_match");
    if (clusterMatch >= 0.4) autoReasons.push("cluster_match");
    if (usageFrequency >= 0.38) autoReasons.push("common_phrase");
    if (recencyUsage >= 0.45) autoReasons.push("recent_usage");
    if (transitionSignal >= 0.45) autoReasons.push("transition_match");
    if (effectiveContext >= 0.72) autoReasons.push("context_match");
    if (memoryBlend >= 0.5) autoReasons.push("memory_layers");
    if (personalization >= 0.62) autoReasons.push("personalization");
    if (twinMatch >= 0.45) autoReasons.push("twin_match");
    if (conceptMatch >= 0.45) autoReasons.push("concept_match");
    if (situationMatch >= 0.5) autoReasons.push("situation_match");
    if (goalNudge >= 0.52) autoReasons.push("goal_nudge");
    if (speedPathScore >= 0.7) autoReasons.push("speed_path");
    if (urgencyMatch >= 0.42) autoReasons.push("urgency_match");
    if (timeRelevance >= 0.42 || timeBoost >= 1.5) autoReasons.push("time_context");
    if (environmentRelevance >= 0.45) autoReasons.push("context_match");
    if (fastPathScore >= 0.62) autoReasons.push("fast_path");
    if (negativeFeedbackPenalty >= 0.26) autoReasons.push("negative_feedback");
    if (novelty >= 0.74) autoReasons.push("exploration");

    const nextEntry = {
      sentence: clean,
      source,
      score,
      confidenceScore: score,
      confidence: getAutoSentenceConfidenceLabel(score),
      confidenceDots: getAutoSentenceConfidenceDots(score),
      reasonCodes: [...new Set(autoReasons)].slice(0, 4),
      reason: [...new Set(autoReasons)].slice(0, 4),
      reasonText: summarizeAutoSentenceReasons(autoReasons),
      intent: detectedIntent.intent,
      context: contextStack,
      details: [
        { label: "Intent", value: detectedIntent.intent },
        { label: "Source layer", value: source },
        { label: "Usage frequency", value: usageFrequency.toFixed(2) },
        { label: "Recent usage", value: recencyUsage.toFixed(2) },
        { label: "Intent match", value: intentMatch.toFixed(2) },
        { label: "Sequence probability", value: sequenceProbability.toFixed(2) },
        { label: "Transition signal", value: transitionSignal.toFixed(2) },
        { label: "Context match", value: effectiveContext.toFixed(2) },
        { label: "Situation context", value: `${contextStack.situation} (${situationMatch.toFixed(2)})` },
        { label: "Cluster match", value: clusterMatch.toFixed(2) },
        { label: "Short-term memory", value: shortTermMemory.toFixed(2) },
        { label: "Mid-term memory", value: midTermMemory.toFixed(2) },
        { label: "Long-term memory", value: longTermMemory.toFixed(2) },
        { label: "Memory blend", value: memoryBlend.toFixed(2) },
        { label: "Concept match", value: conceptMatch.toFixed(2) },
        { label: "Goal nudge", value: goalNudge.toFixed(2) },
        { label: "Time relevance", value: timeRelevance.toFixed(2) },
        { label: "Environment relevance", value: environmentRelevance.toFixed(2) },
        { label: "Personalization", value: personalization.toFixed(2) },
        { label: "Digital twin match", value: twinMatch.toFixed(2) },
        { label: "Twin intent prior", value: twinIntentPrior.toFixed(2) },
        { label: "Speed path", value: speedPathScore.toFixed(2) },
        { label: "Fast path score", value: fastPathScore.toFixed(2) },
        { label: "Urgency match", value: urgencyMatch.toFixed(2) },
        { label: "Acceptance rate", value: `${Math.round(acceptanceRate * 100)}%` },
        { label: "Ignore rate", value: `${Math.round(ignoreRate * 100)}%` },
        { label: "Negative penalty", value: negativeFeedbackPenalty.toFixed(2) },
        { label: "Exploration penalty", value: explorationPenalty.toFixed(2) },
        { label: "Layer success", value: `${Math.round(layerSuccess * 100)}%` },
        { label: "Weighted score", value: score.toFixed(2) },
      ],
    };

    const previous = deduped.get(normalizedPhrase);
    if (!previous || nextEntry.score > previous.score) {
      deduped.set(normalizedPhrase, nextEntry);
    }
  }

  const fromCache = cacheByWord[triggerToken] ?? [];
  fromCache.forEach((entry) => {
    addCandidate({
      sentence: entry,
      source: "cache",
      reasonCodes: ["common_phrase", "intent_match"],
      contextStrength: currentTokens.length > 0 ? 0.86 : 0.64,
      seedBoost: 0.06,
    });
  });

  corpusStats.normalizedCorpus.forEach((phrase) => {
    const tokens = tokenizeText(phrase);
    if (!tokens.includes(triggerToken)) return;
    const contextStrength =
      currentTokens.length === 0
        ? 0.64
        : strictPrefixMode
          ? startsWithTokenSequence(tokens, currentTokens)
            ? 1
            : includesTokenSequence(tokens, currentTokens)
              ? 0.56
              : 0.18
          : includesTokenSequence(tokens, currentTokens)
            ? 0.72
            : 0.28;
    addCandidate({
      sentence: phrase,
      source: "memory",
      reasonCodes: ["common_phrase", "sequence_match"],
      contextStrength,
      seedBoost: currentTokens.length === 0 ? 0.02 : 0.05,
    });
  });

  getAutoSentenceTemplatePhrases(
    triggerToken,
    wordLookup,
    currentTokens,
    detectedIntent.intent
  ).forEach((entry) => {
    addCandidate({
      sentence: entry.sentence,
      source: entry.source,
      reasonCodes: [...entry.reasonCodes, "intent_match"],
      contextStrength: entry.contextStrength,
    });
  });

  applyBrainTemplates({
    tappedWord: triggerToken,
    intent: detectedIntent.intent,
  }).forEach((sentence) => {
    addCandidate({
      sentence,
      source: "template",
      reasonCodes: ["template_match", "intent_match", "goal_nudge"],
      contextStrength: currentTokens.length > 0 ? 0.8 : 0.62,
      seedBoost: 0.03,
    });
  });

  getBrainConceptExpansions({
    tappedWord: triggerToken,
    currentSentence: currentTokens,
  }).forEach((sentence) => {
    addCandidate({
      sentence,
      source: "model",
      reasonCodes: ["concept_match", "exploration"],
      contextStrength: 0.66,
      seedBoost: 0.02,
    });
  });

  const sequenceOptions = Object.entries(sequenceOutcomeBoosts)
    .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
    .slice(0, 3)
    .map(([token]) => normalizeToken(token))
    .filter(Boolean);
  sequenceOptions.forEach((token) => {
    const phraseTokens = currentTokens.length > 0 ? [...currentTokens] : ["i", "want"];
    if (phraseTokens[phraseTokens.length - 1] !== triggerToken) {
      phraseTokens.push(triggerToken);
    }
    phraseTokens.push(token);
    const sentence = phraseTokens.map((entry) => wordLookup[entry]?.text ?? entry).join(" ");
    addCandidate({
      sentence,
      source: "model",
      reasonCodes: ["sequence_match", "context_match"],
      contextStrength: 0.84,
      seedBoost: 0.04,
    });
  });

  getModelDrivenAutoSentences({
    triggerToken,
    currentTokens,
    transitionCounts: wordTransitions,
    continuationBoosts,
    wordLookup,
  }).forEach((entry) => {
    addCandidate({
      sentence: entry.sentence,
      source: entry.source,
      reasonCodes: entry.reasonCodes,
      contextStrength: entry.contextStrength,
    });
  });

  const ranked = [...deduped.values()]
    .sort((a, b) => b.score - a.score || a.sentence.localeCompare(b.sentence))
    .slice(0, Math.max(limit + 2, 8));

  if (ranked.length === 0) return [];
  const scores = ranked.map((entry) => Number(entry.score ?? 0));
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const scoreRange = Math.max(0.001, maxScore - minScore);
  const calibrated = ranked.map((entry) => {
    const normalized = clamp01((Number(entry.score ?? 0) - minScore) / scoreRange);
    const calibratedScore = clamp01(normalized * 0.65 + Number(entry.confidenceScore ?? 0) * 0.35);
    const nextDetails = [
      ...(Array.isArray(entry.details)
        ? entry.details.filter((item) => String(item?.label ?? "") !== "Calibrated confidence")
        : []),
      { label: "Calibrated confidence", value: calibratedScore.toFixed(2) },
    ];
    return {
      ...entry,
      confidenceScore: calibratedScore,
      confidence: getAutoSentenceConfidenceLabel(calibratedScore),
      confidenceDots: getAutoSentenceConfidenceDots(calibratedScore),
      details: nextDetails,
    };
  });

  const explorationSeedValue = getDeterministicExplorationValue([
    childProfile?.id,
    triggerToken,
    contextStack.sessionPattern,
    getTodayKey(),
    currentTokens.join(" "),
  ]);
  let adjusted = calibrated.slice(0, limit);

  if (explorationSeedValue < AUTO_SENTENCE_EXPLORATION_RATE && calibrated.length > limit) {
    const explorationCandidate = calibrated
      .slice(limit)
      .find((entry) => entry.reasonCodes.includes("exploration"));
    if (explorationCandidate) {
      adjusted = [...adjusted.slice(0, Math.max(0, limit - 1)), explorationCandidate]
        .sort((a, b) => b.confidenceScore - a.confidenceScore);
    }
  }

  const productionRank = rankBrainCandidates({
    candidates: adjusted.map((entry) => ({
      sentence: entry.sentence,
      tapCount: tokenizeText(entry.sentence).length,
    })),
    context: {
      recentSentences: history.slice(-30),
      timeOfDay,
    },
    intent: detectedIntent.intent,
    model: {
      phraseFrequency: learningState.acceptedCounts,
      transitions: wordTransitions,
      wordFrequency: usageCounts,
      timePatterns: {
        [timeOfDay]: [...twinRoutineSet],
      },
    },
    limit,
  });
  const productionByPhrase = productionRank.reduce((lookup, entry) => {
    lookup[normalizeToken(entry.sentence)] = Number(entry.score ?? 0);
    return lookup;
  }, {});

  adjusted = adjusted
    .map((entry) => {
      const productionScore = Number(productionByPhrase[normalizeToken(entry.sentence)] ?? 0);
      if (productionScore <= 0) return entry;

      const nextScore = clamp01(
        Number(entry.confidenceScore ?? 0) * 0.72 + productionScore * 0.28
      );
      return {
        ...entry,
        score: nextScore,
        confidenceScore: nextScore,
        confidence: getAutoSentenceConfidenceLabel(nextScore),
        confidenceDots: getAutoSentenceConfidenceDots(nextScore),
        details: [
          ...(Array.isArray(entry.details) ? entry.details : []),
          { label: "Production brain score", value: productionScore.toFixed(2) },
        ],
      };
    })
    .sort((a, b) => b.confidenceScore - a.confidenceScore || a.sentence.localeCompare(b.sentence));

  const top = adjusted[0];
  const second = adjusted[1];
  if (
    top &&
    top.confidenceScore >= AUTO_SENTENCE_HIGH_CONFIDENCE_THRESHOLD &&
    (!second || top.confidenceScore - Number(second.confidenceScore ?? 0) >= 0.16)
  ) {
    return [top];
  }

  return adjusted;
}

function getDateKeyOffset(daysAgo) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getSevenDayAverage(dailySentenceCounts) {
  let sum = 0;
  for (let offset = 0; offset < 7; offset += 1) {
    const key = getDateKeyOffset(offset);
    sum += dailySentenceCounts[key] ?? 0;
  }
  return sum / 7;
}

function getGoalStreak(dailySentenceCounts, dailySentenceGoal) {
  let streak = 0;
  for (let offset = 0; offset < 365; offset += 1) {
    const key = getDateKeyOffset(offset);
    const count = dailySentenceCounts[key] ?? 0;
    if (count < dailySentenceGoal) break;
    streak += 1;
  }
  return streak;
}

function getSuggestedGoal(dailySentenceCounts, fallbackGoal) {
  const avg = getSevenDayAverage(dailySentenceCounts);
  const suggested = Math.round(Math.max(3, Math.min(40, avg * 1.15)));
  return Number.isFinite(suggested) && suggested > 0 ? suggested : fallbackGoal;
}

function getAdaptivePhrases(sentenceHistory, quickPhrases, limit = 4) {
  const quickPhraseSet = new Set(quickPhrases.map((phrase) => normalizeToken(phrase)));
  const counts = new Map();

  sentenceHistory.forEach((entry, index) => {
    const phrase = String(entry ?? "").trim();
    if (!phrase) return;

    const normalized = normalizeToken(phrase);
    if (quickPhraseSet.has(normalized)) return;
    if (phrase.split(/\s+/).length < 2) return;

    const previous = counts.get(normalized);
    if (previous) {
      counts.set(normalized, { text: previous.text, count: previous.count + 1, latestIndex: index });
      return;
    }

    counts.set(normalized, { text: phrase, count: 1, latestIndex: index });
  });

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || b.latestIndex - a.latestIndex)
    .slice(0, limit)
    .map((entry) => entry.text);
}

function getRecentDaySeries(dailySentenceCounts, days = 14) {
  const series = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = getDateKeyOffset(offset);
    const [year, month, day] = key.split("-");
    const label = `${Number(month)}/${Number(day)}`;

    series.push({
      key,
      label,
      count: Number(dailySentenceCounts[key] ?? 0),
      isoDate: `${year}-${month}-${day}`,
    });
  }

  return series;
}

function getAnticipatedWordSuggestions({
  sentenceHistory = [],
  transitionCounts = {},
  quickPhrases = [],
  wordLookup = {},
  limit = 4,
}) {
  const latestPhrase = String(sentenceHistory[sentenceHistory.length - 1] ?? "").trim();
  const latestTokens = tokenizeText(latestPhrase);
  if (latestTokens.length === 0) return [];

  const candidateScores = {};
  const lastToken = latestTokens[latestTokens.length - 1];
  const secondLastToken = latestTokens[latestTokens.length - 2] ?? "";

  Object.entries(transitionCounts[lastToken] ?? {}).forEach(([token, count]) => {
    const normalized = normalizeToken(token);
    if (!normalized) return;
    candidateScores[normalized] = Number(candidateScores[normalized] ?? 0) + Math.log1p(Number(count ?? 0)) * 1.8;
  });
  if (secondLastToken) {
    Object.entries(transitionCounts[secondLastToken] ?? {}).forEach(([token, count]) => {
      const normalized = normalizeToken(token);
      if (!normalized) return;
      candidateScores[normalized] = Number(candidateScores[normalized] ?? 0) + Math.log1p(Number(count ?? 0)) * 0.6;
    });
  }

  const phraseStarts = {};
  [...quickPhrases.slice(0, MAX_PHRASES), ...sentenceHistory.slice(-80)].forEach((phrase) => {
    const tokens = tokenizeText(phrase);
    if (tokens.length < 2) return;
    const start = tokens[0];
    const next = tokens[1];
    const key = `${start}::${next}`;
    phraseStarts[key] = Number(phraseStarts[key] ?? 0) + 1;
  });
  Object.entries(phraseStarts).forEach(([pair, count]) => {
    const [start, next] = pair.split("::");
    if (start !== lastToken) return;
    candidateScores[next] = Number(candidateScores[next] ?? 0) + Math.log1p(Number(count ?? 0)) * 1.1;
  });

  const conceptRelated = getConceptRelatedTokens(latestTokens);
  conceptRelated.forEach((token) => {
    candidateScores[token] = Number(candidateScores[token] ?? 0) + 0.65;
  });

  return Object.entries(candidateScores)
    .map(([token, score]) => ({
      token,
      score: Number(score ?? 0),
    }))
    .filter((entry) => entry.token && !latestTokens.includes(entry.token))
    .sort((a, b) => b.score - a.score || a.token.localeCompare(b.token))
    .slice(0, limit)
    .map((entry) => {
      const word = wordLookup[entry.token] ?? {
        text: entry.token,
        emoji: "🔤",
      };
      return {
        word,
        reason: "Anticipated from recent phrase flow",
      };
    });
}

function getTopRepeatedPhrases(sentenceHistory, limit = 6) {
  const phraseMap = new Map();

  sentenceHistory.forEach((entry, index) => {
    const phrase = String(entry ?? "").trim();
    if (!phrase) return;
    if (tokenizeText(phrase).length < 2) return;

    const normalized = normalizeToken(phrase);
    const previous = phraseMap.get(normalized);

    if (previous) {
      phraseMap.set(normalized, {
        phrase: previous.phrase,
        count: previous.count + 1,
        latestIndex: index,
      });
      return;
    }

    phraseMap.set(normalized, { phrase, count: 1, latestIndex: index });
  });

  return [...phraseMap.values()]
    .sort((a, b) => b.count - a.count || b.latestIndex - a.latestIndex)
    .slice(0, limit);
}

function addPhraseToList(phrase, existingPhrases, maxPhrases = MAX_PHRASES) {
  const cleanPhrase = String(phrase ?? "").trim();
  if (!cleanPhrase) return existingPhrases;
  const normalized = normalizeToken(cleanPhrase);
  const deduped = existingPhrases.filter((item) => normalizeToken(item) !== normalized);
  return [cleanPhrase, ...deduped].slice(0, maxPhrases);
}

function playTapTone() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, audioContext.currentTime);
    gainNode.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.05, audioContext.currentTime + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.08);

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.09);
  } catch (error) {
    console.error("Tap tone playback failed:", error);
  }
}

export default function ParentPage() {
  const navigate = useNavigate();
  const {
    user,
    roles,
    signOut,
    hasAnyRole,
    planTier,
    hasFeature,
    getPlanLimit,
    openBillingPortal,
    stripeCustomerId,
  } = useAuth();
  const ownerId = user?.uid ?? "guest";
  const activePlan = getBillingPlan(planTier);
  const maxChildrenAllowed = Number(getPlanLimit("maxChildren") ?? 1);
  const canUseBackupTools = hasFeature(BILLING_FEATURES.BACKUP_TOOLS);
  const canUseAutoSpeak = hasFeature(BILLING_FEATURES.AUTO_SPEAK);

  const [sentence, setSentence] = useState([]);
  const [customWords, setCustomWords] = useState([]);
  const [sentenceHistory, setSentenceHistory] = useState([]);
  const [sentenceEvents, setSentenceEvents] = useState([]);
  const [speakLatencyMsHistory, setSpeakLatencyMsHistory] = useState([]);
  const [autoSentenceLearning, setAutoSentenceLearning] = useState(createDefaultAutoSentenceLearning());
  const [usageCounts, setUsageCounts] = useState({});
  const [transitionCounts, setTransitionCounts] = useState({});
  const [favoriteTokens, setFavoriteTokens] = useState([]);
  const [quickPhrases, setQuickPhrases] = useState(DEFAULT_QUICK_PHRASES);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [wordSearch, setWordSearch] = useState("");
  const [wordFilter, setWordFilter] = useState("all");
  const [activeCategory, setActiveCategory] = useState(DEFAULT_CATEGORY);
  const [activeSubBoard, setActiveSubBoard] = useState(DEFAULT_SUB_BOARD);
  const [largeTileMode, setLargeTileMode] = useState(false);
  const [scanMode, setScanMode] = useState(false);
  const [holdToSelect, setHoldToSelect] = useState(false);
  const [scanIntervalMs, setScanIntervalMs] = useState(DEFAULT_SCAN_INTERVAL_MS);
  const [speechRate, setSpeechRate] = useState(0.9);
  const [speechPitch, setSpeechPitch] = useState(1);
  const [speechVolume, setSpeechVolume] = useState(1);
  const [speechLanguage, setSpeechLanguage] = useState("en");
  const [dualLanguageMode, setDualLanguageMode] = useState(false);
  const [autoDetectVoice, setAutoDetectVoice] = useState(true);
  const [ttsProvider, setTtsProvider] = useState(TTS_PROVIDERS.BROWSER);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState("");
  const [availableVoices, setAvailableVoices] = useState([]);
  const [dualLanguageSentence, setDualLanguageSentence] = useState("");
  const [dualLanguageLoading, setDualLanguageLoading] = useState(false);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState("child");
  const [tapSoundEnabled, setTapSoundEnabled] = useState(false);
  const [tapFlashEnabled, setTapFlashEnabled] = useState(true);
  const [flashedWordToken, setFlashedWordToken] = useState("");
  const [pinnedPhraseTokens, setPinnedPhraseTokens] = useState([]);
  const [phraseUsageCounts, setPhraseUsageCounts] = useState({});
  const [recentPhraseUsage, setRecentPhraseUsage] = useState([]);
  const [childPhrasesCollapsed, setChildPhrasesCollapsed] = useState(false);
  const [progressiveDisclosureEnabled, setProgressiveDisclosureEnabled] = useState(true);
  const [topWordsMode, setTopWordsMode] = useState(false);
  const [smartHidingEnabled, setSmartHidingEnabled] = useState(true);
  const [adaptiveDifficulty, setAdaptiveDifficulty] = useState(DIFFICULTY_LEVELS.INTERMEDIATE);
  const [therapyGoal, setTherapyGoal] = useState(THERAPY_GOALS.BALANCED);
  const [autoSentenceMode, setAutoSentenceMode] = useState(true);
  const [autoSentenceSelectionMode, setAutoSentenceSelectionMode] = useState(
    AUTO_SENTENCE_SELECTION_MODES.REPLACE
  );
  const [environmentContext, setEnvironmentContext] = useState(AUTO_SENTENCE_ENVIRONMENTS.HOME);
  const [showAllDisclosedWords, setShowAllDisclosedWords] = useState(false);
  const [alternateWordLabel, setAlternateWordLabel] = useState("");
  const [alternateWordSuggestions, setAlternateWordSuggestions] = useState([]);
  const [sentenceBuildStartedAt, setSentenceBuildStartedAt] = useState(null);
  const [speakReactionEmoji, setSpeakReactionEmoji] = useState("");
  const [microReinforcement, setMicroReinforcement] = useState("");
  const [anticipatedWords, setAnticipatedWords] = useState([]);
  const [tapPulse, setTapPulse] = useState(0);
  const [cursorMode, setCursorMode] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [lastAddedIndex, setLastAddedIndex] = useState(-1);
  const [showFirebaseWarning, setShowFirebaseWarning] = useState(true);
  const [scanIndex, setScanIndex] = useState(0);
  const [dailySentenceGoal, setDailySentenceGoal] = useState(8);
  const [dailySentenceCounts, setDailySentenceCounts] = useState({});
  const [childProfiles, setChildProfiles] = useState([DEFAULT_CHILD_PROFILE]);
  const [activeChildId, setActiveChildId] = useState(DEFAULT_CHILD_PROFILE.id);
  const [childProfilesReady, setChildProfilesReady] = useState(false);
  const [modelHydratedKey, setModelHydratedKey] = useState("");
  const [preferenceHydratedKey, setPreferenceHydratedKey] = useState("");
  const [wordsHydratedKey, setWordsHydratedKey] = useState("");
  const [brainCacheHydratedKey, setBrainCacheHydratedKey] = useState("");
  const [localSuggestionCache, setLocalSuggestionCache] = useState({});
  const [syncStatus, setSyncStatus] = useState("offline");
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [openWhyKey, setOpenWhyKey] = useState("");
  const holdSelectTimeoutRef = useRef(null);
  const phraseHoldTimeoutRef = useRef(null);
  const phraseLongPressTriggeredRef = useRef(false);
  const autoSentenceHoldTimeoutRef = useRef(null);
  const autoSentenceLongPressTriggeredRef = useRef(false);
  const autoSentenceSeenSignatureRef = useRef("");
  const autoSentenceLastPresentedRef = useRef([]);
  const autoSentenceLastAcceptedRef = useRef("");
  const lastAcceptedAutoSentenceMetaRef = useRef(null);
  const wordLongPressTimeoutRef = useRef(null);
  const wordLongPressTriggeredRef = useRef(false);
  const recentWordTapTimestampsRef = useRef([]);
  const lastRemovedTokenRef = useRef("");
  const gestureStartRef = useRef(null);
  const lastGestureTapRef = useRef(0);

  const childProfilesKey = useMemo(() => `aac-child-profiles:${ownerId}`, [ownerId]);
  const smartModelKey = useMemo(
    () => `aac-smart-model:${ownerId}:${activeChildId}`,
    [ownerId, activeChildId]
  );
  const preferenceKey = useMemo(
    () => `aac-preferences:${ownerId}:${activeChildId}`,
    [ownerId, activeChildId]
  );
  const childWordsKey = useMemo(
    () => `aac-custom-words:${ownerId}:${activeChildId}`,
    [ownerId, activeChildId]
  );
  const brainCacheKey = useMemo(
    () => `aac-brain-cache:${ownerId}:${activeChildId}`,
    [ownerId, activeChildId]
  );
  const activeChildProfile = useMemo(
    () => childProfiles.find((profile) => profile.id === activeChildId) ?? childProfiles[0] ?? DEFAULT_CHILD_PROFILE,
    [childProfiles, activeChildId]
  );
  const canSyncCloud = Boolean(user && !usingPlaceholderFirebaseConfig);
  const childDocRef = useMemo(
    () => doc(db, "users", ownerId, "children", activeChildId),
    [ownerId, activeChildId]
  );

  useEffect(() => {
    const parsed = parseLocalBrainCache(localStorage.getItem(brainCacheKey) ?? "");
    setLocalSuggestionCache(parsed.cachedSuggestions ?? {});
    setBrainCacheHydratedKey(brainCacheKey);

    if (parsed.lastSync) {
      const parsedDate = new Date(parsed.lastSync);
      if (!Number.isNaN(parsedDate.getTime())) {
        setLastSyncedAt(parsedDate);
      }
    }
  }, [brainCacheKey]);

  useEffect(() => {
    if (brainCacheHydratedKey !== brainCacheKey) return;
    const payload = buildLocalBrainCache({
      childId: activeChildId,
      cachedSuggestions: localSuggestionCache,
      lastSync: lastSyncedAt ? lastSyncedAt.toISOString() : null,
    });
    localStorage.setItem(brainCacheKey, JSON.stringify(payload));
  }, [
    brainCacheHydratedKey,
    brainCacheKey,
    activeChildId,
    localSuggestionCache,
    lastSyncedAt,
  ]);

  useEffect(() => {
    let cancelled = false;
    setChildProfilesReady(false);

    async function loadChildProfiles() {
      let localProfiles = [DEFAULT_CHILD_PROFILE];
      let localActiveId = DEFAULT_CHILD_PROFILE.id;

      try {
        const rawProfiles = localStorage.getItem(childProfilesKey);
        if (rawProfiles) {
          const parsed = JSON.parse(rawProfiles);
          const profiles = Array.isArray(parsed.profiles) && parsed.profiles.length > 0
            ? parsed.profiles
                .map((profile) => ({
                  id: String(profile?.id ?? ""),
                  name: String(profile?.name ?? "").trim() || "Child",
                }))
                .filter((profile) => profile.id)
            : [DEFAULT_CHILD_PROFILE];

          localProfiles = profiles.length > 0 ? profiles : [DEFAULT_CHILD_PROFILE];
          localActiveId =
            localProfiles.find((profile) => profile.id === String(parsed.activeChildId ?? ""))?.id ??
            localProfiles[0].id;
        }
      } catch (error) {
        console.error("Failed to load child profiles from local storage:", error);
      }

      if (!cancelled) {
        setChildProfiles(localProfiles);
        setActiveChildId(localActiveId);
      }

      if (!canSyncCloud) {
        if (!cancelled) {
          setSyncStatus("offline");
          setChildProfilesReady(true);
        }
        return;
      }

      if (!cancelled) {
        setSyncStatus("syncing");
      }

      try {
        const snapshot = await getDocs(collection(db, "users", ownerId, "children"));
        const cloudProfiles = snapshot.docs.map((cloudDoc) => ({
          id: cloudDoc.id,
          name: String(cloudDoc.data()?.profile?.name ?? cloudDoc.data()?.name ?? "").trim() || "Child",
        }));

        const mergedProfiles =
          cloudProfiles.length > 0 ? mergeProfiles(localProfiles, cloudProfiles) : localProfiles;
        const mergedActiveId =
          mergedProfiles.find((profile) => profile.id === localActiveId)?.id ?? mergedProfiles[0]?.id;

        if (!cancelled) {
          setChildProfiles(mergedProfiles.length > 0 ? mergedProfiles : [DEFAULT_CHILD_PROFILE]);
          setActiveChildId(mergedActiveId ?? DEFAULT_CHILD_PROFILE.id);
          setSyncStatus("synced");
          setLastSyncedAt(new Date());
        }
      } catch (error) {
        console.error("Failed to load child profiles from Firestore:", error);
        if (!cancelled) {
          setSyncStatus("error");
        }
      } finally {
        if (!cancelled) {
          setChildProfilesReady(true);
        }
      }
    }

    loadChildProfiles();

    return () => {
      cancelled = true;
    };
  }, [childProfilesKey, canSyncCloud, ownerId]);

  useEffect(() => {
    if (!childProfilesReady) return;

    const profilesPayload =
      Array.isArray(childProfiles) && childProfiles.length > 0 ? childProfiles : [DEFAULT_CHILD_PROFILE];
    const activeId = profilesPayload.find((profile) => profile.id === activeChildId)?.id ?? profilesPayload[0].id;

    localStorage.setItem(
      childProfilesKey,
      JSON.stringify({
        profiles: profilesPayload,
        activeChildId: activeId,
      })
    );

    if (!canSyncCloud) return;

    let cancelled = false;

    async function syncProfilesToCloud() {
      setSyncStatus("syncing");
      try {
        const childrenCollection = collection(db, "users", ownerId, "children");
        const cloudSnapshot = await getDocs(childrenCollection);
        const cloudIds = new Set(cloudSnapshot.docs.map((entry) => entry.id));
        const localIds = new Set(profilesPayload.map((profile) => profile.id));

        await Promise.all(
          profilesPayload.map((profile) =>
            setDoc(
              doc(db, "users", ownerId, "children", profile.id),
              {
                name: profile.name,
                profile: {
                  name: profile.name,
                },
                updatedAt: serverTimestamp(),
              },
              { merge: true }
            )
          )
        );

        await Promise.all(
          [...cloudIds]
            .filter((cloudId) => !localIds.has(cloudId))
            .map((cloudId) => deleteDoc(doc(db, "users", ownerId, "children", cloudId)))
        );

        if (!cancelled) {
          setSyncStatus("synced");
          setLastSyncedAt(new Date());
        }
      } catch (error) {
        console.error("Failed to sync child profiles to Firestore:", error);
        if (!cancelled) {
          setSyncStatus("error");
        }
      }
    }

    syncProfilesToCloud();

    return () => {
      cancelled = true;
    };
  }, [childProfilesKey, childProfiles, activeChildId, childProfilesReady, canSyncCloud, ownerId]);

  useEffect(() => {
    setSentence([]);
    setWordSearch("");
    setWordFilter("all");
    setActiveCategory(DEFAULT_CATEGORY);
    setActiveSubBoard(DEFAULT_SUB_BOARD);
    setCursorIndex(0);
    setLastAddedIndex(-1);
    setFlashedWordToken("");
    setScanIndex(0);
    setOpenWhyKey("");
    setShowAllDisclosedWords(false);
    setAlternateWordLabel("");
    setAlternateWordSuggestions([]);
    setAnticipatedWords([]);
    setMicroReinforcement("");
    recentWordTapTimestampsRef.current = [];
    lastRemovedTokenRef.current = "";
    setSentenceBuildStartedAt(null);
    autoSentenceSeenSignatureRef.current = "";
    autoSentenceLastPresentedRef.current = [];
    autoSentenceLastAcceptedRef.current = "";
    lastAcceptedAutoSentenceMetaRef.current = null;
  }, [activeChildId]);

  useEffect(() => {
    if (adaptiveDifficulty === DIFFICULTY_LEVELS.BEGINNER) {
      setProgressiveDisclosureEnabled(true);
      setTopWordsMode(true);
      setSmartHidingEnabled(true);
      setAutoSentenceMode(true);
      return;
    }

    if (adaptiveDifficulty === DIFFICULTY_LEVELS.INTERMEDIATE) {
      setProgressiveDisclosureEnabled(true);
      setTopWordsMode(false);
      setSmartHidingEnabled(true);
      return;
    }

    setProgressiveDisclosureEnabled(false);
    setTopWordsMode(false);
    setSmartHidingEnabled(false);
  }, [adaptiveDifficulty]);

  useEffect(() => {
    async function loadWords() {
      let localWords = [];

      try {
        const parsedLocalWords = JSON.parse(localStorage.getItem(childWordsKey) ?? "[]");
        if (Array.isArray(parsedLocalWords)) {
          localWords = mergeWordLists(parsedLocalWords, []);
          setCustomWords(localWords);
        } else {
          setCustomWords([]);
        }
      } catch (error) {
        console.error("Failed to load local child words:", error);
        setCustomWords([]);
      }

      if (usingPlaceholderFirebaseConfig) {
        setWordsHydratedKey(childWordsKey);
        return;
      }

      try {
        const childSnapshot = await getDoc(childDocRef);
        const structuredWords = mergeWordLists(
          Array.isArray(childSnapshot.data()?.words?.custom) ? childSnapshot.data()?.words?.custom : [],
          []
        );
        const querySnapshot = await getDocs(
          collection(db, "users", ownerId, "children", activeChildId, "words")
        );
        const cloudWords = mergeWordLists(
          querySnapshot.docs.map((entry) => entry.data()),
          []
        );
        const mergedWords = mergeWordLists(localWords, mergeWordLists(structuredWords, cloudWords));
        setCustomWords(mergedWords);
        localStorage.setItem(childWordsKey, JSON.stringify(mergedWords));
        setWordsHydratedKey(childWordsKey);
      } catch (error) {
        console.error("Failed to load words from Firestore:", error);
        setWordsHydratedKey(childWordsKey);
      }
    }

    loadWords();
  }, [childWordsKey, activeChildId, ownerId, childDocRef]);

  useEffect(() => {
    if (wordsHydratedKey !== childWordsKey) return;
    localStorage.setItem(
      childWordsKey,
      JSON.stringify(mergeWordLists(customWords, []))
    );
  }, [childWordsKey, customWords, wordsHydratedKey]);

  useEffect(() => {
    if (wordsHydratedKey !== childWordsKey) return;
    if (!canSyncCloud) return;

    let cancelled = false;
    async function syncStructuredWords() {
      try {
        setSyncStatus("syncing");
        await setDoc(
          childDocRef,
          {
            words: {
              custom: mergeWordLists(customWords, []),
            },
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        if (!cancelled) {
          setSyncStatus("synced");
          setLastSyncedAt(new Date());
        }
      } catch (error) {
        console.error("Failed to sync structured words:", error);
        if (!cancelled) {
          setSyncStatus("error");
        }
      }
    }

    syncStructuredWords();

    return () => {
      cancelled = true;
    };
  }, [wordsHydratedKey, childWordsKey, canSyncCloud, childDocRef, customWords]);

  useEffect(() => {
    let cancelled = false;

    async function loadSmartModel() {
      let localModel = {
        usageCounts: {},
        transitionCounts: {},
        sentenceHistory: [],
        sentenceEvents: [],
        speakLatencyMsHistory: [],
        autoSentenceLearning: createDefaultAutoSentenceLearning(),
      };

      try {
        const rawModel = localStorage.getItem(smartModelKey);
        if (rawModel) {
          const parsed = JSON.parse(rawModel);
          localModel = {
            usageCounts: parsed.usageCounts ?? {},
            transitionCounts: parsed.transitionCounts ?? {},
            sentenceHistory: Array.isArray(parsed.sentenceHistory) ? parsed.sentenceHistory : [],
            sentenceEvents: normalizeSentenceEvents(parsed.sentenceEvents ?? []),
            speakLatencyMsHistory: mergeLatencyHistory(parsed.speakLatencyMsHistory ?? [], []),
            autoSentenceLearning: normalizeAutoSentenceLearning(parsed.autoSentenceLearning ?? {}),
          };
        }
      } catch (error) {
        console.error("Failed to load smart model from local storage:", error);
      }

      if (!cancelled) {
        setUsageCounts(localModel.usageCounts);
        setTransitionCounts(localModel.transitionCounts);
        setSentenceHistory(localModel.sentenceHistory);
        setSentenceEvents(localModel.sentenceEvents);
        setSpeakLatencyMsHistory(localModel.speakLatencyMsHistory);
        setAutoSentenceLearning(localModel.autoSentenceLearning);
      }

      if (!canSyncCloud) {
        if (!cancelled) {
          setModelHydratedKey(smartModelKey);
        }
        return;
      }

      try {
        setSyncStatus("syncing");
        const snapshot = await getDoc(childDocRef);
        const cloudModel = snapshot.exists() ? structuredModelToSmartModel(snapshot.data() ?? {}) : {};
        const mergedModel = mergeSmartModel(localModel, cloudModel);

        if (!cancelled) {
          setUsageCounts(mergedModel.usageCounts);
          setTransitionCounts(mergedModel.transitionCounts);
          setSentenceHistory(mergedModel.sentenceHistory);
          setSentenceEvents(mergedModel.sentenceEvents);
          setSpeakLatencyMsHistory(mergedModel.speakLatencyMsHistory);
          setAutoSentenceLearning(mergedModel.autoSentenceLearning);
          setSyncStatus("synced");
          setLastSyncedAt(new Date());
        }
      } catch (error) {
        console.error("Failed to merge smart model from Firestore:", error);
        if (!cancelled) {
          setSyncStatus("error");
        }
      } finally {
        if (!cancelled) {
          setModelHydratedKey(smartModelKey);
        }
      }
    }

    loadSmartModel();

    return () => {
      cancelled = true;
    };
  }, [smartModelKey, canSyncCloud, childDocRef]);

  useEffect(() => {
    if (modelHydratedKey !== smartModelKey) return;

    const payload = {
      usageCounts,
      transitionCounts,
      sentenceHistory: sentenceHistory.slice(-50),
      sentenceEvents: normalizeSentenceEvents(sentenceEvents).slice(-MAX_SENTENCE_EVENTS),
      speakLatencyMsHistory: mergeLatencyHistory(speakLatencyMsHistory, []),
      autoSentenceLearning: normalizeAutoSentenceLearning(autoSentenceLearning),
    };

    localStorage.setItem(smartModelKey, JSON.stringify(payload));

    if (!canSyncCloud) return;

    let cancelled = false;
    async function syncSmartModelToCloud() {
      try {
        setSyncStatus("syncing");
        const structuredSections = buildStructuredChildSections({
          profileName: activeChildProfile.name,
          sentenceHistory: payload.sentenceHistory,
          sentenceEvents: payload.sentenceEvents,
          usageCounts: payload.usageCounts,
          smartModel: payload,
          todayKey: getTodayKey(),
        });
        await setDoc(
          childDocRef,
          {
            name: activeChildProfile.name,
            profile: structuredSections.profile,
            stats: structuredSections.stats,
            model: structuredSections.model,
            smartModel: payload,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );

        if (!cancelled) {
          setSyncStatus("synced");
          setLastSyncedAt(new Date());
        }
      } catch (error) {
        console.error("Failed to sync smart model to Firestore:", error);
        if (!cancelled) {
          setSyncStatus("error");
        }
      }
    }

    syncSmartModelToCloud();

    return () => {
      cancelled = true;
    };
  }, [
    smartModelKey,
    usageCounts,
    transitionCounts,
    sentenceHistory,
    sentenceEvents,
    speakLatencyMsHistory,
    autoSentenceLearning,
    modelHydratedKey,
    canSyncCloud,
    childDocRef,
    activeChildProfile.name,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function loadPreferences() {
      let localPreferences = {
        favoriteTokens: [],
        quickPhrases: DEFAULT_QUICK_PHRASES,
        autoSpeak: false,
        dailySentenceGoal: 8,
        dailySentenceCounts: {},
        activeCategory: DEFAULT_CATEGORY,
        activeSubBoard: DEFAULT_SUB_BOARD,
        largeTileMode: false,
        scanMode: false,
        holdToSelect: false,
        scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS,
        speechLanguage: "en",
        dualLanguageMode: false,
        autoDetectVoice: true,
        ttsProvider: TTS_PROVIDERS.BROWSER,
        selectedVoiceURI: "",
        speechRate: 0.9,
        speechPitch: 1,
        speechVolume: 1,
        onboardingCompleted: false,
        workspaceMode: "child",
        tapSoundEnabled: false,
        tapFlashEnabled: true,
        pinnedPhraseTokens: [],
        phraseUsageCounts: {},
        recentPhraseUsage: [],
        progressiveDisclosureEnabled: true,
        topWordsMode: false,
        smartHidingEnabled: true,
        adaptiveDifficulty: DIFFICULTY_LEVELS.INTERMEDIATE,
        therapyGoal: THERAPY_GOALS.BALANCED,
        autoSentenceMode: true,
        autoSentenceSelectionMode: AUTO_SENTENCE_SELECTION_MODES.REPLACE,
        environmentContext: AUTO_SENTENCE_ENVIRONMENTS.HOME,
      };

      try {
        const rawPrefs = localStorage.getItem(preferenceKey);
        if (rawPrefs) {
          const parsed = JSON.parse(rawPrefs);
          localPreferences = {
            favoriteTokens: Array.isArray(parsed.favoriteTokens) ? parsed.favoriteTokens : [],
            quickPhrases:
              Array.isArray(parsed.quickPhrases) && parsed.quickPhrases.length > 0
                ? parsed.quickPhrases.slice(0, MAX_PHRASES)
                : DEFAULT_QUICK_PHRASES,
            autoSpeak: Boolean(parsed.autoSpeak),
            dailySentenceGoal:
              Number.isInteger(parsed.dailySentenceGoal) && parsed.dailySentenceGoal > 0
                ? parsed.dailySentenceGoal
                : 8,
            dailySentenceCounts:
              parsed.dailySentenceCounts && typeof parsed.dailySentenceCounts === "object"
                ? parsed.dailySentenceCounts
                : {},
            activeCategory: normalizeBoardKey(parsed.activeCategory, DEFAULT_CATEGORY),
            activeSubBoard: normalizeBoardKey(parsed.activeSubBoard, DEFAULT_SUB_BOARD),
            largeTileMode: Boolean(parsed.largeTileMode),
            scanMode: Boolean(parsed.scanMode),
            holdToSelect: Boolean(parsed.holdToSelect),
            scanIntervalMs: Math.max(
              600,
              Math.min(3500, Number(parsed.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS))
            ),
            speechLanguage: normalizeLanguageCode(parsed.speechLanguage ?? "en"),
            dualLanguageMode: Boolean(parsed.dualLanguageMode),
            autoDetectVoice: Boolean(parsed.autoDetectVoice ?? true),
            ttsProvider: Object.values(TTS_PROVIDERS).includes(String(parsed.ttsProvider ?? ""))
              ? String(parsed.ttsProvider)
              : TTS_PROVIDERS.BROWSER,
            selectedVoiceURI: String(parsed.selectedVoiceURI ?? ""),
            speechRate: Math.max(0.6, Math.min(1.6, Number(parsed.speechRate ?? 0.9))),
            speechPitch: Math.max(0.6, Math.min(1.6, Number(parsed.speechPitch ?? 1))),
            speechVolume: Math.max(0, Math.min(1, Number(parsed.speechVolume ?? 1))),
            onboardingCompleted: Boolean(parsed.onboardingCompleted),
            workspaceMode: String(parsed.workspaceMode ?? "child").toLowerCase() === "parent" ? "parent" : "child",
            tapSoundEnabled: Boolean(parsed.tapSoundEnabled),
            tapFlashEnabled: Boolean(parsed.tapFlashEnabled ?? true),
            pinnedPhraseTokens: Array.isArray(parsed.pinnedPhraseTokens)
              ? parsed.pinnedPhraseTokens.map((token) => String(token).toLowerCase())
              : [],
            phraseUsageCounts:
              parsed.phraseUsageCounts && typeof parsed.phraseUsageCounts === "object"
                ? parsed.phraseUsageCounts
                : {},
            recentPhraseUsage: Array.isArray(parsed.recentPhraseUsage)
              ? parsed.recentPhraseUsage.map((token) => String(token).toLowerCase())
              : [],
            progressiveDisclosureEnabled: Boolean(parsed.progressiveDisclosureEnabled ?? true),
            topWordsMode: Boolean(parsed.topWordsMode),
            smartHidingEnabled: Boolean(parsed.smartHidingEnabled ?? true),
            adaptiveDifficulty:
              String(parsed.adaptiveDifficulty ?? DIFFICULTY_LEVELS.INTERMEDIATE).toLowerCase() ===
              DIFFICULTY_LEVELS.BEGINNER
                ? DIFFICULTY_LEVELS.BEGINNER
                : String(parsed.adaptiveDifficulty ?? DIFFICULTY_LEVELS.INTERMEDIATE).toLowerCase() ===
                    DIFFICULTY_LEVELS.ADVANCED
                  ? DIFFICULTY_LEVELS.ADVANCED
                  : DIFFICULTY_LEVELS.INTERMEDIATE,
            therapyGoal:
              String(parsed.therapyGoal ?? THERAPY_GOALS.BALANCED).toLowerCase() ===
              THERAPY_GOALS.EXPAND_VOCABULARY
                ? THERAPY_GOALS.EXPAND_VOCABULARY
                : String(parsed.therapyGoal ?? THERAPY_GOALS.BALANCED).toLowerCase() ===
                    THERAPY_GOALS.COMMUNICATION_SPEED
                  ? THERAPY_GOALS.COMMUNICATION_SPEED
                  : THERAPY_GOALS.BALANCED,
            autoSentenceMode: Boolean(parsed.autoSentenceMode ?? true),
            autoSentenceSelectionMode:
              String(
                parsed.autoSentenceSelectionMode ?? AUTO_SENTENCE_SELECTION_MODES.REPLACE
              ).toLowerCase() === AUTO_SENTENCE_SELECTION_MODES.APPEND
                ? AUTO_SENTENCE_SELECTION_MODES.APPEND
                : AUTO_SENTENCE_SELECTION_MODES.REPLACE,
            environmentContext:
              String(parsed.environmentContext ?? AUTO_SENTENCE_ENVIRONMENTS.HOME).toLowerCase() ===
              AUTO_SENTENCE_ENVIRONMENTS.SCHOOL
                ? AUTO_SENTENCE_ENVIRONMENTS.SCHOOL
                : String(parsed.environmentContext ?? AUTO_SENTENCE_ENVIRONMENTS.HOME).toLowerCase() ===
                    AUTO_SENTENCE_ENVIRONMENTS.CLINIC
                  ? AUTO_SENTENCE_ENVIRONMENTS.CLINIC
                  : String(parsed.environmentContext ?? AUTO_SENTENCE_ENVIRONMENTS.HOME).toLowerCase() ===
                      AUTO_SENTENCE_ENVIRONMENTS.COMMUNITY
                    ? AUTO_SENTENCE_ENVIRONMENTS.COMMUNITY
                    : AUTO_SENTENCE_ENVIRONMENTS.HOME,
          };
        }
      } catch (error) {
        console.error("Failed to load user preferences from local storage:", error);
      }

      if (!cancelled) {
        setFavoriteTokens(localPreferences.favoriteTokens);
        setQuickPhrases(localPreferences.quickPhrases);
        setAutoSpeak(localPreferences.autoSpeak);
        setDailySentenceGoal(localPreferences.dailySentenceGoal);
        setDailySentenceCounts(localPreferences.dailySentenceCounts);
        setActiveCategory(localPreferences.activeCategory);
        setActiveSubBoard(localPreferences.activeSubBoard);
        setLargeTileMode(localPreferences.largeTileMode);
        setScanMode(localPreferences.scanMode);
        setHoldToSelect(localPreferences.holdToSelect);
        setScanIntervalMs(localPreferences.scanIntervalMs);
        setSpeechLanguage(localPreferences.speechLanguage);
        setDualLanguageMode(localPreferences.dualLanguageMode);
        setAutoDetectVoice(localPreferences.autoDetectVoice);
        setTtsProvider(localPreferences.ttsProvider);
        setSelectedVoiceURI(localPreferences.selectedVoiceURI);
        setSpeechRate(localPreferences.speechRate);
        setSpeechPitch(localPreferences.speechPitch);
        setSpeechVolume(localPreferences.speechVolume);
        setOnboardingCompleted(localPreferences.onboardingCompleted);
        setWorkspaceMode(localPreferences.workspaceMode);
        setTapSoundEnabled(localPreferences.tapSoundEnabled);
        setTapFlashEnabled(localPreferences.tapFlashEnabled);
        setPinnedPhraseTokens(localPreferences.pinnedPhraseTokens);
        setPhraseUsageCounts(localPreferences.phraseUsageCounts);
        setRecentPhraseUsage(localPreferences.recentPhraseUsage);
        setProgressiveDisclosureEnabled(localPreferences.progressiveDisclosureEnabled);
        setTopWordsMode(localPreferences.topWordsMode);
        setSmartHidingEnabled(localPreferences.smartHidingEnabled);
        setAdaptiveDifficulty(localPreferences.adaptiveDifficulty);
        setTherapyGoal(localPreferences.therapyGoal);
        setAutoSentenceMode(localPreferences.autoSentenceMode);
        setAutoSentenceSelectionMode(localPreferences.autoSentenceSelectionMode);
        setEnvironmentContext(localPreferences.environmentContext);
      }

      if (!canSyncCloud) {
        if (!cancelled) {
          setPreferenceHydratedKey(preferenceKey);
        }
        return;
      }

      try {
        setSyncStatus("syncing");
        const snapshot = await getDoc(childDocRef);
        const cloudPreferences = snapshot.exists() ? mergeCloudPreferences(snapshot.data() ?? {}) : {};
        const mergedPreferences = mergePreferences(localPreferences, cloudPreferences);

        if (!cancelled) {
          setFavoriteTokens(mergedPreferences.favoriteTokens);
          setQuickPhrases(mergedPreferences.quickPhrases);
          setAutoSpeak(mergedPreferences.autoSpeak);
          setDailySentenceGoal(mergedPreferences.dailySentenceGoal);
          setDailySentenceCounts(mergedPreferences.dailySentenceCounts);
          setActiveCategory(mergedPreferences.activeCategory);
          setActiveSubBoard(mergedPreferences.activeSubBoard);
          setLargeTileMode(mergedPreferences.largeTileMode);
          setScanMode(mergedPreferences.scanMode);
          setHoldToSelect(mergedPreferences.holdToSelect);
          setScanIntervalMs(mergedPreferences.scanIntervalMs);
          setSpeechLanguage(mergedPreferences.speechLanguage);
          setDualLanguageMode(mergedPreferences.dualLanguageMode);
          setAutoDetectVoice(mergedPreferences.autoDetectVoice);
          setTtsProvider(mergedPreferences.ttsProvider);
          setSelectedVoiceURI(mergedPreferences.selectedVoiceURI);
          setSpeechRate(mergedPreferences.speechRate);
          setSpeechPitch(mergedPreferences.speechPitch);
          setSpeechVolume(mergedPreferences.speechVolume);
          setOnboardingCompleted(mergedPreferences.onboardingCompleted);
          setWorkspaceMode(mergedPreferences.workspaceMode);
          setTapSoundEnabled(mergedPreferences.tapSoundEnabled);
          setTapFlashEnabled(mergedPreferences.tapFlashEnabled);
          setPinnedPhraseTokens(mergedPreferences.pinnedPhraseTokens);
          setPhraseUsageCounts(mergedPreferences.phraseUsageCounts);
          setRecentPhraseUsage(mergedPreferences.recentPhraseUsage);
          setProgressiveDisclosureEnabled(mergedPreferences.progressiveDisclosureEnabled);
          setTopWordsMode(mergedPreferences.topWordsMode);
          setSmartHidingEnabled(mergedPreferences.smartHidingEnabled);
          setAdaptiveDifficulty(mergedPreferences.adaptiveDifficulty);
          setTherapyGoal(mergedPreferences.therapyGoal);
          setAutoSentenceMode(mergedPreferences.autoSentenceMode);
          setAutoSentenceSelectionMode(mergedPreferences.autoSentenceSelectionMode);
          setEnvironmentContext(mergedPreferences.environmentContext);
          setSyncStatus("synced");
          setLastSyncedAt(new Date());
        }
      } catch (error) {
        console.error("Failed to merge preferences from Firestore:", error);
        if (!cancelled) {
          setSyncStatus("error");
        }
      } finally {
        if (!cancelled) {
          setPreferenceHydratedKey(preferenceKey);
        }
      }
    }

    loadPreferences();

    return () => {
      cancelled = true;
    };
  }, [preferenceKey, canSyncCloud, childDocRef]);

  useEffect(() => {
    if (preferenceHydratedKey !== preferenceKey) return;

    const payload = {
      favoriteTokens,
      quickPhrases: quickPhrases.slice(0, MAX_PHRASES),
      autoSpeak,
      dailySentenceGoal,
      dailySentenceCounts,
      activeCategory,
      activeSubBoard,
      largeTileMode,
      scanMode,
      holdToSelect,
      scanIntervalMs,
      speechLanguage,
      dualLanguageMode,
      autoDetectVoice,
      ttsProvider,
      selectedVoiceURI,
      speechRate,
      speechPitch,
      speechVolume,
      onboardingCompleted,
      workspaceMode,
      tapSoundEnabled,
      tapFlashEnabled,
      pinnedPhraseTokens,
      phraseUsageCounts,
      recentPhraseUsage,
      progressiveDisclosureEnabled,
      topWordsMode,
      smartHidingEnabled,
      adaptiveDifficulty,
      therapyGoal,
      autoSentenceMode,
      autoSentenceSelectionMode,
      environmentContext,
    };

    localStorage.setItem(preferenceKey, JSON.stringify(payload));

    if (!canSyncCloud) return;

    let cancelled = false;

    async function syncPreferencesToCloud() {
      try {
        setSyncStatus("syncing");
        const structuredSections = buildStructuredChildSections({
          profileName: activeChildProfile.name,
          adaptiveDifficulty,
          dailySentenceGoal,
          dailySentenceCounts,
          todayKey: getTodayKey(),
          favoriteTokens,
          quickPhrases,
        });
        await setDoc(
          childDocRef,
          {
            name: activeChildProfile.name,
            profile: structuredSections.profile,
            goals: structuredSections.goals,
            phrases: {
              saved: structuredSections.phrases.saved,
            },
            words: {
              favorites: structuredSections.words.favorites,
            },
            preferences: payload,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );

        if (!cancelled) {
          setSyncStatus("synced");
          setLastSyncedAt(new Date());
        }
      } catch (error) {
        console.error("Failed to sync preferences to Firestore:", error);
        if (!cancelled) {
          setSyncStatus("error");
        }
      }
    }

    syncPreferencesToCloud();

    return () => {
      cancelled = true;
    };
  }, [
    preferenceKey,
    favoriteTokens,
    quickPhrases,
    autoSpeak,
    dailySentenceGoal,
    dailySentenceCounts,
    activeCategory,
    activeSubBoard,
    largeTileMode,
    scanMode,
    holdToSelect,
    scanIntervalMs,
    speechLanguage,
    dualLanguageMode,
    autoDetectVoice,
    ttsProvider,
    selectedVoiceURI,
    speechRate,
    speechPitch,
    speechVolume,
    onboardingCompleted,
    workspaceMode,
    tapSoundEnabled,
    tapFlashEnabled,
    pinnedPhraseTokens,
    phraseUsageCounts,
    recentPhraseUsage,
    progressiveDisclosureEnabled,
    topWordsMode,
    smartHidingEnabled,
    adaptiveDifficulty,
    therapyGoal,
    autoSentenceMode,
    autoSentenceSelectionMode,
    environmentContext,
    preferenceHydratedKey,
    canSyncCloud,
    childDocRef,
    activeChildProfile.name,
  ]);

  const words = useMemo(
    () => mergeWordLists(defaultWords, customWords),
    [customWords]
  );
  const defaultTokenSet = useMemo(
    () => new Set(defaultWords.map((word) => normalizeToken(word.text))),
    []
  );

  const uniqueWords = useMemo(() => {
    return mergeWordLists(words, []);
  }, [words]);

  const wordLookup = useMemo(() => {
    const lookup = {};
    uniqueWords.forEach((word) => {
      lookup[normalizeToken(word.text)] = word;
    });
    return lookup;
  }, [uniqueWords]);

  const favoriteWords = useMemo(
    () => favoriteTokens.map((token) => wordLookup[token]).filter(Boolean),
    [favoriteTokens, wordLookup]
  );
  const activeCategoryForPrediction =
    activeCategory === FAVORITES_CATEGORY ? DEFAULT_CATEGORY : activeCategory;

  const smartSuggestionDetails = useMemo(
    () =>
      getSmartSuggestions({
        words: uniqueWords,
        sentence,
        usageCounts,
        transitionCounts,
        sentenceHistory,
        sentenceEvents,
        quickPhrases,
        favoriteTokens,
        therapyGoal,
        activeCategory: activeCategoryForPrediction,
      }),
    [
      uniqueWords,
      sentence,
      usageCounts,
      transitionCounts,
      sentenceHistory,
      sentenceEvents,
      quickPhrases,
      favoriteTokens,
      therapyGoal,
      activeCategoryForPrediction,
    ]
  );
  const instantIntentSuggestions = useMemo(
    () =>
      getInstantIntentSuggestions({
        sentence,
        wordLookup,
        activeCategory,
        activeSubBoard,
      }),
    [sentence, wordLookup, activeCategory, activeSubBoard]
  );
  const instantIntentTokenSet = useMemo(
    () => new Set(instantIntentSuggestions.map((entry) => normalizeToken(entry.word.text))),
    [instantIntentSuggestions]
  );
  const childSmartSuggestions = useMemo(
    () =>
      smartSuggestionDetails
        .slice(0, 4)
        .filter((entry) => !instantIntentTokenSet.has(normalizeToken(entry.word.text)))
        .slice(0, 4),
    [smartSuggestionDetails, instantIntentTokenSet]
  );
  const autoIntentState = useMemo(() => {
    const currentTokens = sentence.map((word) => normalizeToken(word?.text)).filter(Boolean);
    const tappedToken = normalizeToken(
      sentence[lastAddedIndex]?.text ?? sentence[sentence.length - 1]?.text ?? ""
    );
    return detectIntentFromTokens(currentTokens, tappedToken, sentenceHistory.slice(-20));
  }, [sentence, lastAddedIndex, sentenceHistory]);
  const autoContextState = useMemo(() => {
    return buildContextStack({
      currentTokens: sentence.map((word) => normalizeToken(word?.text)).filter(Boolean),
      sentenceHistory,
      sentenceEvents,
      timeOfDay: getTimeOfDayLabel(new Date()),
      intent: autoIntentState.intent,
      environment: environmentContext,
    });
  }, [sentence, sentenceHistory, sentenceEvents, autoIntentState.intent, environmentContext]);
  const childDigitalTwin = useMemo(
    () =>
      buildChildDigitalTwin({
        sentenceHistory,
        sentenceEvents,
        usageCounts,
        transitionCounts,
        speakLatencyMsHistory,
      }),
    [sentenceHistory, sentenceEvents, usageCounts, transitionCounts, speakLatencyMsHistory]
  );
  const urgencySignal = useMemo(
    () =>
      getUrgencySignal({
        sentenceTokens: sentence.map((word) => normalizeToken(word?.text)).filter(Boolean),
        recentTapTimestamps: recentWordTapTimestampsRef.current,
        sentenceEvents,
      }),
    [sentence, sentenceEvents, tapPulse]
  );
  const predictiveContextHint = useMemo(() => {
    const now = new Date();
    const timeOfDay = getTimeOfDayLabel(now);
    const routineToken = getTopRoutineToken(sentenceEvents, now);
    const recentText = String(sentenceHistory[sentenceHistory.length - 1] ?? "").trim();

    const parts = [
      `${timeOfDay.charAt(0).toUpperCase()}${timeOfDay.slice(1)} context active`,
      `Intent: ${autoIntentState.intent} (${Math.round(autoIntentState.confidence * 100)}%)`,
      `Pattern: ${autoContextState.sessionPattern}`,
      `Situation: ${autoContextState.situation}`,
      `Env: ${environmentContext}`,
      `Goal: ${therapyGoal}`,
    ];
    if (autoContextState.frequentIntents.length > 0) {
      parts.push(`Frequent intents: ${autoContextState.frequentIntents.join(", ")}`);
    }
    if (routineToken && routineToken.score >= 0.9) {
      parts.push(`Routine often includes "${routineToken.token}" around ${now.getHours()}:00`);
    }
    if (recentText) {
      parts.push(`Recent: "${recentText}"`);
    }
    if (Array.isArray(childDigitalTwin.preferredWords) && childDigitalTwin.preferredWords.length > 0) {
      parts.push(`Twin prefers: ${childDigitalTwin.preferredWords.slice(0, 3).join(", ")}`);
    }
    if (urgencySignal.level !== "low") {
      parts.push(`Urgency: ${urgencySignal.level} (${Math.round(urgencySignal.score * 100)}%)`);
    }

    return parts.join(" • ");
  }, [
    sentenceEvents,
    sentenceHistory,
    autoIntentState,
    autoContextState,
    environmentContext,
    childDigitalTwin,
    urgencySignal,
    therapyGoal,
  ]);
  const explainSuggestion = (entry) => {
    const usage = Number(usageCounts[normalizeToken(entry.word.text)] ?? 0);
    const baseReason = entry.reasons?.[0] || "Adaptive prediction";
    const followReason = entry.reasons?.[1] || "";
    const parts = [`Suggested "${entry.word.text}"`];
    if (usage > 0) parts.push(`used ${usage} times`);
    if (baseReason) parts.push(baseReason.toLowerCase());
    if (followReason) parts.push(followReason.toLowerCase());
    return parts.join(" because ");
  };

  const categoryTabs = useMemo(() => {
    const categoryCounts = {};
    uniqueWords.forEach((word) => {
      const category = normalizeBoardKey(word.category, DEFAULT_CUSTOM_CATEGORY);
      categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    });

    const orderedIds = [
      ...CATEGORY_TAB_ORDER.map((item) => item.id),
      ...Object.keys(categoryCounts)
        .filter((id) => !CATEGORY_TAB_ORDER.find((item) => item.id === id))
        .sort((a, b) => formatBoardLabel(a).localeCompare(formatBoardLabel(b))),
    ];

    const tabs = orderedIds
      .filter((id) => (categoryCounts[id] ?? 0) > 0)
      .map((id) => ({
        id,
        label: formatBoardLabel(id, "Category"),
        count: categoryCounts[id] ?? 0,
      }));

    return [
      { id: DEFAULT_CATEGORY, label: "All Boards", count: uniqueWords.length },
      { id: FAVORITES_CATEGORY, label: "⭐ Favorites", count: favoriteWords.length },
      ...tabs,
    ];
  }, [uniqueWords, favoriteWords.length]);

  const subBoardTabs = useMemo(() => {
    if (activeCategory === DEFAULT_CATEGORY) {
      return [{ id: DEFAULT_SUB_BOARD, label: "All Folders", count: uniqueWords.length }];
    }

    if (activeCategory === FAVORITES_CATEGORY) {
      return [{ id: DEFAULT_SUB_BOARD, label: "All Folders", count: favoriteWords.length }];
    }

    const scopedWords = uniqueWords.filter(
      (word) => normalizeBoardKey(word.category, DEFAULT_CUSTOM_CATEGORY) === activeCategory
    );
    const subBoardCounts = {};
    scopedWords.forEach((word) => {
      const subBoard = normalizeBoardKey(word.subBoard, DEFAULT_CUSTOM_SUB_BOARD);
      subBoardCounts[subBoard] = (subBoardCounts[subBoard] ?? 0) + 1;
    });

    const sortedSubBoards = Object.keys(subBoardCounts).sort((a, b) =>
      formatBoardLabel(a).localeCompare(formatBoardLabel(b))
    );

    return [
      { id: DEFAULT_SUB_BOARD, label: "All Folders", count: scopedWords.length },
      ...sortedSubBoards.map((id) => ({
        id,
        label: formatBoardLabel(id, "Folder"),
        count: subBoardCounts[id] ?? 0,
      })),
    ];
  }, [uniqueWords, activeCategory, favoriteWords.length]);

  useEffect(() => {
    const activeCategoryIds = new Set(categoryTabs.map((tab) => tab.id));
    if (!activeCategoryIds.has(activeCategory)) {
      setActiveCategory(DEFAULT_CATEGORY);
      return;
    }

    if (activeCategory === DEFAULT_CATEGORY || activeCategory === FAVORITES_CATEGORY) {
      if (activeSubBoard !== DEFAULT_SUB_BOARD) {
        setActiveSubBoard(DEFAULT_SUB_BOARD);
      }
      return;
    }

    const activeSubBoardIds = new Set(subBoardTabs.map((tab) => tab.id));
    if (!activeSubBoardIds.has(activeSubBoard)) {
      setActiveSubBoard(DEFAULT_SUB_BOARD);
    }
  }, [categoryTabs, subBoardTabs, activeCategory, activeSubBoard]);

  const filteredWords = useMemo(() => {
    const searchToken = normalizeToken(wordSearch);

    return uniqueWords.filter((word) => {
      const token = normalizeToken(word.text);
      const category = normalizeBoardKey(word.category, DEFAULT_CUSTOM_CATEGORY);
      const subBoard = normalizeBoardKey(word.subBoard, DEFAULT_CUSTOM_SUB_BOARD);
      if (!token) return false;

      if (searchToken && !token.includes(searchToken)) return false;

      if (activeCategory === FAVORITES_CATEGORY) {
        if (!favoriteTokens.includes(token)) return false;
      } else if (activeCategory !== DEFAULT_CATEGORY && category !== activeCategory) {
        return false;
      }

      if (
        activeCategory !== DEFAULT_CATEGORY &&
        activeCategory !== FAVORITES_CATEGORY &&
        activeSubBoard !== DEFAULT_SUB_BOARD &&
        subBoard !== activeSubBoard
      ) {
        return false;
      }

      if (wordFilter === "favorites") {
        return favoriteTokens.includes(token);
      }

      if (wordFilter === "default") {
        return defaultTokenSet.has(token);
      }

      if (wordFilter === "custom") {
        return !defaultTokenSet.has(token);
      }

      return true;
    });
  }, [
    uniqueWords,
    wordSearch,
    wordFilter,
    favoriteTokens,
    defaultTokenSet,
    activeCategory,
    activeSubBoard,
  ]);
  const rankedFilteredWords = useMemo(() => {
    return [...filteredWords].sort((a, b) => {
      const tokenA = normalizeToken(a.text);
      const tokenB = normalizeToken(b.text);
      const usageA = Number(usageCounts[tokenA] ?? 0);
      const usageB = Number(usageCounts[tokenB] ?? 0);
      const favoriteA = favoriteTokens.includes(tokenA) ? 1 : 0;
      const favoriteB = favoriteTokens.includes(tokenB) ? 1 : 0;
      const coreA = normalizeBoardKey(a.category, DEFAULT_CUSTOM_CATEGORY) === "core" ? 1 : 0;
      const coreB = normalizeBoardKey(b.category, DEFAULT_CUSTOM_CATEGORY) === "core" ? 1 : 0;
      const scoreA = usageA + favoriteA * 3 + coreA * 0.8;
      const scoreB = usageB + favoriteB * 3 + coreB * 0.8;
      return scoreB - scoreA || a.text.localeCompare(b.text);
    });
  }, [filteredWords, usageCounts, favoriteTokens]);
  const rareWordTokenSet = useMemo(() => {
    const rareTokens = new Set();
    rankedFilteredWords.forEach((word) => {
      const token = normalizeToken(word.text);
      if (!token) return;
      const isFavorite = favoriteTokens.includes(token);
      const usage = Number(usageCounts[token] ?? 0);
      if (!isFavorite && usage <= 1) {
        rareTokens.add(token);
      }
    });
    return rareTokens;
  }, [rankedFilteredWords, favoriteTokens, usageCounts]);
  const disclosureLimit = 12;
  const visibleWords = useMemo(() => {
    if (topWordsMode) return rankedFilteredWords.slice(0, 12);
    if (progressiveDisclosureEnabled && !showAllDisclosedWords) {
      return rankedFilteredWords.slice(0, disclosureLimit);
    }
    return rankedFilteredWords;
  }, [topWordsMode, progressiveDisclosureEnabled, showAllDisclosedWords, rankedFilteredWords, disclosureLimit]);
  const hiddenWordCount = Math.max(0, rankedFilteredWords.length - visibleWords.length);

  useEffect(() => {
    setShowAllDisclosedWords(false);
  }, [activeCategory, activeSubBoard, wordSearch, wordFilter, topWordsMode, progressiveDisclosureEnabled]);

  useEffect(() => {
    if (!canUseAutoSpeak && autoSpeak) {
      setAutoSpeak(false);
    }
  }, [canUseAutoSpeak, autoSpeak]);

  const todayKey = getTodayKey();
  const todaySentenceCount = dailySentenceCounts[todayKey] ?? 0;
  const goalProgressPct = Math.min(
    100,
    Math.round((todaySentenceCount / Math.max(1, dailySentenceGoal)) * 100)
  );
  const sevenDayAverage = getSevenDayAverage(dailySentenceCounts);
  const goalStreak = getGoalStreak(dailySentenceCounts, dailySentenceGoal);
  const suggestedGoal = getSuggestedGoal(dailySentenceCounts, dailySentenceGoal);
  const adaptivePhrases = useMemo(
    () => getAdaptivePhrases(sentenceHistory, quickPhrases),
    [sentenceHistory, quickPhrases]
  );
  const smartPhraseSuggestionDetails = useMemo(
    () =>
      getSmartPhraseSuggestions({
        sentence,
        sentenceHistory,
        quickPhrases,
        transitionCounts,
      }),
    [sentence, sentenceHistory, quickPhrases, transitionCounts]
  );
  const autoSentenceWordCache = useMemo(
    () =>
      buildAutoSentenceWordCache({
        sentenceHistory,
        quickPhrases,
        wordLookup,
      }),
    [activeChildId, sentenceHistory, quickPhrases, wordLookup]
  );
  const effectiveAutoSentenceWordCache = useMemo(
    () =>
      mergeSuggestionCaches(
        autoSentenceWordCache,
        localSuggestionCache,
        SUGGESTION_CACHE_LIMIT
      ),
    [autoSentenceWordCache, localSuggestionCache]
  );
  const autoSentenceSuggestions = useMemo(() => {
    if (!autoSentenceMode) return [];
    const tappedWord = sentence[lastAddedIndex]?.text ?? sentence[sentence.length - 1]?.text ?? "";
    if (!String(tappedWord).trim()) return [];

    return getAutoSentences({
      tappedWord,
      currentSentence: sentence,
      history: sentenceHistory,
      sentenceEvents,
      timeOfDay: getTimeOfDayLabel(new Date()),
      environment: environmentContext,
      therapyGoal,
      childProfile: activeChildProfile,
      digitalTwin: childDigitalTwin,
      urgencyScore: urgencySignal.score,
      frequentPhrases: quickPhrases,
      wordTransitions: transitionCounts,
      usageCounts,
      wordLookup,
      cacheByWord: effectiveAutoSentenceWordCache,
      learning: autoSentenceLearning,
      limit: AUTO_SENTENCE_SUGGESTION_LIMIT,
    });
  }, [
    autoSentenceMode,
    sentence,
    lastAddedIndex,
    sentenceHistory,
    sentenceEvents,
    environmentContext,
    therapyGoal,
    activeChildProfile,
    childDigitalTwin,
    urgencySignal.score,
    quickPhrases,
    transitionCounts,
    usageCounts,
    wordLookup,
    effectiveAutoSentenceWordCache,
    autoSentenceLearning,
  ]);
  const autoSentenceDisplaySuggestions = useMemo(
    () => autoSentenceSuggestions.slice(0, AUTO_SENTENCE_SUGGESTION_LIMIT),
    [autoSentenceSuggestions]
  );
  const ghostAutoSentence = useMemo(() => {
    const top = autoSentenceDisplaySuggestions[0];
    if (!top) return "";
    if (top.confidenceScore < AUTO_SENTENCE_HIGH_CONFIDENCE_THRESHOLD) return "";
    if (sentence.length === 0) return top.sentence;
    const currentText = sentence.map((word) => normalizeToken(word.text)).join(" ");
    const targetText = normalizeToken(top.sentence);
    if (currentText && !targetText.startsWith(currentText)) return "";
    return top.sentence;
  }, [autoSentenceDisplaySuggestions, sentence]);
  const autoSentenceSignature = useMemo(
    () =>
      autoSentenceDisplaySuggestions
        .map((entry) => `${normalizeToken(entry.sentence)}::${entry.source}`)
        .join("|"),
    [autoSentenceDisplaySuggestions]
  );
  useEffect(() => {
    const nextAnticipated = getAnticipatedWordSuggestions({
      sentenceHistory,
      transitionCounts,
      quickPhrases,
      wordLookup,
      limit: 4,
    });
    setAnticipatedWords(nextAnticipated);
  }, [sentenceHistory, transitionCounts, quickPhrases, wordLookup, activeChildId]);
  useEffect(() => {
    if (!autoSentenceMode || autoSentenceDisplaySuggestions.length === 0) return;
    const triggerToken = normalizeToken(
      sentence[lastAddedIndex]?.text ?? sentence[sentence.length - 1]?.text ?? ""
    );
    if (!triggerToken) return;

    const topSentences = autoSentenceDisplaySuggestions
      .slice(0, SUGGESTION_CACHE_LIMIT)
      .map((entry) => String(entry.sentence ?? "").trim())
      .filter(Boolean);
    if (topSentences.length === 0) return;

    setLocalSuggestionCache((previousCache) => {
      const mergedForToken = mergeSuggestionCaches(
        { [triggerToken]: previousCache[triggerToken] ?? [] },
        { [triggerToken]: topSentences },
        SUGGESTION_CACHE_LIMIT
      );
      const nextEntries = mergedForToken[triggerToken] ?? [];
      const previousEntries = Array.isArray(previousCache[triggerToken]) ? previousCache[triggerToken] : [];
      if (nextEntries.join("||") === previousEntries.join("||")) {
        return previousCache;
      }
      return {
        ...previousCache,
        [triggerToken]: nextEntries,
      };
    });
  }, [autoSentenceMode, autoSentenceDisplaySuggestions, sentence, lastAddedIndex]);
  const orderedQuickPhrases = useMemo(() => {
    const recencyIndexByToken = recentPhraseUsage.reduce((lookup, token, index) => {
      lookup[token] = index;
      return lookup;
    }, {});
    const pinnedSet = new Set(pinnedPhraseTokens.map((token) => normalizeToken(token)));

    return [...quickPhrases].sort((a, b) => {
      const tokenA = normalizeToken(a);
      const tokenB = normalizeToken(b);
      const pinnedScoreA = pinnedSet.has(tokenA) ? 1 : 0;
      const pinnedScoreB = pinnedSet.has(tokenB) ? 1 : 0;
      if (pinnedScoreA !== pinnedScoreB) return pinnedScoreB - pinnedScoreA;

      const recencyA = recencyIndexByToken[tokenA] ?? -1;
      const recencyB = recencyIndexByToken[tokenB] ?? -1;
      if (recencyA !== recencyB) return recencyB - recencyA;

      const usageA = Number(phraseUsageCounts[tokenA] ?? 0);
      const usageB = Number(phraseUsageCounts[tokenB] ?? 0);
      if (usageA !== usageB) return usageB - usageA;

      return a.localeCompare(b);
    });
  }, [quickPhrases, pinnedPhraseTokens, phraseUsageCounts, recentPhraseUsage]);
  const compactSmartSuggestions = useMemo(
    () => smartSuggestionDetails.slice(0, 4),
    [smartSuggestionDetails]
  );
  const scannedWord = scanMode ? visibleWords[scanIndex] ?? null : null;
  const sentenceText = useMemo(
    () => sentence.map((word) => String(word?.text ?? "")).join(" ").trim(),
    [sentence]
  );

  useEffect(() => {
    if (!cursorMode) return;
    setCursorIndex((previous) => Math.max(0, Math.min(sentence.length, Number(previous ?? sentence.length))));
  }, [cursorMode, sentence.length]);

  useEffect(() => {
    if (!dualLanguageMode || normalizeLanguageCode(speechLanguage) === "en" || !sentenceText) {
      setDualLanguageSentence("");
      setDualLanguageLoading(false);
      return;
    }

    let cancelled = false;
    setDualLanguageLoading(true);
    translateText(sentenceText, speechLanguage, { sourceLang: "en" })
      .then((translated) => {
        if (!cancelled) {
          setDualLanguageSentence(String(translated ?? "").trim());
          setDualLanguageLoading(false);
        }
      })
      .catch((error) => {
        console.error("Failed to translate sentence preview:", error);
        if (!cancelled) {
          setDualLanguageSentence("");
          setDualLanguageLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dualLanguageMode, speechLanguage, sentenceText]);

  useEffect(() => {
    if (!window?.speechSynthesis) return;
    const synth = window.speechSynthesis;
    synth.getVoices();
    const timer = window.setTimeout(() => {
      setAvailableVoices(synth.getVoices());
    }, 120);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!window?.speechSynthesis) return;

    const synth = window.speechSynthesis;
    const updateVoices = () => {
      const voices = synth.getVoices();
      setAvailableVoices(voices);
      if (selectedVoiceURI && !voices.some((voice) => voice.voiceURI === selectedVoiceURI)) {
        setSelectedVoiceURI("");
      }
    };

    updateVoices();
    synth.addEventListener?.("voiceschanged", updateVoices);

    return () => {
      synth.removeEventListener?.("voiceschanged", updateVoices);
    };
  }, [selectedVoiceURI]);

  useEffect(
    () => () => {
      if (holdSelectTimeoutRef.current) {
        window.clearTimeout(holdSelectTimeoutRef.current);
      }
      if (phraseHoldTimeoutRef.current) {
        window.clearTimeout(phraseHoldTimeoutRef.current);
      }
      if (autoSentenceHoldTimeoutRef.current) {
        window.clearTimeout(autoSentenceHoldTimeoutRef.current);
      }
      if (wordLongPressTimeoutRef.current) {
        window.clearTimeout(wordLongPressTimeoutRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!scanMode || visibleWords.length === 0) {
      setScanIndex(0);
      return;
    }

    const interval = window.setInterval(() => {
      setScanIndex((previous) => (previous + 1) % visibleWords.length);
    }, scanIntervalMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [scanMode, visibleWords.length, scanIntervalMs]);

  useEffect(() => {
    if (scanIndex < visibleWords.length) return;
    setScanIndex(0);
  }, [scanIndex, visibleWords.length]);

  useEffect(() => {
    setAutoSentenceLearning((previous) => applyDailyDecayToAutoSentenceLearning(previous, new Date()));
  }, [activeChildId, todayKey]);

  useEffect(() => {
    if (!autoSentenceMode || autoSentenceDisplaySuggestions.length === 0) return;
    const scopedSignature = `${activeChildId}::${autoSentenceSignature}`;
    if (!autoSentenceSignature || autoSentenceSeenSignatureRef.current === scopedSignature) return;

    const previousSuggestions = autoSentenceLastPresentedRef.current;
    const acceptedPhrase = autoSentenceLastAcceptedRef.current;
    const acceptedMatchedPrevious = previousSuggestions.some(
      (entry) => normalizeToken(entry?.sentence) === normalizeToken(acceptedPhrase)
    );

    autoSentenceSeenSignatureRef.current = scopedSignature;
    autoSentenceLastPresentedRef.current = autoSentenceDisplaySuggestions;
    autoSentenceLastAcceptedRef.current = "";

    setAutoSentenceLearning((previous) => {
      const current = applyDailyDecayToAutoSentenceLearning(previous, new Date());
      const nextShown = { ...current.shownCounts };
      const nextLayerShown = { ...current.layerShownCounts };
      const nextIgnored = { ...current.ignoredCounts };
      const nextIntentShown = { ...current.intentShownCounts };
      const nextDailyShown = { ...current.dailyShownCounts };
      const nextDailyIgnored = { ...current.dailyIgnoredCounts };
      let shownDelta = 0;
      let ignoredDelta = 0;
      const seenPhrases = new Set();

      if (previousSuggestions.length > 0 && !acceptedMatchedPrevious) {
        previousSuggestions.slice(0, 3).forEach((entry) => {
          const normalized = normalizeToken(entry?.sentence);
          if (!normalized) return;
          nextIgnored[normalized] = Number(nextIgnored[normalized] ?? 0) + 1;
          ignoredDelta += 1;
        });
      }

      autoSentenceDisplaySuggestions.forEach((entry) => {
        const normalized = normalizeToken(entry.sentence);
        if (!normalized || seenPhrases.has(normalized)) return;
        seenPhrases.add(normalized);
        nextShown[normalized] = Number(nextShown[normalized] ?? 0) + 1;
        shownDelta += 1;
        const source = String(entry.source ?? "memory");
        nextLayerShown[source] = Number(nextLayerShown[source] ?? 0) + 1;
        const intent = String(entry.intent ?? AUTO_SENTENCE_INTENTS.UNKNOWN);
        nextIntentShown[intent] = Number(nextIntentShown[intent] ?? 0) + 1;
      });

      if (shownDelta > 0) {
        nextDailyShown[todayKey] = Number(nextDailyShown[todayKey] ?? 0) + shownDelta;
      }
      if (ignoredDelta > 0) {
        nextDailyIgnored[todayKey] = Number(nextDailyIgnored[todayKey] ?? 0) + ignoredDelta;
      }

      return {
        ...current,
        shownCounts: nextShown,
        ignoredCounts: nextIgnored,
        dailyShownCounts: nextDailyShown,
        dailyIgnoredCounts: nextDailyIgnored,
        layerShownCounts: nextLayerShown,
        intentShownCounts: nextIntentShown,
      };
    });
  }, [autoSentenceMode, autoSentenceDisplaySuggestions, autoSentenceSignature, activeChildId, todayKey]);

  const appendWords = (wordsToAppend) => {
    const validWords = wordsToAppend.filter((word) => normalizeToken(word?.text));
    if (validWords.length === 0) return;

    setSentence((previousSentence) => {
      const insertAt = cursorMode
        ? Math.max(0, Math.min(previousSentence.length, Number(cursorIndex ?? previousSentence.length)))
        : previousSentence.length;
      const tokenPairs = [];
      const appendedTokens = [];
      let previousToken = normalizeToken(previousSentence[insertAt - 1]?.text);
      const rightNeighborToken = normalizeToken(previousSentence[insertAt]?.text);

      validWords.forEach((word) => {
        const token = normalizeToken(word.text);
        appendedTokens.push(token);

        if (previousToken) {
          tokenPairs.push([previousToken, token]);
        }

        previousToken = token;
      });

      const lastInsertedToken = appendedTokens[appendedTokens.length - 1];
      if (lastInsertedToken && rightNeighborToken) {
        tokenPairs.push([lastInsertedToken, rightNeighborToken]);
      }

      setUsageCounts((previousUsage) => {
        let nextUsage = previousUsage;
        appendedTokens.forEach((token) => {
          nextUsage = incrementCounter(nextUsage, token);
        });
        return nextUsage;
      });

      setTransitionCounts((previousTransitions) => {
        let nextTransitions = previousTransitions;
        tokenPairs.forEach(([fromToken, toToken]) => {
          nextTransitions = incrementTransition(nextTransitions, fromToken, toToken);
        });
        return nextTransitions;
      });

      const nextSentence = [
        ...previousSentence.slice(0, insertAt),
        ...validWords,
        ...previousSentence.slice(insertAt),
      ];

      if (previousSentence.length === 0 && nextSentence.length > 0) {
        setSentenceBuildStartedAt(Date.now());
      }

      setLastAddedIndex(insertAt + validWords.length - 1);
      if (cursorMode) {
        setCursorIndex(insertAt + validWords.length);
      }

      return nextSentence;
    });

    if (autoSpeak) {
      speak(validWords.map((word) => word.text).join(" "), {
        lang: speechLanguage,
        rate: speechRate,
        pitch: speechPitch,
        volume: speechVolume,
        dualLanguageMode,
        autoDetectVoice,
        ttsProvider,
        voiceURI: selectedVoiceURI,
      });
    }
  };

  const addWord = (word) => {
    const nextToken = normalizeToken(word?.text);
    const removedToken = normalizeToken(lastRemovedTokenRef.current);
    if (removedToken && nextToken && removedToken !== nextToken) {
      setUsageCounts((previous) => incrementCounterBy(previous, nextToken, 0.24));
      setTransitionCounts((previous) => incrementTransitionBy(previous, removedToken, nextToken, 0.35));
      setMicroReinforcement(`Adjusted path learned: "${removedToken}" → "${nextToken}"`);
      window.setTimeout(() => {
        setMicroReinforcement((current) =>
          current.includes("Adjusted path learned") ? "" : current
        );
      }, 1700);
      lastRemovedTokenRef.current = "";
    }
    appendWords([word]);
  };

  const handleWordTapFeedback = (word) => {
    const now = Date.now();
    recentWordTapTimestampsRef.current = [
      ...recentWordTapTimestampsRef.current.filter((value) => now - Number(value) < 10000),
      now,
    ].slice(-10);
    setTapPulse((value) => value + 1);
    const token = normalizeToken(word.text);
    if (tapFlashEnabled && token) {
      setFlashedWordToken(token);
      window.setTimeout(() => {
        setFlashedWordToken((previous) => (previous === token ? "" : previous));
      }, 180);
    }

    if (tapSoundEnabled) {
      playTapTone();
    }
  };

  const clearHoldSelectTimer = () => {
    if (!holdSelectTimeoutRef.current) return;
    window.clearTimeout(holdSelectTimeoutRef.current);
    holdSelectTimeoutRef.current = null;
  };

  const startHoldSelect = (word) => {
    clearHoldSelectTimer();
    holdSelectTimeoutRef.current = window.setTimeout(() => {
      addWord(word);
      handleWordTapFeedback(word);
      holdSelectTimeoutRef.current = null;
    }, HOLD_TO_SELECT_MS);
  };

  const clearWordLongPressTimer = () => {
    if (!wordLongPressTimeoutRef.current) return;
    window.clearTimeout(wordLongPressTimeoutRef.current);
    wordLongPressTimeoutRef.current = null;
  };

  const getAlternateWordsFor = (word) => {
    const token = normalizeToken(word?.text);
    const category = normalizeBoardKey(word?.category, DEFAULT_CUSTOM_CATEGORY);
    const pool = uniqueWords.filter((entry) => {
      const nextToken = normalizeToken(entry.text);
      if (!nextToken || nextToken === token) return false;
      return normalizeBoardKey(entry.category, DEFAULT_CUSTOM_CATEGORY) === category;
    });

    return pool
      .sort((a, b) => Number(usageCounts[normalizeToken(b.text)] ?? 0) - Number(usageCounts[normalizeToken(a.text)] ?? 0))
      .slice(0, 4);
  };

  const openAlternateWords = (word) => {
    const alternatives = getAlternateWordsFor(word);
    if (alternatives.length === 0) return;
    wordLongPressTriggeredRef.current = true;
    setAlternateWordLabel(word.text);
    setAlternateWordSuggestions(alternatives);
  };

  const startWordLongPress = (word) => {
    clearWordLongPressTimer();
    wordLongPressTriggeredRef.current = false;
    wordLongPressTimeoutRef.current = window.setTimeout(() => {
      openAlternateWords(word);
      wordLongPressTimeoutRef.current = null;
    }, PHRASE_LONG_PRESS_MS);
  };

  const getWordSelectProps = (word) => {
    if (!holdToSelect) {
      return {
        onClick: () => {
          if (wordLongPressTriggeredRef.current) {
            wordLongPressTriggeredRef.current = false;
            return;
          }
          addWord(word);
          handleWordTapFeedback(word);
          clearWordLongPressTimer();
          if (sentence.length === 0) {
            setAlternateWordLabel("");
            setAlternateWordSuggestions([]);
          }
        },
        onMouseDown: () => startWordLongPress(word),
        onMouseUp: clearWordLongPressTimer,
        onMouseLeave: clearWordLongPressTimer,
        onTouchStart: () => startWordLongPress(word),
        onTouchEnd: clearWordLongPressTimer,
        onTouchCancel: clearWordLongPressTimer,
        onContextMenu: (event) => event.preventDefault(),
      };
    }

    return {
      onMouseDown: () => startHoldSelect(word),
      onMouseUp: clearHoldSelectTimer,
      onMouseLeave: clearHoldSelectTimer,
      onTouchStart: () => startHoldSelect(word),
      onTouchEnd: clearHoldSelectTimer,
      onTouchCancel: clearHoldSelectTimer,
      onContextMenu: (event) => event.preventDefault(),
    };
  };

  const selectScannedWord = () => {
    if (!scannedWord) return;
    addWord(scannedWord);
    handleWordTapFeedback(scannedWord);
  };

  const recordSpokenSentence = (text, options = {}) => {
    const cleanText = String(text ?? "").trim();
    if (!cleanText) return;
    const elapsedMs = Number(options.elapsedMs ?? 0);

    setSentenceHistory((previousHistory) => [...previousHistory, cleanText].slice(-50));
    setSentenceEvents((previousEvents) =>
      [
        ...previousEvents,
        {
          text: cleanText,
          ts: new Date().toISOString(),
          elapsedMs: Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : undefined,
        },
      ].slice(-MAX_SENTENCE_EVENTS)
    );
    if (options.skipLearning) return;

    const sentenceTokens = tokenizeText(cleanText);
    const intent = detectIntentFromTokens(
      sentenceTokens,
      sentenceTokens[sentenceTokens.length - 1] ?? "",
      sentenceHistory.slice(-20)
    ).intent;
    const normalizedPhrase = normalizeToken(cleanText);
    const tapCount = Math.max(1, Number(options.tapCount ?? sentenceTokens.length ?? 1));
    const introducedToken = sentenceTokens.find((token) => Number(usageCounts[token] ?? 0) <= 0);
    if (introducedToken) {
      setMicroReinforcement(`Nice! New word used: ${introducedToken}`);
      window.setTimeout(() => {
        setMicroReinforcement((current) =>
          current === `Nice! New word used: ${introducedToken}` ? "" : current
        );
      }, 1800);
    } else if (sentenceTokens.length >= 4) {
      setMicroReinforcement(`Great sentence length: ${sentenceTokens.length} words`);
      window.setTimeout(() => {
        setMicroReinforcement((current) =>
          current.includes("Great sentence length") ? "" : current
        );
      }, 1700);
    }

    setAutoSentenceLearning((previous) => {
      const current = applyDailyDecayToAutoSentenceLearning(previous, new Date());
      const previousAvgSpeed = Number(current.sentenceSpeedMs[normalizedPhrase] ?? 0);
      const previousSpeedSamples = Number(current.sentenceSpeedSamples[normalizedPhrase] ?? 0);
      const previousTapAvg = Number(current.sentenceTapCountAvg[normalizedPhrase] ?? 0);
      const previousTapSamples = Number(current.sentenceTapCountSamples[normalizedPhrase] ?? 0);
      const shouldUpdateSpeed = Number.isFinite(elapsedMs) && elapsedMs > 0;
      const nextSpeedSamples = shouldUpdateSpeed ? previousSpeedSamples + 1 : previousSpeedSamples;
      const nextAvgSpeed =
        shouldUpdateSpeed
          ? previousSpeedSamples <= 0
            ? elapsedMs
            : (previousAvgSpeed * previousSpeedSamples + elapsedMs) / nextSpeedSamples
          : previousAvgSpeed;
      const nextTapSamples = previousTapSamples + 1;
      const nextTapAvg =
        previousTapSamples <= 0
          ? tapCount
          : (previousTapAvg * previousTapSamples + tapCount) / nextTapSamples;

      return {
        ...current,
        acceptedCounts: {
          ...current.acceptedCounts,
          [normalizedPhrase]: Number(current.acceptedCounts[normalizedPhrase] ?? 0) + 0.2,
        },
        sentenceSpeedMs: shouldUpdateSpeed
          ? {
              ...current.sentenceSpeedMs,
              [normalizedPhrase]: nextAvgSpeed,
            }
          : current.sentenceSpeedMs,
        sentenceSpeedSamples: shouldUpdateSpeed
          ? {
              ...current.sentenceSpeedSamples,
              [normalizedPhrase]: nextSpeedSamples,
            }
          : current.sentenceSpeedSamples,
        sentenceTapCountAvg: {
          ...current.sentenceTapCountAvg,
          [normalizedPhrase]: nextTapAvg,
        },
        sentenceTapCountSamples: {
          ...current.sentenceTapCountSamples,
          [normalizedPhrase]: nextTapSamples,
        },
        intentAcceptedCounts: {
          ...current.intentAcceptedCounts,
          [intent]: Number(current.intentAcceptedCounts[intent] ?? 0) + 0.35,
        },
      };
    });
  };

  const triggerSpeakReaction = (text, options = {}) => {
    const baseReaction = getEmotionalTone(text);
    const urgencyValue = Number(options.urgencyScore ?? 0);
    const reaction =
      urgencyValue >= 0.72 && baseReaction.tone !== "emergency"
        ? { tone: "emergency", emoji: "🚨" }
        : baseReaction;
    setSpeakReactionEmoji(reaction.emoji);
    window.setTimeout(() => {
      setSpeakReactionEmoji((previous) => (previous === reaction.emoji ? "" : previous));
    }, 750);
    return reaction.tone;
  };

  const penalizeRecentAutoSentencePath = (penaltyWeight = 0.65) => {
    const meta = lastAcceptedAutoSentenceMetaRef.current;
    if (!meta?.normalizedPhrase) return;
    const ageMs = Date.now() - Number(meta.ts ?? 0);
    if (!Number.isFinite(ageMs) || ageMs > 12000) return;

    setAutoSentenceLearning((previous) => {
      const current = applyDailyDecayToAutoSentenceLearning(previous, new Date());
      return {
        ...current,
        ignoredCounts: {
          ...current.ignoredCounts,
          [meta.normalizedPhrase]:
            Number(current.ignoredCounts[meta.normalizedPhrase] ?? 0) + Number(penaltyWeight),
        },
      };
    });
  };

  const clearSentenceBuilder = () => {
    if (sentence.length > 0) {
      penalizeRecentAutoSentencePath(0.45);
    }
    lastRemovedTokenRef.current = "";
    setSentence([]);
    setLastAddedIndex(-1);
    setCursorIndex(0);
    setSentenceBuildStartedAt(null);
  };

  const handleSentenceGestureStart = (event) => {
    if (!isChildMode) return;
    if (event.target?.closest?.("button")) return;
    const touch = event.changedTouches?.[0];
    if (!touch) return;
    gestureStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      ts: Date.now(),
    };
  };

  const handleSentenceGestureEnd = (event) => {
    if (!isChildMode) return;
    if (event.target?.closest?.("button")) return;
    const start = gestureStartRef.current;
    gestureStartRef.current = null;
    const touch = event.changedTouches?.[0];
    if (!start || !touch) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const dt = Math.max(1, Date.now() - start.ts);
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (dx > 72 && absDx > absDy && dt < 900) {
      speakSentence();
      return;
    }

    if (dy > 72 && absDy > absDx && dt < 900) {
      clearSentenceBuilder();
      return;
    }

    if (absDx < 16 && absDy < 16 && dt < 320) {
      const now = Date.now();
      if (now - lastGestureTapRef.current < 320) {
        speakSentence();
        lastGestureTapRef.current = 0;
      } else {
        lastGestureTapRef.current = now;
      }
    }
  };

  const removeWordAt = (indexToRemove) => {
    penalizeRecentAutoSentencePath(0.62);
    const removedWord = sentence[indexToRemove];
    lastRemovedTokenRef.current = normalizeToken(removedWord?.text);
    setSentence((previousSentence) => {
      const nextSentence = previousSentence.filter((_, index) => index !== indexToRemove);
      if (nextSentence.length === 0) {
        setSentenceBuildStartedAt(null);
      }
      return nextSentence;
    });
    setLastAddedIndex((previous) => {
      if (previous === indexToRemove) return -1;
      if (previous > indexToRemove) return previous - 1;
      return previous;
    });
    if (cursorMode) {
      setCursorIndex((previous) => Math.max(0, Math.min(sentence.length - 1, previous)));
    }
  };

  const undoLastWord = () => {
    penalizeRecentAutoSentencePath(0.58);
    const removedWord = sentence[sentence.length - 1];
    lastRemovedTokenRef.current = normalizeToken(removedWord?.text);
    setSentence((previousSentence) => {
      const nextSentence = previousSentence.slice(0, -1);
      if (nextSentence.length === 0) {
        setSentenceBuildStartedAt(null);
      }
      return nextSentence;
    });
    setLastAddedIndex((previous) => Math.max(-1, previous - 1));
    if (cursorMode) {
      setCursorIndex((previous) => Math.max(0, previous - 1));
    }
  };

  const speakSentence = () => {
    const text = sentence.map((word) => word.text).join(" ");
    if (!text.trim()) return;

    const tokens = tokenizeText(text);
    const tone = triggerSpeakReaction(text, { urgencyScore: urgencySignal.score });

    speak(text, {
      lang: speechLanguage,
      rate: speechRate,
      pitch: speechPitch,
      volume: speechVolume,
      dualLanguageMode,
      autoDetectVoice,
      ttsProvider,
      voiceURI: selectedVoiceURI,
      tone,
    });
    const elapsedMs =
      Number.isFinite(Number(sentenceBuildStartedAt)) && Number(sentenceBuildStartedAt) > 0
        ? Math.max(0, Date.now() - Number(sentenceBuildStartedAt))
        : 250;
    recordSpokenSentence(text, { elapsedMs, tapCount: Math.max(1, sentence.length) });
    void trackSpeakClickedEvent({
      source: "sentence_builder",
      workspaceMode: isChildMode ? "child" : "parent",
      childProfileId: activeChildProfile?.id,
      languageCode: speechLanguage,
      wordCount: tokens.length,
      characterCount: text.length,
    });
    if (Number.isFinite(Number(elapsedMs)) && Number(elapsedMs) >= 0) {
      setSpeakLatencyMsHistory((previous) => [...previous, elapsedMs].slice(-80));
    }
    setSentenceBuildStartedAt(null);
    setUsageCounts((previousUsage) => {
      let nextUsage = previousUsage;
      tokens.forEach((token) => {
        nextUsage = incrementCounterBy(nextUsage, token, 0.7);
      });
      return nextUsage;
    });
    setTransitionCounts((previousTransitions) => {
      let nextTransitions = previousTransitions;
      for (let index = 1; index < tokens.length; index += 1) {
        nextTransitions = incrementTransitionBy(
          nextTransitions,
          tokens[index - 1],
          tokens[index],
          0.7
        );
      }
      return nextTransitions;
    });
    setDailySentenceCounts((previousCounts) => ({
      ...previousCounts,
      [todayKey]: (previousCounts[todayKey] ?? 0) + 1,
    }));
  };

  const addCustomWord = async () => {
    const text = window.prompt("Enter new word:");
    if (!text?.trim()) return;

    const emoji = window.prompt("Enter emoji:") || "🔤";
    const defaultCategoryForPrompt =
      activeCategory !== DEFAULT_CATEGORY ? activeCategory : DEFAULT_CUSTOM_CATEGORY;
    const rawCategory = window.prompt(
      "Category (Food, Feelings, Actions, Needs, etc.):",
      formatBoardLabel(defaultCategoryForPrompt, "Custom")
    );
    if (rawCategory === null) return;

    const defaultSubBoardForPrompt =
      activeSubBoard !== DEFAULT_SUB_BOARD ? activeSubBoard : DEFAULT_CUSTOM_SUB_BOARD;
    const rawSubBoard = window.prompt(
      "Folder / sub-board (Drinks, Emotions, Requests, etc.):",
      formatBoardLabel(defaultSubBoardForPrompt, "General")
    );
    if (rawSubBoard === null) return;

    const newWord = normalizeWordRecord({
      text: text.trim(),
      emoji,
      category: rawCategory,
      subBoard: rawSubBoard,
    }, defaultCategoryForPrompt, defaultSubBoardForPrompt);
    if (!newWord) return;

    try {
      if (!usingPlaceholderFirebaseConfig) {
        await addDoc(collection(db, "users", ownerId, "children", activeChildId, "words"), newWord);
      }
    } catch (error) {
      console.error("Failed to save word to Firestore:", error);
    }

    setCustomWords((previousWords) => mergeWordLists(previousWords, [newWord]));
    setActiveCategory(newWord.category);
    setActiveSubBoard(newWord.subBoard);
  };

  const applyStarterVocabularySet = async (setId) => {
    const starterSet = STARTER_VOCAB_SETS.find((entry) => entry.id === setId);
    if (!starterSet) return;

    const normalizedStarterWords = mergeWordLists(starterSet.words, []);
    const mergedWords = mergeWordLists(customWords, normalizedStarterWords);
    const existingWordKeys = new Set(
      mergeWordLists(customWords, []).map(
        (word) => `${normalizeToken(word.text)}::${word.category}::${word.subBoard}`
      )
    );
    const newWords = normalizedStarterWords.filter((word) => {
      const key = `${normalizeToken(word.text)}::${word.category}::${word.subBoard}`;
      return !existingWordKeys.has(key);
    });

    setCustomWords(mergedWords);

    if (newWords.length > 0) {
      setActiveCategory(newWords[0].category);
      setActiveSubBoard(newWords[0].subBoard);
    }

    if (usingPlaceholderFirebaseConfig || newWords.length === 0) return;

    try {
      await Promise.all(
        newWords.map((word) =>
          addDoc(collection(db, "users", ownerId, "children", activeChildId, "words"), word)
        )
      );
    } catch (error) {
      console.error("Failed to apply starter vocabulary set to Firestore:", error);
    }
  };

  const toggleFavorite = (word) => {
    const token = normalizeToken(word.text);
    if (!token) return;

    setFavoriteTokens((previousTokens) => {
      if (previousTokens.includes(token)) {
        return previousTokens.filter((existingToken) => existingToken !== token);
      }

      return [...previousTokens, token].slice(-32);
    });
  };

  const saveCurrentSentenceAsPhrase = () => {
    const phrase = sentence.map((word) => word.text).join(" ").trim();
    if (!phrase) return;
    savePhraseToQuickPhrases(phrase);
  };

  const mapTokensToWords = (tokens) => {
    return tokens.map((token) => {
      const normalized = normalizeToken(token);
      return (
        wordLookup[normalized] ??
        normalizeWordRecord(
          {
            text: token,
            emoji: "🔤",
            category: activeCategory !== DEFAULT_CATEGORY ? activeCategory : DEFAULT_CUSTOM_CATEGORY,
            subBoard: activeSubBoard !== DEFAULT_SUB_BOARD ? activeSubBoard : DEFAULT_CUSTOM_SUB_BOARD,
          },
          DEFAULT_CUSTOM_CATEGORY,
          DEFAULT_CUSTOM_SUB_BOARD
        ) ??
        { text: token, emoji: "🔤" }
      );
    });
  };

  const useQuickPhrase = (phrase, options = {}) => {
    const speakNow = Boolean(options.speakNow);
    const appendToSentence = options.appendToSentence !== false;
    const tokens = phrase.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return;
    const phraseToken = normalizeToken(phrase);

    const mappedWords = mapTokensToWords(tokens);

    if (appendToSentence) {
      appendWords(mappedWords);
    }
    if (speakNow) {
      const phraseUrgency = getUrgencySignal({
        sentenceTokens: tokens.map((token) => normalizeToken(token)),
        recentTapTimestamps: recentWordTapTimestampsRef.current,
        sentenceEvents,
      }).score;
      const tone = triggerSpeakReaction(phrase, { urgencyScore: phraseUrgency });
      speak(phrase, {
        lang: speechLanguage,
        rate: speechRate,
        pitch: speechPitch,
        volume: speechVolume,
        dualLanguageMode,
        autoDetectVoice,
        ttsProvider,
        voiceURI: selectedVoiceURI,
        tone,
      });
      const elapsedMs =
        Number.isFinite(Number(sentenceBuildStartedAt)) && Number(sentenceBuildStartedAt) > 0
          ? Math.max(0, Date.now() - Number(sentenceBuildStartedAt))
          : 250;
      recordSpokenSentence(phrase, { elapsedMs, tapCount: 1 });
      void trackSpeakClickedEvent({
        source: "quick_phrase",
        workspaceMode: isChildMode ? "child" : "parent",
        childProfileId: activeChildProfile?.id,
        languageCode: speechLanguage,
        wordCount: tokens.length,
        characterCount: phrase.length,
      });
      setSpeakLatencyMsHistory((previous) => [...previous, elapsedMs].slice(-80));
      setSentenceBuildStartedAt(null);
    }
    setPhraseUsageCounts((previous) => incrementCounter(previous, phraseToken));
    setRecentPhraseUsage((previous) => {
      const deduped = previous.filter((token) => token !== phraseToken);
      return [...deduped, phraseToken].slice(-MAX_PHRASES);
    });
  };

  const removeQuickPhrase = (phraseToRemove) => {
    const phraseToken = normalizeToken(phraseToRemove);
    setQuickPhrases((previousPhrases) =>
      previousPhrases.filter((phrase) => normalizeToken(phrase) !== phraseToken)
    );
    setPinnedPhraseTokens((previous) => previous.filter((token) => token !== phraseToken));
    setRecentPhraseUsage((previous) => previous.filter((token) => token !== phraseToken));
    setPhraseUsageCounts((previous) => {
      const next = { ...previous };
      delete next[phraseToken];
      return next;
    });
  };

  const togglePinnedPhrase = (phrase) => {
    const phraseToken = normalizeToken(phrase);
    if (!phraseToken) return;

    setPinnedPhraseTokens((previous) => {
      if (previous.includes(phraseToken)) {
        return previous.filter((token) => token !== phraseToken);
      }
      return [...previous, phraseToken].slice(-MAX_PHRASES);
    });
  };

  const savePhraseToQuickPhrases = (phrase) => {
    setQuickPhrases((previousPhrases) => addPhraseToList(phrase, previousPhrases, MAX_PHRASES));
  };

  const editOrDeleteQuickPhrase = (phrase) => {
    const editedPhrase = window.prompt("Edit phrase. Leave empty to delete:", phrase);
    if (editedPhrase === null) return;

    const cleaned = editedPhrase.trim();
    if (!cleaned) {
      removeQuickPhrase(phrase);
      return;
    }

    const phraseToken = normalizeToken(phrase);
    setQuickPhrases((previousPhrases) => {
      const withoutOriginal = previousPhrases.filter(
        (entry) => normalizeToken(entry) !== phraseToken
      );
      return addPhraseToList(cleaned, withoutOriginal, MAX_PHRASES);
    });
  };

  const clearPhraseHoldTimer = () => {
    if (!phraseHoldTimeoutRef.current) return;
    window.clearTimeout(phraseHoldTimeoutRef.current);
    phraseHoldTimeoutRef.current = null;
  };

  const startPhraseHold = (phrase) => {
    clearPhraseHoldTimer();
    phraseLongPressTriggeredRef.current = false;
    phraseHoldTimeoutRef.current = window.setTimeout(() => {
      phraseLongPressTriggeredRef.current = true;
      editOrDeleteQuickPhrase(phrase);
      phraseHoldTimeoutRef.current = null;
    }, PHRASE_LONG_PRESS_MS);
  };

  const usePhraseFromChildRow = (phrase) => {
    if (phraseLongPressTriggeredRef.current) {
      phraseLongPressTriggeredRef.current = false;
      return;
    }
    useQuickPhrase(phrase, { speakNow: true });
  };

  const getChildPhraseButtonProps = (phrase) => ({
    onClick: () => usePhraseFromChildRow(phrase),
    onMouseDown: () => startPhraseHold(phrase),
    onMouseUp: clearPhraseHoldTimer,
    onMouseLeave: clearPhraseHoldTimer,
    onTouchStart: () => startPhraseHold(phrase),
    onTouchEnd: clearPhraseHoldTimer,
    onTouchCancel: clearPhraseHoldTimer,
    onContextMenu: (event) => event.preventDefault(),
  });

  const registerAutoSentenceAcceptance = (phrase, metadata = {}) => {
    const normalizedPhrase = normalizeToken(phrase);
    if (!normalizedPhrase) return;
    const source = String(metadata.source ?? "memory");
    const intent = String(metadata.intent ?? AUTO_SENTENCE_INTENTS.UNKNOWN);
    const elapsedMs = Number(metadata.elapsedMs ?? 0);
    const tapCount = Math.max(1, Number(metadata.tapCount ?? 1));
    autoSentenceLastAcceptedRef.current = phrase;
    lastAcceptedAutoSentenceMetaRef.current = {
      phrase,
      normalizedPhrase,
      intent,
      source,
      ts: Date.now(),
    };

    setAutoSentenceLearning((previous) => {
      const current = applyDailyDecayToAutoSentenceLearning(previous, new Date());
      const previousAvgSpeed = Number(current.sentenceSpeedMs[normalizedPhrase] ?? 0);
      const previousSpeedSamples = Number(current.sentenceSpeedSamples[normalizedPhrase] ?? 0);
      const previousTapAvg = Number(current.sentenceTapCountAvg[normalizedPhrase] ?? 0);
      const previousTapSamples = Number(current.sentenceTapCountSamples[normalizedPhrase] ?? 0);
      const nextSpeedSamples = previousSpeedSamples + 1;
      const safeLatency = elapsedMs > 0 ? elapsedMs : 220;
      const nextAvgSpeed =
        previousSpeedSamples <= 0
          ? safeLatency
          : (previousAvgSpeed * previousSpeedSamples + safeLatency) / nextSpeedSamples;
      const nextTapSamples = previousTapSamples + 1;
      const nextTapAvg =
        previousTapSamples <= 0
          ? tapCount
          : (previousTapAvg * previousTapSamples + tapCount) / nextTapSamples;

      return {
        ...current,
        acceptedCounts: {
          ...current.acceptedCounts,
          [normalizedPhrase]: Number(current.acceptedCounts[normalizedPhrase] ?? 0) + 1,
        },
        dailyAcceptedCounts: {
          ...current.dailyAcceptedCounts,
          [todayKey]: Number(current.dailyAcceptedCounts[todayKey] ?? 0) + 1,
        },
        sentenceSpeedMs: {
          ...current.sentenceSpeedMs,
          [normalizedPhrase]: nextAvgSpeed,
        },
        sentenceSpeedSamples: {
          ...current.sentenceSpeedSamples,
          [normalizedPhrase]: nextSpeedSamples,
        },
        sentenceTapCountAvg: {
          ...current.sentenceTapCountAvg,
          [normalizedPhrase]: nextTapAvg,
        },
        sentenceTapCountSamples: {
          ...current.sentenceTapCountSamples,
          [normalizedPhrase]: nextTapSamples,
        },
        intentAcceptedCounts: {
          ...current.intentAcceptedCounts,
          [intent]: Number(current.intentAcceptedCounts[intent] ?? 0) + 1,
        },
        layerAcceptedCounts: {
          ...current.layerAcceptedCounts,
          [source]: Number(current.layerAcceptedCounts[source] ?? 0) + 1,
        },
      };
    });
  };

  const speakAutoSentence = (entryOrPhrase, options = {}) => {
    const phrase = String(
      typeof entryOrPhrase === "string"
        ? entryOrPhrase
        : entryOrPhrase?.sentence ?? entryOrPhrase?.phrase ?? ""
    )
      .trim()
      .replace(/\s+/g, " ");
    if (!phrase) return;

    const source =
      typeof entryOrPhrase === "string"
        ? "memory"
        : String(entryOrPhrase?.source ?? "memory");
    const analyticsSource =
      options.analyticsSource === "ghost_sentence" ? "ghost_sentence" : "auto_sentence";
    const tokens = tokenizeText(phrase);
    if (tokens.length === 0) return;

    const mappedWords = mapTokensToWords(tokens);
    const shouldAppend =
      options.append === true ||
      (options.append !== false &&
        autoSentenceSelectionMode === AUTO_SENTENCE_SELECTION_MODES.APPEND &&
        sentence.length > 0);
    const baseWords = shouldAppend ? sentence : [];
    const nextWords = [...baseWords, ...mappedWords];
    if (nextWords.length === 0) return;

    setSentence(nextWords);
    setLastAddedIndex(nextWords.length - 1);
    if (cursorMode) {
      setCursorIndex(nextWords.length);
    }

    const spokenText = nextWords.map((word) => word.text).join(" ").trim();
    const autoUrgency = getUrgencySignal({
      sentenceTokens: tokens,
      recentTapTimestamps: recentWordTapTimestampsRef.current,
      sentenceEvents,
    }).score;
    const tone = triggerSpeakReaction(spokenText, { urgencyScore: autoUrgency });
    speak(spokenText, {
      lang: speechLanguage,
      rate: speechRate,
      pitch: speechPitch,
      volume: speechVolume,
      dualLanguageMode,
      autoDetectVoice,
      ttsProvider,
      voiceURI: selectedVoiceURI,
      tone,
    });
    recordSpokenSentence(spokenText, { skipLearning: true, tapCount: 1 });
    void trackSpeakClickedEvent({
      source: analyticsSource,
      workspaceMode: isChildMode ? "child" : "parent",
      childProfileId: activeChildProfile?.id,
      languageCode: speechLanguage,
      wordCount: tokens.length,
      characterCount: spokenText.length,
      autoSentenceSource: source,
    });

    const spokenWeight = shouldAppend ? 0.45 : 0.72;
    setUsageCounts((previousUsage) => {
      let nextUsage = previousUsage;
      tokens.forEach((token) => {
        nextUsage = incrementCounterBy(nextUsage, token, spokenWeight);
      });
      return nextUsage;
    });
    setTransitionCounts((previousTransitions) => {
      let nextTransitions = previousTransitions;
      const previousLastToken = normalizeToken(baseWords[baseWords.length - 1]?.text);

      if (previousLastToken && tokens[0]) {
        nextTransitions = incrementTransitionBy(
          nextTransitions,
          previousLastToken,
          tokens[0],
          spokenWeight
        );
      }

      for (let index = 1; index < tokens.length; index += 1) {
        nextTransitions = incrementTransitionBy(
          nextTransitions,
          tokens[index - 1],
          tokens[index],
          spokenWeight
        );
      }

      return nextTransitions;
    });
    setDailySentenceCounts((previousCounts) => ({
      ...previousCounts,
      [todayKey]: (previousCounts[todayKey] ?? 0) + 1,
    }));
    const latencyMs =
      Number.isFinite(Number(sentenceBuildStartedAt)) && Number(sentenceBuildStartedAt) > 0
        ? Math.max(120, Date.now() - Number(sentenceBuildStartedAt))
        : 220;
    setSpeakLatencyMsHistory((previous) => [...previous, latencyMs].slice(-80));
    registerAutoSentenceAcceptance(spokenText, {
      source,
      intent: entryOrPhrase?.intent ?? AUTO_SENTENCE_INTENTS.UNKNOWN,
      elapsedMs: latencyMs,
      tapCount: 1,
    });
    setSentenceBuildStartedAt(null);
  };

  const clearAutoSentenceHoldTimer = () => {
    if (!autoSentenceHoldTimeoutRef.current) return;
    window.clearTimeout(autoSentenceHoldTimeoutRef.current);
    autoSentenceHoldTimeoutRef.current = null;
  };

  const startAutoSentenceHold = (entry) => {
    clearAutoSentenceHoldTimer();
    autoSentenceLongPressTriggeredRef.current = false;
    autoSentenceHoldTimeoutRef.current = window.setTimeout(() => {
      autoSentenceLongPressTriggeredRef.current = true;
      const edited = window.prompt("Edit sentence before speaking:", entry.sentence);
      const phrase = String(edited ?? "").trim();
      if (phrase) {
        speakAutoSentence({ ...entry, sentence: phrase }, { append: false });
      }
      autoSentenceHoldTimeoutRef.current = null;
    }, AUTO_SENTENCE_LONG_PRESS_MS);
  };

  const useAutoSentenceFromChildRow = (entry) => {
    if (autoSentenceLongPressTriggeredRef.current) {
      autoSentenceLongPressTriggeredRef.current = false;
      return;
    }
    speakAutoSentence(entry);
  };

  const getAutoSentenceButtonProps = (entry) => ({
    onClick: () => useAutoSentenceFromChildRow(entry),
    onMouseDown: () => startAutoSentenceHold(entry),
    onMouseUp: clearAutoSentenceHoldTimer,
    onMouseLeave: clearAutoSentenceHoldTimer,
    onTouchStart: () => startAutoSentenceHold(entry),
    onTouchEnd: clearAutoSentenceHoldTimer,
    onTouchCancel: clearAutoSentenceHoldTimer,
    onContextMenu: (event) => event.preventDefault(),
  });

  const speakGhostSentence = () => {
    if (!ghostAutoSentence) return;
    const topEntry = autoSentenceDisplaySuggestions[0];
    if (!topEntry) return;
    speakAutoSentence(topEntry, { append: false, analyticsSource: "ghost_sentence" });
  };

  const handleManageBilling = async () => {
    if (!user) {
      navigate("/login");
      return;
    }

    if (!stripeCustomerId) {
      navigate("/pricing");
      return;
    }

    try {
      const session = await openBillingPortal({ returnPath: "/pricing" });
      if (!session?.portalUrl) {
        throw new Error("Stripe portal URL is missing.");
      }
      window.location.assign(session.portalUrl);
    } catch (error) {
      window.alert(error?.message || "Unable to open billing portal right now.");
    }
  };

  const addChildProfile = () => {
    if (childProfiles.length >= maxChildrenAllowed) {
      window.alert(
        `${activePlan.name} supports up to ${maxChildrenAllowed} child profile${
          maxChildrenAllowed === 1 ? "" : "s"
        }. Upgrade to add more.`
      );
      navigate("/pricing");
      return;
    }

    const suggestedName = `Child ${childProfiles.length + 1}`;
    const name = window.prompt("New child name:", suggestedName);
    if (!name?.trim()) return;

    const newChild = {
      id: makeChildId(),
      name: name.trim(),
    };

    setChildProfiles((previousProfiles) => [...previousProfiles, newChild]);
    setActiveChildId(newChild.id);
  };

  const renameActiveChild = () => {
    const currentName = activeChildProfile?.name ?? "Child";
    const nextName = window.prompt("Rename child:", currentName);
    if (!nextName?.trim()) return;

    setChildProfiles((previousProfiles) =>
      previousProfiles.map((profile) =>
        profile.id === activeChildProfile.id ? { ...profile, name: nextName.trim() } : profile
      )
    );
  };

  const removeActiveChild = () => {
    if (childProfiles.length <= 1) {
      window.alert("At least one child profile is required.");
      return;
    }

    if (!window.confirm(`Delete profile "${activeChildProfile.name}"?`)) return;

    localStorage.removeItem(`aac-smart-model:${ownerId}:${activeChildProfile.id}`);
    localStorage.removeItem(`aac-preferences:${ownerId}:${activeChildProfile.id}`);
    localStorage.removeItem(`aac-custom-words:${ownerId}:${activeChildProfile.id}`);
    localStorage.removeItem(`aac-brain-cache:${ownerId}:${activeChildProfile.id}`);

    const remainingProfiles = childProfiles.filter((profile) => profile.id !== activeChildProfile.id);
    setChildProfiles(remainingProfiles);
    setActiveChildId(remainingProfiles[0].id);
  };

  const setGoalFromPrompt = () => {
    const value = window.prompt("Set daily spoken-sentence goal:", String(dailySentenceGoal));
    if (value === null) return;

    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 200) {
      window.alert("Please enter a whole number between 1 and 200.");
      return;
    }

    setDailySentenceGoal(parsed);
  };

  const applySuggestedGoal = () => {
    setDailySentenceGoal(suggestedGoal);
  };

  const saveAdaptivePhrase = (phrase) => {
    savePhraseToQuickPhrases(phrase);
  };

  useEffect(() => {
    const latestPhrase = String(sentenceHistory[sentenceHistory.length - 1] ?? "").trim();
    if (!latestPhrase) return;
    if (tokenizeText(latestPhrase).length < 2) return;

    const normalizedLatest = normalizeToken(latestPhrase);
    const repeatedCount = sentenceHistory.reduce(
      (total, entry) => total + (normalizeToken(entry) === normalizedLatest ? 1 : 0),
      0
    );

    if (repeatedCount < AUTO_SAVE_PHRASE_MIN_REPEAT) return;

    setQuickPhrases((previousPhrases) => {
      const alreadySaved = previousPhrases.some(
        (phrase) => normalizeToken(phrase) === normalizedLatest
      );
      if (alreadySaved) return previousPhrases;
      return addPhraseToList(latestPhrase, previousPhrases, MAX_PHRASES);
    });
  }, [sentenceHistory]);

  const resetTodayProgress = () => {
    setDailySentenceCounts((previousCounts) => ({
      ...previousCounts,
      [todayKey]: 0,
    }));
  };

  const resetLearningData = () => {
    if (!window.confirm("Reset learned predictions, usage counts, and sentence history?")) return;

    setUsageCounts({});
    setTransitionCounts({});
    setSentenceHistory([]);
    setSentenceEvents([]);
    setSpeakLatencyMsHistory([]);
    setAutoSentenceLearning(createDefaultAutoSentenceLearning());
    setLocalSuggestionCache({});
    setSentenceBuildStartedAt(null);
    setDailySentenceCounts({});
    autoSentenceSeenSignatureRef.current = "";
    autoSentenceLastPresentedRef.current = [];
    autoSentenceLastAcceptedRef.current = "";
    lastAcceptedAutoSentenceMetaRef.current = null;
  };

  const exportWorkspaceData = () => {
    if (!canUseBackupTools) {
      window.alert("Backup export is available on Pro and Premium plans.");
      navigate("/pricing");
      return;
    }

    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      childProfile: activeChildProfile,
      smartModel: {
        usageCounts,
        transitionCounts,
        sentenceHistory,
        sentenceEvents,
        speakLatencyMsHistory,
        autoSentenceLearning,
      },
      preferences: {
        favoriteTokens,
        quickPhrases,
        autoSpeak,
        dailySentenceGoal,
        dailySentenceCounts,
        activeCategory,
        activeSubBoard,
        largeTileMode,
        scanMode,
        holdToSelect,
        scanIntervalMs,
        speechLanguage,
        dualLanguageMode,
        autoDetectVoice,
        ttsProvider,
        selectedVoiceURI,
        speechRate,
        speechPitch,
        speechVolume,
        onboardingCompleted,
        workspaceMode,
        tapSoundEnabled,
        tapFlashEnabled,
        pinnedPhraseTokens,
        phraseUsageCounts,
        recentPhraseUsage,
        progressiveDisclosureEnabled,
        topWordsMode,
        smartHidingEnabled,
        adaptiveDifficulty,
        therapyGoal,
        autoSentenceMode,
        autoSentenceSelectionMode,
        environmentContext,
      },
      customWords: mergeWordLists(customWords, []),
      localBrainCache: buildLocalBrainCache({
        childId: activeChildId,
        cachedSuggestions: localSuggestionCache,
        lastSync: lastSyncedAt ? lastSyncedAt.toISOString() : null,
      }),
    };

    const serialized = JSON.stringify(backup, null, 2);
    window.prompt("Copy your Titonova NeuroVoice backup JSON:", serialized);
  };

  const importWorkspaceData = () => {
    if (!canUseBackupTools) {
      window.alert("Backup import is available on Pro and Premium plans.");
      navigate("/pricing");
      return;
    }

    const raw = window.prompt("Paste your Titonova NeuroVoice backup JSON:");
    if (!raw?.trim()) return;

    try {
      const parsed = JSON.parse(raw);
      const model = parsed.smartModel ?? {};
      const prefs = parsed.preferences ?? {};
      const parsedBrainCache = parseLocalBrainCache(JSON.stringify(parsed.localBrainCache ?? {}));

      setUsageCounts(model.usageCounts ?? {});
      setTransitionCounts(model.transitionCounts ?? {});
      setSentenceHistory(Array.isArray(model.sentenceHistory) ? model.sentenceHistory.slice(-50) : []);
      setSentenceEvents(normalizeSentenceEvents(model.sentenceEvents ?? []).slice(-MAX_SENTENCE_EVENTS));
      setFavoriteTokens(Array.isArray(prefs.favoriteTokens) ? prefs.favoriteTokens : []);
      setQuickPhrases(
        Array.isArray(prefs.quickPhrases) && prefs.quickPhrases.length > 0
          ? prefs.quickPhrases.slice(0, MAX_PHRASES)
          : DEFAULT_QUICK_PHRASES
      );
      setAutoSpeak(Boolean(prefs.autoSpeak));
      setDailySentenceGoal(
        Number.isInteger(prefs.dailySentenceGoal) && prefs.dailySentenceGoal > 0
          ? prefs.dailySentenceGoal
          : 8
      );
      setDailySentenceCounts(
        prefs.dailySentenceCounts && typeof prefs.dailySentenceCounts === "object"
          ? prefs.dailySentenceCounts
          : {}
      );
      setActiveCategory(normalizeBoardKey(prefs.activeCategory, DEFAULT_CATEGORY));
      setActiveSubBoard(normalizeBoardKey(prefs.activeSubBoard, DEFAULT_SUB_BOARD));
      setLargeTileMode(Boolean(prefs.largeTileMode));
      setScanMode(Boolean(prefs.scanMode));
      setHoldToSelect(Boolean(prefs.holdToSelect));
      setScanIntervalMs(
        Math.max(600, Math.min(3500, Number(prefs.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS)))
      );
      setSpeechLanguage(normalizeLanguageCode(prefs.speechLanguage ?? "en"));
      setDualLanguageMode(Boolean(prefs.dualLanguageMode));
      setAutoDetectVoice(Boolean(prefs.autoDetectVoice ?? true));
      setTtsProvider(
        Object.values(TTS_PROVIDERS).includes(String(prefs.ttsProvider ?? ""))
          ? String(prefs.ttsProvider)
          : TTS_PROVIDERS.BROWSER
      );
      setSelectedVoiceURI(String(prefs.selectedVoiceURI ?? ""));
      setSpeechRate(Math.max(0.6, Math.min(1.6, Number(prefs.speechRate ?? 0.9))));
      setSpeechPitch(Math.max(0.6, Math.min(1.6, Number(prefs.speechPitch ?? 1))));
      setSpeechVolume(Math.max(0, Math.min(1, Number(prefs.speechVolume ?? 1))));
      setOnboardingCompleted(Boolean(prefs.onboardingCompleted));
      setWorkspaceMode(String(prefs.workspaceMode ?? "child").toLowerCase() === "parent" ? "parent" : "child");
      setTapSoundEnabled(Boolean(prefs.tapSoundEnabled));
      setTapFlashEnabled(Boolean(prefs.tapFlashEnabled ?? true));
      setPinnedPhraseTokens(
        Array.isArray(prefs.pinnedPhraseTokens)
          ? prefs.pinnedPhraseTokens.map((token) => String(token).toLowerCase())
          : []
      );
      setPhraseUsageCounts(
        prefs.phraseUsageCounts && typeof prefs.phraseUsageCounts === "object"
          ? prefs.phraseUsageCounts
          : {}
      );
      setRecentPhraseUsage(
        Array.isArray(prefs.recentPhraseUsage)
          ? prefs.recentPhraseUsage.map((token) => String(token).toLowerCase())
          : []
      );
      setProgressiveDisclosureEnabled(Boolean(prefs.progressiveDisclosureEnabled ?? true));
      setTopWordsMode(Boolean(prefs.topWordsMode));
      setSmartHidingEnabled(Boolean(prefs.smartHidingEnabled ?? true));
      setAdaptiveDifficulty(
        String(prefs.adaptiveDifficulty ?? DIFFICULTY_LEVELS.INTERMEDIATE).toLowerCase() ===
          DIFFICULTY_LEVELS.BEGINNER
          ? DIFFICULTY_LEVELS.BEGINNER
          : String(prefs.adaptiveDifficulty ?? DIFFICULTY_LEVELS.INTERMEDIATE).toLowerCase() ===
              DIFFICULTY_LEVELS.ADVANCED
            ? DIFFICULTY_LEVELS.ADVANCED
            : DIFFICULTY_LEVELS.INTERMEDIATE
      );
      setTherapyGoal(
        String(prefs.therapyGoal ?? THERAPY_GOALS.BALANCED).toLowerCase() ===
          THERAPY_GOALS.EXPAND_VOCABULARY
          ? THERAPY_GOALS.EXPAND_VOCABULARY
          : String(prefs.therapyGoal ?? THERAPY_GOALS.BALANCED).toLowerCase() ===
              THERAPY_GOALS.COMMUNICATION_SPEED
            ? THERAPY_GOALS.COMMUNICATION_SPEED
            : THERAPY_GOALS.BALANCED
      );
      setAutoSentenceMode(Boolean(prefs.autoSentenceMode ?? true));
      setAutoSentenceSelectionMode(
        String(prefs.autoSentenceSelectionMode ?? AUTO_SENTENCE_SELECTION_MODES.REPLACE).toLowerCase() ===
          AUTO_SENTENCE_SELECTION_MODES.APPEND
          ? AUTO_SENTENCE_SELECTION_MODES.APPEND
          : AUTO_SENTENCE_SELECTION_MODES.REPLACE
      );
      setEnvironmentContext(
        String(prefs.environmentContext ?? AUTO_SENTENCE_ENVIRONMENTS.HOME).toLowerCase() ===
          AUTO_SENTENCE_ENVIRONMENTS.SCHOOL
          ? AUTO_SENTENCE_ENVIRONMENTS.SCHOOL
          : String(prefs.environmentContext ?? AUTO_SENTENCE_ENVIRONMENTS.HOME).toLowerCase() ===
              AUTO_SENTENCE_ENVIRONMENTS.CLINIC
            ? AUTO_SENTENCE_ENVIRONMENTS.CLINIC
            : String(prefs.environmentContext ?? AUTO_SENTENCE_ENVIRONMENTS.HOME).toLowerCase() ===
                AUTO_SENTENCE_ENVIRONMENTS.COMMUNITY
              ? AUTO_SENTENCE_ENVIRONMENTS.COMMUNITY
              : AUTO_SENTENCE_ENVIRONMENTS.HOME
      );
      setCustomWords(mergeWordLists(Array.isArray(parsed.customWords) ? parsed.customWords : [], []));
      setSpeakLatencyMsHistory(mergeLatencyHistory(model.speakLatencyMsHistory ?? [], []));
      setLocalSuggestionCache(parsedBrainCache.cachedSuggestions ?? {});
      setAutoSentenceLearning(normalizeAutoSentenceLearning(model.autoSentenceLearning ?? {}));
      autoSentenceSeenSignatureRef.current = "";
      autoSentenceLastPresentedRef.current = [];
      autoSentenceLastAcceptedRef.current = "";
      lastAcceptedAutoSentenceMetaRef.current = null;
      window.alert("Backup imported.");
    } catch (error) {
      console.error("Failed to import workspace data:", error);
      window.alert("Backup JSON is invalid.");
    }
  };

  const toggleAutoSpeak = () => {
    if (!canUseAutoSpeak) {
      window.alert("Auto-Speak is available on Pro and Premium plans.");
      navigate("/pricing");
      return;
    }
    setAutoSpeak((enabled) => !enabled);
  };

  const totalWordTaps = Object.values(usageCounts).reduce((total, value) => total + value, 0);
  const autoSentenceImpact = useMemo(
    () => getAutoSentenceImpactSummary(autoSentenceLearning),
    [autoSentenceLearning]
  );
  const autoSentenceDailyTrend = useMemo(
    () => getRecentAutoSentenceRateSeries(autoSentenceLearning, 14),
    [autoSentenceLearning]
  );
  const avgSpeakLatencySeconds = useMemo(() => {
    if (!Array.isArray(speakLatencyMsHistory) || speakLatencyMsHistory.length === 0) return null;
    const totalMs = speakLatencyMsHistory.reduce((sum, value) => sum + Number(value ?? 0), 0);
    return totalMs / speakLatencyMsHistory.length / 1000;
  }, [speakLatencyMsHistory]);
  const bestSpeakLatencySeconds = useMemo(() => {
    if (!Array.isArray(speakLatencyMsHistory) || speakLatencyMsHistory.length === 0) return null;
    return Math.min(...speakLatencyMsHistory.map((value) => Number(value ?? 0))) / 1000;
  }, [speakLatencyMsHistory]);
  const recommendations = useMemo(() => {
    const insights = [];
    const usageEntries = Object.entries(usageCounts).sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0));
    const topWord = usageEntries[0];
    const totalUsage = usageEntries.reduce((sum, [, count]) => sum + Number(count ?? 0), 0);
    const uniqueWordCount = usageEntries.length;
    const repeatedPhrases = getTopRepeatedPhrases(sentenceHistory, 3);
    const routineToken = getTopRoutineToken(sentenceEvents, new Date());
    const nowHour = new Date().getHours();

    if (topWord && totalUsage > 12) {
      const topShare = Number(topWord[1] ?? 0) / Math.max(1, totalUsage);
      if (topShare >= 0.35) {
        insights.push(`"${topWord[0]}" dominates usage. Add 3-5 alternatives in the same category.`);
      }
      if (topWord[0] === "want") {
        insights.push(`High use of "want". Consider expanding with action verbs like "go", "play", "rest".`);
      }
    }

    if (uniqueWordCount < 10 && totalUsage > 20) {
      insights.push("Word variety is low. Introduce a starter set and promote daily rotation words.");
    }

    if (sevenDayAverage < dailySentenceGoal * 0.6) {
      insights.push("Goal completion is low. Consider lowering today’s goal, then ramping weekly.");
    }

    if (repeatedPhrases.length > 0 && repeatedPhrases[0].count >= 3) {
      insights.push(`Phrase "${repeatedPhrases[0].phrase}" repeats often. Add related follow-up choices nearby.`);
    }

    if (routineToken && routineToken.score >= 1) {
      insights.push(
        `Routine signal: "${routineToken.token}" appears around ${nowHour}:00. Preload it in smart suggestions.`
      );
    }

    if (avgSpeakLatencySeconds !== null && avgSpeakLatencySeconds > 8) {
      insights.push(`Speed opportunity: avg speak time is ${avgSpeakLatencySeconds.toFixed(1)}s. Keep Top-12 mode enabled.`);
    }

    if (autoSentenceImpact.shownTotal >= 8) {
      const acceptPct = Math.round(autoSentenceImpact.acceptanceRate * 100);
      const ignorePct = Math.round(autoSentenceImpact.ignoreRate * 100);
      if (acceptPct < 18) {
        insights.push("Auto-sentence acceptance is low. Review 'Why?' details and pin stronger quick phrases.");
      } else if (acceptPct >= 35) {
        insights.push(`Auto-sentence acceptance is ${acceptPct}%. Keep phrase templates aligned to daily routines.`);
      }
      if (ignorePct >= 45) {
        insights.push("Suggestions are being ignored often. Reduce board noise or tune environment context.");
      }
      if (autoSentenceImpact.bestLayer?.label) {
        insights.push(
          `${autoSentenceImpact.bestLayer.label} layer is strongest (${Math.round(
            autoSentenceImpact.bestLayer.rate * 100
          )}% acceptance).`
        );
      }
    }

    if (therapyGoal === THERAPY_GOALS.EXPAND_VOCABULARY) {
      insights.push("Therapy goal is vocabulary expansion: keep novelty nudges and concept-linked suggestions enabled.");
    } else if (therapyGoal === THERAPY_GOALS.COMMUNICATION_SPEED) {
      insights.push("Therapy goal is fastest communication: prioritize one-tap phrases and auto-sentence shortcuts.");
    }

    if (insights.length === 0) {
      insights.push("Communication diversity looks healthy. Continue adding context-specific vocabulary weekly.");
    }

    return insights.slice(0, 4);
  }, [
    usageCounts,
    sentenceHistory,
    sentenceEvents,
    dailySentenceGoal,
    sevenDayAverage,
    avgSpeakLatencySeconds,
    autoSentenceImpact,
    therapyGoal,
  ]);
  const progressStories = useMemo(() => {
    const stories = [];
    const usageEntries = Object.entries(usageCounts).sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0));
    const uniqueWords = usageEntries.length;

    const today = new Date();
    const currentWeekTotal = Array.from({ length: 7 }).reduce((sum, _, offset) => {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate()
      ).padStart(2, "0")}`;
      return sum + Number(dailySentenceCounts[key] ?? 0);
    }, 0);
    const previousWeekTotal = Array.from({ length: 7 }).reduce((sum, _, offset) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (offset + 7));
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate()
      ).padStart(2, "0")}`;
      return sum + Number(dailySentenceCounts[key] ?? 0);
    }, 0);
    const weekGrowthPct =
      previousWeekTotal > 0
        ? Math.round(((currentWeekTotal - previousWeekTotal) / previousWeekTotal) * 100)
        : currentWeekTotal > 0
          ? 100
          : 0;

    if (uniqueWords >= 5) {
      stories.push(`Your child used ${uniqueWords} unique words this profile. Great expansion momentum.`);
    }
    if (currentWeekTotal > 0) {
      stories.push(`This week has ${currentWeekTotal} spoken sentences so far.`);
    }
    if (weekGrowthPct > 0) {
      stories.push(`Communication improved by ${weekGrowthPct}% versus last week.`);
    }
    if (avgSpeakLatencySeconds !== null && avgSpeakLatencySeconds < 6.5) {
      stories.push(`Average time-to-speak is now ${avgSpeakLatencySeconds.toFixed(1)}s. Speed is improving.`);
    }
    if (autoSentenceImpact.tapsSavedEstimate > 0) {
      stories.push(
        `Auto-sentence shortcuts saved an estimated ${autoSentenceImpact.tapsSavedEstimate} taps for this child profile.`
      );
    }
    if (autoSentenceImpact.bestLayer?.label) {
      stories.push(
        `Top auto-sentence source this week: ${autoSentenceImpact.bestLayer.label} (${Math.round(
          autoSentenceImpact.bestLayer.rate * 100
        )}% accepted).`
      );
    }
    if (therapyGoal === THERAPY_GOALS.EXPAND_VOCABULARY) {
      stories.push("Therapy focus: expanding vocabulary with guided novel variations.");
    }
    if (therapyGoal === THERAPY_GOALS.COMMUNICATION_SPEED) {
      stories.push("Therapy focus: fastest-path communication with reduced taps.");
    }
    if (stories.length === 0) {
      stories.push("Every tap builds confidence. Keep using quick phrases and smart suggestions daily.");
    }

    return stories.slice(0, 3);
  }, [usageCounts, dailySentenceCounts, avgSpeakLatencySeconds, autoSentenceImpact, therapyGoal]);

  const syncSummary = useMemo(() => {
    if (!canSyncCloud) {
      return "Offline mode: using local data";
    }

    if (syncStatus === "syncing") {
      return "Syncing with cloud...";
    }

    if (syncStatus === "error") {
      return "Sync issue: using local backup";
    }

    if (lastSyncedAt instanceof Date && !Number.isNaN(lastSyncedAt.getTime())) {
      return `Last synced: ${lastSyncedAt.toLocaleTimeString()}`;
    }

    return "Cloud sync ready";
  }, [canSyncCloud, syncStatus, lastSyncedAt]);
  const isParentMode = workspaceMode === "parent";
  const isChildMode = !isParentMode;

  return (
    <div style={workspaceRootStyle}>
      <div style={workspaceGlowOneStyle} />
      <div style={workspaceGlowTwoStyle} />
      <div style={workspaceShellStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={{ marginBottom: 8 }}>Titonova NeuroVoice</h1>
          <p style={{ margin: 0 }}>
            {user ? `Signed in as ${user?.displayName || user?.email}` : "Guest mode (no account required)"} | Active
            child: {activeChildProfile.name} | Roles: {roles.join(", ") || ROLES.PARENT} | Plan:{" "}
            {activePlan.name} ({activePlan.priceLabel})
          </p>
          <p style={syncStatusStyle}>{syncSummary}</p>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {hasAnyRole([ROLES.THERAPIST, ROLES.ADMIN]) ? (
            <Link to="/therapist" style={linkPillStyle}>
              Therapist View
            </Link>
          ) : null}
          {hasAnyRole([ROLES.ADMIN]) ? (
            <Link to="/admin" style={linkPillStyle}>
              Admin View
            </Link>
          ) : null}
          <Link to="/pricing" style={linkPillStyle}>
            Pricing
          </Link>
          {user && stripeCustomerId ? (
            <button onClick={handleManageBilling} style={btnStyle}>
              Manage Billing
            </button>
          ) : null}
          {user ? (
            <button onClick={signOut} style={btnStyle}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>

      <section style={childSwitcherStyle}>
        <strong>Child profile</strong>
        <div style={childControlsStyle}>
          <select
            value={activeChildProfile.id}
            onChange={(event) => setActiveChildId(event.target.value)}
            style={selectStyle}
          >
            {childProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <button onClick={addChildProfile} style={btnStyle}>
            Add Child
          </button>
          <button onClick={renameActiveChild} style={btnStyle}>
            Rename
          </button>
          <button onClick={removeActiveChild} style={btnStyle}>
            Delete
          </button>
        </div>
        <p style={{ margin: "8px 0 0", color: "#9db5ce", fontSize: 13 }}>
          {activePlan.name} limit: up to {maxChildrenAllowed} child profile{maxChildrenAllowed === 1 ? "" : "s"}.
        </p>
      </section>

      <section style={modeSwitcherStyle}>
        <div>
          <strong style={panelTitleStyle}>Workspace mode</strong>
          <p style={modeHelpTextStyle}>
            Child mode focuses on speaking fast. Parent mode shows goals, coaching, and configuration.
          </p>
        </div>
        <div style={modeToggleRowStyle}>
          <button
            onClick={() => setWorkspaceMode("child")}
            style={workspaceMode === "child" ? activeBtnStyle : btnStyle}
          >
            Child Mode
          </button>
          <button
            onClick={() => setWorkspaceMode("parent")}
            style={workspaceMode === "parent" ? activeBtnStyle : btnStyle}
          >
            Parent Mode
          </button>
        </div>
      </section>

      {usingPlaceholderFirebaseConfig && showFirebaseWarning ? (
        <div style={warningBannerStyle}>
          <span>
            Firebase env variables are placeholders. Set VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, and
            VITE_FIREBASE_PROJECT_ID to enable live auth/firestore.
          </span>
          <button onClick={() => setShowFirebaseWarning(false)} style={warningDismissBtnStyle}>
            Dismiss
          </button>
        </div>
      ) : null}

      {isParentMode && !onboardingCompleted ? (
        <section style={panelCardStyle}>
          <strong style={panelTitleStyle}>Quick start guide</strong>
          <p style={onboardingBodyStyle}>
            1) Choose a child profile. 2) Tap words or phrases and press Speak. 3) Save frequently-used phrases.
            4) Add a starter vocabulary set to jumpstart variety.
          </p>
          <div style={starterSetRowStyle}>
            {STARTER_VOCAB_SETS.map((set) => (
              <button
                key={set.id}
                onClick={() => applyStarterVocabularySet(set.id)}
                style={btnStyle}
              >
                Add {set.label}
              </button>
            ))}
            <button onClick={() => setOnboardingCompleted(true)} style={btnStyle}>
              Dismiss Guide
            </button>
          </div>
        </section>
      ) : null}

      {isParentMode ? (
      <section style={goalCardStyle}>
        <div style={goalHeaderStyle}>
          <strong>Daily speaking goal</strong>
          <span>
            {todaySentenceCount}/{dailySentenceGoal}
          </span>
        </div>
        <div style={progressTrackStyle}>
          <div style={{ ...progressFillStyle, width: `${goalProgressPct}%` }} />
        </div>
        <p style={goalMetaStyle}>
          7-day avg: {sevenDayAverage.toFixed(1)} | Goal streak: {goalStreak} day{goalStreak === 1 ? "" : "s"}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={setGoalFromPrompt} style={btnStyle}>
            Set Goal
          </button>
          <button onClick={applySuggestedGoal} style={btnStyle}>
            Use Suggested Goal ({suggestedGoal})
          </button>
          <button onClick={resetTodayProgress} style={btnStyle}>
            Reset Today
          </button>
        </div>
      </section>
      ) : null}

      {isParentMode ? (
      <section style={finderSectionStyle}>
        <strong>Word Management</strong>
        <div style={finderControlsStyle}>
          <input
            type="text"
            value={wordSearch}
            onChange={(event) => setWordSearch(event.target.value)}
            placeholder="Search words..."
            style={textInputStyle}
          />
          <select value={wordFilter} onChange={(event) => setWordFilter(event.target.value)} style={selectStyle}>
            <option value="all">All words</option>
            <option value="favorites">Favorites</option>
            <option value="default">Default</option>
            <option value="custom">Custom</option>
          </select>
          <button onClick={() => setWordSearch("")} style={btnStyle}>
            Reset Search
          </button>
          <button onClick={addCustomWord} style={btnStyle}>
            + Add Word
          </button>
        </div>
      </section>
      ) : null}

      {isParentMode ? (
      <section
        style={panelCardStyle}
        onTouchStart={handleSentenceGestureStart}
        onTouchEnd={handleSentenceGestureEnd}
        onDoubleClick={() => {
          if (isChildMode) speakSentence();
        }}
      >
        <strong style={panelTitleStyle}>Board navigation</strong>
        <div style={boardTabRowStyle}>
          {categoryTabs.map((tab) => {
            const isActive = activeCategory === tab.id;
            return (
              <button
                key={`category-tab-${tab.id}`}
                onClick={() => {
                  setActiveCategory(tab.id);
                  setActiveSubBoard(DEFAULT_SUB_BOARD);
                }}
                style={boardTabBtnStyle(isActive)}
              >
                {tab.label} ({tab.count})
              </button>
            );
          })}
        </div>

        {activeCategory !== DEFAULT_CATEGORY ? (
          <div style={boardSubTabRowStyle}>
            {subBoardTabs.map((tab) => {
              const isActive = activeSubBoard === tab.id;
              return (
                <button
                  key={`subboard-tab-${tab.id}`}
                  onClick={() => setActiveSubBoard(tab.id)}
                  style={boardSubTabBtnStyle(isActive)}
                >
                  {tab.label} ({tab.count})
                </button>
              );
            })}
          </div>
        ) : null}

        <p style={boardNavigationHintStyle}>
          Active board: {formatBoardLabel(activeCategory, "All Boards")}
          {activeCategory !== DEFAULT_CATEGORY
            ? ` / ${formatBoardLabel(activeSubBoard, "All Folders")}`
            : ""}
        </p>
      </section>
      ) : null}

      {isParentMode ? (
      <section style={panelCardStyle}>
        <strong style={panelTitleStyle}>Accessibility + voice</strong>
        <div style={accessibilityRowStyle}>
          <button
            onClick={() => setLargeTileMode((value) => !value)}
            style={largeTileMode ? activeBtnStyle : btnStyle}
          >
            {largeTileMode ? "Large Tiles On" : "Large Tiles Off"}
          </button>
          <button
            onClick={() => setHoldToSelect((value) => !value)}
            style={holdToSelect ? activeBtnStyle : btnStyle}
          >
            {holdToSelect ? "Hold-to-select On" : "Hold-to-select Off"}
          </button>
          <button
            onClick={() => setScanMode((value) => !value)}
            style={scanMode ? activeBtnStyle : btnStyle}
          >
            {scanMode ? "Scan + Select On" : "Scan + Select Off"}
          </button>
          <button onClick={() => setOnboardingCompleted(false)} style={btnStyle}>
            Show Guide
          </button>
          <button
            onClick={() => setTapSoundEnabled((value) => !value)}
            style={tapSoundEnabled ? activeBtnStyle : btnStyle}
          >
            {tapSoundEnabled ? "Tap Sound On" : "Tap Sound Off"}
          </button>
          <button
            onClick={() => setTapFlashEnabled((value) => !value)}
            style={tapFlashEnabled ? activeBtnStyle : btnStyle}
          >
            {tapFlashEnabled ? "Tap Flash On" : "Tap Flash Off"}
          </button>
          <button
            onClick={() => setDualLanguageMode((value) => !value)}
            style={dualLanguageMode ? activeBtnStyle : btnStyle}
          >
            {dualLanguageMode ? "Dual Language On" : "Dual Language Off"}
          </button>
          <button
            onClick={() => setAutoDetectVoice((value) => !value)}
            style={autoDetectVoice ? activeBtnStyle : btnStyle}
          >
            {autoDetectVoice ? "Auto Voice On" : "Auto Voice Off"}
          </button>
          <button
            onClick={() => setCursorMode((value) => !value)}
            style={cursorMode ? activeBtnStyle : btnStyle}
          >
            {cursorMode ? "Cursor Mode On" : "Cursor Mode Off"}
          </button>
          <button
            onClick={() => setProgressiveDisclosureEnabled((value) => !value)}
            style={progressiveDisclosureEnabled ? activeBtnStyle : btnStyle}
          >
            {progressiveDisclosureEnabled ? "Progressive On" : "Progressive Off"}
          </button>
          <button
            onClick={() => setTopWordsMode((value) => !value)}
            style={topWordsMode ? activeBtnStyle : btnStyle}
          >
            {topWordsMode ? "Top 12 On" : "Top 12 Off"}
          </button>
          <button
            onClick={() => setSmartHidingEnabled((value) => !value)}
            style={smartHidingEnabled ? activeBtnStyle : btnStyle}
          >
            {smartHidingEnabled ? "Smart Hiding On" : "Smart Hiding Off"}
          </button>
          <button
            onClick={() => setAutoSentenceMode((value) => !value)}
            style={autoSentenceMode ? activeBtnStyle : btnStyle}
          >
            {autoSentenceMode ? "Auto-Sentence On" : "Auto-Sentence Off"}
          </button>
          <button
            onClick={() =>
              setAutoSentenceSelectionMode((previous) =>
                previous === AUTO_SENTENCE_SELECTION_MODES.REPLACE
                  ? AUTO_SENTENCE_SELECTION_MODES.APPEND
                  : AUTO_SENTENCE_SELECTION_MODES.REPLACE
              )
            }
            style={autoSentenceSelectionMode === AUTO_SENTENCE_SELECTION_MODES.APPEND ? activeBtnStyle : btnStyle}
          >
            {autoSentenceSelectionMode === AUTO_SENTENCE_SELECTION_MODES.APPEND
              ? "Auto-Sentence Append"
              : "Auto-Sentence Replace"}
          </button>
          <button
            onClick={() =>
              setEnvironmentContext((previous) =>
                previous === AUTO_SENTENCE_ENVIRONMENTS.HOME
                  ? AUTO_SENTENCE_ENVIRONMENTS.SCHOOL
                  : previous === AUTO_SENTENCE_ENVIRONMENTS.SCHOOL
                    ? AUTO_SENTENCE_ENVIRONMENTS.CLINIC
                    : previous === AUTO_SENTENCE_ENVIRONMENTS.CLINIC
                      ? AUTO_SENTENCE_ENVIRONMENTS.COMMUNITY
                      : AUTO_SENTENCE_ENVIRONMENTS.HOME
              )
            }
            style={activeBtnStyle}
          >
            Env: {environmentContext}
          </button>
        </div>
        <div style={difficultyRowStyle}>
          <span style={wordGridMetaTextStyle}>Adaptive difficulty:</span>
          <button
            onClick={() => setAdaptiveDifficulty(DIFFICULTY_LEVELS.BEGINNER)}
            style={adaptiveDifficulty === DIFFICULTY_LEVELS.BEGINNER ? activeBtnStyle : btnStyle}
          >
            Beginner
          </button>
          <button
            onClick={() => setAdaptiveDifficulty(DIFFICULTY_LEVELS.INTERMEDIATE)}
            style={adaptiveDifficulty === DIFFICULTY_LEVELS.INTERMEDIATE ? activeBtnStyle : btnStyle}
          >
            Intermediate
          </button>
          <button
            onClick={() => setAdaptiveDifficulty(DIFFICULTY_LEVELS.ADVANCED)}
            style={adaptiveDifficulty === DIFFICULTY_LEVELS.ADVANCED ? activeBtnStyle : btnStyle}
          >
            Advanced
          </button>
        </div>
        <div style={difficultyRowStyle}>
          <span style={wordGridMetaTextStyle}>Therapy goal:</span>
          <button
            onClick={() => setTherapyGoal(THERAPY_GOALS.BALANCED)}
            style={therapyGoal === THERAPY_GOALS.BALANCED ? activeBtnStyle : btnStyle}
          >
            Balanced
          </button>
          <button
            onClick={() => setTherapyGoal(THERAPY_GOALS.EXPAND_VOCABULARY)}
            style={therapyGoal === THERAPY_GOALS.EXPAND_VOCABULARY ? activeBtnStyle : btnStyle}
          >
            Expand Vocabulary
          </button>
          <button
            onClick={() => setTherapyGoal(THERAPY_GOALS.COMMUNICATION_SPEED)}
            style={therapyGoal === THERAPY_GOALS.COMMUNICATION_SPEED ? activeBtnStyle : btnStyle}
          >
            Fastest Path
          </button>
        </div>
        <p style={speedHintStyle}>
          Avg time-to-speak: {avgSpeakLatencySeconds !== null ? `${avgSpeakLatencySeconds.toFixed(1)}s` : "—"} | Best:{" "}
          {bestSpeakLatencySeconds !== null ? `${bestSpeakLatencySeconds.toFixed(1)}s` : "—"}
        </p>

        {scanMode ? (
          <div style={scanControlPanelStyle}>
            <label style={rangeLabelStyle}>
              Scan interval ({scanIntervalMs} ms)
              <input
                type="range"
                min={600}
                max={3000}
                step={100}
                value={scanIntervalMs}
                onChange={(event) => setScanIntervalMs(Number(event.target.value))}
              />
            </label>
            <div style={scanReadoutStyle}>
              Highlighted: {scannedWord ? scannedWord.text : "No word"}
            </div>
            <button onClick={selectScannedWord} style={btnStyle} disabled={!scannedWord}>
              Select Highlighted
            </button>
          </div>
        ) : null}

        <div style={voiceGridStyle}>
          <label style={rangeLabelStyle}>
            TTS provider
            <select
              value={ttsProvider}
              onChange={(event) => setTtsProvider(String(event.target.value))}
              style={selectStyle}
            >
              <option value={TTS_PROVIDERS.BROWSER}>Browser voices</option>
              <option value={TTS_PROVIDERS.AZURE_NEURAL}>Azure Neural TTS</option>
              <option value={TTS_PROVIDERS.GOOGLE_CLOUD}>Google Cloud TTS</option>
              <option value={TTS_PROVIDERS.ELEVENLABS}>ElevenLabs</option>
            </select>
          </label>
          <label style={rangeLabelStyle}>
            Speech language
            <select
              value={speechLanguage}
              onChange={(event) => setSpeechLanguage(normalizeLanguageCode(event.target.value))}
              style={selectStyle}
            >
              {UI_LANGUAGE_OPTIONS.map((option) => (
                <option key={`speech-lang-${option.code}`} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label style={rangeLabelStyle}>
            Voice
            <select
              value={selectedVoiceURI}
              onChange={(event) => setSelectedVoiceURI(event.target.value)}
              style={selectStyle}
              disabled={autoDetectVoice || ttsProvider !== TTS_PROVIDERS.BROWSER}
            >
              <option value="">System default</option>
              {availableVoices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name} ({voice.lang})
                </option>
              ))}
            </select>
          </label>
          <label style={rangeLabelStyle}>
            Speech rate ({speechRate.toFixed(2)}x)
            <input
              type="range"
              min={0.6}
              max={1.6}
              step={0.05}
              value={speechRate}
              onChange={(event) => setSpeechRate(Number(event.target.value))}
            />
          </label>
          <label style={rangeLabelStyle}>
            Pitch ({speechPitch.toFixed(2)})
            <input
              type="range"
              min={0.6}
              max={1.6}
              step={0.05}
              value={speechPitch}
              onChange={(event) => setSpeechPitch(Number(event.target.value))}
            />
          </label>
          <label style={rangeLabelStyle}>
            Volume ({speechVolume.toFixed(2)})
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={speechVolume}
              onChange={(event) => setSpeechVolume(Number(event.target.value))}
            />
          </label>
        </div>
        {ttsProvider !== TTS_PROVIDERS.BROWSER ? (
          <p style={speedHintStyle}>
            {ttsProvider} selected. Browser voice fallback is active until `/api/tts` provider routing is configured.
          </p>
        ) : null}
      </section>
      ) : null}

      <section style={panelCardStyle}>
        <div style={sentenceHeaderStyle}>
          <strong style={panelTitleStyle}>Sentence Builder</strong>
          {isParentMode ? (
            <div style={sentenceMetaStyle}>
              <span style={sentenceCounterStyle}>{sentence.length} word{sentence.length === 1 ? "" : "s"}</span>
              <button onClick={() => setCursorMode((value) => !value)} style={cursorMode ? activeBtnStyle : btnStyle}>
                {cursorMode ? "Cursor On" : "Cursor Off"}
              </button>
            </div>
          ) : null}
        </div>
        <div
          style={sentenceStyle}
          onClick={(event) => {
            if (!isChildMode) return;
            if (!ghostAutoSentence) return;
            if (event.target?.closest?.("button")) return;
            speakGhostSentence();
          }}
        >
          {sentence.length === 0 && !cursorMode ? (
            <span style={{ color: "#9db5ce" }}>Tap words or quick phrases to build a sentence.</span>
          ) : null}
          {sentence.map((word, index) => (
            <React.Fragment key={`${word.text}-${index}`}>
              {isParentMode && cursorMode && cursorIndex === index ? <span style={sentenceCursorStyle}>|</span> : null}
              <button
                onClick={() => {
                  if (isParentMode && cursorMode) {
                    setCursorIndex(index + 1);
                    return;
                  }
                  removeWordAt(index);
                }}
                style={
                  index === lastAddedIndex
                    ? { ...sentenceChipStyle, ...sentenceChipHighlightStyle }
                    : sentenceChipStyle
                }
                title={cursorMode ? "Set cursor after this word" : "Remove this word"}
              >
                {word.text}
              </button>
            </React.Fragment>
          ))}
          {isParentMode && cursorMode && cursorIndex === sentence.length ? <span style={sentenceCursorStyle}>|</span> : null}
        </div>
        {dualLanguageMode && normalizeLanguageCode(speechLanguage) !== "en" && sentenceText ? (
          <div style={dualLanguagePreviewStyle}>
            <div>
              <strong>EN:</strong> {sentenceText}
            </div>
            <div>
              <strong>{speechLanguage.toUpperCase()}:</strong>{" "}
              {dualLanguageLoading ? "Translating..." : dualLanguageSentence || "—"}
            </div>
          </div>
        ) : null}
        {isChildMode && ghostAutoSentence ? (
          <button onClick={speakGhostSentence} style={ghostSentenceStyle}>
            Ghost: {ghostAutoSentence} • Tap to speak
          </button>
        ) : null}
        {isChildMode && speakReactionEmoji ? (
          <div style={speakReactionStyle}>{speakReactionEmoji}</div>
        ) : null}
        {isChildMode && microReinforcement ? (
          <div style={microReinforcementStyle}>{microReinforcement}</div>
        ) : null}
        {isParentMode && cursorMode ? (
          <div style={cursorControlRowStyle}>
            <button onClick={() => setCursorIndex((value) => Math.max(0, value - 1))} style={btnStyle}>
              Cursor Left
            </button>
            <button
              onClick={() => setCursorIndex((value) => Math.min(sentence.length, value + 1))}
              style={btnStyle}
            >
              Cursor Right
            </button>
            <span style={cursorHintStyle}>Insert position: {cursorIndex}</span>
          </div>
        ) : null}
        {isChildMode ? (
          <>
            <div style={childSentenceActionRowStyle}>
              <button onClick={speakSentence} style={childPrimarySpeakBtnStyle}>
                🔊 Speak
              </button>
              <button onClick={undoLastWord} style={childSentenceActionBtnStyle} disabled={sentence.length === 0}>
                ↩ Undo
              </button>
              <button
                onClick={clearSentenceBuilder}
                style={childSentenceActionBtnStyle}
              >
                ❌ Clear
              </button>
            </div>
            <p style={gestureHintStyle}>Swipe right: Speak • Swipe down: Clear • Double tap: Quick Speak</p>
          </>
        ) : (
          <div style={actionRowStyle}>
            <button onClick={speakSentence} style={btnStyle}>
              Speak
            </button>
            <button onClick={undoLastWord} style={btnStyle} disabled={sentence.length === 0}>
              Undo
            </button>
            <button
              onClick={clearSentenceBuilder}
              style={btnStyle}
            >
              Clear
            </button>
            <button onClick={saveCurrentSentenceAsPhrase} style={btnStyle} disabled={sentence.length === 0}>
              Save Phrase
            </button>
          </div>
        )}
        {isParentMode ? (
        <div style={smartSuggestionInlineRowStyle}>
          {compactSmartSuggestions.map((entry, index) => (
            <button
              key={`compact-suggestion-${entry.word.text}-${index}`}
              {...getWordSelectProps(entry.word)}
              style={compactSuggestionBtnStyle}
              title={entry.reasons[0] || "Adaptive suggestion"}
            >
              {entry.word.text}
            </button>
          ))}
        </div>
        ) : null}
      </section>

      {isChildMode ? (
      <section style={childSuggestionsCardStyle}>
        <strong style={panelTitleStyle}>Smart Suggestions</strong>
        <p style={intentHelperTextStyle}>{predictiveContextHint}</p>
        {anticipatedWords.length > 0 ? (
          <div style={anticipationRowStyle}>
            <strong style={panelTitleStyle}>Anticipated Next</strong>
            <div style={suggestionRowStyle}>
              {anticipatedWords.map((entry, index) => (
                <button
                  key={`anticipated-word-${entry.word.text}-${index}`}
                  {...getWordSelectProps(entry.word)}
                  style={anticipationChipStyle}
                  title={entry.reason}
                >
                  {entry.word.emoji || "🔤"} {entry.word.text}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {autoSentenceMode && autoSentenceDisplaySuggestions.length > 0 ? (
          <div style={autoSentenceRowStyle}>
            <strong style={panelTitleStyle}>Auto-Sentence</strong>
            {autoSentenceDisplaySuggestions.map((entry, index) => {
              const key = `auto-sentence-why-${normalizeToken(entry.sentence)}-${index}`;
              const isOpen = openWhyKey === key;

              return (
                <div key={`auto-sentence-${entry.sentence}-${index}`} style={autoSentenceCardStyle}>
                  <button
                    {...getAutoSentenceButtonProps(entry)}
                    style={autoSentenceBtnStyle(
                      entry.confidenceScore,
                      autoSentenceDisplaySuggestions.length === 1
                    )}
                    title={entry.reasonText}
                  >
                    <span style={autoSentenceBtnTopRowStyle}>
                      <span>⚡ {entry.sentence}</span>
                      <span style={autoSentenceConfidenceDotsStyle(entry.confidenceScore)}>
                        {entry.confidenceDots}
                      </span>
                    </span>
                    <span style={autoSentenceReasonStyle}>{entry.reasonText}</span>
                  </button>
                  <div style={autoSentenceActionRowStyle}>
                    <span style={autoSentenceMetaBadgeStyle}>
                      {entry.intent} • {entry.source}
                    </span>
                    <button
                      onClick={() => setOpenWhyKey(isOpen ? "" : key)}
                      style={whyButtonStyle}
                      title="Show why this sentence was suggested"
                    >
                      {isOpen ? "Hide Why" : "Why?"}
                    </button>
                  </div>
                  {isOpen ? (
                    <div style={whyPopoverStyle}>
                      <div style={whyDetailRowStyle}>
                        <span style={whyDetailLabelStyle}>Reason tags</span>
                        <strong style={whyDetailValueStyle}>
                          {entry.reasonCodes?.length > 0 ? entry.reasonCodes.join(", ") : "adaptive"}
                        </strong>
                      </div>
                      {(entry.details ?? []).map((item) => (
                        <div key={`${key}-${item.label}`} style={whyDetailRowStyle}>
                          <span style={whyDetailLabelStyle}>{item.label}</span>
                          <strong style={whyDetailValueStyle}>{item.value}</strong>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            <span style={autoSentenceHintStyle}>
              Tap to speak instantly. Long press to edit before speaking.
            </span>
          </div>
        ) : null}
        {instantIntentSuggestions.length > 0 ? (
          <p style={intentHelperTextStyle}>
            1-Tap intent: {instantIntentSuggestions[0].reason}
          </p>
        ) : null}
        {instantIntentSuggestions.length > 0 ? (
          <div style={suggestionRowStyle}>
            {instantIntentSuggestions.map((entry, index) => (
              <button
                key={`intent-smart-suggestion-${entry.word.text}-${index}`}
                {...getWordSelectProps(entry.word)}
                style={childSuggestionBtnStyle(entry.confidence, largeTileMode)}
                title={entry.reason}
              >
                <span style={{ fontSize: 24 }}>{entry.word.emoji || "🔤"}</span>
                <span>{entry.word.text}</span>
                <span style={suggestionConfidenceBadgeStyle(entry.confidence)}>{entry.confidence}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div style={suggestionRowStyle}>
          {instantIntentSuggestions.length === 0 && childSmartSuggestions.length === 0 ? (
            <p style={{ margin: 0 }}>Start building a sentence to unlock smart suggestions.</p>
          ) : null}
          {childSmartSuggestions.map((entry, index) => (
            <button
              key={`child-smart-suggestion-${entry.word.text}-${index}`}
              {...getWordSelectProps(entry.word)}
              style={childSuggestionBtnStyle(entry.confidence, largeTileMode)}
              title={entry.reasons[0] || "Adaptive suggestion"}
            >
              <span style={{ fontSize: 24 }}>{entry.word.emoji || "🔤"}</span>
              <span>{entry.word.text}</span>
              <span style={suggestionConfidenceBadgeStyle(entry.confidence)}>{entry.confidence}</span>
            </button>
          ))}
        </div>
        {childSmartSuggestions.length > 0 ? (
          <p style={intentHelperTextStyle}>{explainSuggestion(childSmartSuggestions[0])}</p>
        ) : null}
      </section>
      ) : null}

      {isChildMode ? (
      <section style={childStickyCategoryCardStyle}>
        <strong style={panelTitleStyle}>Categories</strong>
        <div style={childCategoryTabRowStyle}>
          {categoryTabs.map((tab) => {
            const isActive = activeCategory === tab.id;
            return (
              <button
                key={`child-category-tab-${tab.id}`}
                onClick={() => {
                  setActiveCategory(tab.id);
                  setActiveSubBoard(DEFAULT_SUB_BOARD);
                }}
                style={boardTabBtnStyle(isActive)}
              >
                {getChildCategoryLabel(tab.id)}
              </button>
            );
          })}
        </div>

        {activeCategory !== DEFAULT_CATEGORY && activeCategory !== FAVORITES_CATEGORY ? (
          <div style={boardSubTabRowStyle}>
            {subBoardTabs.map((tab) => {
              const isActive = activeSubBoard === tab.id;
              return (
                <button
                  key={`child-subboard-tab-${tab.id}`}
                  onClick={() => setActiveSubBoard(tab.id)}
                  style={boardSubTabBtnStyle(isActive)}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </section>
      ) : null}

      {isParentMode ? (
      <section style={panelCardStyle}>
        <strong style={panelTitleStyle}>Quick phrases</strong>
        <div style={phraseRowStyle}>
          {orderedQuickPhrases.map((phrase) => {
            const token = normalizeToken(phrase);
            const isPinned = pinnedPhraseTokens.includes(token);
            const usageCount = Number(phraseUsageCounts[token] ?? 0);
            const isRecent = recentPhraseUsage.slice(-3).includes(token);

            return (
              <div key={phrase} style={phraseCardStyle}>
                <button onClick={() => useQuickPhrase(phrase)} style={phraseBtnStyle}>
                  {phrase}
                </button>
                <div style={phraseMetaRowStyle}>
                  <button
                    onClick={() => togglePinnedPhrase(phrase)}
                    style={phrasePinBtnStyle(isPinned)}
                    title={isPinned ? "Unpin phrase" : "Pin phrase"}
                  >
                    {isPinned ? "★" : "☆"}
                  </button>
                  {isRecent ? <span style={phraseMetaBadgeStyle}>Recent</span> : null}
                  {usageCount > 0 ? <span style={phraseMetaBadgeStyle}>Used {usageCount}</span> : null}
                  <button
                    onClick={() => removeQuickPhrase(phrase)}
                    style={phraseDeleteBtnStyle}
                    title="Remove phrase"
                  >
                    x
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      ) : null}

      {isParentMode ? (
      <section style={panelCardStyle}>
        <strong style={panelTitleStyle}>Adaptive phrase suggestions</strong>
        <div style={phraseRowStyle}>
          {adaptivePhrases.length === 0 ? (
            <p style={{ margin: 0 }}>
              Speak a few sentences and this child profile will start surfacing repeated phrases.
            </p>
          ) : null}
          {adaptivePhrases.map((phrase) => (
            <div key={`adaptive-${phrase}`} style={phraseCardStyle}>
              <button onClick={() => useQuickPhrase(phrase)} style={phraseBtnStyle}>
                {phrase}
              </button>
              <button
                onClick={() => saveAdaptivePhrase(phrase)}
                style={phraseSaveBtnStyle}
                title="Save to quick phrases"
              >
                +
              </button>
            </div>
          ))}
        </div>
        <p style={adaptiveLoopHintStyle}>
          Repeated spoken phrases are auto-saved after {AUTO_SAVE_PHRASE_MIN_REPEAT} uses.
        </p>
      </section>
      ) : null}

      {isParentMode ? (
      <section style={panelCardStyle}>
        <strong style={panelTitleStyle}>Smart phrase continuations</strong>
        <div style={phraseRowStyle}>
          {smartPhraseSuggestionDetails.length === 0 ? (
            <p style={{ margin: 0 }}>
              Build a sentence and the model will suggest likely next multi-word continuations.
            </p>
          ) : null}
          {smartPhraseSuggestionDetails.map((entry, index) => {
            const key = `smart-phrase-${entry.phrase}-${index}`;
            const isOpen = openWhyKey === key;

            return (
              <div key={key} style={smartSuggestionCardStyle}>
                <button
                  onClick={() => useQuickPhrase(entry.phrase)}
                  style={smartSuggestionMainBtnStyle}
                  title={entry.reasons.length > 0 ? entry.reasons.join(" | ") : "Personalized phrase"}
                >
                  <span style={smartSuggestionPrimaryTextStyle}>{entry.phrase}</span>
                  <span style={suggestionConfidenceBadgeStyle(entry.confidence)}>{entry.confidence}</span>
                  <span style={suggestionReasonStyle}>{entry.reasons[0] || "Adaptive phrase prediction"}</span>
                </button>
                <div style={smartSuggestionActionRowStyle}>
                  <button
                    onClick={() => savePhraseToQuickPhrases(entry.phrase)}
                    style={phraseSavePillStyle}
                    title="Save this phrase to quick phrases"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setOpenWhyKey(isOpen ? "" : key)}
                    style={whyButtonStyle}
                    title="Show why this phrase was suggested"
                  >
                    {isOpen ? "Hide Why" : "Why?"}
                  </button>
                </div>
                {isOpen ? (
                  <div style={whyPopoverStyle}>
                    {entry.details.map((item) => (
                      <div key={`${key}-${item.label}`} style={whyDetailRowStyle}>
                        <span style={whyDetailLabelStyle}>{item.label}</span>
                        <strong style={whyDetailValueStyle}>{item.value}</strong>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
      ) : null}

      {isParentMode ? (
      <section style={panelCardStyle}>
        <strong style={panelTitleStyle}>Favorites</strong>
        <div style={suggestionRowStyle}>
          {favoriteWords.length === 0 ? <p style={{ margin: 0 }}>No favorite words yet. Tap star on a word.</p> : null}
          {favoriteWords.map((word, index) => (
            <button
              key={`favorite-${word.text}-${index}`}
              {...getWordSelectProps(word)}
              style={largeTileMode ? { ...suggestionBtnStyle, ...largeSuggestionBtnStyle } : suggestionBtnStyle}
            >
              <span style={{ fontSize: 24 }}>{word.emoji || "🔤"}</span>
              <span>{word.text}</span>
            </button>
          ))}
        </div>
      </section>
      ) : null}

      {isParentMode ? (
      <section style={panelCardStyle}>
        <strong style={panelTitleStyle}>Smart suggestions</strong>
        <div style={suggestionRowStyle}>
          {smartSuggestionDetails.map((entry, index) => {
            const key = `smart-word-${entry.word.text}-${index}`;
            const isOpen = openWhyKey === key;

            return (
              <div key={key} style={smartSuggestionCardStyle}>
                <button
                  {...getWordSelectProps(entry.word)}
                  style={largeTileMode ? { ...smartSuggestionMainBtnStyle, ...largeSuggestionBtnStyle } : smartSuggestionMainBtnStyle}
                  title={entry.reasons.length > 0 ? entry.reasons.join(" | ") : "Personalized suggestion"}
                >
                  <span style={{ fontSize: 24 }}>{entry.word.emoji || "🔤"}</span>
                  <span>{entry.word.text}</span>
                  <span style={suggestionConfidenceBadgeStyle(entry.confidence)}>{entry.confidence}</span>
                  <span style={suggestionReasonStyle}>{entry.reasons[0] || "Adaptive prediction"}</span>
                </button>
                <button
                  onClick={() => setOpenWhyKey(isOpen ? "" : key)}
                  style={whyButtonStyle}
                  title="Show why this word was suggested"
                >
                  {isOpen ? "Hide Why" : "Why?"}
                </button>
                {isOpen ? (
                  <div style={whyPopoverStyle}>
                    {entry.details.map((item) => (
                      <div key={`${key}-${item.label}`} style={whyDetailRowStyle}>
                        <span style={whyDetailLabelStyle}>{item.label}</span>
                        <strong style={whyDetailValueStyle}>{item.value}</strong>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
      ) : null}

      {isParentMode ? (
      <section style={panelCardStyle}>
      <strong style={panelTitleStyle}>Sync + Backup</strong>
      <p style={parentSyncStatusStyle}>Status: {syncSummary}</p>
      {!canUseBackupTools ? (
        <p style={parentSyncStatusStyle}>Upgrade to Pro or Premium to unlock backup import/export tools.</p>
      ) : null}
      {!canUseAutoSpeak ? (
        <p style={parentSyncStatusStyle}>Auto-Speak unlocks on Pro and Premium plans.</p>
      ) : null}
      <div style={actionRowStyle}>
        <button onClick={exportWorkspaceData} style={btnStyle} disabled={!canUseBackupTools}>
          Export Backup
        </button>
        <button onClick={importWorkspaceData} style={btnStyle} disabled={!canUseBackupTools}>
          Import Backup
        </button>
        <button onClick={resetLearningData} style={btnStyle}>
          Reset Learning
        </button>
        <button onClick={toggleAutoSpeak} style={autoSpeak ? activeBtnStyle : btnStyle}>
          {autoSpeak ? "Auto-Speak On" : "Auto-Speak Off"}
        </button>
        {!canUseBackupTools || !canUseAutoSpeak ? (
          <Link to="/pricing" style={linkPillStyle}>
            Upgrade Plan
          </Link>
        ) : null}
      </div>
      </section>
      ) : null}

      <section style={panelCardStyle}>
      <strong style={panelTitleStyle}>{isChildMode ? "Word Grid" : "Word board"}</strong>
      {isChildMode ? (
        <div style={wordGridControlRowStyle}>
          <span style={wordGridMetaTextStyle}>
            {topWordsMode
              ? `Top 12 mode (${visibleWords.length} shown)`
              : progressiveDisclosureEnabled
                ? `${visibleWords.length}/${rankedFilteredWords.length} shown`
                : `${visibleWords.length} words`}
          </span>
          {hiddenWordCount > 0 ? (
            <button onClick={() => setShowAllDisclosedWords(true)} style={btnStyle}>
              Show More ({hiddenWordCount})
            </button>
          ) : null}
          {showAllDisclosedWords && progressiveDisclosureEnabled && !topWordsMode ? (
            <button onClick={() => setShowAllDisclosedWords(false)} style={btnStyle}>
              Show Top 12
            </button>
          ) : null}
        </div>
      ) : null}
      {isChildMode && alternateWordSuggestions.length > 0 ? (
        <div style={alternateWordPanelStyle}>
          <strong style={panelTitleStyle}>Alternates for "{alternateWordLabel}"</strong>
          <div style={smartSuggestionInlineRowStyle}>
            {alternateWordSuggestions.map((entry, index) => (
              <button
                key={`alternate-word-${entry.text}-${index}`}
                {...getWordSelectProps(entry)}
                style={compactSuggestionBtnStyle}
              >
                {entry.emoji || "🔤"} {entry.text}
              </button>
            ))}
            <button
              onClick={() => {
                setAlternateWordLabel("");
                setAlternateWordSuggestions([]);
              }}
              style={btnStyle}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
      <div style={isChildMode ? childGridStyle : gridStyle}>
        {visibleWords.length === 0 ? <p style={{ margin: 0 }}>No words match this filter.</p> : null}
        {visibleWords.map((word, index) => {
          const token = normalizeToken(word.text);
          const isFavorite = favoriteTokens.includes(token);
          const category = normalizeBoardKey(word.category, DEFAULT_CUSTOM_CATEGORY);
          const categoryAccent = CATEGORY_ACCENT_COLORS[category] ?? CATEGORY_ACCENT_COLORS.default;
          const isFlashed = flashedWordToken && token === flashedWordToken;
          const isRareWord = smartHidingEnabled && rareWordTokenSet.has(token);

          return (
            <div key={`${word.text}-${index}`} style={isChildMode ? childWordCardStyle : wordCardStyle}>
              <button
                {...getWordSelectProps(word)}
                style={{
                  ...gridBtn,
                  ...(isChildMode ? childWordTileStyle : {}),
                  ...(largeTileMode ? largeWordTileStyle : {}),
                  ...(scanMode && index === scanIndex ? scanHighlightTileStyle : {}),
                  ...(isFlashed ? flashedTileStyle : {}),
                  ...(isRareWord ? rareWordTileStyle : {}),
                  boxShadow: `inset 0 0 0 1px ${categoryAccent}, 0 8px 18px rgba(5, 15, 28, 0.35)`,
                }}
              >
                <div style={{ fontSize: 30 }}>{word.emoji || "🔤"}</div>
                <div>{word.text}</div>
                {isParentMode ? (
                  <div style={wordBoardMetaStyle}>
                    {formatBoardLabel(word.category, "Custom")} / {formatBoardLabel(word.subBoard, "General")}
                  </div>
                ) : null}
              </button>
              <button
                onClick={() => toggleFavorite(word)}
                style={isChildMode ? childFavoriteCornerBtnStyle : favoriteToggleBtnStyle}
                title={isFavorite ? "Remove favorite" : "Add favorite"}
              >
                {isFavorite ? "★" : "☆"}
              </button>
            </div>
          );
        })}
      </div>
      </section>

      {isChildMode ? (
      <section style={panelCardStyle}>
        <div style={childPhraseHeaderStyle}>
          <strong style={panelTitleStyle}>Quick Phrases</strong>
          <div style={childPhraseHeaderActionsStyle}>
            <button
              onClick={saveCurrentSentenceAsPhrase}
              style={btnStyle}
              disabled={sentence.length === 0}
            >
              + Save Phrase
            </button>
            <button
              onClick={() => setChildPhrasesCollapsed((value) => !value)}
              style={btnStyle}
            >
              {childPhrasesCollapsed ? "Show" : "Hide"}
            </button>
          </div>
        </div>
        {!childPhrasesCollapsed ? (
        <div style={phraseRowStyle}>
          {orderedQuickPhrases.map((phrase) => {
            const token = normalizeToken(phrase);
            const isPinned = pinnedPhraseTokens.includes(token);
            const usageCount = Number(phraseUsageCounts[token] ?? 0);
            const isRecent = recentPhraseUsage.slice(-3).includes(token);

            return (
              <div key={`child-quick-${phrase}`} style={phraseCardStyle}>
                <button {...getChildPhraseButtonProps(phrase)} style={phraseBtnStyle}>
                  {phrase}
                </button>
                <div style={phraseMetaRowStyle}>
                  <button
                    onClick={() => togglePinnedPhrase(phrase)}
                    style={phrasePinBtnStyle(isPinned)}
                    title={isPinned ? "Unpin phrase" : "Pin phrase"}
                  >
                    {isPinned ? "★" : "☆"}
                  </button>
                  {isRecent ? <span style={phraseMetaBadgeStyle}>Recent</span> : null}
                  {usageCount > 0 ? <span style={phraseMetaBadgeStyle}>Used {usageCount}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
        ) : null}
        <p style={childPhraseHintStyle}>Tap to speak and add words. Long press a phrase to edit or delete.</p>
      </section>
      ) : null}

      {isParentMode ? (
      <section style={panelCardStyle}>
        <strong style={panelTitleStyle}>Progress Stories</strong>
        <div style={insightListStyle}>
          {progressStories.map((entry, index) => (
            <div key={`story-${index}`} style={storyItemStyle}>
              {entry}
            </div>
          ))}
        </div>
      </section>
      ) : null}

      {isParentMode ? (
      <section style={panelCardStyle}>
        <strong style={panelTitleStyle}>Insights</strong>
        <div style={insightListStyle}>
          {recommendations.map((entry, index) => (
            <div key={`insight-${index}`} style={insightItemStyle}>
              • {entry}
            </div>
          ))}
        </div>
      </section>
      ) : null}

      {isParentMode ? (
      <Dashboard
        activeChildName={activeChildProfile.name}
        sentenceHistory={sentenceHistory}
        usageCounts={usageCounts}
        dailySentenceCounts={dailySentenceCounts}
        quickPhraseCount={quickPhrases.length}
        totalWordTaps={totalWordTaps}
        todaySentenceCount={todaySentenceCount}
        dailySentenceGoal={dailySentenceGoal}
        goalStreak={goalStreak}
        sevenDayAverage={sevenDayAverage}
        avgSpeakLatencySeconds={avgSpeakLatencySeconds}
        bestSpeakLatencySeconds={bestSpeakLatencySeconds}
        autoSentenceImpact={autoSentenceImpact}
        autoSentenceDailyTrend={autoSentenceDailyTrend}
        childDigitalTwin={childDigitalTwin}
        recommendations={recommendations}
      />
      ) : null}
      {isChildMode ? (
      <button
        onClick={() => {
          const emergencyText = "I need help now";
          const emergencyWords = tokenizeText(emergencyText);
          void trackSpeakClickedEvent({
            source: "emergency_button",
            workspaceMode: "child",
            childProfileId: activeChildProfile?.id,
            languageCode: speechLanguage,
            wordCount: emergencyWords.length,
            characterCount: emergencyText.length,
          });
          triggerSpeakReaction("I need help now");
          speak(emergencyText, {
            lang: speechLanguage,
            rate: speechRate,
            pitch: speechPitch,
            volume: speechVolume,
            dualLanguageMode,
            autoDetectVoice,
            ttsProvider,
            voiceURI: selectedVoiceURI,
            tone: "emergency",
          });
        }}
        style={floatingEmergencyBtnStyle}
      >
        🚨 I NEED HELP
      </button>
      ) : null}
    </div>
    </div>
  );
}

function Dashboard({
  activeChildName,
  sentenceHistory,
  usageCounts,
  dailySentenceCounts,
  quickPhraseCount,
  totalWordTaps,
  todaySentenceCount,
  dailySentenceGoal,
  goalStreak,
  sevenDayAverage,
  avgSpeakLatencySeconds,
  bestSpeakLatencySeconds,
  autoSentenceImpact,
  autoSentenceDailyTrend,
  childDigitalTwin,
  recommendations,
}) {
  const impact = autoSentenceImpact ?? getAutoSentenceImpactSummary({});
  const topWords = Object.entries(usageCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const repeatedPhrases = getTopRepeatedPhrases(sentenceHistory, 6);
  const phraseMax = repeatedPhrases[0]?.count ?? 1;
  const dailyTrend = getRecentDaySeries(dailySentenceCounts, 14);
  const trendMax = Math.max(1, ...dailyTrend.map((entry) => entry.count));
  const activeDays14 = dailyTrend.filter((entry) => entry.count > 0).length;
  const goalPct = Math.min(100, Math.round((todaySentenceCount / Math.max(1, dailySentenceGoal)) * 100));
  const topWordMax = topWords[0]?.[1] ?? 1;
  const recentSentences = sentenceHistory.slice(-5).reverse();
  const autoSentenceAcceptPct = Math.round(clamp01(impact.acceptanceRate) * 100);
  const autoSentenceIgnorePct = Math.round(clamp01(impact.ignoreRate) * 100);
  const autoSentenceShown = Math.round(impact.shownTotal);
  const autoSentenceAccepted = Math.round(impact.acceptedTotal);
  const autoSentenceIgnored = Math.round(impact.ignoredTotal);
  const autoSentenceTapsSaved = Math.round(impact.tapsSavedEstimate);
  const autoSentenceAverageSaved = impact.averageTapsSavedPerAccept.toFixed(1);
  const autoSentenceLayerRows = Array.isArray(impact.layers) ? impact.layers : [];
  const hasAutoSentenceLayerData = autoSentenceLayerRows.some((entry) => entry.shown > 0);
  const autoQualityTrend = Array.isArray(autoSentenceDailyTrend) ? autoSentenceDailyTrend : [];
  const hasAutoQualityTrendData = autoQualityTrend.some((entry) => entry.shown > 0);
  const twin = childDigitalTwin ?? {
    intents: {},
    preferredWords: [],
    routines: {},
    phrasePatterns: {},
    speedProfile: {},
  };
  const twinIntentRows = Object.entries(twin.intents ?? {})
    .map(([intent, value]) => ({
      intent,
      pct: Math.round(clamp01(value) * 100),
    }))
    .sort((a, b) => b.pct - a.pct);
  const twinPreferredWords = Array.isArray(twin.preferredWords) ? twin.preferredWords : [];
  const twinRoutineRows = Object.entries(twin.routines ?? {})
    .map(([bucket, tokens]) => ({
      bucket,
      tokens: Array.isArray(tokens) ? tokens.slice(0, 4) : [],
    }))
    .filter((entry) => entry.tokens.length > 0);
  const twinPatternRows = Object.entries(twin.phrasePatterns ?? {})
    .map(([pattern, tokens]) => ({
      pattern,
      tokens: Array.isArray(tokens) ? tokens.slice(0, 4) : [],
    }))
    .filter((entry) => entry.tokens.length > 0)
    .slice(0, 4);
  const twinSpeed = twin.speedProfile ?? {};

  return (
    <section style={dashboardShellStyle}>
      <div style={dashboardBackdropStyle} />

      <div style={dashboardContentStyle}>
        <div style={dashboardHeroStyle}>
          <div>
            <p style={dashboardEyebrowStyle}>Caregiver Intelligence Panel</p>
            <h2 style={dashboardHeadingStyle}>Parent Dashboard</h2>
            <p style={dashboardSubtitleStyle}>Viewing child profile: {activeChildName}</p>
          </div>

          <div style={dashboardGoalBadgeStyle}>
            <span style={dashboardGoalLabelStyle}>Goal Progress</span>
            <strong style={dashboardGoalValueStyle}>
              {todaySentenceCount}/{dailySentenceGoal}
            </strong>
            <div style={dashboardMiniTrackStyle}>
              <div style={{ ...dashboardMiniFillStyle, width: `${goalPct}%` }} />
            </div>
          </div>
        </div>

        <div style={dashboardStatsGridStyle}>
          <div style={dashboardStatCardStyle}>
            <span style={dashboardStatLabelStyle}>Total taps</span>
            <strong style={dashboardStatValueStyle}>{totalWordTaps}</strong>
          </div>
          <div style={dashboardStatCardStyle}>
            <span style={dashboardStatLabelStyle}>Unique words</span>
            <strong style={dashboardStatValueStyle}>{Object.keys(usageCounts).length}</strong>
          </div>
          <div style={dashboardStatCardStyle}>
            <span style={dashboardStatLabelStyle}>7-day average</span>
            <strong style={dashboardStatValueStyle}>{sevenDayAverage.toFixed(1)}</strong>
          </div>
          <div style={dashboardStatCardStyle}>
            <span style={dashboardStatLabelStyle}>Goal streak</span>
            <strong style={dashboardStatValueStyle}>
              {goalStreak} day{goalStreak === 1 ? "" : "s"}
            </strong>
          </div>
          <div style={dashboardStatCardStyle}>
            <span style={dashboardStatLabelStyle}>Saved phrases</span>
            <strong style={dashboardStatValueStyle}>{quickPhraseCount}</strong>
          </div>
          <div style={dashboardStatCardStyle}>
            <span style={dashboardStatLabelStyle}>Active days (14d)</span>
            <strong style={dashboardStatValueStyle}>{activeDays14}</strong>
          </div>
          <div style={dashboardStatCardStyle}>
            <span style={dashboardStatLabelStyle}>Avg speak time</span>
            <strong style={dashboardStatValueStyle}>
              {avgSpeakLatencySeconds !== null ? `${avgSpeakLatencySeconds.toFixed(1)}s` : "—"}
            </strong>
          </div>
          <div style={dashboardStatCardStyle}>
            <span style={dashboardStatLabelStyle}>Best speak time</span>
            <strong style={dashboardStatValueStyle}>
              {bestSpeakLatencySeconds !== null ? `${bestSpeakLatencySeconds.toFixed(1)}s` : "—"}
            </strong>
          </div>
          <div style={dashboardStatCardStyle}>
            <span style={dashboardStatLabelStyle}>Auto accepts</span>
            <strong style={dashboardStatValueStyle}>{autoSentenceAccepted}</strong>
          </div>
          <div style={dashboardStatCardStyle}>
            <span style={dashboardStatLabelStyle}>Auto accept rate</span>
            <strong style={dashboardStatValueStyle}>{autoSentenceAcceptPct}%</strong>
          </div>
          <div style={dashboardStatCardStyle}>
            <span style={dashboardStatLabelStyle}>Auto ignore rate</span>
            <strong style={dashboardStatValueStyle}>{autoSentenceIgnorePct}%</strong>
          </div>
          <div style={dashboardStatCardStyle}>
            <span style={dashboardStatLabelStyle}>Est. taps saved</span>
            <strong style={dashboardStatValueStyle}>{autoSentenceTapsSaved}</strong>
          </div>
        </div>

        <div style={dashboardPanelsStyle}>
          <div style={dashboardPanelStyle}>
            <h3 style={dashboardPanelTitleStyle}>Daily Speaking Trend (14 days)</h3>
            <div style={dashboardTrendChartStyle}>
              {dailyTrend.map((entry) => (
                <div key={entry.key} style={dashboardTrendBarWrapStyle}>
                  <div style={dashboardTrendCountStyle}>{entry.count}</div>
                  <div style={dashboardTrendTrackStyle}>
                    <div
                      style={{
                        ...dashboardTrendFillStyle,
                        height: `${Math.max(4, Math.round((entry.count / trendMax) * 100))}%`,
                      }}
                    />
                  </div>
                  <div style={dashboardTrendLabelStyle}>{entry.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={dashboardPanelStyle}>
            <h3 style={dashboardPanelTitleStyle}>Recent Sentences</h3>
            {recentSentences.length === 0 ? (
              <p style={dashboardPanelEmptyStyle}>No spoken sentences yet.</p>
            ) : (
              <div style={dashboardSentenceListStyle}>
                {recentSentences.map((entry, index) => (
                  <div key={`${entry}-${index}`} style={dashboardSentenceItemStyle}>
                    {entry}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={dashboardPanelStyle}>
            <h3 style={dashboardPanelTitleStyle}>Auto-Sentence Impact</h3>
            <div style={dashboardWordBarsStyle}>
              <div style={dashboardWordRowStyle}>
                <div style={dashboardWordHeaderStyle}>
                  <span>Accept rate</span>
                  <span>{autoSentenceAcceptPct}%</span>
                </div>
                <div style={dashboardWordTrackStyle}>
                  <div
                    style={{
                      ...dashboardWordFillStyle,
                      width: `${autoSentenceAcceptPct}%`,
                    }}
                  />
                </div>
              </div>
              <div style={dashboardWordRowStyle}>
                <div style={dashboardWordHeaderStyle}>
                  <span>Ignore rate</span>
                  <span>{autoSentenceIgnorePct}%</span>
                </div>
                <div style={dashboardWordTrackStyle}>
                  <div
                    style={{
                      ...dashboardIgnoreFillStyle,
                      width: `${autoSentenceIgnorePct}%`,
                    }}
                  />
                </div>
              </div>
            </div>
            <div style={dashboardAutoSentenceMetaStyle}>
              <span>
                Shown: <strong>{autoSentenceShown}</strong>
              </span>
              <span>
                Accepted: <strong>{autoSentenceAccepted}</strong>
              </span>
              <span>
                Ignored: <strong>{autoSentenceIgnored}</strong>
              </span>
            </div>
            <p style={dashboardAutoSentenceHintStyle}>
              Average savings: <strong>{autoSentenceAverageSaved} taps</strong> per accepted auto-sentence.
            </p>
          </div>

          <div style={dashboardPanelStyle}>
            <h3 style={dashboardPanelTitleStyle}>Source Quality</h3>
            {!hasAutoSentenceLayerData ? (
              <p style={dashboardPanelEmptyStyle}>No source-layer data yet. Use auto-sentence suggestions to train it.</p>
            ) : (
              <div style={dashboardWordBarsStyle}>
                {autoSentenceLayerRows.map((entry) => {
                  const ratePct = Math.round(clamp01(entry.rate) * 100);
                  return (
                    <div key={entry.key} style={dashboardWordRowStyle}>
                      <div style={dashboardWordHeaderStyle}>
                        <span>{entry.label}</span>
                        <span>
                          {entry.accepted.toFixed(0)}/{entry.shown.toFixed(0)} • {ratePct}%
                        </span>
                      </div>
                      <div style={dashboardWordTrackStyle}>
                        <div
                          style={{
                            ...dashboardLayerFillStyle,
                            width: `${ratePct}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {impact.bestLayer ? (
              <p style={dashboardAutoSentenceHintStyle}>
                Best source right now: <strong>{impact.bestLayer.label}</strong> (
                {Math.round(clamp01(impact.bestLayer.rate) * 100)}% accepted).
              </p>
            ) : null}
          </div>

          <div style={dashboardPanelStyle}>
            <h3 style={dashboardPanelTitleStyle}>Auto Quality Trend (14 days)</h3>
            {!hasAutoQualityTrendData ? (
              <p style={dashboardPanelEmptyStyle}>
                Not enough auto-suggestion activity yet. This trend appears after suggestions are shown.
              </p>
            ) : (
              <div style={dashboardAutoTrendChartStyle}>
                {autoQualityTrend.map((entry) => {
                  const acceptPct = Math.round(clamp01(entry.acceptRate) * 100);
                  const ignorePct = Math.round(clamp01(entry.ignoreRate) * 100);
                  return (
                    <div key={entry.key} style={dashboardAutoTrendColumnStyle}>
                      <div style={dashboardAutoTrendShownStyle}>{entry.shown.toFixed(0)}</div>
                      <div style={dashboardAutoTrendTrackStyle}>
                        <div
                          style={{
                            ...dashboardAutoTrendAcceptBarStyle,
                            height: `${Math.max(entry.shown > 0 ? 6 : 0, acceptPct)}%`,
                          }}
                        />
                        <div
                          style={{
                            ...dashboardAutoTrendIgnoreBarStyle,
                            height: `${Math.max(entry.shown > 0 ? 6 : 0, ignorePct)}%`,
                          }}
                        />
                      </div>
                      <div style={dashboardTrendLabelStyle}>{entry.label}</div>
                    </div>
                  );
                })}
              </div>
            )}
            <p style={dashboardAutoSentenceHintStyle}>
              Green = accept rate, red = ignore rate, top number = suggestions shown.
            </p>
          </div>

          <div style={dashboardPanelStyle}>
            <h3 style={dashboardPanelTitleStyle}>Digital Twin (Per Child)</h3>
            <div style={dashboardTwinBlockStyle}>
              <strong style={dashboardTwinTitleStyle}>Intent Profile</strong>
              {twinIntentRows.length === 0 ? (
                <p style={dashboardPanelEmptyStyle}>Intent data will appear after sentences are spoken.</p>
              ) : (
                <div style={dashboardWordBarsStyle}>
                  {twinIntentRows.map((row) => (
                    <div key={row.intent} style={dashboardWordRowStyle}>
                      <div style={dashboardWordHeaderStyle}>
                        <span style={{ textTransform: "capitalize" }}>{row.intent}</span>
                        <span>{row.pct}%</span>
                      </div>
                      <div style={dashboardWordTrackStyle}>
                        <div
                          style={{
                            ...dashboardTwinIntentFillStyle,
                            width: `${row.pct}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={dashboardTwinBlockStyle}>
              <strong style={dashboardTwinTitleStyle}>Preferred Words</strong>
              {twinPreferredWords.length === 0 ? (
                <p style={dashboardPanelEmptyStyle}>No preferred words yet.</p>
              ) : (
                <div style={dashboardTwinChipRowStyle}>
                  {twinPreferredWords.slice(0, 8).map((token) => (
                    <span key={`twin-word-${token}`} style={dashboardTwinChipStyle}>
                      {token}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div style={dashboardTwinBlockStyle}>
              <strong style={dashboardTwinTitleStyle}>Routines</strong>
              {twinRoutineRows.length === 0 ? (
                <p style={dashboardPanelEmptyStyle}>Routine signals need timestamped sentence events.</p>
              ) : (
                <div style={dashboardTwinListStyle}>
                  {twinRoutineRows.map((entry) => (
                    <div key={`twin-routine-${entry.bucket}`} style={dashboardTwinListItemStyle}>
                      <strong style={{ textTransform: "capitalize" }}>{entry.bucket}:</strong>{" "}
                      {entry.tokens.join(", ")}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={dashboardTwinBlockStyle}>
              <strong style={dashboardTwinTitleStyle}>Phrase Patterns</strong>
              {twinPatternRows.length === 0 ? (
                <p style={dashboardPanelEmptyStyle}>Pattern data appears after repeated sentence starts.</p>
              ) : (
                <div style={dashboardTwinListStyle}>
                  {twinPatternRows.map((entry) => (
                    <div key={`twin-pattern-${entry.pattern}`} style={dashboardTwinListItemStyle}>
                      <strong>{entry.pattern}</strong> → {entry.tokens.join(", ")}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={dashboardTwinSpeedRowStyle}>
              <span>Avg: {Number(twinSpeed.avgTimeToSpeak ?? 0).toFixed(2)}s</span>
              <span>Median: {Number(twinSpeed.medianTimeToSpeak ?? 0).toFixed(2)}s</span>
              <span>Best: {Number(twinSpeed.bestTimeToSpeak ?? 0).toFixed(2)}s</span>
              <span>Samples: {Number(twinSpeed.samples ?? 0)}</span>
            </div>
          </div>

          <div style={dashboardPanelStyle}>
            <h3 style={dashboardPanelTitleStyle}>Most Used Words</h3>
            {topWords.length === 0 ? (
              <p style={dashboardPanelEmptyStyle}>No usage data yet.</p>
            ) : (
              <div style={dashboardWordBarsStyle}>
                {topWords.map(([word, count]) => (
                  <div key={word} style={dashboardWordRowStyle}>
                    <div style={dashboardWordHeaderStyle}>
                      <span>{word}</span>
                      <span>{count}</span>
                    </div>
                    <div style={dashboardWordTrackStyle}>
                      <div
                        style={{
                          ...dashboardWordFillStyle,
                          width: `${Math.round((count / topWordMax) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={dashboardPanelStyle}>
            <h3 style={dashboardPanelTitleStyle}>Repeated Phrase Trends</h3>
            {repeatedPhrases.length === 0 ? (
              <p style={dashboardPanelEmptyStyle}>No repeated phrases yet.</p>
            ) : (
              <div style={dashboardWordBarsStyle}>
                {repeatedPhrases.map((entry) => (
                  <div key={entry.phrase} style={dashboardWordRowStyle}>
                    <div style={dashboardWordHeaderStyle}>
                      <span style={dashboardPhraseLabelStyle}>{entry.phrase}</span>
                      <span>{entry.count}</span>
                    </div>
                    <div style={dashboardWordTrackStyle}>
                      <div
                        style={{
                          ...dashboardPhraseFillStyle,
                          width: `${Math.round((entry.count / phraseMax) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={dashboardPanelStyle}>
            <h3 style={dashboardPanelTitleStyle}>Recommendations</h3>
            <div style={dashboardRecommendationListStyle}>
              {recommendations.map((entry, index) => (
                <div key={`${entry}-${index}`} style={dashboardRecommendationItemStyle}>
                  {entry}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const workspaceRootStyle = {
  minHeight: "100vh",
  background:
    "radial-gradient(1300px 620px at -10% -10%, rgba(25, 84, 151, 0.28), transparent 55%), radial-gradient(900px 520px at 95% 0%, rgba(0, 149, 117, 0.14), transparent 60%), linear-gradient(160deg, #050d1c 0%, #071326 46%, #050f1f 100%)",
  color: "#e9f4ff",
  position: "relative",
  overflow: "hidden",
};

const workspaceGlowOneStyle = {
  position: "absolute",
  width: 360,
  height: 360,
  borderRadius: "50%",
  top: -130,
  right: -110,
  background: "radial-gradient(circle, rgba(73,142,255,0.22), rgba(73,142,255,0))",
  pointerEvents: "none",
};

const workspaceGlowTwoStyle = {
  position: "absolute",
  width: 300,
  height: 300,
  borderRadius: "50%",
  left: -140,
  top: 240,
  background: "radial-gradient(circle, rgba(65,232,196,0.16), rgba(65,232,196,0))",
  pointerEvents: "none",
};

const workspaceShellStyle = {
  width: "min(1220px, 96vw)",
  margin: "0 auto",
  padding: "20px 0 40px",
  position: "relative",
  zIndex: 2,
  fontFamily: "\"Space Grotesk\", \"Avenir Next\", \"Segoe UI\", sans-serif",
};

const headerStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  marginBottom: 16,
  padding: 16,
  borderRadius: 16,
  background: "linear-gradient(145deg, rgba(255,255,255,0.1), rgba(255,255,255,0.04))",
  border: "1px solid rgba(154, 190, 228, 0.26)",
  backdropFilter: "blur(6px)",
};

const syncStatusStyle = {
  marginTop: 8,
  marginBottom: 0,
  display: "inline-block",
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 12,
  letterSpacing: 0.2,
  color: "#c8e4ff",
  border: "1px solid rgba(138, 177, 216, 0.45)",
  background: "rgba(11, 32, 53, 0.62)",
};

const linkPillStyle = {
  color: "#d8edff",
  textDecoration: "none",
  border: "1px solid rgba(137, 176, 222, 0.65)",
  padding: "10px 12px",
  borderRadius: 12,
  background: "rgba(15, 32, 53, 0.58)",
};

const warningStyle = {
  border: "1px solid rgba(255, 189, 87, 0.8)",
  background: "linear-gradient(145deg, rgba(77, 55, 16, 0.78), rgba(56, 41, 16, 0.7))",
  color: "#ffe4a7",
  padding: 12,
  borderRadius: 12,
  marginBottom: 12,
};

const warningBannerStyle = {
  ...warningStyle,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
  fontSize: 13,
};

const warningDismissBtnStyle = {
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid rgba(255, 209, 130, 0.72)",
  background: "rgba(116, 80, 23, 0.74)",
  color: "#fff0cd",
  cursor: "pointer",
  fontSize: 12,
};

const childSwitcherStyle = {
  border: "1px solid rgba(132, 169, 208, 0.3)",
  background: "rgba(12, 28, 47, 0.66)",
  borderRadius: 14,
  padding: 12,
  marginBottom: 12,
};

const childControlsStyle = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 2fr) repeat(auto-fit, minmax(110px, 1fr))",
  gap: 8,
  marginTop: 8,
};

const panelCardStyle = {
  border: "1px solid rgba(139, 175, 215, 0.34)",
  background: "rgba(6, 18, 33, 0.84)",
  borderRadius: 14,
  padding: 12,
  marginBottom: 12,
};

const panelTitleStyle = {
  display: "block",
  letterSpacing: 0.3,
  marginBottom: 8,
  color: "#d9eeff",
};

const modeSwitcherStyle = {
  ...panelCardStyle,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
};

const modeToggleRowStyle = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const modeHelpTextStyle = {
  margin: "4px 0 0",
  fontSize: 12,
  color: "#a5c4df",
};

const goalCardStyle = {
  ...panelCardStyle,
};

const goalHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  marginBottom: 8,
  color: "#f0f9ff",
};

const goalMetaStyle = {
  marginTop: 8,
  marginBottom: 8,
  color: "#a9c4df",
};

const progressTrackStyle = {
  width: "100%",
  height: 12,
  borderRadius: 999,
  background: "rgba(124, 161, 200, 0.28)",
  overflow: "hidden",
};

const progressFillStyle = {
  height: "100%",
  background: "linear-gradient(90deg, #34a6ff, #33d2a0)",
};

const finderSectionStyle = {
  ...panelCardStyle,
};

const finderControlsStyle = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 2fr) minmax(130px, 1fr) auto auto",
  gap: 8,
  marginTop: 8,
};

const textInputStyle = {
  padding: 11,
  borderRadius: 12,
  border: "1px solid rgba(135, 172, 212, 0.5)",
  background: "rgba(7, 21, 37, 0.85)",
  color: "#e8f4ff",
};

const selectStyle = {
  padding: 11,
  borderRadius: 12,
  border: "1px solid rgba(135, 172, 212, 0.5)",
  background: "rgba(7, 21, 37, 0.9)",
  color: "#e8f4ff",
};

const boardTabRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};

const childCategoryTabRowStyle = {
  ...boardTabRowStyle,
  flexWrap: "nowrap",
  overflowX: "auto",
  paddingBottom: 2,
};

const childStickyCategoryCardStyle = {
  ...panelCardStyle,
  position: "sticky",
  top: 8,
  zIndex: 9,
  backdropFilter: "blur(6px)",
};

const boardTabBtnStyle = (active) => ({
  border: active ? "1px solid rgba(108, 243, 197, 0.8)" : "1px solid rgba(135, 172, 212, 0.45)",
  background: active
    ? "linear-gradient(140deg, rgba(17, 95, 72, 0.82), rgba(12, 75, 93, 0.78))"
    : "rgba(13, 33, 55, 0.72)",
  color: active ? "#dcfff2" : "#d4e9fb",
  borderRadius: 999,
  padding: "8px 12px",
  cursor: "pointer",
  fontSize: 13,
  letterSpacing: 0.2,
});

const boardSubTabRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 10,
};

const boardSubTabBtnStyle = (active) => ({
  border: active ? "1px solid rgba(121, 174, 255, 0.85)" : "1px solid rgba(133, 170, 209, 0.45)",
  background: active
    ? "linear-gradient(140deg, rgba(29, 70, 125, 0.82), rgba(18, 53, 97, 0.78))"
    : "rgba(9, 26, 45, 0.72)",
  color: active ? "#e4f0ff" : "#c7ddf2",
  borderRadius: 999,
  padding: "7px 11px",
  cursor: "pointer",
  fontSize: 12,
});

const boardNavigationHintStyle = {
  margin: "10px 0 0",
  color: "#a8c5e2",
  fontSize: 13,
};

const onboardingBodyStyle = {
  margin: "0 0 10px",
  color: "#c3ddf2",
  lineHeight: 1.5,
};

const starterSetRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};

const accessibilityRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 10,
};

const scanControlPanelStyle = {
  border: "1px solid rgba(130, 168, 208, 0.35)",
  borderRadius: 12,
  padding: 10,
  background: "rgba(8, 23, 39, 0.7)",
  marginBottom: 10,
  display: "grid",
  gap: 8,
};

const voiceGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 10,
};

const rangeLabelStyle = {
  display: "grid",
  gap: 6,
  color: "#cae2f7",
  fontSize: 13,
};

const scanReadoutStyle = {
  color: "#b6d4ed",
  fontSize: 13,
};

const speedHintStyle = {
  margin: "8px 0 0",
  color: "#9ec2df",
  fontSize: 12,
};

const difficultyRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
  marginTop: 8,
};

const sentenceStyle = {
  border: "1px solid rgba(125, 163, 201, 0.45)",
  background: "rgba(3, 13, 25, 0.72)",
  padding: 12,
  minHeight: 76,
  marginBottom: 4,
  fontSize: 24,
  display: "flex",
  flexWrap: "nowrap",
  gap: 8,
  borderRadius: 12,
  overflowX: "auto",
  alignItems: "center",
};

const dualLanguagePreviewStyle = {
  marginTop: 6,
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid rgba(139, 186, 228, 0.42)",
  background: "rgba(12, 30, 49, 0.58)",
  color: "#cae5fb",
  fontSize: 13,
  display: "grid",
  gap: 4,
};

const ghostSentenceStyle = {
  marginTop: 6,
  fontSize: 13,
  color: "rgba(168, 209, 243, 0.88)",
  border: "1px dashed rgba(138, 180, 220, 0.4)",
  borderRadius: 10,
  padding: "6px 10px",
  background: "rgba(13, 29, 49, 0.5)",
  width: "100%",
  textAlign: "left",
  cursor: "pointer",
};

const sentenceChipStyle = {
  border: "1px solid rgba(123, 176, 223, 0.65)",
  borderRadius: 14,
  background: "linear-gradient(145deg, rgba(27,61,95,0.8), rgba(22,50,80,0.72))",
  color: "#e6f5ff",
  padding: "8px 12px",
  cursor: "pointer",
  fontSize: 18,
  whiteSpace: "nowrap",
  transition: "transform 120ms ease, border-color 120ms ease",
};

const sentenceChipHighlightStyle = {
  border: "1px solid rgba(123, 243, 193, 0.88)",
  background: "linear-gradient(145deg, rgba(22, 91, 66, 0.88), rgba(20, 73, 57, 0.82))",
  color: "#eafff5",
  transform: "translateY(-1px)",
};

const sentenceHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
  marginBottom: 8,
};

const sentenceMetaStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const sentenceCounterStyle = {
  fontSize: 12,
  color: "#9ec0df",
};

const sentenceCursorStyle = {
  color: "#89ffcf",
  fontWeight: 700,
  fontSize: 24,
  lineHeight: 1,
  alignSelf: "center",
};

const speakReactionStyle = {
  marginTop: 6,
  fontSize: 28,
  lineHeight: 1,
  filter: "drop-shadow(0 0 8px rgba(134, 197, 255, 0.45))",
};

const microReinforcementStyle = {
  marginTop: 8,
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid rgba(118, 225, 178, 0.5)",
  background: "rgba(19, 69, 53, 0.62)",
  color: "#d9ffef",
  fontSize: 12,
  letterSpacing: 0.2,
};

const cursorControlRowStyle = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 8,
};

const cursorHintStyle = {
  fontSize: 12,
  color: "#9dc0df",
};

const smartSuggestionInlineRowStyle = {
  display: "flex",
  gap: 8,
  marginTop: 10,
  flexWrap: "wrap",
};

const compactSuggestionBtnStyle = {
  border: "1px solid rgba(130, 173, 215, 0.52)",
  background: "rgba(14, 36, 60, 0.72)",
  color: "#e8f5ff",
  borderRadius: 999,
  padding: "8px 12px",
  fontSize: 14,
  cursor: "pointer",
};

const anticipationRowStyle = {
  border: "1px solid rgba(126, 187, 237, 0.36)",
  borderRadius: 12,
  background: "rgba(11, 33, 55, 0.72)",
  padding: 10,
  marginBottom: 8,
};

const anticipationChipStyle = {
  ...compactSuggestionBtnStyle,
  border: "1px solid rgba(124, 199, 243, 0.58)",
  background: "rgba(17, 46, 74, 0.8)",
  fontSize: 13,
};

const suggestionRowStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
  gap: 8,
  marginTop: 8,
};

const suggestionBtnStyle = {
  display: "grid",
  gap: 6,
  alignItems: "center",
  justifyItems: "center",
  textAlign: "center",
  padding: 14,
  fontSize: 16,
  borderRadius: 14,
  border: "1px solid rgba(141, 183, 226, 0.5)",
  background: "linear-gradient(150deg, rgba(20, 50, 80, 0.86), rgba(15, 36, 63, 0.76))",
  color: "#ecf7ff",
  cursor: "pointer",
  minHeight: 88,
};

const largeSuggestionBtnStyle = {
  minHeight: 122,
  fontSize: 20,
  padding: 18,
};

const childSuggestionsCardStyle = {
  ...panelCardStyle,
  paddingTop: 10,
};

const autoSentenceRowStyle = {
  border: "1px solid rgba(117, 222, 178, 0.46)",
  borderRadius: 12,
  background: "rgba(11, 41, 34, 0.68)",
  padding: 10,
  marginBottom: 8,
  display: "grid",
  gap: 8,
};

const autoSentenceCardStyle = {
  display: "grid",
  gap: 6,
};

const autoSentenceBtnStyle = (confidenceScore = 0.55, featured = false) => {
  const glow = confidenceScore >= 0.78
    ? "0 0 0 1px rgba(148, 255, 218, 0.72), 0 0 16px rgba(116, 242, 193, 0.34)"
    : confidenceScore >= 0.56
      ? "0 0 0 1px rgba(255, 226, 150, 0.58), 0 0 12px rgba(255, 190, 104, 0.22)"
      : "0 0 0 1px rgba(163, 192, 222, 0.4), 0 0 8px rgba(121, 156, 194, 0.16)";

  return {
    border: "1px solid rgba(117, 222, 178, 0.62)",
    borderRadius: 12,
    background: "linear-gradient(145deg, rgba(15, 103, 73, 0.9), rgba(10, 81, 59, 0.88))",
    color: "#eafff2",
    cursor: "pointer",
    padding: "10px 12px",
    textAlign: "left",
    display: "grid",
    gap: 6,
    boxShadow: glow,
    minHeight: featured ? 68 : "auto",
    fontSize: featured ? 17 : 15,
  };
};

const autoSentenceBtnTopRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const autoSentenceConfidenceDotsStyle = (confidenceScore = 0.55) => ({
  fontSize: 11,
  letterSpacing: 1.5,
  color:
    confidenceScore >= 0.78
      ? "rgba(216, 255, 237, 0.96)"
      : confidenceScore >= 0.56
        ? "rgba(255, 236, 173, 0.95)"
        : "rgba(207, 222, 239, 0.88)",
  minWidth: 40,
  textAlign: "right",
});

const autoSentenceReasonStyle = {
  fontSize: 11,
  color: "rgba(214, 244, 229, 0.84)",
  lineHeight: 1.3,
};

const autoSentenceActionRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  flexWrap: "wrap",
};

const autoSentenceMetaBadgeStyle = {
  fontSize: 11,
  padding: "4px 8px",
  borderRadius: 999,
  border: "1px solid rgba(129, 200, 167, 0.5)",
  background: "rgba(18, 57, 46, 0.7)",
  color: "rgba(219, 255, 239, 0.88)",
  letterSpacing: 0.2,
  textTransform: "capitalize",
};

const autoSentenceHintStyle = {
  fontSize: 11,
  color: "rgba(176, 225, 204, 0.84)",
};

const intentHelperTextStyle = {
  margin: "0 0 8px",
  color: "#a6c8e6",
  fontSize: 12,
  lineHeight: 1.4,
};

const childSuggestionBtnStyle = (confidence, largeMode = false) => {
  const glowByConfidence = {
    High: "0 0 0 1px rgba(110,255,198,0.55), 0 0 18px rgba(79,230,172,0.35)",
    Medium: "0 0 0 1px rgba(255,218,133,0.48), 0 0 14px rgba(255,189,90,0.22)",
    Low: "0 0 0 1px rgba(160,187,221,0.35), 0 0 10px rgba(118,158,204,0.14)",
  };

  return {
    ...(largeMode ? { ...suggestionBtnStyle, ...largeSuggestionBtnStyle } : suggestionBtnStyle),
    boxShadow: glowByConfidence[confidence] ?? glowByConfidence.Low,
  };
};

const suggestionConfidenceBadgeStyle = (confidence) => {
  if (confidence === "High") {
    return {
      fontSize: 11,
      padding: "3px 8px",
      borderRadius: 999,
      border: "1px solid rgba(110, 255, 198, 0.7)",
      background: "rgba(16, 81, 59, 0.72)",
      color: "#dbffe8",
      letterSpacing: 0.2,
    };
  }

  if (confidence === "Medium") {
    return {
      fontSize: 11,
      padding: "3px 8px",
      borderRadius: 999,
      border: "1px solid rgba(255, 218, 133, 0.72)",
      background: "rgba(99, 73, 24, 0.68)",
      color: "#ffe9ba",
      letterSpacing: 0.2,
    };
  }

  return {
    fontSize: 11,
    padding: "3px 8px",
    borderRadius: 999,
    border: "1px solid rgba(160, 187, 221, 0.62)",
    background: "rgba(29, 50, 79, 0.66)",
    color: "#d8e9fb",
    letterSpacing: 0.2,
  };
};

const suggestionReasonStyle = {
  fontSize: 12,
  color: "#a9c6e4",
  lineHeight: 1.3,
};

const smartSuggestionCardStyle = {
  border: "1px solid rgba(136, 176, 216, 0.34)",
  borderRadius: 14,
  background: "rgba(10, 26, 45, 0.74)",
  padding: 8,
  display: "grid",
  gap: 8,
};

const smartSuggestionMainBtnStyle = {
  ...suggestionBtnStyle,
  width: "100%",
  minHeight: 96,
};

const smartSuggestionPrimaryTextStyle = {
  fontSize: 16,
  lineHeight: 1.35,
  textAlign: "center",
  color: "#e8f6ff",
};

const smartSuggestionActionRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
};

const whyButtonStyle = {
  justifySelf: "end",
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid rgba(129, 170, 212, 0.6)",
  background: "rgba(19, 41, 67, 0.78)",
  color: "#d7ecff",
  cursor: "pointer",
  fontSize: 12,
};

const phraseSavePillStyle = {
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid rgba(118, 221, 181, 0.6)",
  background: "rgba(30, 74, 59, 0.7)",
  color: "#d8ffed",
  cursor: "pointer",
  fontSize: 12,
};

const whyPopoverStyle = {
  border: "1px solid rgba(128, 165, 205, 0.4)",
  borderRadius: 10,
  background: "rgba(8, 19, 34, 0.9)",
  padding: 10,
  display: "grid",
  gap: 6,
};

const whyDetailRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 12,
};

const whyDetailLabelStyle = {
  color: "#a8c3df",
};

const whyDetailValueStyle = {
  color: "#e3f4ff",
  fontWeight: 600,
};

const phraseRowStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 8,
  marginTop: 8,
};

const phraseCardStyle = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: 6,
};

const phraseBtnStyle = {
  textAlign: "left",
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid rgba(131, 172, 214, 0.42)",
  background: "rgba(15, 38, 63, 0.75)",
  color: "#e2f3ff",
  cursor: "pointer",
};

const phraseMetaRowStyle = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  flexWrap: "wrap",
};

const phraseMetaBadgeStyle = {
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid rgba(129, 171, 213, 0.46)",
  color: "#c9e3fa",
  background: "rgba(9, 30, 52, 0.68)",
};

const phrasePinBtnStyle = (active) => ({
  padding: "0 10px",
  borderRadius: 12,
  border: active ? "1px solid rgba(249, 214, 112, 0.84)" : "1px solid rgba(131, 172, 214, 0.42)",
  background: active ? "rgba(95, 76, 18, 0.84)" : "rgba(14, 37, 62, 0.75)",
  color: active ? "#ffe9af" : "#d1e7fb",
  cursor: "pointer",
});

const phraseDeleteBtnStyle = {
  padding: "0 12px",
  borderRadius: 12,
  border: "1px solid rgba(242, 133, 133, 0.55)",
  background: "rgba(88, 29, 39, 0.7)",
  color: "#ffdce0",
  cursor: "pointer",
};

const phraseSaveBtnStyle = {
  padding: "0 12px",
  borderRadius: 12,
  border: "1px solid rgba(118, 221, 181, 0.6)",
  background: "rgba(30, 74, 59, 0.7)",
  color: "#d8ffed",
  cursor: "pointer",
};

const adaptiveLoopHintStyle = {
  margin: "10px 0 0",
  color: "#9ec1de",
  fontSize: 12,
};

const actionRowStyle = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const childSentenceActionRowStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 8,
  marginTop: 10,
};

const gestureHintStyle = {
  margin: "8px 0 0",
  color: "#9ec2df",
  fontSize: 12,
};

const childSentenceActionBtnStyle = {
  border: "1px solid rgba(143, 182, 222, 0.55)",
  background: "linear-gradient(145deg, rgba(23,58,91,0.86), rgba(17,44,73,0.86))",
  color: "#e9f6ff",
  borderRadius: 12,
  cursor: "pointer",
  fontSize: 16,
  padding: "12px 10px",
  textAlign: "center",
  minHeight: 46,
};

const childPrimarySpeakBtnStyle = {
  ...childSentenceActionBtnStyle,
  border: "1px solid rgba(122, 255, 196, 0.78)",
  background: "linear-gradient(145deg, rgba(16, 117, 78, 0.94), rgba(13, 92, 64, 0.94))",
  color: "#eafff4",
  boxShadow: "0 6px 18px rgba(17, 120, 81, 0.34)",
};

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
  gap: 10,
  marginTop: 8,
};

const wordGridControlRowStyle = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
  marginBottom: 8,
};

const wordGridMetaTextStyle = {
  fontSize: 12,
  color: "#a6c8e6",
};

const alternateWordPanelStyle = {
  border: "1px solid rgba(130, 172, 214, 0.4)",
  borderRadius: 12,
  background: "rgba(10, 25, 43, 0.8)",
  padding: 10,
  marginBottom: 8,
};

const childGridStyle = {
  ...gridStyle,
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 8,
};

const wordCardStyle = {
  display: "grid",
  gap: 6,
};

const childWordCardStyle = {
  ...wordCardStyle,
  position: "relative",
};

const btnStyle = {
  padding: "10px 12px",
  fontSize: 15,
  borderRadius: 12,
  border: "1px solid rgba(143, 182, 222, 0.55)",
  background: "linear-gradient(145deg, rgba(23,58,91,0.86), rgba(17,44,73,0.86))",
  color: "#e9f6ff",
  cursor: "pointer",
};

const activeBtnStyle = {
  ...btnStyle,
  background: "linear-gradient(145deg, rgba(18, 102, 76, 0.9), rgba(12, 78, 58, 0.9))",
  border: "1px solid rgba(106, 234, 188, 0.72)",
};

const gridBtn = {
  padding: 18,
  fontSize: 18,
  borderRadius: 16,
  background: "linear-gradient(145deg, rgba(29, 67, 104, 0.86), rgba(19, 46, 77, 0.86))",
  border: "1px solid rgba(135, 175, 218, 0.52)",
  color: "#f2fbff",
  cursor: "pointer",
  minHeight: 112,
};

const childWordTileStyle = {
  minHeight: 118,
  borderRadius: 14,
  padding: 10,
  fontSize: 17,
  gap: 6,
};

const largeWordTileStyle = {
  minHeight: 160,
  fontSize: 22,
  padding: 24,
};

const scanHighlightTileStyle = {
  border: "2px solid rgba(113, 241, 198, 0.95)",
  boxShadow: "0 0 0 2px rgba(35, 174, 137, 0.3), 0 0 24px rgba(69, 226, 184, 0.45)",
};

const flashedTileStyle = {
  transform: "scale(1.02)",
  transition: "transform 100ms ease",
};

const rareWordTileStyle = {
  opacity: 0.72,
  filter: "saturate(0.84)",
};

const wordBoardMetaStyle = {
  marginTop: 2,
  fontSize: 11,
  color: "#9eb8d6",
  letterSpacing: 0.15,
};

const favoriteToggleBtnStyle = {
  borderRadius: 10,
  border: "1px solid rgba(250, 216, 108, 0.66)",
  background: "rgba(94, 76, 19, 0.8)",
  color: "#ffe8a8",
  cursor: "pointer",
  fontSize: 18,
  padding: "6px 0",
};

const childFavoriteCornerBtnStyle = {
  position: "absolute",
  top: 8,
  right: 8,
  width: 28,
  height: 28,
  borderRadius: 999,
  border: "1px solid rgba(250, 216, 108, 0.66)",
  background: "rgba(94, 76, 19, 0.82)",
  color: "#ffe8a8",
  cursor: "pointer",
  fontSize: 15,
  lineHeight: "26px",
  padding: 0,
};

const childPhraseHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
};

const childPhraseHeaderActionsStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};

const childPhraseHintStyle = {
  margin: "8px 0 0",
  color: "#a9c7e2",
  fontSize: 12,
};

const parentSyncStatusStyle = {
  margin: "0 0 10px",
  color: "#b8d4ed",
  fontSize: 13,
};

const insightListStyle = {
  display: "grid",
  gap: 8,
};

const insightItemStyle = {
  border: "1px solid rgba(132, 172, 212, 0.32)",
  background: "rgba(9, 27, 46, 0.8)",
  color: "#d8ecff",
  borderRadius: 10,
  padding: "8px 10px",
  fontSize: 14,
};

const storyItemStyle = {
  ...insightItemStyle,
  border: "1px solid rgba(122, 224, 180, 0.38)",
  background: "rgba(11, 42, 36, 0.78)",
  color: "#e5fff3",
};

const floatingEmergencyBtnStyle = {
  position: "fixed",
  right: 18,
  bottom: 18,
  zIndex: 12,
  border: "1px solid rgba(255, 143, 143, 0.82)",
  background: "linear-gradient(145deg, rgba(171, 26, 42, 0.95), rgba(131, 20, 35, 0.95))",
  color: "#fff2f2",
  padding: "12px 16px",
  borderRadius: 999,
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 0.3,
  boxShadow: "0 14px 28px rgba(69, 8, 19, 0.45)",
};

const dashboardShellStyle = {
  marginTop: 40,
  position: "relative",
  borderRadius: 20,
  overflow: "hidden",
  border: "1px solid rgba(126, 163, 203, 0.35)",
  boxShadow: "0 22px 46px rgba(2, 11, 22, 0.55)",
  fontFamily: "\"Space Grotesk\", \"Avenir Next\", \"Segoe UI\", sans-serif",
};

const dashboardBackdropStyle = {
  position: "absolute",
  inset: 0,
  background:
    "linear-gradient(135deg, rgba(38, 128, 206, 0.28), rgba(0, 166, 132, 0.22) 45%, rgba(255, 196, 77, 0.16))",
};

const dashboardContentStyle = {
  position: "relative",
  padding: 18,
  background: "rgba(6, 19, 34, 0.84)",
  backdropFilter: "blur(4px)",
};

const dashboardHeroStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  marginBottom: 14,
};

const dashboardEyebrowStyle = {
  margin: 0,
  letterSpacing: 1.2,
  fontSize: 12,
  textTransform: "uppercase",
  color: "#95c1e4",
  fontWeight: 700,
};

const dashboardHeadingStyle = {
  margin: "4px 0 4px",
  fontSize: 30,
  lineHeight: 1.1,
  color: "#f2f9ff",
};

const dashboardSubtitleStyle = {
  margin: 0,
  color: "#b9d4ec",
};

const dashboardGoalBadgeStyle = {
  minWidth: 220,
  borderRadius: 14,
  padding: 12,
  border: "1px solid rgba(130, 173, 217, 0.55)",
  background: "linear-gradient(135deg, rgba(16, 55, 88, 0.84), rgba(17, 76, 66, 0.82))",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.15)",
};

const dashboardGoalLabelStyle = {
  fontSize: 12,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: "#9fc3df",
  fontWeight: 700,
};

const dashboardGoalValueStyle = {
  display: "block",
  marginTop: 4,
  marginBottom: 8,
  fontSize: 24,
  color: "#e7f9ff",
};

const dashboardMiniTrackStyle = {
  width: "100%",
  height: 10,
  borderRadius: 999,
  background: "rgba(156, 188, 216, 0.28)",
  overflow: "hidden",
};

const dashboardMiniFillStyle = {
  height: "100%",
  background: "linear-gradient(90deg, #1e9bd7, #2dbb7f)",
};

const dashboardStatsGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 10,
  marginBottom: 14,
};

const dashboardStatCardStyle = {
  borderRadius: 12,
  border: "1px solid rgba(132, 172, 212, 0.4)",
  background: "rgba(10, 33, 57, 0.72)",
  padding: 10,
};

const dashboardStatLabelStyle = {
  display: "block",
  color: "#9dc2df",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 6,
};

const dashboardStatValueStyle = {
  color: "#e7f7ff",
  fontSize: 22,
  lineHeight: 1,
};

const dashboardPanelsStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: 12,
};

const dashboardPanelStyle = {
  borderRadius: 14,
  border: "1px solid rgba(129, 170, 211, 0.35)",
  background: "rgba(8, 28, 48, 0.74)",
  padding: 12,
};

const dashboardPanelTitleStyle = {
  margin: "0 0 10px",
  color: "#e9f7ff",
  fontSize: 18,
};

const dashboardPanelEmptyStyle = {
  margin: 0,
  color: "#9fc2de",
};

const dashboardSentenceListStyle = {
  display: "grid",
  gap: 8,
};

const dashboardSentenceItemStyle = {
  borderRadius: 10,
  border: "1px solid rgba(130, 168, 208, 0.4)",
  padding: "8px 10px",
  background: "linear-gradient(180deg, rgba(26, 64, 98, 0.72), rgba(16, 39, 65, 0.72))",
  color: "#e4f5ff",
};

const dashboardRecommendationListStyle = {
  display: "grid",
  gap: 8,
};

const dashboardRecommendationItemStyle = {
  borderRadius: 10,
  border: "1px solid rgba(125, 168, 208, 0.38)",
  padding: "8px 10px",
  background: "rgba(16, 42, 69, 0.72)",
  color: "#dff0ff",
  fontSize: 14,
  lineHeight: 1.35,
};

const dashboardWordBarsStyle = {
  display: "grid",
  gap: 10,
};

const dashboardWordRowStyle = {
  display: "grid",
  gap: 4,
};

const dashboardWordHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  color: "#cae4f8",
  fontWeight: 600,
};

const dashboardWordTrackStyle = {
  width: "100%",
  height: 10,
  borderRadius: 999,
  background: "rgba(147, 184, 220, 0.28)",
  overflow: "hidden",
};

const dashboardWordFillStyle = {
  height: "100%",
  background: "linear-gradient(90deg, #3197df, #2fbb92)",
};

const dashboardLayerFillStyle = {
  height: "100%",
  background: "linear-gradient(90deg, #5f8dff, #3bc7d4)",
};

const dashboardIgnoreFillStyle = {
  height: "100%",
  background: "linear-gradient(90deg, #d17338, #d64c55)",
};

const dashboardPhraseFillStyle = {
  height: "100%",
  background: "linear-gradient(90deg, #3d8cff, #48d0bc)",
};

const dashboardAutoSentenceMetaStyle = {
  marginTop: 10,
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  color: "#c5deef",
  fontSize: 13,
};

const dashboardAutoSentenceHintStyle = {
  marginTop: 10,
  marginBottom: 0,
  color: "#b8d3e8",
  fontSize: 13,
  lineHeight: 1.35,
};

const dashboardAutoTrendChartStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(14, minmax(18px, 1fr))",
  gap: 6,
  alignItems: "end",
};

const dashboardAutoTrendColumnStyle = {
  display: "grid",
  justifyItems: "center",
  gap: 4,
};

const dashboardAutoTrendShownStyle = {
  fontSize: 10,
  color: "#9ec2dd",
  minHeight: 12,
};

const dashboardAutoTrendTrackStyle = {
  width: "100%",
  height: 86,
  borderRadius: 8,
  background: "rgba(134, 169, 205, 0.24)",
  padding: "4px 3px",
  display: "flex",
  gap: 3,
  alignItems: "flex-end",
  justifyContent: "center",
};

const dashboardAutoTrendAcceptBarStyle = {
  width: "45%",
  borderRadius: "4px 4px 2px 2px",
  background: "linear-gradient(180deg, #5bd6a6, #2fbf8f)",
};

const dashboardAutoTrendIgnoreBarStyle = {
  width: "45%",
  borderRadius: "4px 4px 2px 2px",
  background: "linear-gradient(180deg, #f5a66a, #d66758)",
};

const dashboardTwinBlockStyle = {
  display: "grid",
  gap: 8,
  marginBottom: 10,
};

const dashboardTwinTitleStyle = {
  color: "#d8edff",
  fontSize: 13,
  letterSpacing: 0.3,
  textTransform: "uppercase",
};

const dashboardTwinIntentFillStyle = {
  height: "100%",
  background: "linear-gradient(90deg, #54b2ff, #48d9bd)",
};

const dashboardTwinChipRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const dashboardTwinChipStyle = {
  borderRadius: 999,
  border: "1px solid rgba(117, 172, 220, 0.52)",
  background: "rgba(22, 53, 84, 0.74)",
  color: "#deefff",
  padding: "4px 10px",
  fontSize: 12,
};

const dashboardTwinListStyle = {
  display: "grid",
  gap: 6,
};

const dashboardTwinListItemStyle = {
  borderRadius: 9,
  border: "1px solid rgba(123, 166, 206, 0.35)",
  background: "rgba(14, 36, 60, 0.72)",
  color: "#d7ebff",
  padding: "6px 8px",
  fontSize: 13,
  lineHeight: 1.35,
};

const dashboardTwinSpeedRowStyle = {
  marginTop: 4,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
  gap: 8,
  color: "#bdd9f1",
  fontSize: 12,
  borderTop: "1px solid rgba(115, 162, 205, 0.32)",
  paddingTop: 8,
};

const dashboardPhraseLabelStyle = {
  maxWidth: "82%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const dashboardTrendChartStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(14, minmax(18px, 1fr))",
  gap: 6,
  alignItems: "end",
};

const dashboardTrendBarWrapStyle = {
  display: "grid",
  justifyItems: "center",
  gap: 4,
};

const dashboardTrendCountStyle = {
  fontSize: 10,
  color: "#95bad9",
  minHeight: 12,
};

const dashboardTrendTrackStyle = {
  width: "100%",
  height: 80,
  borderRadius: 8,
  background: "rgba(139, 177, 215, 0.24)",
  display: "flex",
  alignItems: "flex-end",
  overflow: "hidden",
};

const dashboardTrendFillStyle = {
  width: "100%",
  background: "linear-gradient(180deg, #35a6f2, #38cda2)",
};

const dashboardTrendLabelStyle = {
  fontSize: 10,
  color: "#9dc2df",
  letterSpacing: 0.1,
};
