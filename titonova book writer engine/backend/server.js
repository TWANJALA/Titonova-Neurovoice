import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { File } from "node:buffer";
import OpenAI from "openai";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { extractMemoryDelta, mergeMemory, formatMemoryForPrompt, extractChapterSummary, checkConsistency } from "./memoryEngine.js";

const app = express();
const port = process.env.PORT || 5000;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
const EXPORTS_BUCKET = "exports";
const MEMORY_TABLE = "narrative_memory";
const BOOK_MEMORY_TABLE = "book_memory";
const CHARACTERS_TABLE = "characters";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function stubText({ prompt, mode }) {
  const body = ["[stubbed] This environment is running without an active OpenAI quota."];
  if (prompt) body.push(`Prompt: ${prompt.slice(0, 120)}`);
  if (mode) body.push(`Mode: ${mode}`);
  body.push("Here is placeholder narrative text so you can keep testing the UI.");
  body.push("Chapter 1: The Beginning\nThe sun dipped behind the ridge as the crew prepared for their impossible heist.");
  return body.join("\n\n");
}

app.use(cors());
// Use raw body for Stripe webhook; JSON for others
app.use((req, res, next) => {
  if (req.originalUrl === "/api/stripe/webhook") {
    next();
  } else {
    express.json({ limit: "2mb" })(req, res, next);
  }
});

app.get("/", (_req, res) => {
  res.send("Story engine backend is running. Use /health or /api routes.");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

async function requireAuth(req, res, next) {
  if (!supabase) {
    req.user = { id: "guest" };
    return next();
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "") : null;

  if (!token) {
    req.user = { id: "guest" };
    return next();
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    req.user = { id: "guest" };
    return next();
  }

  req.user = data.user;
  next();
}

async function fetchProfile(userId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, plan, stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.warn("Supabase fetch profile error", error);
    return null;
  }
  return data || null;
}

async function ensureProfile(userId) {
  if (!supabase || !userId) return null;
  const profile = await fetchProfile(userId);
  if (profile) return profile;
  const { data, error } = await supabase.from("profiles").insert({ id: userId, plan: "free" }).select().maybeSingle();
  if (error) {
    console.warn("Supabase insert profile error", error);
    return null;
  }
  return data || null;
}

async function requireBookQuota(req, res, next) {
  if (!supabase) return next();
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized." });
  if (userId === "guest") return next();

  const profile = await ensureProfile(userId);
  const plan = profile?.plan || "free";

  if (plan === "free") {
    const { error, count } = await supabase
      .from("books")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);

    if (error) {
      console.error("Book quota check error", error);
      return res.status(500).json({ error: "Failed to check book quota." });
    }

    if ((count || 0) >= 1) {
      return res.status(402).json({ error: "Free plan allows 1 book. Upgrade to add more." });
    }
  }

  next();
}

async function requireExportAccess(req, res, next) {
  // Payments disabled: allow export for all users
  return next();
}

async function getMemoryPayload(userId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(MEMORY_TABLE)
    .select("payload")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.warn("memory fetch error", error);
    return null;
  }
  return data?.payload || null;
}

async function upsertMemoryPayload(userId, payload) {
  if (!supabase || !userId || !payload || typeof payload !== "object") return;
  const { error } = await supabase
    .from(MEMORY_TABLE)
    .upsert({ user_id: userId, payload }, { onConflict: "user_id" });
  if (error) {
    console.warn("memory upsert error", error);
  }
}

async function ensureBookAccess(userId, bookId) {
  if (!supabase || !userId || !bookId) return null;
  const { data, error } = await supabase
    .from("books")
    .select("id, user_id")
    .eq("id", bookId)
    .maybeSingle();
  if (error) {
    console.warn("book access check error", error);
    return null;
  }
  if (!data || data.user_id !== userId) return null;
  return data;
}

async function getBookMemory(bookId, userId) {
  const book = await ensureBookAccess(userId, bookId);
  if (!book) return null;
  const { data, error } = await supabase
    .from(BOOK_MEMORY_TABLE)
    .select("memory_json")
    .eq("book_id", bookId)
    .maybeSingle();
  if (error) {
    console.warn("book memory fetch error", error);
    return null;
  }
  return data?.memory_json || null;
}

async function upsertBookMemory(bookId, userId, payload) {
  const book = await ensureBookAccess(userId, bookId);
  if (!book || !payload || typeof payload !== "object") return;
  const { error } = await supabase
    .from(BOOK_MEMORY_TABLE)
    .upsert({ book_id: bookId, memory_json: payload }, { onConflict: "book_id" });
  if (error) {
    console.warn("book memory upsert error", error);
  }
}

async function ensureCharacterAccess(userId, characterId) {
  if (!supabase || !userId || !characterId) return null;
  const { data, error } = await supabase
    .from(CHARACTERS_TABLE)
    .select("id, user_id, book_id")
    .eq("id", characterId)
    .maybeSingle();
  if (error) {
    console.warn("character access check error", error);
    return null;
  }
  if (!data || data.user_id !== userId) return null;
  return data;
}

function normalizeTraits(traits) {
  if (Array.isArray(traits)) {
    return traits.map((t) => `${t}`.trim()).filter(Boolean);
  }
  if (typeof traits === "string") {
    return traits
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

function buildNovelPrompt({ memory, chapterNumber, userInput }) {
  const limitedMemory = formatMemoryForPrompt(memory);
  const tone = limitedMemory?.tone || "original tone";
  const chapterValue = chapterNumber || 1;

  return `
You are an expert novel writer.

BOOK MEMORY:
${JSON.stringify(limitedMemory)}

TASK:
Continue writing Chapter ${chapterValue}.

RULES:
- Maintain character consistency
- Follow timeline strictly
- Keep tone: ${tone}
- Do NOT introduce contradictions

USER INPUT:
${userInput}
`;
}

app.post("/api/generate", requireAuth, requireBookQuota, async (req, res) => {
  const promptInput = (req.body?.prompt || "").trim();
  const chapterNumber = req.body?.chapterNumber || 1;
  const bookId = req.body?.bookId || null;
  if (!promptInput) {
    return res.status(400).json({ error: "Prompt is required." });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.json({ text: stubText({ prompt: promptInput }) });
    }

    const memory = bookId
      ? await getBookMemory(bookId, req.user.id)
      : await getMemoryPayload(req.user.id);
    const userInput = `Book idea: ${promptInput}\nReturn outline and chapter start.`;
    const prompt = buildNovelPrompt({ memory, chapterNumber, userInput });
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.85,
      max_tokens: 900,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) {
      return res.status(502).json({ error: "No text returned from model." });
    }

    try {
      const [delta, summaryList, consistency] = await Promise.all([
        extractMemoryDelta(client, text),
        extractChapterSummary(client, text),
        checkConsistency(client, memory, text),
      ]);
      const enriched = delta || {};
      if (summaryList?.length) {
        enriched.chapter_summaries = summaryList;
      }
      if (consistency?.consistency_notes?.length) {
        enriched.consistency_notes = consistency.consistency_notes;
      }
      if (Object.keys(enriched).length) {
        const merged = mergeMemory(memory, enriched);
        if (bookId) {
          await upsertBookMemory(bookId, req.user.id, merged);
        } else {
          await upsertMemoryPayload(req.user.id, merged);
        }
      }
    } catch (memErr) {
      console.warn("memory extract error", memErr);
    }

    res.json({ text });
  } catch (error) {
    console.error("/api/generate error", error);
    if (error?.status === 429) {
      return res.json({ text: stubText({ prompt: promptInput }) });
    }
    const message = error?.response?.data?.error?.message || error.message || "Generation failed.";
    res.status(500).json({ error: message });
  }
});

app.post("/api/generate/full", requireAuth, requireBookQuota, async (req, res) => {
  const promptInput = (req.body?.prompt || "").trim();
  const chapters = Math.min(Math.max(Number(req.body?.chapters) || 6, 3), 12);
  const wordsPerChapter = Math.min(Math.max(Number(req.body?.wordsPerChapter) || 300, 150), 800);
  const bookId = req.body?.bookId || null;

  if (!promptInput) {
    return res.status(400).json({ error: "Prompt is required." });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.json({ text: stubText({ prompt: promptInput }) });
    }

    const memory = bookId
      ? await getBookMemory(bookId, req.user.id)
      : await getMemoryPayload(req.user.id);

    const prompt = `You are a concise but rich novelist. Write a full short book based on the user pitch.

Book memory (may be empty):
${JSON.stringify(formatMemoryForPrompt(memory))}

Requirements:
- Total chapters: ${chapters}
- Aim for about ${wordsPerChapter} words per chapter (can flex 20%).
- Include a title and numbered chapters with headings.
- Maintain consistency with any memory details.
- Keep pacing tight; no filler.

User pitch:
${promptInput}
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.9,
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text) {
      return res.status(502).json({ error: "No text returned from model." });
    }

    res.json({ text });
  } catch (error) {
    console.error("/api/generate/full error", error);
    if (error?.status === 429) {
      return res.json({ text: stubText({ prompt: promptInput }) });
    }
    const message = error?.response?.data?.error?.message || error.message || "Full generation failed.";
    res.status(500).json({ error: message });
  }
});

app.post("/api/transform/stream", requireAuth, async (req, res) => {
  const text = (req.body?.text || "").trim();
  const mode = (req.body?.mode || "").trim();
  const chapterNumber = req.body?.chapterNumber || 1;
  const bookId = req.body?.bookId || null;

  if (!text) {
    return res.status(400).json({ error: "Text is required." });
  }

  const instructions = {
    rewrite: "Rewrite for clarity and pacing while preserving meaning.",
    expand: "Expand with vivid detail and richer scene-setting. Keep coherent flow.",
    shorten: "Condense to a tighter version without losing key beats.",
    add_dialogue: "Inject natural, character-driven dialogue that fits the scene.",
    make_emotional: "Amplify emotional resonance and interiority without melodrama.",
  };

  const directive = instructions[mode];
  if (!directive) {
    return res.status(400).json({ error: "Invalid mode." });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      const stub = stubText({ prompt: text, mode });
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.write(stub);
      return res.end();
    }

    const memory = bookId
      ? await getBookMemory(bookId, req.user.id)
      : await getMemoryPayload(req.user.id);
    const userInput = `Mode: ${mode}\nDirective: ${directive}\n\nOriginal Text:\n${text}`;
    const prompt = buildNovelPrompt({ memory, chapterNumber, userInput });
    const stream = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.85,
      max_tokens: 900,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    });

    let fullText = "";

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        fullText += content;
        res.write(content);
      }
    }

    if (fullText) {
      try {
        const [delta, summaryList, consistency] = await Promise.all([
          extractMemoryDelta(client, fullText),
          extractChapterSummary(client, fullText),
          checkConsistency(client, memory, fullText),
        ]);
        const enriched = delta || {};
        if (summaryList?.length) {
          enriched.chapter_summaries = summaryList;
        }
        if (consistency?.consistency_notes?.length) {
          enriched.consistency_notes = consistency.consistency_notes;
        }
        if (Object.keys(enriched).length) {
          const merged = mergeMemory(memory, enriched);
          if (bookId) {
            await upsertBookMemory(bookId, req.user.id, merged);
          } else {
            await upsertMemoryPayload(req.user.id, merged);
          }
        }
      } catch (memErr) {
        console.warn("memory extract error", memErr);
      }
    }

    res.end();
  } catch (error) {
    console.error("/api/transform/stream error", error);
    if (error?.status === 429) {
      const stub = stubText({ prompt: text, mode });
      if (!res.headersSent) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      res.write(stub);
      return res.end();
    }
    const message = error?.response?.data?.error?.message || error.message || "Transform failed.";
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    } else {
      res.write(`\n[error] ${message}`);
      res.end();
    }
  }
});

app.post("/api/generate/stream", requireAuth, requireBookQuota, async (req, res) => {
  const promptInput = (req.body?.prompt || "").trim();
  const chapterNumber = req.body?.chapterNumber || 1;
  const bookId = req.body?.bookId || null;
  if (!promptInput) {
    return res.status(400).json({ error: "Prompt is required." });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      const stub = stubText({ prompt: promptInput });
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.write(stub);
      return res.end();
    }

    const memory = bookId
      ? await getBookMemory(bookId, req.user.id)
      : await getMemoryPayload(req.user.id);
    const userInput = `Book idea: ${promptInput}\nReturn outline and chapter start.`;
    const prompt = buildNovelPrompt({ memory, chapterNumber, userInput });
    const stream = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.85,
      max_tokens: 900,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    });

    let fullText = "";

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        fullText += content;
        res.write(content);
      }
    }

    if (fullText) {
      try {
        const [delta, summaryList, consistency] = await Promise.all([
          extractMemoryDelta(client, fullText),
          extractChapterSummary(client, fullText),
          checkConsistency(client, memory, fullText),
        ]);
        const enriched = delta || {};
        if (summaryList?.length) {
          enriched.chapter_summaries = summaryList;
        }
        if (consistency?.consistency_notes?.length) {
          enriched.consistency_notes = consistency.consistency_notes;
        }
        if (Object.keys(enriched).length) {
          const merged = mergeMemory(memory, enriched);
          if (bookId) {
            await upsertBookMemory(bookId, req.user.id, merged);
          } else {
            await upsertMemoryPayload(req.user.id, merged);
          }
        }
      } catch (memErr) {
        console.warn("memory extract error", memErr);
      }
    }

    res.end();
  } catch (error) {
    console.error("/api/generate/stream error", error);
    if (error?.status === 429) {
      const stub = stubText({ prompt: promptInput });
      if (!res.headersSent) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      res.write(stub);
      return res.end();
    }
    const message = error?.response?.data?.error?.message || error.message || "Generation failed.";
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    } else {
      res.write(`\n[error] ${message}`);
      res.end();
    }
  }
});

app.post("/api/voice-book", requireAuth, upload.single("file"), async (req, res) => {
  const audio = req.file;
  if (!audio) {
    return res.status(400).json({ error: "Audio file required." });
  }

  const chapterNumber = req.body?.chapterNumber || 1;
  const bookId = req.body?.bookId || null;

  try {
    const file = new File([audio.buffer], audio.originalname || "audio.webm", {
      type: audio.mimetype || "audio/webm",
    });

    const transcription = await client.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "en",
      temperature: 0,
    });

    const transcript = transcription.text?.trim() || "";
    if (!transcript) {
      return res.status(502).json({ error: "No transcript returned from Whisper." });
    }

    const memory = bookId
      ? await getBookMemory(bookId, req.user.id)
      : await getMemoryPayload(req.user.id);
    const userInput = `Transcript:\n${transcript}\nReturn JSON only for a book draft. Schema: { title: string, outline: string[], chapters: [ { title: string, summary: string, content: string } ] }. No extra keys, no prose outside JSON.`;
    const prompt = buildNovelPrompt({ memory, chapterNumber, userInput });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      max_tokens: 1400,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    const parsed = safeJsonParse(raw);

    if (!parsed) {
      return res.status(502).json({ error: "Model did not return valid JSON.", raw });
    }

    try {
      const combinedText = [parsed.title, ...(parsed.outline || []), ...(parsed.chapters || []).map((c) => c.content || c.summary || "")]
        .filter(Boolean)
        .join("\n");
      const sourceText = combinedText || transcript;
      const [delta, summaryList, consistency] = await Promise.all([
        extractMemoryDelta(client, sourceText),
        extractChapterSummary(client, sourceText),
        checkConsistency(client, memory, sourceText),
      ]);
      const enriched = delta || {};
      if (summaryList?.length) {
        enriched.chapter_summaries = summaryList;
      }
      if (consistency?.consistency_notes?.length) {
        enriched.consistency_notes = consistency.consistency_notes;
      }
      if (Object.keys(enriched).length) {
        const merged = mergeMemory(memory, enriched);
        if (bookId) {
          await upsertBookMemory(bookId, req.user.id, merged);
        } else {
          await upsertMemoryPayload(req.user.id, merged);
        }
      }
    } catch (memErr) {
      console.warn("memory extract error", memErr);
    }

    res.json({ transcript, book: parsed });
  } catch (error) {
    console.error("/api/voice-book error", error);
    const message = error?.response?.data?.error?.message || error.message || "Voice pipeline failed.";
    res.status(500).json({ error: message });
  }
});

app.post("/api/cover", requireAuth, async (req, res) => {
  const prompt = (req.body?.prompt || "").trim();
  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required." });
  }

  try {
    const result = await client.images.generate({
      model: "gpt-image-1",
      prompt,
      size: "1024x1024",
      n: 1,
      response_format: "b64_json",
    });

    const b64 = result.data?.[0]?.b64_json;
    if (!b64) {
      return res.status(502).json({ error: "No image returned from model." });
    }

    res.json({ image: `data:image/png;base64,${b64}` });
  } catch (error) {
    console.error("/api/cover error", error);
    const message = error?.response?.data?.error?.message || error.message || "Cover generation failed.";
    res.status(500).json({ error: message });
  }
});

app.post("/api/exports", requireAuth, requireExportAccess, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured." });
  const userId = req.user?.id;
  const bookId = req.body?.bookId;
  const type = (req.body?.type || "").toLowerCase();

  if (!bookId || !type) {
    return res.status(400).json({ error: "bookId and type are required." });
  }

  if (!["pdf", "docx"].includes(type)) {
    return res.status(400).json({ error: "type must be pdf or docx." });
  }

  try {
    const { data: book, error: bookErr } = await supabase
      .from("books")
      .select("id")
      .eq("id", bookId)
      .eq("user_id", userId)
      .maybeSingle();

    if (bookErr) {
      console.error("exports book fetch error", bookErr);
      return res.status(500).json({ error: "Failed to verify book ownership." });
    }

    if (!book) {
      return res.status(404).json({ error: "Book not found for this user." });
    }

    const { data: exportRow, error: insertErr } = await supabase
      .from("exports")
      .insert({ user_id: userId, book_id: bookId, type, status: "pending" })
      .select()
      .maybeSingle();

    if (insertErr) {
      console.error("exports insert error", insertErr);
      return res.status(500).json({ error: "Failed to create export." });
    }

    res.json({ export: exportRow });
  } catch (error) {
    console.error("/api/exports error", error);
    res.status(500).json({ error: "Export request failed." });
  }
});

app.post("/api/exports/:id/render", requireAuth, requireExportAccess, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured." });
  const userId = req.user?.id;
  const exportId = req.params.id;
  const content = (req.body?.content || "").trim();
  const title = (req.body?.title || "Draft Book").trim();

  if (!content) {
    return res.status(400).json({ error: "content is required to render export." });
  }

  try {
    const { data: exp, error: fetchErr } = await supabase
      .from("exports")
      .select("id, user_id, type, status")
      .eq("id", exportId)
      .eq("user_id", userId)
      .maybeSingle();

    if (fetchErr) {
      console.error("export fetch error", fetchErr);
      return res.status(500).json({ error: "Failed to fetch export." });
    }

    if (!exp) {
      return res.status(404).json({ error: "Export not found for this user." });
    }

    if (exp.status !== "pending") {
      return res.status(400).json({ error: `Export already ${exp.status}.` });
    }

    let buffer;
    let path;
    let contentType;

    if (exp.type === "docx") {
      buffer = await renderDocxBuffer({ title, content });
      path = `${userId}/${exportId}.docx`;
      contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } else {
      buffer = await renderPdfBuffer({ title, content });
      path = `${userId}/${exportId}.pdf`;
      contentType = "application/pdf";
    }

    const { error: uploadErr } = await supabase.storage
      .from(EXPORTS_BUCKET)
      .upload(path, buffer, {
        contentType,
        upsert: true,
      });

    if (uploadErr) {
      console.error("export upload error", uploadErr);
      await supabase
        .from("exports")
        .update({ status: "failed", error: uploadErr.message })
        .eq("id", exportId);
      return res.status(500).json({ error: "Failed to store export." });
    }

    const { data: signed, error: signedErr } = await supabase.storage
      .from(EXPORTS_BUCKET)
      .createSignedUrl(path, 60 * 60); // 1 hour

    if (signedErr) {
      console.error("export signed url error", signedErr);
    }

    const { error: updateErr, data: updated } = await supabase
      .from("exports")
      .update({ status: "ready", asset_id: path })
      .eq("id", exportId)
      .select()
      .maybeSingle();

    if (updateErr) {
      console.error("export update error", updateErr);
      return res.status(500).json({ error: "Failed to update export status." });
    }

    res.json({ export: updated, url: signed?.signedUrl || null });
  } catch (error) {
    console.error("/api/exports/:id/render error", error);
    res.status(500).json({ error: "Render failed." });
  }
});

function renderPdfBuffer({ title, content }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err) => reject(err));

      doc.fontSize(20).text(title, { underline: true });
      doc.moveDown();
      doc.fontSize(12).text(content, { align: "left" });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function renderDocxBuffer({ title, content }) {
  const paragraphs = [];
  if (title) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: title, bold: true, size: 32 })],
        spacing: { after: 300 },
      })
    );
  }
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: content, size: 24 })],
    })
  );

  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs }],
  });

  return Packer.toBuffer(doc);
}

app.post("/api/stripe/create-checkout-session", requireAuth, async (req, res) => {
  return res.json({ url: null, sessionId: null, message: "Payments disabled." });

  // Payments disabled
});

app.post("/api/stripe/portal-session", requireAuth, async (req, res) => {
  return res.json({ url: null, message: "Payments disabled." });
});

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) return res.status(500).json({ error: "Stripe not configured." });
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Webhook signature verification failed", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const subscriptionId = session.subscription;
          const customerId = session.customer;
          const userId = session.metadata?.userId || null;
          if (subscriptionId && customerId) {
            await upsertSubscription({ subscriptionId, customerId, userId });
          }
          break;
        }
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          await upsertSubscription({
            subscriptionId: sub.id,
            customerId: sub.customer,
            userId: sub.metadata?.userId || null,
            priceId: sub.items?.data?.[0]?.price?.id,
            status: sub.status,
            currentPeriodEnd: sub.current_period_end,
          });
          break;
        }
        default:
          break;
      }
    } catch (error) {
      console.error("Webhook handling error", error);
      return res.status(500).send("Webhook handler failed");
    }

    res.json({ received: true });
  }
);

async function upsertSubscription({ subscriptionId, customerId, userId, priceId, status, currentPeriodEnd }) {
  if (!supabase) return;
  try {
    let plan = mapPriceToPlan(priceId);

    if (!plan && subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
      const price = sub.items?.data?.[0]?.price?.id;
      plan = mapPriceToPlan(price);
      status = status || sub.status;
      currentPeriodEnd = currentPeriodEnd || sub.current_period_end;
      priceId = price;
    }

    const update = {
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      subscription_status: status || null,
      current_period_end: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
    };
    if (plan) update.plan = plan;

    if (userId) {
      await supabase.from("profiles").upsert({ id: userId, ...update }, { onConflict: "id" });
    } else {
      await supabase.from("profiles").update(update).eq("stripe_customer_id", customerId);
    }
  } catch (error) {
    console.error("Supabase upsertSubscription error", error);
  }
}

function mapPriceToPlan(priceId) {
  if (!priceId) return null;
  const pro = process.env.STRIPE_PRICE_PRO;
  const elite = process.env.STRIPE_PRICE_ELITE;
  if (priceId === pro) return "pro";
  if (priceId === elite) return "elite";
  return null;
}

app.get("/api/profile", requireAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured." });
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized." });
  const profile = await ensureProfile(userId);
  res.json({ profile: profile || null, user: req.user });
});

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

app.get("/api/memory", requireAuth, async (req, res) => {
  const memory = await getMemoryPayload(req.user.id);
  res.json({ memory });
});

app.put("/api/memory", requireAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured." });
  const userId = req.user?.id;
  const payload = req.body?.payload;

  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "payload (object) is required." });
  }

  try {
    const { error } = await supabase
      .from(MEMORY_TABLE)
      .upsert({ user_id: userId, payload }, { onConflict: "user_id" });

    if (error) {
      console.error("memory upsert error", error);
      return res.status(500).json({ error: "Failed to store memory." });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("/api/memory error", err);
    res.status(500).json({ error: "Memory update failed." });
  }
});

app.get("/api/memory/dashboard", requireAuth, async (req, res) => {
  const userId = req.user?.id;
  const bookId = req.query?.bookId || null;
  try {
    const memory = bookId ? await getBookMemory(bookId, userId) : await getMemoryPayload(userId);
    const formatted = formatMemoryForPrompt(memory || {});
    res.json({ formatted, raw: memory || {} });
  } catch (err) {
    console.error("/api/memory/dashboard error", err);
    res.status(500).json({ error: "Failed to load memory dashboard." });
  }
});

app.get("/api/characters", requireAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured." });
  const userId = req.user?.id;
  const bookId = req.query?.bookId || null;

  try {
    let query = supabase.from(CHARACTERS_TABLE).select("id, name, role, traits, summary, book_id").eq("user_id", userId).order("created_at", { ascending: false });
    if (bookId) {
      const book = await ensureBookAccess(userId, bookId);
      if (!book) return res.status(404).json({ error: "Book not found for this user." });
      query = query.eq("book_id", bookId);
    }

    const { data, error } = await query;
    if (error) {
      console.error("characters list error", error);
      return res.status(500).json({ error: "Failed to load characters." });
    }
    res.json({ characters: data || [] });
  } catch (err) {
    console.error("/api/characters error", err);
    res.status(500).json({ error: "Failed to load characters." });
  }
});

app.post("/api/characters", requireAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured." });
  const userId = req.user?.id;
  const name = (req.body?.name || "").trim();
  const role = (req.body?.role || "").trim() || null;
  const summary = (req.body?.summary || "").trim() || null;
  const traits = normalizeTraits(req.body?.traits);
  const bookId = (req.body?.bookId || "").trim() || null;

  if (!name) {
    return res.status(400).json({ error: "name is required." });
  }

  if (bookId) {
    const book = await ensureBookAccess(userId, bookId);
    if (!book) return res.status(404).json({ error: "Book not found for this user." });
  }

  try {
    const { data, error } = await supabase
      .from(CHARACTERS_TABLE)
      .insert({ user_id: userId, book_id: bookId, name, role, summary, traits: traits.length ? traits : null })
      .select("id, name, role, traits, summary, book_id")
      .maybeSingle();

    if (error) {
      console.error("character insert error", error);
      return res.status(500).json({ error: "Failed to save character." });
    }

    res.json({ character: data });
  } catch (err) {
    console.error("/api/characters POST error", err);
    res.status(500).json({ error: "Failed to save character." });
  }
});

app.put("/api/characters/:id", requireAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured." });
  const userId = req.user?.id;
  const characterId = req.params.id;

  try {
    const character = await ensureCharacterAccess(userId, characterId);
    if (!character) return res.status(404).json({ error: "Character not found for this user." });

    const bookId = (req.body?.bookId || character.book_id || "").trim() || null;
    if (bookId) {
      const book = await ensureBookAccess(userId, bookId);
      if (!book) return res.status(404).json({ error: "Book not found for this user." });
    }

    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required." });
    const role = (req.body?.role || "").trim() || null;
    const summary = (req.body?.summary || "").trim() || null;
    const traits = normalizeTraits(req.body?.traits);

    const { data, error } = await supabase
      .from(CHARACTERS_TABLE)
      .update({ name, role, summary, traits: traits.length ? traits : null, book_id: bookId })
      .eq("id", characterId)
      .eq("user_id", userId)
      .select("id, name, role, traits, summary, book_id")
      .maybeSingle();

    if (error) {
      console.error("character update error", error);
      return res.status(500).json({ error: "Failed to update character." });
    }

    res.json({ character: data });
  } catch (err) {
    console.error("/api/characters PUT error", err);
    res.status(500).json({ error: "Failed to update character." });
  }
});

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
