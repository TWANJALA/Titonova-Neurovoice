export function formatMemoryForPrompt(memory) {
  const combined = flattenMemoryLayers(memory);
  const characters = Array.isArray(combined.characters) ? combined.characters : [];
  const events = Array.isArray(combined.new_events)
    ? combined.new_events
    : Array.isArray(combined.recent_events)
      ? combined.recent_events
      : [];
  const summaries = Array.isArray(combined.chapter_summaries) ? combined.chapter_summaries : [];
  const limited = {
    characters,
    tone: combined.tone || "original tone",
    world_rules: Array.isArray(combined.world_rules) ? combined.world_rules : [],
    timeline: combined.timeline || combined.chronology || "",
    recent_events: events.slice(-5),
    current_chapter_summary:
      combined.current_chapter_summary ||
      combined.chapter_summary ||
      combined.summary ||
      summaries[summaries.length - 1] ||
      "",
    chapter_summaries: summaries.slice(-5),
  };
  return limited;
}

export function buildPrompt(memory, userInput, chapter) {
  const chapterNumber = chapter || 1;
  const limitedMemory = formatMemoryForPrompt(memory);
  const tone = limitedMemory.tone || "original tone";

  return `
You are writing a professional novel.

MEMORY:
${JSON.stringify(limitedMemory, null, 2)}

TASK:
Write Chapter ${chapterNumber}.

Maintain:
- Character behavior consistency
- Timeline accuracy
- Tone: ${tone}

User wants:
${userInput}
`;
}

export async function extractMemoryDelta(openaiClient, text) {
  if (!text || !openaiClient) return null;

  const prompt = `Extract structured story elements from this text:

TEXT:
${text}

Return JSON:
{
  "characters": [],
  "new_events": [],
  "world_rules": []
}`;

  const response = await openaiClient.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.choices?.[0]?.message?.content || "";
  return safeJsonParse(raw);
}

export function mergeMemory(baseMemory, delta) {
  const base = baseMemory && typeof baseMemory === "object" ? baseMemory : {};
  const hasLayers = base.core_memory || base.chapter_memory || base.session_memory;

  const mergeLayer = (layer = {}, deltaObj = {}) => ({
    ...layer,
    characters: mergeArray(layer.characters, deltaObj.characters),
    new_events: mergeArray(layer.new_events, deltaObj.new_events),
    world_rules: mergeArray(layer.world_rules, deltaObj.world_rules),
    chapter_summaries: mergeArray(layer.chapter_summaries, deltaObj.chapter_summaries),
    consistency_notes: mergeArray(layer.consistency_notes, deltaObj.consistency_notes),
    tone: deltaObj.tone || layer.tone,
    timeline: deltaObj.timeline || layer.timeline,
    current_chapter_summary: deltaObj.current_chapter_summary || layer.current_chapter_summary,
  });

  if (hasLayers) {
    return {
      ...base,
      core_memory: mergeLayer(base.core_memory || {}, delta || {}),
      chapter_memory: mergeLayer(base.chapter_memory || {}, delta || {}),
      session_memory: mergeLayer(base.session_memory || {}, delta || {}),
    };
  }

  return mergeLayer(base, delta || {});
}

function mergeArray(a, b) {
  const arrA = Array.isArray(a) ? a : [];
  const arrB = Array.isArray(b) ? b : [];
  const set = new Set([...arrA, ...arrB].filter(Boolean));
  return Array.from(set);
}

function safeJsonParse(text) {
  if (!text) return null;
  const cleaned = text
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export async function extractChapterSummary(openaiClient, text) {
  if (!text || !openaiClient) return [];

  const prompt = `Summarize this chapter in 5 bullet points:
${text}`;

  const response = await openaiClient.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.choices?.[0]?.message?.content || "";
  return parseBullets(raw);
}

export async function checkConsistency(openaiClient, memory, text) {
  if (!openaiClient || !text) return null;
  const memoryJson = memory ? JSON.stringify(memory) : "{}";
  const prompt = `Check for inconsistencies:

MEMORY:
${memoryJson}

TEXT:
${text}

Return:
- contradictions
- suggestions`;

  const response = await openaiClient.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.choices?.[0]?.message?.content || "";
  const lines = parseBullets(raw);
  if (!lines.length) return null;
  return { consistency_notes: lines };
}

function flattenMemoryLayers(memory) {
  const mem = memory && typeof memory === "object" ? memory : {};
  const core = mem.core_memory && typeof mem.core_memory === "object" ? mem.core_memory : {};
  const chapter = mem.chapter_memory && typeof mem.chapter_memory === "object" ? mem.chapter_memory : {};
  const session = mem.session_memory && typeof mem.session_memory === "object" ? mem.session_memory : {};
  // Priority: core -> chapter -> session -> legacy top-level overrides
  return {
    ...core,
    ...chapter,
    ...session,
    ...mem,
  };
}

function parseBullets(text) {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-•]\s*/, ""))
    .filter(Boolean)
    .slice(0, 5);
}
