import React, { useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ROLES } from "../constants/roles";
import { db } from "../firebase";
import {
  buildChildOutcomeReport,
  getDailyAutoSuggestionRateSeries,
  buildPopulationSummary,
  computeOutcomeMetrics,
  normalizeChildSnapshot,
} from "../lib/outcomeMetrics";

const THERAPY_VOCAB_SETS = [
  {
    id: "core-expansion",
    label: "Core Expansion",
    description: "High-frequency core words for sentence growth.",
    words: [
      { text: "go", emoji: "->", category: "actions", subBoard: "verbs" },
      { text: "play", emoji: "[]", category: "actions", subBoard: "activities" },
      { text: "finish", emoji: "[]", category: "actions", subBoard: "verbs" },
      { text: "more", emoji: "+", category: "core", subBoard: "requests" },
      { text: "different", emoji: "<>", category: "core", subBoard: "responses" },
    ],
  },
  {
    id: "needs-and-safety",
    label: "Needs and Safety",
    description: "Daily support and regulation vocabulary.",
    words: [
      { text: "bathroom", emoji: "WC", category: "needs", subBoard: "support" },
      { text: "break", emoji: "||", category: "needs", subBoard: "support" },
      { text: "hurt", emoji: "!", category: "needs", subBoard: "support" },
      { text: "too loud", emoji: "~", category: "feelings", subBoard: "states" },
      { text: "help me", emoji: "?", category: "needs", subBoard: "support" },
    ],
  },
  {
    id: "social-language",
    label: "Social Language",
    description: "Greetings, manners, and peer interaction.",
    words: [
      { text: "hello", emoji: "o/", category: "social", subBoard: "greetings" },
      { text: "please", emoji: "*", category: "social", subBoard: "manners" },
      { text: "thank you", emoji: "*", category: "social", subBoard: "manners" },
      { text: "my turn", emoji: "1", category: "social", subBoard: "play" },
      { text: "your turn", emoji: "2", category: "social", subBoard: "play" },
    ],
  },
];

function normalizeToken(text) {
  return String(text ?? "").trim().toLowerCase();
}

function tokenizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePackWord(word) {
  const text = String(word?.text ?? "").trim();
  if (!text) return null;

  const category = String(word?.category ?? "custom")
    .trim()
    .toLowerCase();
  const subBoard = String(word?.subBoard ?? "general")
    .trim()
    .toLowerCase();

  return {
    text,
    emoji: String(word?.emoji ?? "[]").trim() || "[]",
    category: category || "custom",
    subBoard: subBoard || "general",
  };
}

function wordKey(word) {
  return `${normalizeToken(word?.text)}::${normalizeToken(word?.category)}::${normalizeToken(word?.subBoard)}`;
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recentDayKeys(days = 14, now = new Date()) {
  const keys = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(now);
    date.setDate(now.getDate() - index);
    keys.push(formatDateKey(date));
  }
  return keys;
}

function getDateKeyOffset(offsetDays = 0, now = new Date()) {
  const date = new Date(now);
  date.setDate(now.getDate() - Number(offsetDays ?? 0));
  return formatDateKey(date);
}

function getDefaultFixedBaselineRange(periodDays = 30, now = new Date()) {
  const safePeriod = Math.max(7, Math.round(periodDays));
  return {
    startKey: getDateKeyOffset(safePeriod * 2 - 1, now),
    endKey: getDateKeyOffset(safePeriod, now),
  };
}

function getDailySentenceSeries(dailySentenceCounts = {}, days = 14, now = new Date()) {
  return recentDayKeys(days, now).map((key) => ({
    key,
    label: key.slice(5),
    count: Number(dailySentenceCounts[key] ?? 0),
  }));
}

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

function normalizeSentenceEvents(sentenceEvents = [], sentenceHistory = []) {
  const normalized = [];

  sentenceEvents.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const text = String(entry.text ?? "").trim();
    if (!text) return;
    const stamp = toDateLike(entry.ts);
    normalized.push({ text, ts: stamp ? stamp.getTime() : null });
  });

  if (normalized.length === 0) {
    sentenceHistory.forEach((entry) => {
      const text = String(entry ?? "").trim();
      if (text) normalized.push({ text, ts: null });
    });
  }

  return normalized;
}

function getDailyUniqueWordSeries(sentenceEvents = [], sentenceHistory = [], days = 14, now = new Date()) {
  const events = normalizeSentenceEvents(sentenceEvents, sentenceHistory);
  const keySet = new Set(recentDayKeys(days, now));
  const tokenSets = new Map();

  keySet.forEach((key) => tokenSets.set(key, new Set()));

  events.forEach((entry) => {
    if (!entry.ts) return;
    const date = new Date(entry.ts);
    if (Number.isNaN(date.getTime())) return;
    const dayKey = formatDateKey(date);
    if (!tokenSets.has(dayKey)) return;
    const target = tokenSets.get(dayKey);
    tokenizeText(entry.text).forEach((token) => target.add(token));
  });

  return [...tokenSets.entries()].map(([key, tokens]) => ({
    key,
    label: key.slice(5),
    count: tokens.size,
  }));
}

function getTrendDelta(series = [], windowSize = 7) {
  if (series.length < windowSize * 2) return 0;
  const values = series.map((entry) => Number(entry.count ?? 0));
  const recent = values.slice(-windowSize).reduce((sum, value) => sum + value, 0);
  const previous = values.slice(-windowSize * 2, -windowSize).reduce((sum, value) => sum + value, 0);

  if (previous <= 0) {
    if (recent <= 0) return 0;
    return 1;
  }

  return (recent - previous) / previous;
}

function formatSignedPercent(value) {
  const percent = Math.round(Number(value ?? 0) * 100);
  if (percent > 0) return `+${percent}%`;
  if (percent < 0) return `${percent}%`;
  return "0%";
}

function formatCompactNumber(value, decimals = 2) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0";
  return parsed.toFixed(decimals);
}

function toCsv(rows = []) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const safe = String(cell ?? "");
          if (safe.includes(",") || safe.includes("\n") || safe.includes('"')) {
            return `"${safe.replace(/"/g, '""')}"`;
          }
          return safe;
        })
        .join(",")
    )
    .join("\n");
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

function buildTherapistSuggestions(
  usageCounts = {},
  sentenceEvents = [],
  dailySentenceCounts = {},
  now = new Date()
) {
  const entries = Object.entries(usageCounts).sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0));
  const total = entries.reduce((sum, [, count]) => sum + Number(count ?? 0), 0);
  const topWord = entries[0];
  const suggestions = [];

  if (topWord && total > 10) {
    const topShare = Number(topWord[1] ?? 0) / Math.max(1, total);
    if (topShare >= 0.35) {
      suggestions.push(`High reliance on "${topWord[0]}" (${Math.round(topShare * 100)}% of taps). Model alternatives in the same category.`);
    }
  }

  if (entries.length < 12 && total > 20) {
    suggestions.push("Low active vocabulary variety. Assign one starter vocabulary set and target 3 new words this week.");
  }

  if (topWord?.[0] === "want") {
    suggestions.push('"want" is dominant. Introduce action verbs (go, play, stop, rest, help) to expand intent expression.');
  }

  const dailySeries = getDailySentenceSeries(dailySentenceCounts, 14, now);
  const sentenceTrend = getTrendDelta(dailySeries, 7);
  if (sentenceTrend > 0.2) {
    suggestions.push(`Sentence output is improving (${formatSignedPercent(sentenceTrend)} vs prior week). Raise daily goal gradually.`);
  } else if (sentenceTrend < -0.2) {
    suggestions.push(`Sentence output dropped (${formatSignedPercent(sentenceTrend)}). Reduce board complexity and prioritize core intents.`);
  }

  const uniqueSeries = getDailyUniqueWordSeries(sentenceEvents, [], 14, now);
  const uniqueTrend = getTrendDelta(uniqueSeries, 7);
  if (uniqueTrend < -0.2) {
    suggestions.push("Lexical diversity is trending down. Add category drills with high-interest words.");
  }

  if (suggestions.length === 0) {
    suggestions.push("Usage balance looks healthy. Continue category expansion and phrase automation.");
  }

  return suggestions.slice(0, 6);
}

export default function TherapistPage() {
  const { roles, signOut, hasAnyRole, user, profile } = useAuth();
  const [parentUid, setParentUid] = useState("");
  const [childId, setChildId] = useState("");
  const [childData, setChildData] = useState(null);
  const [caseloadChildren, setCaseloadChildren] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingCaseload, setLoadingCaseload] = useState(false);
  const [savingGoal, setSavingGoal] = useState(false);
  const [assigningSetId, setAssigningSetId] = useState("");
  const [assignmentMessage, setAssignmentMessage] = useState("");
  const [error, setError] = useState("");
  const [goalInput, setGoalInput] = useState("8");
  const [reportRange, setReportRange] = useState("monthly");
  const [anchorDateKey, setAnchorDateKey] = useState(() => getDateKeyOffset(0));
  const [baselineMode, setBaselineMode] = useState("rolling");
  const [baselineStartKey, setBaselineStartKey] = useState(() => getDefaultFixedBaselineRange(30).startKey);
  const [baselineEndKey, setBaselineEndKey] = useState(() => getDefaultFixedBaselineRange(30).endKey);
  const reportPeriodDays = reportRange === "weekly" ? 7 : 30;
  const chartDays = reportPeriodDays === 7 ? 14 : 30;
  const reportRangeLabel = reportRange === "weekly" ? "Weekly (7 days)" : "Monthly (30 days)";
  const reportNow = useMemo(() => {
    const isDateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(anchorDateKey ?? ""));
    if (!isDateKey) return new Date();
    const parsed = new Date(`${anchorDateKey}T12:00:00`);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }, [anchorDateKey]);
  const reportAnchorLabel = formatDateKey(reportNow);
  const normalizedFixedBaseline = useMemo(() => {
    const fallback = getDefaultFixedBaselineRange(reportPeriodDays, reportNow);
    const isDateKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
    let start = isDateKey(baselineStartKey) ? String(baselineStartKey) : fallback.startKey;
    let end = isDateKey(baselineEndKey) ? String(baselineEndKey) : fallback.endKey;
    if (start > end) {
      const temp = start;
      start = end;
      end = temp;
    }
    return {
      startKey: start,
      endKey: end,
    };
  }, [baselineStartKey, baselineEndKey, reportPeriodDays, reportNow]);
  const baselineSummaryLabel =
    baselineMode === "fixed"
      ? `Fixed baseline: ${normalizedFixedBaseline.startKey} to ${normalizedFixedBaseline.endKey}`
      : "Rolling baseline: previous period";
  const baselineOptions = useMemo(
    () => ({
      baselineMode,
      baselineStartKey: normalizedFixedBaseline.startKey,
      baselineEndKey: normalizedFixedBaseline.endKey,
      now: reportNow,
    }),
    [baselineMode, normalizedFixedBaseline, reportNow]
  );

  const outcomeMetrics = useMemo(
    () => (childData ? computeOutcomeMetrics(childData, reportPeriodDays, baselineOptions) : null),
    [childData, reportPeriodDays, baselineOptions]
  );
  const activeUsageCounts = childData?.model?.wordFrequency ?? childData?.smartModel?.usageCounts ?? {};
  const activeSentenceEvents = childData?.model?.sentenceEvents ?? childData?.smartModel?.sentenceEvents ?? [];
  const activeSentenceHistory = childData?.model?.sentenceHistory ?? childData?.smartModel?.sentenceHistory ?? [];
  const activeAutoSentenceLearning =
    childData?.model?.autoSentenceLearning ?? childData?.smartModel?.autoSentenceLearning ?? {};

  const dailySentenceSeries = useMemo(
    () => getDailySentenceSeries(childData?.preferences?.dailySentenceCounts ?? {}, chartDays, reportNow),
    [childData, chartDays, reportNow]
  );

  const uniqueWordSeries = useMemo(
    () =>
      getDailyUniqueWordSeries(
        activeSentenceEvents,
        activeSentenceHistory,
        chartDays,
        reportNow
      ),
    [activeSentenceEvents, activeSentenceHistory, chartDays, reportNow]
  );

  const autoQualitySeries = useMemo(
    () => getDailyAutoSuggestionRateSeries(activeAutoSentenceLearning, chartDays, reportNow),
    [activeAutoSentenceLearning, chartDays, reportNow]
  );

  const recommendations = useMemo(
    () =>
      buildTherapistSuggestions(
        activeUsageCounts,
        activeSentenceEvents,
        childData?.preferences?.dailySentenceCounts ?? {},
        reportNow
      ),
    [activeUsageCounts, activeSentenceEvents, childData, reportNow]
  );

  const sentenceTrendDelta = useMemo(() => getTrendDelta(dailySentenceSeries, 7), [dailySentenceSeries]);
  const uniqueTrendDelta = useMemo(() => getTrendDelta(uniqueWordSeries, 7), [uniqueWordSeries]);
  const autoQualityTotals = useMemo(
    () =>
      autoQualitySeries.reduce(
        (acc, entry) => {
          acc.shown += Number(entry.shown ?? 0);
          acc.accepted += Number(entry.accepted ?? 0);
          acc.ignored += Number(entry.ignored ?? 0);
          return acc;
        },
        { shown: 0, accepted: 0, ignored: 0 }
      ),
    [autoQualitySeries]
  );
  const autoAcceptRateAvg = autoQualityTotals.shown > 0 ? autoQualityTotals.accepted / autoQualityTotals.shown : 0;
  const autoIgnoreRateAvg = autoQualityTotals.shown > 0 ? autoQualityTotals.ignored / autoQualityTotals.shown : 0;

  const totalWordTaps = Object.values(activeUsageCounts).reduce(
    (sum, count) => sum + Number(count ?? 0),
    0
  );

  const topWords = Object.entries(activeUsageCounts)
    .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
    .slice(0, 8);

  const sentenceSamples = activeSentenceHistory.slice(-8).reverse();

  const recentSentenceTotal = dailySentenceSeries.slice(-7).reduce((sum, entry) => sum + entry.count, 0);
  const previousSentenceTotal = dailySentenceSeries.slice(-14, -7).reduce((sum, entry) => sum + entry.count, 0);
  const recentUniqueTotal = uniqueWordSeries.slice(-7).reduce((sum, entry) => sum + entry.count, 0);

  const progressStories = useMemo(() => {
    if (!childData) return [];

    const stories = [];
    const childName = childData.name || "This child";

    stories.push(`${childName} produced ${recentSentenceTotal} sentences in the last 7 days.`);

    if (previousSentenceTotal > 0) {
      const lift = (recentSentenceTotal - previousSentenceTotal) / previousSentenceTotal;
      if (lift > 0) {
        stories.push(`Sentence output improved ${Math.round(lift * 100)}% compared with the previous week.`);
      } else if (lift < 0) {
        stories.push(`Sentence output is down ${Math.round(Math.abs(lift) * 100)}% week-over-week; simplify boards and reinforce core intents.`);
      }
    }

    if (recentUniqueTotal > 0) {
      stories.push(`Used ${recentUniqueTotal} unique word-events this week, signaling active exploration.`);
    }

    if (topWords.length > 0) {
      stories.push(`Most-used token is "${topWords[0][0]}" (${topWords[0][1]} taps). This should guide targeted expansion.`);
    }

    return stories.slice(0, 4);
  }, [childData, previousSentenceTotal, recentSentenceTotal, recentUniqueTotal, topWords]);

  const beforeAfterRows = useMemo(() => {
    const outcomes = outcomeMetrics ?? {};
    return [
      {
        key: "attempts",
        label: "Communication attempts/day",
        baseline: Number(outcomes.previousAttemptsPerDay ?? 0),
        current: Number(outcomes.recentAttemptsPerDay ?? 0),
        delta: Number(outcomes.attemptsPerDayDelta ?? 0),
        unit: "",
        decimals: 2,
        better: "higher",
      },
      {
        key: "vocab",
        label: "Unique vocabulary",
        baseline: Number(outcomes.uniqueVocabularyPrevious ?? 0),
        current: Number(outcomes.uniqueVocabularyRecent ?? 0),
        delta: Number(outcomes.uniqueVocabularyDelta ?? 0),
        unit: " words",
        decimals: 0,
        better: "higher",
      },
      {
        key: "sentence_length",
        label: "Average sentence length",
        baseline: Number(outcomes.avgSentenceLengthPrevious ?? 0),
        current: Number(outcomes.avgSentenceLengthRecent ?? 0),
        delta: Number(outcomes.avgSentenceLengthDelta ?? 0),
        unit: " words",
        decimals: 1,
        better: "higher",
      },
      {
        key: "time_to_communicate",
        label: "Time to communicate",
        baseline: Number(outcomes.avgTimeToCommunicatePreviousMs ?? 0) / 1000,
        current: Number(outcomes.avgTimeToCommunicateRecentMs ?? 0) / 1000,
        delta: Number(outcomes.timeToCommunicateDelta ?? 0),
        unit: "s",
        decimals: 2,
        better: "lower",
      },
    ];
  }, [outcomeMetrics]);

  const reportPayload = useMemo(() => {
    if (!childData) return null;
    const childOutcomes = outcomeMetrics ?? computeOutcomeMetrics(childData, reportPeriodDays, baselineOptions);

    return {
      generatedAt: new Date().toISOString(),
      therapist: {
        uid: user?.uid ?? "",
        name: profile?.displayName || user?.displayName || "",
        email: user?.email || "",
      },
      child: {
        parentUid: childData.parentUid,
        childId: childData.childId,
        name: childData.name,
        goal: childOutcomes.dailyGoal,
      },
      reportConfig: {
        periodDays: reportPeriodDays,
        anchorDate: reportAnchorLabel,
        baselineMode,
        baselineStartKey: childOutcomes.baselineStartKey,
        baselineEndKey: childOutcomes.baselineEndKey,
      },
      metrics: {
        baselineMode: childOutcomes.baselineMode,
        baselineStartKey: childOutcomes.baselineStartKey,
        baselineEndKey: childOutcomes.baselineEndKey,
        totalWordTaps,
        uniqueWords: Object.keys(activeUsageCounts).length,
        recentSentenceTotal,
        previousSentenceTotal,
        sentenceTrendDelta,
        uniqueTrendDelta,
        attemptsPerDay: childOutcomes.recentAttemptsPerDay,
        attemptsPerDayDelta: childOutcomes.attemptsPerDayDelta,
        newWordsInPeriod: childOutcomes.newWordsInPeriod,
        avgSentenceLength: childOutcomes.avgSentenceLengthRecent,
        avgTimeToCommunicateMs: childOutcomes.avgTimeToCommunicateRecentMs,
        suggestionAcceptanceRate: childOutcomes.suggestionAcceptanceRate,
        suggestionIgnoreRate: childOutcomes.suggestionIgnoreRate,
        highRisk: childOutcomes.highRisk,
        riskFlags: childOutcomes.riskFlags,
      },
      beforeAfter: beforeAfterRows,
      outcomeSummary: buildChildOutcomeReport({
        childName: childData.name,
        periodDays: reportPeriodDays,
        outcomes: childOutcomes,
      }),
      topWords,
      recommendations,
      progressStories,
      trends: {
        dailySentences: dailySentenceSeries,
        dailyUniqueWords: uniqueWordSeries,
        autoSuggestionQuality: autoQualitySeries,
      },
      therapyAssignments: childData.therapyAssignments ?? [],
    };
  }, [
    childData,
    dailySentenceSeries,
    outcomeMetrics,
    reportPeriodDays,
    baselineOptions,
    uniqueTrendDelta,
    recommendations,
    sentenceTrendDelta,
    progressStories,
    beforeAfterRows,
    recentSentenceTotal,
    previousSentenceTotal,
    topWords,
    totalWordTaps,
    activeUsageCounts,
    autoQualitySeries,
    uniqueWordSeries,
    user,
    profile,
    baselineMode,
  ]);

  const caseloadMetrics = useMemo(
    () =>
      caseloadChildren.map((entry) => ({
        ...entry,
        outcomes: computeOutcomeMetrics(entry, reportPeriodDays, baselineOptions),
      })),
    [caseloadChildren, reportPeriodDays, baselineOptions]
  );

  const caseloadSummary = useMemo(
    () => buildPopulationSummary(caseloadMetrics),
    [caseloadMetrics]
  );

  function resetFixedBaselineRange() {
    const defaults = getDefaultFixedBaselineRange(reportPeriodDays, reportNow);
    setBaselineStartKey(defaults.startKey);
    setBaselineEndKey(defaults.endKey);
  }

  async function loadParentCaseload() {
    setError("");
    setAssignmentMessage("");
    const safeParentUid = String(parentUid).trim();
    const safeChildId = String(childId).trim();

    if (!safeParentUid) {
      setError("Parent UID is required.");
      return;
    }

    setLoadingCaseload(true);
    try {
      const childrenSnapshot = await getDocs(collection(db, "users", safeParentUid, "children"));
      let childDocs = childrenSnapshot.docs;
      if (safeChildId) {
        childDocs = childDocs.filter((entry) => entry.id === safeChildId);
      }

      const children = await Promise.all(
        childDocs.map(async (entry) => {
          const wordsSnapshot = await getDocs(
            collection(db, "users", safeParentUid, "children", entry.id, "words")
          );
          return normalizeChildSnapshot(
            safeParentUid,
            entry.id,
            entry.data() ?? {},
            wordsSnapshot.docs.map((wordDoc) => wordDoc.data())
          );
        })
      );

      setCaseloadChildren(children);
      if (children.length > 0) {
        setChildData(children[0]);
        setGoalInput(String(children[0]?.goals?.dailyTarget ?? children[0]?.preferences?.dailySentenceGoal ?? 8));
      } else {
        setChildData(null);
        setError("No child records found for this parent UID.");
      }
    } catch (loadError) {
      console.error("Failed to load parent caseload:", loadError);
      setError(loadError.message || "Unable to load caseload.");
    } finally {
      setLoadingCaseload(false);
    }
  }

  async function loadChildWorkspace() {
    setError("");
    setAssignmentMessage("");
    const safeParentUid = String(parentUid).trim();
    const safeChildId = String(childId).trim();

    if (!safeParentUid || !safeChildId) {
      setError("Parent UID and Child ID are required.");
      return;
    }

    setLoading(true);
    try {
      const childRef = doc(db, "users", safeParentUid, "children", safeChildId);
      const childSnapshot = await getDoc(childRef);

      if (!childSnapshot.exists()) {
        setChildData(null);
        setError("Child profile not found.");
        return;
      }

      const childDocData = childSnapshot.data();
      const wordsSnapshot = await getDocs(collection(db, "users", safeParentUid, "children", safeChildId, "words"));
      const words = wordsSnapshot.docs.map((entry) => entry.data());

      const nextData = normalizeChildSnapshot(
        safeParentUid,
        safeChildId,
        childDocData ?? {},
        words
      );

      setChildData(nextData);
      setCaseloadChildren([nextData]);
      setGoalInput(String(nextData.preferences?.dailySentenceGoal ?? 8));
    } catch (loadError) {
      console.error("Failed to load therapist workspace data:", loadError);
      setError(loadError.message || "Unable to load child workspace.");
    } finally {
      setLoading(false);
    }
  }

  async function assignGoal() {
    if (!childData) return;

    const parsedGoal = Number.parseInt(goalInput, 10);
    if (!Number.isInteger(parsedGoal) || parsedGoal <= 0 || parsedGoal > 200) {
      setError("Goal must be a whole number between 1 and 200.");
      return;
    }

    setSavingGoal(true);
    setError("");
    setAssignmentMessage("");
    try {
      await setDoc(
        doc(db, "users", childData.parentUid, "children", childData.childId),
        {
          preferences: {
            ...(childData.preferences ?? {}),
            dailySentenceGoal: parsedGoal,
          },
          goals: {
            ...(childData.goals ?? {}),
            dailyTarget: parsedGoal,
          },
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setChildData((previous) =>
        previous
          ? {
              ...previous,
              preferences: {
                ...(previous.preferences ?? {}),
                dailySentenceGoal: parsedGoal,
              },
              goals: {
                ...(previous.goals ?? {}),
                dailyTarget: parsedGoal,
              },
              updatedAt: new Date(),
            }
          : previous
      );
      setCaseloadChildren((previous) =>
        previous.map((entry) =>
          entry.childId === childData.childId
            ? {
                ...entry,
                preferences: {
                  ...(entry.preferences ?? {}),
                  dailySentenceGoal: parsedGoal,
                },
                goals: {
                  ...(entry.goals ?? {}),
                  dailyTarget: parsedGoal,
                },
              }
            : entry
        )
      );
      setAssignmentMessage(`Goal updated to ${parsedGoal} sentences/day.`);
    } catch (saveError) {
      console.error("Failed to assign therapist goal:", saveError);
      setError(saveError.message || "Unable to update goal.");
    } finally {
      setSavingGoal(false);
    }
  }

  async function assignVocabularySet(setId) {
    if (!childData) return;

    const selectedSet = THERAPY_VOCAB_SETS.find((entry) => entry.id === setId);
    if (!selectedSet) return;

    setAssigningSetId(setId);
    setError("");
    setAssignmentMessage("");

    try {
      const normalizedPackWords = selectedSet.words
        .map((word) => normalizePackWord(word))
        .filter(Boolean);

      const existingKeys = new Set((childData.words ?? []).map((word) => wordKey(word)));
      const newWords = normalizedPackWords.filter((word) => !existingKeys.has(wordKey(word)));

      if (newWords.length > 0) {
        await Promise.all(
          newWords.map((word) =>
            addDoc(collection(db, "users", childData.parentUid, "children", childData.childId, "words"), {
              ...word,
              source: "therapist-pack",
              sourcePackId: selectedSet.id,
              sourcePackLabel: selectedSet.label,
              assignedAt: new Date().toISOString(),
              assignedByUid: user?.uid ?? "",
            })
          )
        );
      }

      const assignmentEntry = {
        id: `assignment-${Date.now().toString(36)}`,
        setId: selectedSet.id,
        setLabel: selectedSet.label,
        wordsAdded: newWords.length,
        assignedByUid: user?.uid ?? "",
        assignedByName: profile?.displayName || user?.displayName || user?.email || "Therapist",
        assignedAt: new Date().toISOString(),
      };

      const nextAssignments = [assignmentEntry, ...(childData.therapyAssignments ?? [])].slice(0, 30);

      await setDoc(
        doc(db, "users", childData.parentUid, "children", childData.childId),
        {
          therapyAssignments: nextAssignments,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setChildData((previous) =>
        previous
          ? {
              ...previous,
              words: [...(previous.words ?? []), ...newWords],
              therapyAssignments: nextAssignments,
              updatedAt: new Date(),
            }
          : previous
      );
      setCaseloadChildren((previous) =>
        previous.map((entry) =>
          entry.childId === childData.childId
            ? {
                ...entry,
                words: [...(entry.words ?? []), ...newWords],
                therapyAssignments: nextAssignments,
                updatedAt: new Date(),
              }
            : entry
        )
      );

      setAssignmentMessage(
        newWords.length > 0
          ? `Assigned "${selectedSet.label}". Added ${newWords.length} new words.`
          : `Assigned "${selectedSet.label}". All words already existed.`
      );
    } catch (assignError) {
      console.error("Failed to assign vocabulary set:", assignError);
      setError(assignError.message || "Unable to assign vocabulary set.");
    } finally {
      setAssigningSetId("");
    }
  }

  function exportJsonReport() {
    if (!reportPayload || !childData) return;
    downloadTextFile(
      `therapist-report-${reportRange}-${childData.childId}-${Date.now()}.json`,
      JSON.stringify(reportPayload, null, 2),
      "application/json"
    );
  }

  function exportCsvReport() {
    if (!childData) return;

    const rows = [
      [
        "date",
        "report_anchor_date",
        "sentence_count",
        "unique_words",
        "auto_shown",
        "auto_accepted",
        "auto_ignored",
        "auto_accept_rate_pct",
        "auto_ignore_rate_pct",
        "baseline_mode",
        "baseline_start",
        "baseline_end",
      ],
      ...dailySentenceSeries.map((entry, index) => [
        entry.key,
        reportAnchorLabel,
        entry.count,
        uniqueWordSeries[index]?.count ?? 0,
        autoQualitySeries[index]?.shown ?? 0,
        autoQualitySeries[index]?.accepted ?? 0,
        autoQualitySeries[index]?.ignored ?? 0,
        Math.round(Number(autoQualitySeries[index]?.acceptRate ?? 0) * 100),
        Math.round(Number(autoQualitySeries[index]?.ignoreRate ?? 0) * 100),
        outcomeMetrics?.baselineMode ?? baselineMode,
        outcomeMetrics?.baselineStartKey ?? normalizedFixedBaseline.startKey,
        outcomeMetrics?.baselineEndKey ?? normalizedFixedBaseline.endKey,
      ]),
    ];

    downloadTextFile(
      `therapist-trend-${reportRange}-${childData.childId}-${Date.now()}.csv`,
      `${toCsv(rows)}\n`,
      "text/csv;charset=utf-8"
    );
  }

  function exportOutcomeReport() {
    if (!childData) return;
    const outcomes = outcomeMetrics ?? computeOutcomeMetrics(childData, reportPeriodDays, baselineOptions);
    const reportText = buildChildOutcomeReport({
      childName: childData.name,
      periodDays: reportPeriodDays,
      outcomes,
    });
    const comparisonLines = beforeAfterRows.map((row) => {
      const baseline = formatCompactNumber(row.baseline, row.decimals);
      const current = formatCompactNumber(row.current, row.decimals);
      return `- ${row.label}: ${baseline}${row.unit} -> ${current}${row.unit} (${formatSignedPercent(row.delta)})`;
    });
    const lines = [
      `Report anchor date: ${reportAnchorLabel}`,
      `Baseline configuration: ${baselineSummaryLabel}`,
      "",
      reportText,
      "",
      "Baseline vs current:",
      ...comparisonLines,
    ];
    downloadTextFile(
      `outcome-report-${reportRange}-${childData.childId}-${Date.now()}.txt`,
      `${lines.join("\n")}\n`,
      "text/plain;charset=utf-8"
    );
  }

  function exportPdfReport() {
    if (!childData) return;
    const outcomes = outcomeMetrics ?? computeOutcomeMetrics(childData, reportPeriodDays, baselineOptions);
    const reportText = buildChildOutcomeReport({
      childName: childData.name,
      periodDays: reportPeriodDays,
      outcomes,
    });
    const comparisonLines = beforeAfterRows.map((row) => {
      const baseline = formatCompactNumber(row.baseline, row.decimals);
      const current = formatCompactNumber(row.current, row.decimals);
      return `- ${row.label}: ${baseline}${row.unit} -> ${current}${row.unit} (${formatSignedPercent(row.delta)})`;
    });
    const printLines = [reportText, "", "Baseline vs current:", ...comparisonLines];
    const printWindow = window.open("", "_blank", "noopener,noreferrer,width=900,height=700");
    if (!printWindow) return;

    const escaped = printLines
      .join("\n")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    printWindow.document.write(`
      <html>
        <head>
          <title>Titonova NeuroVoice Outcome Report</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; padding: 24px; color: #1f3557; }
            h1 { margin: 0 0 6px; }
            .meta { color: #4b607f; margin-bottom: 16px; }
            pre { white-space: pre-wrap; font-size: 14px; line-height: 1.5; background: #f7f9ff; border: 1px solid #d4deef; border-radius: 10px; padding: 12px; }
          </style>
        </head>
        <body>
          <h1>Titonova NeuroVoice Outcome Report</h1>
          <div class="meta">${childData.name} • ${reportRangeLabel} • Report anchor: ${reportAnchorLabel} • ${baselineSummaryLabel}</div>
          <pre>${escaped}</pre>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    window.setTimeout(() => {
      printWindow.print();
    }, 150);
  }

  function exportCaseloadCsv() {
    if (caseloadMetrics.length === 0) return;
    const rows = [
      [
        "parent_uid",
        "child_id",
        "child_name",
        "report_anchor_date",
        "baseline_attempts_per_day",
        "attempts_per_day",
        "attempts_delta_pct",
        "baseline_unique_words",
        "new_words",
        "current_unique_words",
        "baseline_avg_sentence_length",
        "avg_sentence_length",
        "baseline_time_to_communicate_seconds",
        "avg_time_to_communicate_seconds",
        "baseline_mode",
        "baseline_start",
        "baseline_end",
        "high_risk",
      ],
      ...caseloadMetrics.map((entry) => [
        entry.parentUid,
        entry.childId,
        entry.name,
        reportAnchorLabel,
        entry.outcomes.previousAttemptsPerDay.toFixed(2),
        entry.outcomes.recentAttemptsPerDay.toFixed(2),
        Math.round(entry.outcomes.attemptsPerDayDelta * 100),
        entry.outcomes.uniqueVocabularyPrevious,
        entry.outcomes.newWordsInPeriod,
        entry.outcomes.uniqueVocabularyRecent,
        entry.outcomes.avgSentenceLengthPrevious.toFixed(2),
        entry.outcomes.avgSentenceLengthRecent.toFixed(2),
        (entry.outcomes.avgTimeToCommunicatePreviousMs / 1000).toFixed(2),
        (entry.outcomes.avgTimeToCommunicateRecentMs / 1000).toFixed(2),
        entry.outcomes.baselineMode ?? baselineMode,
        entry.outcomes.baselineStartKey ?? "",
        entry.outcomes.baselineEndKey ?? "",
        entry.outcomes.highRisk ? "yes" : "no",
      ]),
    ];

    downloadTextFile(
      `therapist-caseload-${Date.now()}.csv`,
      `${toCsv(rows)}\n`,
      "text/csv;charset=utf-8"
    );
  }

  const maxSentenceCount = Math.max(1, ...dailySentenceSeries.map((entry) => entry.count));
  const maxUniqueCount = Math.max(1, ...uniqueWordSeries.map((entry) => entry.count));
  const updatedAtDate = toDateLike(childData?.updatedAt);

  return (
    <div style={pageStyle}>
      <h1 style={titleStyle}>Therapist Workspace</h1>
      <p style={subtitleStyle}>Review child progress remotely, assign vocabulary sets, and export session-ready reports.</p>
      <p style={rolesStyle}>Current roles: {roles.join(", ") || ROLES.THERAPIST}</p>

      <div style={navRowStyle}>
        <Link to="/app" style={linkStyle}>Go to Titonova NeuroVoice</Link>
        {hasAnyRole([ROLES.ADMIN]) ? (
          <Link to="/admin" style={linkStyle}>
            Go to admin
          </Link>
        ) : null}
        <button onClick={signOut} style={buttonStyle}>
          Sign out
        </button>
      </div>

      <section style={panelStyle}>
        <h2 style={panelHeadingStyle}>Remote child access</h2>
        <div style={exportRowStyle}>
          <span style={metricLabelStyle}>Report range</span>
          <label style={inlineLabelStyle}>
            Report anchor date
            <input
              type="date"
              value={reportAnchorLabel}
              onChange={(event) => setAnchorDateKey(event.target.value)}
              style={inlineInputStyle}
            />
          </label>
          <button
            onClick={() => setReportRange("weekly")}
            style={reportRange === "weekly" ? activeButtonStyle : buttonStyle}
          >
            Weekly
          </button>
          <button
            onClick={() => setReportRange("monthly")}
            style={reportRange === "monthly" ? activeButtonStyle : buttonStyle}
          >
            Monthly
          </button>
          <span style={metricLabelStyle}>Baseline</span>
          <button
            onClick={() => setBaselineMode("rolling")}
            style={baselineMode === "rolling" ? activeButtonStyle : buttonStyle}
          >
            Rolling
          </button>
          <button
            onClick={() => setBaselineMode("fixed")}
            style={baselineMode === "fixed" ? activeButtonStyle : buttonStyle}
          >
            Fixed
          </button>
          {baselineMode === "fixed" ? (
            <button onClick={resetFixedBaselineRange} style={buttonStyle}>
              Reset Baseline
            </button>
          ) : null}
        </div>
        {baselineMode === "fixed" ? (
          <div style={baselineDateRowStyle}>
            <label style={labelStyle}>
              Baseline start
              <input
                type="date"
                value={normalizedFixedBaseline.startKey}
                onChange={(event) => setBaselineStartKey(event.target.value)}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              Baseline end
              <input
                type="date"
                value={normalizedFixedBaseline.endKey}
                onChange={(event) => setBaselineEndKey(event.target.value)}
                style={inputStyle}
              />
            </label>
          </div>
        ) : null}
        <p style={metadataStyle}>Report anchor: {reportAnchorLabel} | Baseline configuration: {baselineSummaryLabel}</p>
        <div style={inputGridStyle}>
          <label style={labelStyle}>
            Parent UID
            <input
              type="text"
              value={parentUid}
              onChange={(event) => setParentUid(event.target.value)}
              placeholder="Paste parent UID"
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Child ID
            <input
              type="text"
              value={childId}
              onChange={(event) => setChildId(event.target.value)}
              placeholder="Paste child profile ID"
              style={inputStyle}
            />
          </label>
          <button onClick={loadChildWorkspace} style={buttonStyle} disabled={loading}>
            {loading ? "Loading..." : "Load Child Data"}
          </button>
          <button onClick={loadParentCaseload} style={buttonStyle} disabled={loadingCaseload}>
            {loadingCaseload ? "Loading Caseload..." : "Load Parent Caseload"}
          </button>
        </div>
        {error ? <p style={errorStyle}>{error}</p> : null}
        {assignmentMessage ? <p style={successStyle}>{assignmentMessage}</p> : null}
      </section>

      {caseloadMetrics.length > 0 ? (
        <section style={panelStyle}>
          <h2 style={panelHeadingStyle}>Caseload outcomes ({reportRangeLabel})</h2>
          <p style={metadataStyle}>Report anchor: {reportAnchorLabel} | Baseline configuration: {baselineSummaryLabel}</p>
          <div style={metricGridStyle}>
            <div style={metricCardStyle}>
              <span style={metricLabelStyle}>Children</span>
              <strong style={metricValueStyle}>{caseloadSummary.childCount}</strong>
            </div>
            <div style={metricCardStyle}>
              <span style={metricLabelStyle}>Avg improvement</span>
              <strong style={metricValueStyle}>{caseloadSummary.avgImprovementPct}%</strong>
            </div>
            <div style={metricCardStyle}>
              <span style={metricLabelStyle}>Engagement</span>
              <strong style={metricValueStyle}>{caseloadSummary.engagementRatePct}%</strong>
            </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>High-risk</span>
                <strong style={metricValueStyle}>{caseloadSummary.highRiskCount}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Suggestion acceptance</span>
                <strong style={metricValueStyle}>
                  {caseloadMetrics.length > 0
                    ? `${Math.round(
                        (caseloadMetrics.reduce(
                          (sum, entry) => sum + Number(entry.outcomes.suggestionAcceptanceRate ?? 0),
                          0
                        ) /
                          caseloadMetrics.length) *
                          100
                      )}%`
                    : "0%"}
                </strong>
              </div>
            </div>
          <div style={exportRowStyle}>
            <button onClick={exportCaseloadCsv} style={buttonStyle}>
              Export Caseload CSV
            </button>
          </div>
          <div style={tableWrapperStyle}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Child</th>
                  <th style={thStyle}>Attempts/day</th>
                  <th style={thStyle}>Delta</th>
                  <th style={thStyle}>New words</th>
                  <th style={thStyle}>Avg length</th>
                  <th style={thStyle}>Avg time (s)</th>
                  <th style={thStyle}>Risk</th>
                  <th style={thStyle}>Action</th>
                </tr>
              </thead>
              <tbody>
                {caseloadMetrics.map((entry) => (
                  <tr key={`${entry.parentUid}-${entry.childId}`}>
                    <td style={tdStyle}>{entry.name}</td>
                    <td style={tdStyle}>{entry.outcomes.recentAttemptsPerDay.toFixed(2)}</td>
                    <td style={tdStyle}>{formatSignedPercent(entry.outcomes.attemptsPerDayDelta)}</td>
                    <td style={tdStyle}>{entry.outcomes.newWordsInPeriod}</td>
                    <td style={tdStyle}>{entry.outcomes.avgSentenceLengthRecent.toFixed(2)}</td>
                    <td style={tdStyle}>{(entry.outcomes.avgTimeToCommunicateRecentMs / 1000).toFixed(2)}</td>
                    <td style={tdStyle}>{entry.outcomes.highRisk ? `⚠️ ${entry.outcomes.riskFlags.join(", ")}` : "OK"}</td>
                    <td style={tdStyle}>
                      <button
                        onClick={() => {
                          setChildData(entry);
                          setGoalInput(
                            String(entry?.goals?.dailyTarget ?? entry?.preferences?.dailySentenceGoal ?? 8)
                          );
                        }}
                        style={buttonStyle}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {childData ? (
        <>
          <section style={panelStyle}>
            <h2 style={panelHeadingStyle}>Child snapshot: {childData.name}</h2>
            <div style={metricGridStyle}>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Custom words</span>
                <strong style={metricValueStyle}>{childData.words.length}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Word taps</span>
                <strong style={metricValueStyle}>{totalWordTaps}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Unique words</span>
                <strong style={metricValueStyle}>{Object.keys(activeUsageCounts).length}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Current goal</span>
                <strong style={metricValueStyle}>{outcomeMetrics?.dailyGoal ?? childData.preferences?.dailySentenceGoal ?? 8}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Attempts/day change</span>
                <strong style={metricValueStyle}>{formatSignedPercent(outcomeMetrics?.attemptsPerDayDelta ?? 0)}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>New words ({reportPeriodDays}d)</span>
                <strong style={metricValueStyle}>{Math.round(outcomeMetrics?.newWordsInPeriod ?? 0)}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Avg sentence length</span>
                <strong style={metricValueStyle}>{(outcomeMetrics?.avgSentenceLengthRecent ?? 0).toFixed(1)}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Time to communicate</span>
                <strong style={metricValueStyle}>{((outcomeMetrics?.avgTimeToCommunicateRecentMs ?? 0) / 1000).toFixed(2)}s</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Suggestion acceptance</span>
                <strong style={metricValueStyle}>{Math.round((outcomeMetrics?.suggestionAcceptanceRate ?? 0) * 100)}%</strong>
              </div>
            </div>
            <p style={metadataStyle}>
              Last child sync: {updatedAtDate ? updatedAtDate.toLocaleString() : "Unknown"}
            </p>
            <section style={comparisonSectionStyle}>
              <h3 style={comparisonHeadingStyle}>Baseline vs Current (Pilot Evidence)</h3>
              <div style={comparisonGridStyle}>
                {beforeAfterRows.map((row) => {
                  const isPositive = row.better === "lower" ? row.delta <= 0 : row.delta >= 0;
                  return (
                    <article key={row.key} style={comparisonCardStyle}>
                      <strong style={comparisonLabelStyle}>{row.label}</strong>
                      <div style={comparisonRowStyle}>
                        <span>Baseline</span>
                        <span>{formatCompactNumber(row.baseline, row.decimals)}{row.unit}</span>
                      </div>
                      <div style={comparisonRowStyle}>
                        <span>Current</span>
                        <span>{formatCompactNumber(row.current, row.decimals)}{row.unit}</span>
                      </div>
                      <span style={comparisonDeltaStyle(isPositive)}>{formatSignedPercent(row.delta)}</span>
                    </article>
                  );
                })}
              </div>
            </section>
          </section>

          <section style={panelStyle}>
            <h2 style={panelHeadingStyle}>Outcome report ({reportRangeLabel})</h2>
            <p style={metadataStyle}>Report anchor: {reportAnchorLabel} | Baseline configuration: {baselineSummaryLabel}</p>
            <pre style={reportPreStyle}>
              {buildChildOutcomeReport({
                childName: childData.name,
                periodDays: reportPeriodDays,
                outcomes: outcomeMetrics,
              })}
            </pre>
          </section>

          <section style={panelStyle}>
            <h2 style={panelHeadingStyle}>Goal and vocabulary assignment</h2>
            <div style={goalRowStyle}>
              <input
                type="number"
                min={1}
                max={200}
                value={goalInput}
                onChange={(event) => setGoalInput(event.target.value)}
                style={inputStyle}
              />
              <button onClick={assignGoal} style={buttonStyle} disabled={savingGoal}>
                {savingGoal ? "Saving..." : "Save Goal"}
              </button>
            </div>
            <div style={packGridStyle}>
              {THERAPY_VOCAB_SETS.map((entry) => (
                <article key={entry.id} style={packCardStyle}>
                  <strong>{entry.label}</strong>
                  <p style={packDescriptionStyle}>{entry.description}</p>
                  <button
                    onClick={() => assignVocabularySet(entry.id)}
                    style={buttonStyle}
                    disabled={assigningSetId === entry.id}
                  >
                    {assigningSetId === entry.id ? "Assigning..." : "Assign Set"}
                  </button>
                </article>
              ))}
            </div>
          </section>

          <section style={panelStyle}>
            <h2 style={panelHeadingStyle}>Progress over time</h2>
            <div style={chartBlockStyle}>
              <strong style={chartTitleStyle}>Daily sentence output ({chartDays} days)</strong>
              <div style={chartGridStyle(dailySentenceSeries.length)}>
                {dailySentenceSeries.map((entry) => (
                  <div key={entry.key} style={barCellStyle} title={`${entry.key}: ${entry.count} sentences`}>
                    <div
                      style={{
                        ...barStyle,
                        height: `${Math.max(6, (entry.count / maxSentenceCount) * 100)}%`,
                        background: "linear-gradient(180deg, #53a6ff, #2e6dff)",
                      }}
                    />
                    <span style={barLabelStyle}>{entry.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={chartBlockStyle}>
              <strong style={chartTitleStyle}>Daily unique words ({chartDays} days)</strong>
              <div style={chartGridStyle(uniqueWordSeries.length)}>
                {uniqueWordSeries.map((entry) => (
                  <div key={entry.key} style={barCellStyle} title={`${entry.key}: ${entry.count} unique words`}>
                    <div
                      style={{
                        ...barStyle,
                        height: `${Math.max(6, (entry.count / maxUniqueCount) * 100)}%`,
                        background: "linear-gradient(180deg, #3de4a6, #12a56c)",
                      }}
                    />
                    <span style={barLabelStyle}>{entry.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={chartBlockStyle}>
              <strong style={chartTitleStyle}>Auto suggestion quality ({chartDays} days)</strong>
              <div style={chartGridStyle(autoQualitySeries.length)}>
                {autoQualitySeries.map((entry) => {
                  const acceptPct = Math.round(Number(entry.acceptRate ?? 0) * 100);
                  const ignorePct = Math.round(Number(entry.ignoreRate ?? 0) * 100);
                  const active = Number(entry.shown ?? 0) > 0;
                  return (
                    <div
                      key={`auto-quality-${entry.key}`}
                      style={barCellStyle}
                      title={`${entry.key}: shown ${entry.shown}, accept ${acceptPct}%, ignore ${ignorePct}%`}
                    >
                      <div style={dualBarWrapStyle}>
                        <div
                          style={{
                            ...dualRateBarStyle,
                            height: `${Math.max(active ? 6 : 0, acceptPct)}%`,
                            background: "linear-gradient(180deg, #3de4a6, #12a56c)",
                          }}
                        />
                        <div
                          style={{
                            ...dualRateBarStyle,
                            height: `${Math.max(active ? 6 : 0, ignorePct)}%`,
                            background: "linear-gradient(180deg, #ff9a9a, #d44b4b)",
                          }}
                        />
                      </div>
                      <span style={barLabelStyle}>{entry.label}</span>
                    </div>
                  );
                })}
              </div>
              <p style={metadataStyle}>
                Avg accept: {Math.round(autoAcceptRateAvg * 100)}% | Avg ignore: {Math.round(autoIgnoreRateAvg * 100)}% | Total shown: {Math.round(autoQualityTotals.shown)}
              </p>
            </div>

            <div>
              <strong>Progress stories</strong>
              <ul style={listStyle}>
                {progressStories.map((entry, index) => (
                  <li key={`${entry}-${index}`}>{entry}</li>
                ))}
              </ul>
            </div>
          </section>

          <section style={panelStyle}>
            <h2 style={panelHeadingStyle}>Therapist recommendations</h2>
            <ul style={listStyle}>
              {recommendations.map((entry, index) => (
                <li key={`${entry}-${index}`}>{entry}</li>
              ))}
            </ul>
          </section>

          <section style={panelStyle}>
            <h2 style={panelHeadingStyle}>Top words and sentence samples</h2>
            <div style={twoColStyle}>
              <div>
                <strong>Top words</strong>
                <ul style={listStyle}>
                  {topWords.map(([word, count]) => (
                    <li key={word}>
                      {word}: {count}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>Recent sentence samples</strong>
                <ul style={listStyle}>
                  {sentenceSamples.map((entry, index) => (
                    <li key={`${entry}-${index}`}>{entry}</li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          <section style={panelStyle}>
            <h2 style={panelHeadingStyle}>Assignment history</h2>
            <ul style={listStyle}>
              {(childData.therapyAssignments ?? []).slice(0, 8).map((entry) => {
                const assignedDate = toDateLike(entry.assignedAt);
                return (
                  <li key={entry.id || `${entry.setId}-${entry.assignedAt}`}>
                    {entry.setLabel || entry.setId} - {entry.wordsAdded ?? 0} words ({assignedDate ? assignedDate.toLocaleString() : "Unknown date"})
                  </li>
                );
              })}
              {(childData.therapyAssignments ?? []).length === 0 ? <li>No assignments yet.</li> : null}
            </ul>
          </section>

          <section style={panelStyle}>
            <h2 style={panelHeadingStyle}>Export reports</h2>
            <div style={exportRowStyle}>
              <button onClick={exportJsonReport} style={buttonStyle}>
                Export JSON report
              </button>
              <button onClick={exportCsvReport} style={buttonStyle}>
                Export CSV trends
              </button>
              <button onClick={exportOutcomeReport} style={buttonStyle}>
                Export outcome summary
              </button>
              <button onClick={exportPdfReport} style={buttonStyle}>
                Download PDF (Print)
              </button>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

const pageStyle = {
  maxWidth: 980,
  margin: "40px auto",
  padding: 24,
};

const titleStyle = {
  marginBottom: 8,
};

const subtitleStyle = {
  marginTop: 0,
  marginBottom: 8,
  color: "#364660",
};

const rolesStyle = {
  marginTop: 0,
  color: "#4c5d7f",
};

const navRowStyle = {
  display: "flex",
  gap: 10,
  marginBottom: 16,
  flexWrap: "wrap",
};

const linkStyle = {
  padding: "8px 12px",
  border: "1px solid #bfcae2",
  borderRadius: 8,
  textDecoration: "none",
  background: "#f8fbff",
  color: "#203355",
};

const panelStyle = {
  border: "1px solid #d6deea",
  borderRadius: 12,
  padding: 14,
  marginBottom: 12,
  background: "#fff",
};

const panelHeadingStyle = {
  marginTop: 0,
  marginBottom: 10,
};

const inputGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 10,
  alignItems: "end",
};

const baselineDateRowStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 10,
  marginBottom: 6,
};

const labelStyle = {
  display: "grid",
  gap: 6,
  fontWeight: 600,
};

const inputStyle = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #c7d0df",
};

const buttonStyle = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #b9c6dc",
  background: "#f3f7ff",
  cursor: "pointer",
};

const activeButtonStyle = {
  ...buttonStyle,
  border: "1px solid #508de4",
  background: "#dce9ff",
  color: "#173866",
};

const metricGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 10,
};

const metricCardStyle = {
  border: "1px solid #d4dceb",
  borderRadius: 10,
  padding: 10,
  background: "#f7f9ff",
};

const metricLabelStyle = {
  display: "block",
  fontSize: 12,
  color: "#4e5f79",
  textTransform: "uppercase",
};

const metricValueStyle = {
  fontSize: 24,
  lineHeight: 1.1,
};

const metadataStyle = {
  marginBottom: 0,
  marginTop: 10,
  color: "#51627f",
};

const goalRowStyle = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  marginBottom: 14,
};

const packGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 10,
};

const packCardStyle = {
  border: "1px solid #d3dcf0",
  borderRadius: 10,
  padding: 10,
  background: "#f8faff",
  display: "grid",
  gap: 8,
};

const packDescriptionStyle = {
  margin: 0,
  color: "#4d5f7b",
  fontSize: 14,
};

const chartBlockStyle = {
  marginBottom: 16,
};

const chartTitleStyle = {
  display: "block",
  marginBottom: 8,
};

const chartGridStyle = (dayCount = 14) => ({
  display: "grid",
  gridTemplateColumns: `repeat(${Math.max(7, Math.min(31, Number(dayCount ?? 14)))}, minmax(20px, 1fr))`,
  gap: 6,
  alignItems: "end",
  minHeight: 130,
  padding: "8px 6px",
  borderRadius: 10,
  background: "#f7f9ff",
  border: "1px solid #d5ddee",
});

const barCellStyle = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "flex-end",
  minHeight: 110,
  gap: 6,
};

const barStyle = {
  width: "100%",
  borderRadius: 6,
  transition: "height 180ms ease",
};

const dualBarWrapStyle = {
  width: "100%",
  height: "100%",
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 3,
  alignItems: "end",
};

const dualRateBarStyle = {
  width: "100%",
  borderRadius: 6,
  transition: "height 180ms ease",
};

const barLabelStyle = {
  fontSize: 10,
  color: "#5b6a85",
};

const comparisonSectionStyle = {
  marginTop: 10,
  marginBottom: 10,
};

const comparisonHeadingStyle = {
  marginTop: 0,
  marginBottom: 8,
  fontSize: 15,
  color: "#2a3f60",
};

const comparisonGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: 10,
};

const comparisonCardStyle = {
  border: "1px solid #d4deef",
  borderRadius: 10,
  background: "#f7f9ff",
  padding: 10,
  display: "grid",
  gap: 6,
};

const comparisonLabelStyle = {
  fontSize: 13,
  color: "#2a3f60",
};

const comparisonRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 12,
  color: "#4e5f79",
};

const comparisonDeltaStyle = (isPositive = true) => ({
  marginTop: 4,
  fontSize: 12,
  fontWeight: 700,
  color: isPositive ? "#15764a" : "#ab2a2a",
});

const listStyle = {
  margin: "8px 0 0",
  paddingLeft: 20,
};

const twoColStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 12,
};

const inlineLabelStyle = {
  display: "grid",
  gap: 4,
  fontSize: 12,
  color: "#4e5f79",
  textTransform: "uppercase",
};

const inlineInputStyle = {
  ...inputStyle,
  padding: "6px 8px",
  minWidth: 160,
};

const exportRowStyle = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
  alignItems: "end",
};

const reportPreStyle = {
  margin: 0,
  whiteSpace: "pre-wrap",
  background: "#f7f9ff",
  border: "1px solid #d4deef",
  borderRadius: 10,
  padding: 10,
  color: "#1f3557",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 13,
};

const tableWrapperStyle = {
  marginTop: 12,
  overflowX: "auto",
  border: "1px solid #d4deef",
  borderRadius: 10,
};

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  minWidth: 780,
};

const thStyle = {
  textAlign: "left",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.3,
  color: "#4d5f7b",
  padding: 8,
  borderBottom: "1px solid #d4deef",
  background: "#f7f9ff",
};

const tdStyle = {
  padding: 8,
  borderBottom: "1px solid #edf1f8",
  fontSize: 13,
  color: "#1f3557",
  verticalAlign: "top",
};

const errorStyle = {
  marginBottom: 0,
  color: "#9c1c1c",
};

const successStyle = {
  marginBottom: 0,
  color: "#146131",
};
