function toDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === "function") {
    const parsed = value.toDate();
    return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed : null;
  }
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recentDayKeys(days = 30, now = new Date()) {
  const keys = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(now);
    date.setDate(now.getDate() - index);
    keys.push(formatDateKey(date));
  }
  return keys;
}

function normalizeDateKey(value) {
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = toDateLike(value);
  return parsed ? formatDateKey(parsed) : "";
}

function parseDateKey(value) {
  const key = normalizeDateKey(value);
  if (!key) return null;
  const parsed = new Date(`${key}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildDateKeyRange(start, end) {
  const startDate = parseDateKey(start);
  const endDate = parseDateKey(end);
  if (!startDate || !endDate) return [];

  const low = startDate <= endDate ? startDate : endDate;
  const high = startDate <= endDate ? endDate : startDate;
  const keys = [];
  const cursor = new Date(low);

  while (cursor <= high) {
    keys.push(formatDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return keys;
}

function sumDailyCountsByKeys(dailyCounts = {}, keys = []) {
  if (!Array.isArray(keys) || keys.length === 0) return 0;
  return keys.reduce((sum, key) => sum + safeNumber(dailyCounts[key] ?? 0, 0), 0);
}

function normalizeToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

function tokenizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safePercentDelta(current, previous) {
  const now = safeNumber(current, 0);
  const before = safeNumber(previous, 0);
  if (before <= 0) {
    if (now <= 0) return 0;
    return 1;
  }
  return (now - before) / before;
}

function average(values = []) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sum = values.reduce((total, value) => total + safeNumber(value, 0), 0);
  return sum / values.length;
}

function normalizeChildModel(child = {}) {
  const smartModel = child?.smartModel ?? {};
  const structuredModel = child?.model ?? {};

  return {
    usageCounts:
      structuredModel.wordFrequency && typeof structuredModel.wordFrequency === "object"
        ? structuredModel.wordFrequency
        : smartModel.usageCounts ?? {},
    sentenceHistory: Array.isArray(structuredModel.sentenceHistory)
      ? structuredModel.sentenceHistory
      : Array.isArray(smartModel.sentenceHistory)
        ? smartModel.sentenceHistory
        : [],
    sentenceEvents: Array.isArray(structuredModel.sentenceEvents)
      ? structuredModel.sentenceEvents
      : Array.isArray(smartModel.sentenceEvents)
        ? smartModel.sentenceEvents
        : [],
    speakLatencyMsHistory: Array.isArray(structuredModel.speakLatencyMsHistory)
      ? structuredModel.speakLatencyMsHistory
      : Array.isArray(smartModel.speakLatencyMsHistory)
        ? smartModel.speakLatencyMsHistory
        : [],
    autoSentenceLearning:
      structuredModel.autoSentenceLearning && typeof structuredModel.autoSentenceLearning === "object"
        ? structuredModel.autoSentenceLearning
        : smartModel.autoSentenceLearning && typeof smartModel.autoSentenceLearning === "object"
          ? smartModel.autoSentenceLearning
          : {},
  };
}

function normalizeSentenceEvents(sentenceEvents = [], sentenceHistory = []) {
  const normalized = [];

  sentenceEvents.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const text = String(entry.text ?? "").trim();
    if (!text) return;
    const stamp = toDateLike(entry.ts);
    const elapsedMs = safeNumber(entry.elapsedMs ?? entry.latencyMs ?? entry.elapsed ?? 0, 0);
    normalized.push({
      text,
      ts: stamp ? stamp.getTime() : null,
      elapsedMs: elapsedMs > 0 ? elapsedMs : null,
    });
  });

  if (normalized.length === 0) {
    sentenceHistory.forEach((entry) => {
      const text = String(entry ?? "").trim();
      if (!text) return;
      normalized.push({ text, ts: null, elapsedMs: null });
    });
  }

  return normalized;
}

function getDailySentenceSeries(dailySentenceCounts = {}, days = 30, now = new Date()) {
  return recentDayKeys(days, now).map((key) => ({
    key,
    label: key.slice(5),
    count: safeNumber(dailySentenceCounts[key] ?? 0, 0),
  }));
}

function getDailyAutoSuggestionRateSeries(autoSentenceLearning = {}, days = 14, now = new Date()) {
  const safeDays = Math.max(1, Math.min(60, Math.round(days)));
  const shownMap =
    autoSentenceLearning?.dailyShownCounts && typeof autoSentenceLearning.dailyShownCounts === "object"
      ? autoSentenceLearning.dailyShownCounts
      : {};
  const acceptedMap =
    autoSentenceLearning?.dailyAcceptedCounts && typeof autoSentenceLearning.dailyAcceptedCounts === "object"
      ? autoSentenceLearning.dailyAcceptedCounts
      : {};
  const ignoredMap =
    autoSentenceLearning?.dailyIgnoredCounts && typeof autoSentenceLearning.dailyIgnoredCounts === "object"
      ? autoSentenceLearning.dailyIgnoredCounts
      : {};

  return recentDayKeys(safeDays, now).map((key) => {
    const shown = safeNumber(shownMap[key] ?? 0, 0);
    const accepted = safeNumber(acceptedMap[key] ?? 0, 0);
    const ignored = safeNumber(ignoredMap[key] ?? 0, 0);
    const acceptRate = shown > 0 ? Math.min(1, accepted / shown) : 0;
    const ignoreRate = shown > 0 ? Math.min(1, ignored / shown) : 0;

    return {
      key,
      label: key.slice(5),
      shown,
      accepted,
      ignored,
      acceptRate,
      ignoreRate,
    };
  });
}

function buildPopulationAutoSuggestionRateSeries(children = [], days = 30, now = new Date()) {
  const safeDays = Math.max(1, Math.min(60, Math.round(days)));
  const perChildSeries = (Array.isArray(children) ? children : []).map((child) => {
    const model = normalizeChildModel(child);
    return getDailyAutoSuggestionRateSeries(model.autoSentenceLearning ?? {}, safeDays, now);
  });
  const keys = recentDayKeys(safeDays, now);

  return keys.map((key, index) => {
    let shown = 0;
    let accepted = 0;
    let ignored = 0;

    perChildSeries.forEach((series) => {
      const row = series[index];
      shown += safeNumber(row?.shown ?? 0, 0);
      accepted += safeNumber(row?.accepted ?? 0, 0);
      ignored += safeNumber(row?.ignored ?? 0, 0);
    });

    const acceptRate = shown > 0 ? Math.min(1, accepted / shown) : 0;
    const ignoreRate = shown > 0 ? Math.min(1, ignored / shown) : 0;

    return {
      key,
      label: key.slice(5),
      shown,
      accepted,
      ignored,
      acceptRate,
      ignoreRate,
    };
  });
}

function splitByPeriod(values = [], periodDays = 30) {
  const safePeriod = Math.max(1, Math.round(periodDays));
  const recent = values.slice(-safePeriod);
  const previous = values.slice(-safePeriod * 2, -safePeriod);
  return { recent, previous };
}

function computeSentenceLengthStats(sentenceEvents = [], sentenceHistory = [], periodDays = 30) {
  const normalizedEvents = normalizeSentenceEvents(sentenceEvents, sentenceHistory);
  const withLength = normalizedEvents.map((entry) => tokenizeText(entry.text).length).filter((value) => value > 0);
  const { recent, previous } = splitByPeriod(withLength, periodDays);
  return {
    recentAvg: average(recent),
    previousAvg: average(previous),
  };
}

function computeVocabularyStats(sentenceEvents = [], sentenceHistory = [], periodDays = 30) {
  const normalizedEvents = normalizeSentenceEvents(sentenceEvents, sentenceHistory);
  const withTokens = normalizedEvents.map((entry) => tokenizeText(entry.text)).filter((tokens) => tokens.length > 0);
  const { recent, previous } = splitByPeriod(withTokens, periodDays);

  const buildSet = (groups = []) => {
    const set = new Set();
    groups.forEach((tokens) => {
      tokens.forEach((token) => {
        const normalized = normalizeToken(token);
        if (normalized) set.add(normalized);
      });
    });
    return set;
  };

  const recentSet = buildSet(recent);
  const previousSet = buildSet(previous);
  let newWords = 0;
  recentSet.forEach((token) => {
    if (!previousSet.has(token)) newWords += 1;
  });

  return {
    recentUnique: recentSet.size,
    previousUnique: previousSet.size,
    newWords,
  };
}

function computeLatencyStats(latencyHistory = [], periodDays = 30) {
  const filtered = (Array.isArray(latencyHistory) ? latencyHistory : [])
    .map((value) => safeNumber(value, 0))
    .filter((value) => value > 0);

  const { recent, previous } = splitByPeriod(filtered, periodDays);
  return {
    recentAvgMs: average(recent),
    previousAvgMs: average(previous),
  };
}

function computeSentenceLengthStatsFromTokenGroups(recentGroups = [], previousGroups = []) {
  const recentLengths = (Array.isArray(recentGroups) ? recentGroups : [])
    .map((tokens) => tokens.length)
    .filter((value) => value > 0);
  const previousLengths = (Array.isArray(previousGroups) ? previousGroups : [])
    .map((tokens) => tokens.length)
    .filter((value) => value > 0);

  return {
    recentAvg: average(recentLengths),
    previousAvg: average(previousLengths),
  };
}

function computeVocabularyStatsFromTokenGroups(recentGroups = [], previousGroups = []) {
  const buildSet = (groups = []) => {
    const set = new Set();
    groups.forEach((tokens) => {
      (Array.isArray(tokens) ? tokens : []).forEach((token) => {
        const normalized = normalizeToken(token);
        if (normalized) set.add(normalized);
      });
    });
    return set;
  };

  const recentSet = buildSet(recentGroups);
  const previousSet = buildSet(previousGroups);
  let newWords = 0;
  recentSet.forEach((token) => {
    if (!previousSet.has(token)) newWords += 1;
  });

  return {
    recentUnique: recentSet.size,
    previousUnique: previousSet.size,
    newWords,
  };
}

function getWindowTokenGroups(sentenceEvents = [], sentenceHistory = [], recentKeys = [], previousKeys = []) {
  const normalizedEvents = normalizeSentenceEvents(sentenceEvents, sentenceHistory);
  const recentSet = new Set(Array.isArray(recentKeys) ? recentKeys : []);
  const previousSet = new Set(Array.isArray(previousKeys) ? previousKeys : []);
  const recentGroups = [];
  const previousGroups = [];
  let timedCount = 0;

  normalizedEvents.forEach((entry) => {
    const tokens = tokenizeText(entry.text);
    if (tokens.length === 0) return;
    if (!entry.ts) return;
    const key = formatDateKey(new Date(entry.ts));
    timedCount += 1;
    if (recentSet.has(key)) recentGroups.push(tokens);
    if (previousSet.has(key)) previousGroups.push(tokens);
  });

  if (timedCount === 0) {
    const ordered = normalizedEvents.map((entry) => tokenizeText(entry.text)).filter((tokens) => tokens.length > 0);
    const recentLength = Math.max(1, recentSet.size);
    const previousLength = Math.max(1, previousSet.size);
    return {
      recentGroups: ordered.slice(-recentLength),
      previousGroups: ordered.slice(-(recentLength + previousLength), -recentLength),
      timed: false,
    };
  }

  return {
    recentGroups,
    previousGroups,
    timed: true,
  };
}

function computeLatencyStatsByWindow({
  sentenceEvents = [],
  sentenceHistory = [],
  recentKeys = [],
  previousKeys = [],
  latencyHistory = [],
  fallbackPeriodDays = 30,
} = {}) {
  const normalizedEvents = normalizeSentenceEvents(sentenceEvents, sentenceHistory);
  const recentSet = new Set(Array.isArray(recentKeys) ? recentKeys : []);
  const previousSet = new Set(Array.isArray(previousKeys) ? previousKeys : []);
  const recentValues = [];
  const previousValues = [];

  normalizedEvents.forEach((entry) => {
    if (!entry.ts || !entry.elapsedMs || entry.elapsedMs <= 0) return;
    const key = formatDateKey(new Date(entry.ts));
    if (recentSet.has(key)) recentValues.push(entry.elapsedMs);
    if (previousSet.has(key)) previousValues.push(entry.elapsedMs);
  });

  if (recentValues.length === 0 && previousValues.length === 0) {
    return {
      ...computeLatencyStats(latencyHistory, fallbackPeriodDays),
      source: "rolling_history",
    };
  }

  return {
    recentAvgMs: average(recentValues),
    previousAvgMs: average(previousValues),
    source: "event_windows",
  };
}

function computeRiskFlags(outcomes = {}) {
  const flags = [];
  if (safeNumber(outcomes.attemptsPerDayDelta, 0) < -0.2) {
    flags.push("attempt_drop");
  }
  if (safeNumber(outcomes.avgSentenceLengthDelta, 0) < -0.15) {
    flags.push("sentence_length_drop");
  }
  if (safeNumber(outcomes.timeToCommunicateDelta, 0) > 0.2) {
    flags.push("speed_regression");
  }
  if (safeNumber(outcomes.recentAttemptsPerDay, 0) < 1) {
    flags.push("low_engagement");
  }
  return flags;
}

function sumMapValues(value = {}) {
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce((sum, entry) => sum + safeNumber(entry, 0), 0);
}

function computeOutcomeMetrics(child = {}, periodDays = 30, options = {}) {
  const safePeriod = Math.max(7, Math.round(periodDays));
  const model = normalizeChildModel(child);
  const preferences = child?.preferences ?? {};
  const goals = child?.goals ?? {};
  const now = toDateLike(options?.now) ?? new Date();
  const baselineMode = String(options?.baselineMode ?? "rolling") === "fixed" ? "fixed" : "rolling";
  const requestedBaselineStart = normalizeDateKey(options?.baselineStartKey ?? options?.baselineStart);
  const requestedBaselineEnd = normalizeDateKey(options?.baselineEndKey ?? options?.baselineEnd);
  const currentKeys = recentDayKeys(safePeriod, now);
  let previousKeys = [];
  let effectiveBaselineMode = baselineMode;

  if (baselineMode === "fixed") {
    const fixedKeys = buildDateKeyRange(requestedBaselineStart, requestedBaselineEnd);
    if (fixedKeys.length > 0) {
      previousKeys = fixedKeys;
    } else {
      effectiveBaselineMode = "rolling";
    }
  }

  if (effectiveBaselineMode === "rolling") {
    previousKeys = recentDayKeys(safePeriod * 2, now).slice(0, safePeriod);
  }

  const dailyCounts =
    preferences.dailySentenceCounts && typeof preferences.dailySentenceCounts === "object"
      ? preferences.dailySentenceCounts
      : {};
  const recentAttemptsTotal = sumDailyCountsByKeys(dailyCounts, currentKeys);
  const previousAttemptsTotal = sumDailyCountsByKeys(dailyCounts, previousKeys);
  const recentAttemptsPerDay = recentAttemptsTotal / Math.max(1, currentKeys.length);
  const previousAttemptsPerDay = previousAttemptsTotal / Math.max(1, previousKeys.length);
  const attemptsPerDayDelta = safePercentDelta(recentAttemptsPerDay, previousAttemptsPerDay);

  const windowTokenGroups = getWindowTokenGroups(
    model.sentenceEvents,
    model.sentenceHistory,
    currentKeys,
    previousKeys
  );
  const sentenceLength = computeSentenceLengthStatsFromTokenGroups(
    windowTokenGroups.recentGroups,
    windowTokenGroups.previousGroups
  );
  const avgSentenceLengthDelta = safePercentDelta(sentenceLength.recentAvg, sentenceLength.previousAvg);

  const vocab = computeVocabularyStatsFromTokenGroups(
    windowTokenGroups.recentGroups,
    windowTokenGroups.previousGroups
  );
  const uniqueVocabularyDelta = safePercentDelta(vocab.recentUnique, vocab.previousUnique);

  const latency = computeLatencyStatsByWindow({
    sentenceEvents: model.sentenceEvents,
    sentenceHistory: model.sentenceHistory,
    recentKeys: currentKeys,
    previousKeys,
    latencyHistory: model.speakLatencyMsHistory,
    fallbackPeriodDays: safePeriod,
  });
  const timeToCommunicateDelta = safePercentDelta(latency.recentAvgMs, latency.previousAvgMs);
  const learning = model.autoSentenceLearning ?? {};
  const suggestionShown = sumMapValues(learning.shownCounts ?? {});
  const suggestionAccepted = sumMapValues(learning.acceptedCounts ?? {});
  const suggestionAcceptanceRate =
    suggestionShown > 0 ? Math.min(1, suggestionAccepted / suggestionShown) : 0;
  const suggestionIgnoreRate =
    suggestionShown > 0 ? Math.max(0, 1 - suggestionAcceptanceRate) : 0;

  const dailyGoal = safeNumber(goals.dailyTarget ?? preferences.dailySentenceGoal ?? 8, 8);
  const goalProgress = safeNumber(goals.currentProgress ?? 0, 0);

  const outcomes = {
    periodDays: safePeriod,
    baselineMode: effectiveBaselineMode,
    baselineStartKey: previousKeys[0] ?? "",
    baselineEndKey: previousKeys[previousKeys.length - 1] ?? "",
    baselineDays: previousKeys.length,
    currentStartKey: currentKeys[0] ?? "",
    currentEndKey: currentKeys[currentKeys.length - 1] ?? "",
    currentDays: currentKeys.length,
    timedEventCoverage: windowTokenGroups.timed ? "timed" : "fallback_ordered",
    latencySource: String(latency.source ?? "rolling_history"),
    recentAttemptsPerDay,
    previousAttemptsPerDay,
    attemptsPerDayDelta,
    recentAttemptsTotal,
    previousAttemptsTotal,
    uniqueVocabularyRecent: vocab.recentUnique,
    uniqueVocabularyPrevious: vocab.previousUnique,
    uniqueVocabularyDelta,
    newWordsInPeriod: vocab.newWords,
    avgSentenceLengthRecent: sentenceLength.recentAvg,
    avgSentenceLengthPrevious: sentenceLength.previousAvg,
    avgSentenceLengthDelta,
    avgTimeToCommunicateRecentMs: latency.recentAvgMs,
    avgTimeToCommunicatePreviousMs: latency.previousAvgMs,
    timeToCommunicateDelta,
    suggestionAcceptanceRate,
    suggestionIgnoreRate,
    dailyGoal,
    goalProgress,
    engagementRate: recentAttemptsPerDay > 0 ? 1 : 0,
    totalWordTaps: Object.values(model.usageCounts).reduce((sum, value) => sum + safeNumber(value, 0), 0),
    uniqueWordsAllTime: Object.keys(model.usageCounts).length,
  };

  outcomes.riskFlags = computeRiskFlags(outcomes);
  outcomes.highRisk = outcomes.riskFlags.length > 0;
  return outcomes;
}

function formatSignedPercent(value) {
  const percent = Math.round(safeNumber(value, 0) * 100);
  if (percent > 0) return `+${percent}%`;
  if (percent < 0) return `${percent}%`;
  return "0%";
}

function buildChildOutcomeReport({ childName = "Child", periodDays = 30, outcomes = null } = {}) {
  if (!outcomes) return "No outcome data available.";

  const avgSentenceLength = safeNumber(outcomes.avgSentenceLengthRecent, 0).toFixed(1);
  const avgLatencySeconds = (safeNumber(outcomes.avgTimeToCommunicateRecentMs, 0) / 1000).toFixed(2);
  const attemptsDelta = formatSignedPercent(outcomes.attemptsPerDayDelta);
  const suggestionAcceptance = Math.round(safeNumber(outcomes.suggestionAcceptanceRate, 0) * 100);
  const baselineLabel =
    String(outcomes.baselineMode ?? "rolling") === "fixed"
      ? `baseline window ${outcomes.baselineStartKey || "?"} to ${outcomes.baselineEndKey || "?"}`
      : "previous period";

  return [
    `Child: ${childName}`,
    `Period: ${periodDays} days`,
    `Baseline mode: ${String(outcomes.baselineMode ?? "rolling")}`,
    "",
    `- Communication attempts/day: ${safeNumber(outcomes.recentAttemptsPerDay, 0).toFixed(2)} (${attemptsDelta} vs ${baselineLabel})`,
    `- New words used: ${Math.max(0, Math.round(safeNumber(outcomes.newWordsInPeriod, 0)))}`,
    `- Avg sentence length: ${avgSentenceLength} words`,
    `- Time to communicate: ${avgLatencySeconds}s`,
    `- Suggestion acceptance: ${suggestionAcceptance}%`,
  ].join("\n");
}

function buildPopulationSummary(children = []) {
  const records = (Array.isArray(children) ? children : []).map((entry) => ({
    ...entry,
    outcomes: entry?.outcomes ?? computeOutcomeMetrics(entry),
  }));

  if (records.length === 0) {
    return {
      childCount: 0,
      avgImprovementPct: 0,
      engagementRatePct: 0,
      highRiskCount: 0,
      highRiskCases: [],
    };
  }

  const avgImprovement =
    records.reduce((sum, entry) => sum + safeNumber(entry.outcomes.attemptsPerDayDelta, 0), 0) /
    records.length;
  const engagedCount = records.filter((entry) => safeNumber(entry.outcomes.recentAttemptsPerDay, 0) > 0).length;
  const highRiskCases = records.filter((entry) => entry.outcomes.highRisk);

  return {
    childCount: records.length,
    avgImprovementPct: Math.round(avgImprovement * 100),
    engagementRatePct: Math.round((engagedCount / Math.max(1, records.length)) * 100),
    highRiskCount: highRiskCases.length,
    highRiskCases,
  };
}

function normalizeChildSnapshot(parentUid, childId, childDoc = {}, words = []) {
  return {
    parentUid,
    childId,
    name: String(childDoc?.profile?.name ?? childDoc?.name ?? "Child").trim() || "Child",
    profile: childDoc?.profile ?? {},
    stats: childDoc?.stats ?? {},
    goals: childDoc?.goals ?? {},
    preferences: childDoc?.preferences ?? {},
    smartModel: childDoc?.smartModel ?? {},
    model: childDoc?.model ?? {},
    therapyAssignments: Array.isArray(childDoc?.therapyAssignments) ? childDoc.therapyAssignments : [],
    words: Array.isArray(words) ? words : [],
    updatedAt: childDoc?.updatedAt ?? null,
  };
}

export {
  buildChildOutcomeReport,
  buildPopulationAutoSuggestionRateSeries,
  buildPopulationSummary,
  computeOutcomeMetrics,
  formatDateKey,
  formatSignedPercent,
  getDailyAutoSuggestionRateSeries,
  getDailySentenceSeries,
  normalizeChildSnapshot,
  normalizeSentenceEvents,
  recentDayKeys,
  toDateLike,
};
