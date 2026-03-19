import React, { useEffect, useMemo, useState } from "react";
import { addDoc, collection, getDocs } from "firebase/firestore";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ROLES } from "../constants/roles";
import { db, usingPlaceholderFirebaseConfig } from "../firebase";

const defaultWords = [
  { text: "I", emoji: "👤" },
  { text: "want", emoji: "🙏" },
  { text: "food", emoji: "🍔" },
  { text: "water", emoji: "💧" },
  { text: "help", emoji: "🆘" },
  { text: "happy", emoji: "😊" },
  { text: "sad", emoji: "😢" },
  { text: "stop", emoji: "✋" },
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

const MAX_PHRASES = 12;
const DEFAULT_CHILD_PROFILE = { id: "child-main", name: "Child 1" };

function makeChildId() {
  return `child-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeToken(text) {
  return String(text ?? "").trim().toLowerCase();
}

function getTodayKey() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function speak(text) {
  if (!text?.trim()) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
}

function incrementCounter(counterMap, token) {
  return {
    ...counterMap,
    [token]: (counterMap[token] ?? 0) + 1,
  };
}

function incrementTransition(transitionMap, fromToken, toToken) {
  return {
    ...transitionMap,
    [fromToken]: {
      ...(transitionMap[fromToken] ?? {}),
      [toToken]: ((transitionMap[fromToken] ?? {})[toToken] ?? 0) + 1,
    },
  };
}

function getRecentTokenCounts(sentenceHistory, maxItems = 6) {
  const recent = sentenceHistory.slice(-maxItems);
  const tokenCounts = {};

  recent.forEach((entry) => {
    String(entry)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .forEach((token) => {
        tokenCounts[token] = (tokenCounts[token] ?? 0) + 1;
      });
  });

  return tokenCounts;
}

function getSmartSuggestions({ words, sentence, usageCounts, transitionCounts, sentenceHistory, limit = 4 }) {
  const wordMap = new Map();

  words.forEach((word) => {
    const token = normalizeToken(word.text);
    if (!token || wordMap.has(token)) return;
    wordMap.set(token, word);
  });

  const sentenceTokens = new Set(sentence.map((word) => normalizeToken(word.text)));
  const lastToken = normalizeToken(sentence[sentence.length - 1]?.text);
  const recentTokenCounts = getRecentTokenCounts(sentenceHistory);

  const scored = [...wordMap.entries()].map(([token, word]) => {
    let score = 1;

    score += (usageCounts[token] ?? 0) * 0.45;
    score += (recentTokenCounts[token] ?? 0) * 0.25;

    if (sentence.length === 0) {
      score += START_WORD_BOOSTS[token] ?? 0;
    }

    if (lastToken) {
      score += ((transitionCounts[lastToken] ?? {})[token] ?? 0) * 1.2;
      score += (CONTEXT_BOOSTS[lastToken] ?? {})[token] ?? 0;
    }

    if (sentenceTokens.has(token)) score -= 0.4;
    if (lastToken && token === lastToken) score -= 0.8;

    return { word, score };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.word.text.localeCompare(b.word.text))
    .slice(0, limit)
    .map((entry) => entry.word);
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

export default function ParentPage() {
  const { user, roles, signOut, hasAnyRole } = useAuth();
  const ownerId = user?.uid ?? "guest";

  const [sentence, setSentence] = useState([]);
  const [customWords, setCustomWords] = useState([]);
  const [sentenceHistory, setSentenceHistory] = useState([]);
  const [usageCounts, setUsageCounts] = useState({});
  const [transitionCounts, setTransitionCounts] = useState({});
  const [favoriteTokens, setFavoriteTokens] = useState([]);
  const [quickPhrases, setQuickPhrases] = useState(DEFAULT_QUICK_PHRASES);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [wordSearch, setWordSearch] = useState("");
  const [wordFilter, setWordFilter] = useState("all");
  const [dailySentenceGoal, setDailySentenceGoal] = useState(8);
  const [dailySentenceCounts, setDailySentenceCounts] = useState({});
  const [childProfiles, setChildProfiles] = useState([DEFAULT_CHILD_PROFILE]);
  const [activeChildId, setActiveChildId] = useState(DEFAULT_CHILD_PROFILE.id);
  const [childProfilesReady, setChildProfilesReady] = useState(false);
  const [modelHydratedKey, setModelHydratedKey] = useState("");
  const [preferenceHydratedKey, setPreferenceHydratedKey] = useState("");
  const [wordsHydratedKey, setWordsHydratedKey] = useState("");

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
  const activeChildProfile = useMemo(
    () => childProfiles.find((profile) => profile.id === activeChildId) ?? childProfiles[0] ?? DEFAULT_CHILD_PROFILE,
    [childProfiles, activeChildId]
  );

  useEffect(() => {
    setChildProfilesReady(false);

    try {
      const rawProfiles = localStorage.getItem(childProfilesKey);
      if (!rawProfiles) {
        setChildProfiles([DEFAULT_CHILD_PROFILE]);
        setActiveChildId(DEFAULT_CHILD_PROFILE.id);
        setChildProfilesReady(true);
        return;
      }

      const parsed = JSON.parse(rawProfiles);
      const profiles = Array.isArray(parsed.profiles) && parsed.profiles.length > 0
        ? parsed.profiles
            .map((profile) => ({
              id: String(profile?.id ?? ""),
              name: String(profile?.name ?? "").trim() || "Child",
            }))
            .filter((profile) => profile.id)
        : [DEFAULT_CHILD_PROFILE];

      const nextProfiles = profiles.length > 0 ? profiles : [DEFAULT_CHILD_PROFILE];
      const requestedActiveId = String(parsed.activeChildId ?? "");
      const nextActiveId =
        nextProfiles.find((profile) => profile.id === requestedActiveId)?.id ?? nextProfiles[0].id;

      setChildProfiles(nextProfiles);
      setActiveChildId(nextActiveId);
      setChildProfilesReady(true);
    } catch (error) {
      console.error("Failed to load child profiles:", error);
      setChildProfiles([DEFAULT_CHILD_PROFILE]);
      setActiveChildId(DEFAULT_CHILD_PROFILE.id);
      setChildProfilesReady(true);
    }
  }, [childProfilesKey]);

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
  }, [childProfilesKey, childProfiles, activeChildId, childProfilesReady]);

  useEffect(() => {
    setSentence([]);
    setWordSearch("");
    setWordFilter("all");
  }, [activeChildId]);

  useEffect(() => {
    async function loadWords() {
      try {
        const localWords = JSON.parse(localStorage.getItem(childWordsKey) ?? "[]");
        if (Array.isArray(localWords)) {
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
        const querySnapshot = await getDocs(
          collection(db, "users", ownerId, "children", activeChildId, "words")
        );
        const words = querySnapshot.docs.map((doc) => doc.data());
        setCustomWords(words);
        localStorage.setItem(childWordsKey, JSON.stringify(words));
        setWordsHydratedKey(childWordsKey);
      } catch (error) {
        console.error("Failed to load words from Firestore:", error);
        setWordsHydratedKey(childWordsKey);
      }
    }

    loadWords();
  }, [childWordsKey, activeChildId, ownerId]);

  useEffect(() => {
    if (wordsHydratedKey !== childWordsKey) return;
    localStorage.setItem(childWordsKey, JSON.stringify(customWords));
  }, [childWordsKey, customWords, wordsHydratedKey]);

  useEffect(() => {
    try {
      const rawModel = localStorage.getItem(smartModelKey);
      if (!rawModel) {
        setUsageCounts({});
        setTransitionCounts({});
        setSentenceHistory([]);
        setModelHydratedKey(smartModelKey);
        return;
      }

      const parsed = JSON.parse(rawModel);
      setUsageCounts(parsed.usageCounts ?? {});
      setTransitionCounts(parsed.transitionCounts ?? {});
      setSentenceHistory(Array.isArray(parsed.sentenceHistory) ? parsed.sentenceHistory : []);
      setModelHydratedKey(smartModelKey);
    } catch (error) {
      console.error("Failed to load smart model:", error);
      setUsageCounts({});
      setTransitionCounts({});
      setSentenceHistory([]);
      setModelHydratedKey(smartModelKey);
    }
  }, [smartModelKey]);

  useEffect(() => {
    if (modelHydratedKey !== smartModelKey) return;

    const payload = {
      usageCounts,
      transitionCounts,
      sentenceHistory: sentenceHistory.slice(-50),
    };

    localStorage.setItem(smartModelKey, JSON.stringify(payload));
  }, [smartModelKey, usageCounts, transitionCounts, sentenceHistory, modelHydratedKey]);

  useEffect(() => {
    try {
      const rawPrefs = localStorage.getItem(preferenceKey);
      if (!rawPrefs) {
        setFavoriteTokens([]);
        setQuickPhrases(DEFAULT_QUICK_PHRASES);
        setAutoSpeak(false);
        setDailySentenceGoal(8);
        setDailySentenceCounts({});
        setPreferenceHydratedKey(preferenceKey);
        return;
      }

      const parsed = JSON.parse(rawPrefs);
      setFavoriteTokens(Array.isArray(parsed.favoriteTokens) ? parsed.favoriteTokens : []);
      setQuickPhrases(
        Array.isArray(parsed.quickPhrases) && parsed.quickPhrases.length > 0
          ? parsed.quickPhrases.slice(0, MAX_PHRASES)
          : DEFAULT_QUICK_PHRASES
      );
      setAutoSpeak(Boolean(parsed.autoSpeak));
      setDailySentenceGoal(
        Number.isInteger(parsed.dailySentenceGoal) && parsed.dailySentenceGoal > 0
          ? parsed.dailySentenceGoal
          : 8
      );
      setDailySentenceCounts(
        parsed.dailySentenceCounts && typeof parsed.dailySentenceCounts === "object"
          ? parsed.dailySentenceCounts
          : {}
      );
      setPreferenceHydratedKey(preferenceKey);
    } catch (error) {
      console.error("Failed to load user preferences:", error);
      setFavoriteTokens([]);
      setQuickPhrases(DEFAULT_QUICK_PHRASES);
      setAutoSpeak(false);
      setDailySentenceGoal(8);
      setDailySentenceCounts({});
      setPreferenceHydratedKey(preferenceKey);
    }
  }, [preferenceKey]);

  useEffect(() => {
    if (preferenceHydratedKey !== preferenceKey) return;

    const payload = {
      favoriteTokens,
      quickPhrases: quickPhrases.slice(0, MAX_PHRASES),
      autoSpeak,
      dailySentenceGoal,
      dailySentenceCounts,
    };

    localStorage.setItem(preferenceKey, JSON.stringify(payload));
  }, [
    preferenceKey,
    favoriteTokens,
    quickPhrases,
    autoSpeak,
    dailySentenceGoal,
    dailySentenceCounts,
    preferenceHydratedKey,
  ]);

  const words = useMemo(() => [...defaultWords, ...customWords], [customWords]);
  const defaultTokenSet = useMemo(
    () => new Set(defaultWords.map((word) => normalizeToken(word.text))),
    []
  );

  const uniqueWords = useMemo(() => {
    const wordMap = new Map();
    words.forEach((word) => {
      const token = normalizeToken(word.text);
      if (!token || wordMap.has(token)) return;
      wordMap.set(token, word);
    });
    return [...wordMap.values()];
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

  const smartSuggestions = useMemo(
    () =>
      getSmartSuggestions({
        words: uniqueWords,
        sentence,
        usageCounts,
        transitionCounts,
        sentenceHistory,
      }),
    [uniqueWords, sentence, usageCounts, transitionCounts, sentenceHistory]
  );

  const filteredWords = useMemo(() => {
    const searchToken = normalizeToken(wordSearch);

    return uniqueWords.filter((word) => {
      const token = normalizeToken(word.text);
      if (!token) return false;

      if (searchToken && !token.includes(searchToken)) return false;

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
  }, [uniqueWords, wordSearch, wordFilter, favoriteTokens, defaultTokenSet]);

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

  const appendWords = (wordsToAppend) => {
    const validWords = wordsToAppend.filter((word) => normalizeToken(word?.text));
    if (validWords.length === 0) return;

    setSentence((previousSentence) => {
      const tokenPairs = [];
      const appendedTokens = [];
      let previousToken = normalizeToken(previousSentence[previousSentence.length - 1]?.text);

      validWords.forEach((word) => {
        const token = normalizeToken(word.text);
        appendedTokens.push(token);

        if (previousToken) {
          tokenPairs.push([previousToken, token]);
        }

        previousToken = token;
      });

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

      return [...previousSentence, ...validWords];
    });

    if (autoSpeak) {
      speak(validWords.map((word) => word.text).join(" "));
    }
  };

  const addWord = (word) => {
    appendWords([word]);
  };

  const removeWordAt = (indexToRemove) => {
    setSentence((previousSentence) => previousSentence.filter((_, index) => index !== indexToRemove));
  };

  const undoLastWord = () => {
    setSentence((previousSentence) => previousSentence.slice(0, -1));
  };

  const speakSentence = () => {
    const text = sentence.map((word) => word.text).join(" ");
    if (!text.trim()) return;

    speak(text);
    setSentenceHistory((previousHistory) => [...previousHistory, text].slice(-50));
    setDailySentenceCounts((previousCounts) => ({
      ...previousCounts,
      [todayKey]: (previousCounts[todayKey] ?? 0) + 1,
    }));
  };

  const addCustomWord = async () => {
    const text = window.prompt("Enter new word:");
    const emoji = window.prompt("Enter emoji:") || "🔤";

    if (!text?.trim()) return;

    const newWord = { text: text.trim(), emoji };

    try {
      if (!usingPlaceholderFirebaseConfig) {
        await addDoc(collection(db, "users", ownerId, "children", activeChildId, "words"), newWord);
      }
    } catch (error) {
      console.error("Failed to save word to Firestore:", error);
    }

    setCustomWords((previousWords) => [...previousWords, newWord]);
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

    setQuickPhrases((previousPhrases) => {
      const phraseToken = normalizeToken(phrase);
      const deduped = previousPhrases.filter((item) => normalizeToken(item) !== phraseToken);
      return [phrase, ...deduped].slice(0, MAX_PHRASES);
    });
  };

  const useQuickPhrase = (phrase) => {
    const tokens = phrase.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return;

    const mappedWords = tokens.map((token) => {
      const normalized = normalizeToken(token);
      return wordLookup[normalized] ?? { text: token, emoji: "🔤" };
    });

    appendWords(mappedWords);
  };

  const removeQuickPhrase = (phraseToRemove) => {
    setQuickPhrases((previousPhrases) =>
      previousPhrases.filter((phrase) => normalizeToken(phrase) !== normalizeToken(phraseToRemove))
    );
  };

  const addChildProfile = () => {
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
    setQuickPhrases((previousPhrases) => {
      const normalized = normalizeToken(phrase);
      const deduped = previousPhrases.filter((item) => normalizeToken(item) !== normalized);
      return [phrase, ...deduped].slice(0, MAX_PHRASES);
    });
  };

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
    setDailySentenceCounts({});
  };

  const exportWorkspaceData = () => {
    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      childProfile: activeChildProfile,
      smartModel: {
        usageCounts,
        transitionCounts,
        sentenceHistory,
      },
      preferences: {
        favoriteTokens,
        quickPhrases,
        autoSpeak,
        dailySentenceGoal,
        dailySentenceCounts,
      },
      customWords,
    };

    const serialized = JSON.stringify(backup, null, 2);
    window.prompt("Copy your AAC backup JSON:", serialized);
  };

  const importWorkspaceData = () => {
    const raw = window.prompt("Paste AAC backup JSON:");
    if (!raw?.trim()) return;

    try {
      const parsed = JSON.parse(raw);
      const model = parsed.smartModel ?? {};
      const prefs = parsed.preferences ?? {};

      setUsageCounts(model.usageCounts ?? {});
      setTransitionCounts(model.transitionCounts ?? {});
      setSentenceHistory(Array.isArray(model.sentenceHistory) ? model.sentenceHistory.slice(-50) : []);
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
      setCustomWords(Array.isArray(parsed.customWords) ? parsed.customWords : []);
      window.alert("Backup imported.");
    } catch (error) {
      console.error("Failed to import workspace data:", error);
      window.alert("Backup JSON is invalid.");
    }
  };

  const totalWordTaps = Object.values(usageCounts).reduce((total, value) => total + value, 0);

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <header style={headerStyle}>
        <div>
          <h1 style={{ marginBottom: 8 }}>AAC Workspace</h1>
          <p style={{ margin: 0 }}>
            {user ? `Signed in as ${user?.displayName || user?.email}` : "Guest mode (no account required)"} | Active
            child: {activeChildProfile.name} | Roles: {roles.join(", ") || ROLES.PARENT}
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {hasAnyRole([ROLES.THERAPIST, ROLES.ADMIN]) ? <Link to="/therapist">Therapist View</Link> : null}
          {hasAnyRole([ROLES.ADMIN]) ? <Link to="/admin">Admin View</Link> : null}
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
      </section>

      {usingPlaceholderFirebaseConfig ? (
        <p style={warningStyle}>
          Firebase env variables are placeholders. Set VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN,
          and VITE_FIREBASE_PROJECT_ID to enable live auth/firestore.
        </p>
      ) : null}

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

      <section style={finderSectionStyle}>
        <strong>Word finder</strong>
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
        </div>
      </section>

      <div style={sentenceStyle}>
        {sentence.length === 0 ? (
          <span style={{ color: "#666" }}>Tap words or quick phrases to build a sentence.</span>
        ) : (
          sentence.map((word, index) => (
            <button
              key={`${word.text}-${index}`}
              onClick={() => removeWordAt(index)}
              style={sentenceChipStyle}
              title="Remove this word"
            >
              {word.text}
            </button>
          ))
        )}
      </div>

      <section style={{ marginBottom: 16 }}>
        <strong>Quick phrases</strong>
        <div style={phraseRowStyle}>
          {quickPhrases.map((phrase) => (
            <div key={phrase} style={phraseCardStyle}>
              <button onClick={() => useQuickPhrase(phrase)} style={phraseBtnStyle}>
                {phrase}
              </button>
              <button
                onClick={() => removeQuickPhrase(phrase)}
                style={phraseDeleteBtnStyle}
                title="Remove phrase"
              >
                x
              </button>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: 16 }}>
        <strong>Adaptive phrase suggestions</strong>
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
      </section>

      <section style={{ marginBottom: 16 }}>
        <strong>Favorites</strong>
        <div style={suggestionRowStyle}>
          {favoriteWords.length === 0 ? <p style={{ margin: 0 }}>No favorite words yet. Tap star on a word.</p> : null}
          {favoriteWords.map((word, index) => (
            <button
              key={`favorite-${word.text}-${index}`}
              onClick={() => addWord(word)}
              style={suggestionBtnStyle}
            >
              <span style={{ fontSize: 24 }}>{word.emoji || "🔤"}</span>
              <span>{word.text}</span>
            </button>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: 16 }}>
        <strong>Smart suggestions</strong>
        <div style={suggestionRowStyle}>
          {smartSuggestions.map((word, index) => (
            <button
              key={`suggestion-${word.text}-${index}`}
              onClick={() => addWord(word)}
              style={suggestionBtnStyle}
            >
              <span style={{ fontSize: 24 }}>{word.emoji || "🔤"}</span>
              <span>{word.text}</span>
            </button>
          ))}
        </div>
      </section>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={speakSentence} style={btnStyle}>
          Speak
        </button>

        <button onClick={undoLastWord} style={btnStyle} disabled={sentence.length === 0}>
          Undo
        </button>

        <button onClick={() => setSentence([])} style={btnStyle}>
          Clear
        </button>

        <button onClick={saveCurrentSentenceAsPhrase} style={btnStyle} disabled={sentence.length === 0}>
          Save Phrase
        </button>

        <button onClick={() => speak("I need help now")} style={btnStyle}>
          Emergency Speak
        </button>

        <button
          onClick={() => setAutoSpeak((enabled) => !enabled)}
          style={autoSpeak ? activeBtnStyle : btnStyle}
          title="Speak every new word automatically"
        >
          {autoSpeak ? "Auto-Speak On" : "Auto-Speak Off"}
        </button>

        <button onClick={addCustomWord} style={btnStyle}>
          Add Word
        </button>

        <button onClick={exportWorkspaceData} style={btnStyle}>
          Export Data
        </button>

        <button onClick={importWorkspaceData} style={btnStyle}>
          Import Data
        </button>

        <button onClick={resetLearningData} style={btnStyle}>
          Reset Learning
        </button>
      </div>

      <div style={gridStyle}>
        {filteredWords.length === 0 ? <p style={{ margin: 0 }}>No words match this filter.</p> : null}
        {filteredWords.map((word, index) => {
          const token = normalizeToken(word.text);
          const isFavorite = favoriteTokens.includes(token);

          return (
            <div key={`${word.text}-${index}`} style={wordCardStyle}>
              <button onClick={() => addWord(word)} style={gridBtn}>
                <div style={{ fontSize: 30 }}>{word.emoji || "🔤"}</div>
                <div>{word.text}</div>
              </button>
              <button
                onClick={() => toggleFavorite(word)}
                style={favoriteToggleBtnStyle}
                title={isFavorite ? "Remove favorite" : "Add favorite"}
              >
                {isFavorite ? "★" : "☆"}
              </button>
            </div>
          );
        })}
      </div>

      <Dashboard
        activeChildName={activeChildProfile.name}
        sentenceHistory={sentenceHistory}
        usageCounts={usageCounts}
        quickPhraseCount={quickPhrases.length}
        totalWordTaps={totalWordTaps}
        todaySentenceCount={todaySentenceCount}
        dailySentenceGoal={dailySentenceGoal}
        goalStreak={goalStreak}
        sevenDayAverage={sevenDayAverage}
      />
    </div>
  );
}

function Dashboard({
  activeChildName,
  sentenceHistory,
  usageCounts,
  quickPhraseCount,
  totalWordTaps,
  todaySentenceCount,
  dailySentenceGoal,
  goalStreak,
  sevenDayAverage,
}) {
  const topWords = Object.entries(usageCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const goalPct = Math.min(100, Math.round((todaySentenceCount / Math.max(1, dailySentenceGoal)) * 100));
  const topWordMax = topWords[0]?.[1] ?? 1;
  const recentSentences = sentenceHistory.slice(-5).reverse();

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
        </div>

        <div style={dashboardPanelsStyle}>
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
        </div>
      </div>
    </section>
  );
}

const headerStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  marginBottom: 20,
};

const warningStyle = {
  border: "1px solid #d8a117",
  background: "#fff9e6",
  padding: 10,
  borderRadius: 8,
};

const childSwitcherStyle = {
  border: "1px solid #dce6f5",
  background: "#f8fbff",
  borderRadius: 10,
  padding: 10,
  marginBottom: 12,
};

const childControlsStyle = {
  display: "grid",
  gridTemplateColumns: "2fr repeat(3, auto)",
  gap: 8,
  marginTop: 8,
};

const goalCardStyle = {
  border: "1px solid #d9e3f2",
  background: "#f7fbff",
  padding: 10,
  borderRadius: 10,
  marginBottom: 12,
};

const goalHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  marginBottom: 8,
};

const goalMetaStyle = {
  marginTop: 8,
  marginBottom: 8,
  color: "#4b5a70",
};

const progressTrackStyle = {
  width: "100%",
  height: 10,
  borderRadius: 999,
  background: "#e7eef8",
  overflow: "hidden",
};

const progressFillStyle = {
  height: "100%",
  background: "#68b783",
};

const finderSectionStyle = {
  marginBottom: 14,
};

const finderControlsStyle = {
  display: "grid",
  gridTemplateColumns: "2fr 1fr auto",
  gap: 8,
  marginTop: 8,
};

const textInputStyle = {
  padding: 10,
  borderRadius: 10,
  border: "1px solid #ccd7e7",
};

const selectStyle = {
  padding: 10,
  borderRadius: 10,
  border: "1px solid #ccd7e7",
  background: "#fff",
};

const sentenceStyle = {
  border: "2px solid #ccc",
  padding: 10,
  minHeight: 60,
  marginBottom: 20,
  fontSize: 24,
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};

const sentenceChipStyle = {
  border: "1px solid #c9d5e5",
  borderRadius: 12,
  background: "#f3f8ff",
  padding: "6px 10px",
  cursor: "pointer",
  fontSize: 18,
};

const suggestionRowStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 8,
  marginTop: 8,
};

const suggestionBtnStyle = {
  display: "grid",
  gap: 6,
  alignItems: "center",
  justifyItems: "center",
  textAlign: "center",
  padding: 12,
  fontSize: 16,
  borderRadius: 12,
  border: "1px solid #d9d9d9",
  background: "#f8fbff",
  cursor: "pointer",
};

const phraseRowStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
  marginTop: 8,
};

const phraseCardStyle = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: 6,
};

const phraseBtnStyle = {
  textAlign: "left",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #d7dde5",
  background: "#f8f9fc",
  cursor: "pointer",
};

const phraseDeleteBtnStyle = {
  padding: "0 10px",
  borderRadius: 10,
  border: "1px solid #e0caca",
  background: "#fff2f2",
  cursor: "pointer",
};

const phraseSaveBtnStyle = {
  padding: "0 10px",
  borderRadius: 10,
  border: "1px solid #c6d7c8",
  background: "#eef9ef",
  cursor: "pointer",
};

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 10,
  marginTop: 20,
};

const wordCardStyle = {
  display: "grid",
  gap: 6,
};

const btnStyle = {
  padding: 10,
  fontSize: 16,
  borderRadius: 10,
  cursor: "pointer",
};

const activeBtnStyle = {
  ...btnStyle,
  background: "#ddf4e2",
  border: "1px solid #8fcf9f",
};

const gridBtn = {
  padding: 20,
  fontSize: 18,
  borderRadius: 20,
  background: "#f5f5f5",
  border: "none",
  cursor: "pointer",
};

const favoriteToggleBtnStyle = {
  borderRadius: 10,
  border: "1px solid #d9d1a5",
  background: "#fff9de",
  cursor: "pointer",
  fontSize: 18,
  padding: "4px 0",
};

const dashboardShellStyle = {
  marginTop: 40,
  position: "relative",
  borderRadius: 20,
  overflow: "hidden",
  border: "1px solid #d7e3f0",
  boxShadow: "0 18px 40px rgba(15, 53, 89, 0.14)",
  fontFamily: "\"Space Grotesk\", \"Avenir Next\", \"Segoe UI\", sans-serif",
};

const dashboardBackdropStyle = {
  position: "absolute",
  inset: 0,
  background:
    "linear-gradient(135deg, rgba(18, 88, 139, 0.16), rgba(0, 163, 122, 0.14) 45%, rgba(255, 196, 77, 0.14))",
};

const dashboardContentStyle = {
  position: "relative",
  padding: 18,
  background: "rgba(255, 255, 255, 0.94)",
  backdropFilter: "blur(2px)",
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
  color: "#446380",
  fontWeight: 700,
};

const dashboardHeadingStyle = {
  margin: "4px 0 4px",
  fontSize: 30,
  lineHeight: 1.1,
  color: "#11344f",
};

const dashboardSubtitleStyle = {
  margin: 0,
  color: "#35546f",
};

const dashboardGoalBadgeStyle = {
  minWidth: 220,
  borderRadius: 14,
  padding: 12,
  border: "1px solid #bcd2e7",
  background: "linear-gradient(135deg, #f0f8ff, #eefef7)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.8)",
};

const dashboardGoalLabelStyle = {
  fontSize: 12,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: "#42627d",
  fontWeight: 700,
};

const dashboardGoalValueStyle = {
  display: "block",
  marginTop: 4,
  marginBottom: 8,
  fontSize: 24,
  color: "#0b3855",
};

const dashboardMiniTrackStyle = {
  width: "100%",
  height: 10,
  borderRadius: 999,
  background: "#d8e7f3",
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
  border: "1px solid #d6e3ef",
  background: "#ffffff",
  padding: 10,
};

const dashboardStatLabelStyle = {
  display: "block",
  color: "#4d6780",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 6,
};

const dashboardStatValueStyle = {
  color: "#10364f",
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
  border: "1px solid #d8e5f2",
  background: "#fbfdff",
  padding: 12,
};

const dashboardPanelTitleStyle = {
  margin: "0 0 10px",
  color: "#12354f",
  fontSize: 18,
};

const dashboardPanelEmptyStyle = {
  margin: 0,
  color: "#5a758e",
};

const dashboardSentenceListStyle = {
  display: "grid",
  gap: 8,
};

const dashboardSentenceItemStyle = {
  borderRadius: 10,
  border: "1px solid #d2deea",
  padding: "8px 10px",
  background: "linear-gradient(180deg, #ffffff, #f6faff)",
  color: "#1e4563",
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
  color: "#20455f",
  fontWeight: 600,
};

const dashboardWordTrackStyle = {
  width: "100%",
  height: 10,
  borderRadius: 999,
  background: "#dbe6f1",
  overflow: "hidden",
};

const dashboardWordFillStyle = {
  height: "100%",
  background: "linear-gradient(90deg, #3197df, #2fbb92)",
};
