import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient";

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [book, setBook] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState("");
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [bookJson, setBookJson] = useState(null);
  const [coverPrompt, setCoverPrompt] = useState("");
  const [coverImage, setCoverImage] = useState("");
  const [coverLoading, setCoverLoading] = useState(false);
  const [exportId, setExportId] = useState("");
  const [exportUrl, setExportUrl] = useState("");
  const [exportLoading, setExportLoading] = useState(false);
  const [billingLoading, setBillingLoading] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [plan, setPlan] = useState("free");
  const [userId, setUserId] = useState("guest");
  const [session, setSession] = useState({ user: { id: "guest", email: "guest@local" }, access_token: null });
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState("");
  const [memoryText, setMemoryText] = useState(`{
  "characters": ["John", "AI robot X"],
  "tone": "dark sci-fi",
  "timeline": "Mars colony year 2080"
}`);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memorySaving, setMemorySaving] = useState(false);
  const [dashboard, setDashboard] = useState(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [characters, setCharacters] = useState([]);
  const [charactersLoading, setCharactersLoading] = useState(false);
  const [characterForm, setCharacterForm] = useState({ name: "", role: "", traits: "", summary: "", bookId: "" });
  const [characterFilterBookId, setCharacterFilterBookId] = useState("");
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState("");

  const mediaRecorderRef = useRef(null);

  const generateBook = async () => {
    if (!prompt.trim()) {
      setError("Please describe your book idea first.");
      return;
    }

    setLoading(true);
    setError("");
    setBook("");

    try {
      const res = await fetch("/api/generate/full", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt }),
      });

      const data = await res.json();
      if (!res.ok || !data?.text) {
        throw new Error(data?.error || "Failed to generate book.");
      }

      setBook(data.text);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const runTransform = async (mode) => {
    if (!book.trim()) {
      setError("Generate or paste text first.");
      return;
    }

    setActionLoading(mode);
    setError("");
    const original = book;
    setBook("");

    try {
      const res = await fetch("/api/transform/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: original, mode }),
      });

      if (!res.ok || !res.body) {
        const message = await res.text();
        throw new Error(message || "Failed to start transform.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        const chunk = decoder.decode(result.value || new Uint8Array(), {
          stream: !done,
        });
        if (chunk) {
          setBook((prev) => prev + chunk);
        }
      }
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setActionLoading("");
    }
  };

  const startRecording = async () => {
    setError("");
    setTranscript("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        await sendVoice(blob);
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setError(err.message || "Microphone access failed.");
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      setIsRecording(false);
    }
  };

  const sendVoice = async (blob) => {
    setVoiceLoading(true);
    setBookJson(null);
    setBook("");
    setTranscript("");
    setError("");
    try {
      const form = new FormData();
      form.append("file", blob, "voice.webm");

      const res = await fetch("/api/voice-book", {
        method: "POST",
        headers: {},
        body: form,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Voice processing failed.");
      }

      setTranscript(data.transcript || "");
      setBookJson(data.book || null);
      if (data.book) {
        setBook(formatBook(data.book));
      } else {
        setBook(data.raw || "");
      }
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setVoiceLoading(false);
    }
  };

  const formatBook = (bookObj) => {
    if (!bookObj) return "";
    const lines = [];
    if (bookObj.title) lines.push(`# ${bookObj.title}`);
    if (bookObj.outline?.length) {
      lines.push("\nOutline:");
      bookObj.outline.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
    }
    if (bookObj.chapters?.length) {
      lines.push("\nChapters:");
      bookObj.chapters.forEach((ch, idx) => {
        lines.push(`\n${idx + 1}. ${ch.title || "Chapter"}`);
        if (ch.summary) lines.push(`Summary: ${ch.summary}`);
        if (ch.content) lines.push(ch.content);
      });
    }
    return lines.join("\n");
  };

  const signIn = async () => {
    setNotice("Auth disabled. You are in guest mode.");
  };

  const signOut = async () => {
    setNotice("Auth disabled. You are in guest mode.");
  };

  const saveMemory = async () => {
    setMemorySaving(true);
    setError("");
    try {
      let parsed;
      try {
        parsed = JSON.parse(memoryText);
      } catch (err) {
        throw new Error("Memory must be valid JSON.");
      }

      const res = await fetch("/api/memory", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ payload: parsed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save memory.");
      setNotice("Memory saved.");
    } catch (err) {
      setError(err.message || "Failed to save memory.");
    } finally {
      setMemorySaving(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      setProfileLoading(true);
      setSession({ user: { id: "guest", email: "guest@local" }, access_token: null });
      setUserId("guest");
      await fetchProfile();
      await fetchMemory();
      await fetchDashboard();
      await fetchCharacters();
      setProfileLoading(false);
    };
    init();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    const checkout = params.get("checkout");
    if (session && (sessionId || checkout === "success")) {
      fetchProfile(session.access_token);
      setNotice("Billing updated. Plan refreshed.");
      window.history.replaceState({}, "", window.location.pathname);
    } else if (checkout === "cancel") {
      setNotice("Checkout canceled.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [session]);

  const fetchProfile = async (token) => {
    try {
      const res = await fetch(`/api/profile`, {
        headers: {},
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load profile.");
      const profile = data.profile;
      if (profile) {
        setPlan(profile.plan || "free");
        setCustomerId(profile.stripe_customer_id || "");
      } else {
        setPlan("free");
        setCustomerId("");
      }
    } catch (err) {
      console.error(err);
      setPlan("free");
    }
  };

  const fetchMemory = async (token) => {
    setMemoryLoading(true);
    try {
      const res = await fetch(`/api/memory`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load memory.");
      if (data.memory) {
        setMemoryText(JSON.stringify(data.memory, null, 2));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setMemoryLoading(false);
    }
  };

  const fetchDashboard = async (token, bookId = "") => {
    setDashboardLoading(true);
    try {
      const query = bookId ? `?bookId=${encodeURIComponent(bookId)}` : "";
      const res = await fetch(`/api/memory/dashboard${query}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load memory dashboard.");
      setDashboard(data || null);
    } catch (err) {
      console.error(err);
    } finally {
      setDashboardLoading(false);
    }
  };

  const fetchCharacters = async (token, bookId = "") => {
    setCharactersLoading(true);
    try {
      const query = bookId ? `?bookId=${encodeURIComponent(bookId)}` : "";
      const res = await fetch(`/api/characters${query}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load characters.");
      setCharacters(Array.isArray(data.characters) ? data.characters : []);
    } catch (err) {
      console.error(err);
    } finally {
      setCharactersLoading(false);
    }
  };

  const createCharacter = async () => {
    const name = characterForm.name.trim();
    if (!name) {
      setError("Name is required for characters.");
      return;
    }
    setCharactersLoading(true);
    setError("");
    try {
      const payload = {
        name,
        role: characterForm.role.trim() || null,
        traits: characterForm.traits.trim(),
        summary: characterForm.summary.trim() || null,
        bookId: characterForm.bookId.trim() || null,
      };

      const res = await fetch("/api/characters", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save character.");

      setNotice("Character saved.");
      setCharacterForm({ name: "", role: "", traits: "", summary: "", bookId: characterForm.bookId });
      await fetchCharacters(session.access_token, characterForm.bookId.trim());
    } catch (err) {
      setError(err.message || "Failed to save character.");
    } finally {
      setCharactersLoading(false);
    }
  };

  const generateCover = async () => {
    const effectivePrompt = (coverPrompt || bookJson?.title || prompt || "").trim();
    if (!effectivePrompt) {
      setError("Provide a cover prompt or a title first.");
      return;
    }
    setCoverLoading(true);
    setError("");
    setCoverImage("");
    try {
      const res = await fetch("/api/cover", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: effectivePrompt }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Cover generation failed.");
      }
      setCoverImage(data.image || "");
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setCoverLoading(false);
    }
  };

  const renderExport = async () => {
    if (plan === "free") {
      setError("Upgrade to export.");
      return;
    }
    if (!exportId.trim()) {
      setError("Enter an export ID.");
      return;
    }
    if (!book.trim()) {
      setError("Generate or paste text first.");
      return;
    }

    setExportLoading(true);
    setError("");
    setNotice("");
    setExportUrl("");

    try {
      const res = await fetch(`/api/exports/${exportId.trim()}/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: book,
          title: bookJson?.title || prompt || "Draft Book",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Export render failed.");
      }

      setExportUrl(data.url || "");
      setNotice("Export rendered. Download below.");
    } catch (err) {
      setError(err.message || "Export render failed.");
    } finally {
      setExportLoading(false);
    }
  };

  const pricePro = import.meta.env.VITE_STRIPE_PRICE_PRO || "";
  const priceElite = import.meta.env.VITE_STRIPE_PRICE_ELITE || "";

  const startCheckout = async (tier) => {
    const priceId = tier === "pro" ? pricePro : priceElite;
    if (!priceId) {
      setError(`Missing price ID for ${tier.toUpperCase()}. Set VITE_STRIPE_PRICE_${tier.toUpperCase()} in frontend env and STRIPE_PRICE_${tier.toUpperCase()} in backend.`);
      return;
    }
    if (!userId) {
      setError("Sign in first to upgrade.");
      return;
    }
    setBillingLoading(tier);
    setError("");
    try {
      const successUrl = `${window.location.origin}/?checkout=success`;
      const cancelUrl = `${window.location.origin}/?checkout=cancel`;
      const res = await fetch("/api/stripe/create-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ priceId, successUrl, cancelUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Checkout failed.");
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      setError(err.message || "Checkout failed.");
    } finally {
      setBillingLoading("");
    }
  };

  const openPortal = async () => {
    if (!userId) {
      setError("Sign in first to manage billing.");
      return;
    }
    if (!customerId.trim()) {
      setError("No Stripe customer found. Start a checkout first.");
      return;
    }
    setBillingLoading("portal");
    setError("");
    try {
      const returnUrl = window.location.origin;
      const res = await fetch("/api/stripe/portal-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ customerId: customerId.trim(), returnUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Portal session failed.");
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      setError(err.message || "Portal session failed.");
    } finally {
      setBillingLoading("");
    }
  };

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-3xl p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="text-sm text-gray-300">Plan: {plan || "free"} (payments disabled)</div>
          <div className="text-sm text-gray-400">Guest mode: auth disabled.</div>
        </div>
        {notice && (
          <div className="mb-4 rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200">
            {notice}
          </div>
        )}
        <header className="mb-6">
          <h1 className="text-3xl font-bold">TitoNova Book Engine 🚀</h1>
          <p className="mt-2 text-sm text-gray-300">
            Describe your book and let AI draft the first pass.
          </p>
        </header>

        <section className="space-y-3">
          <textarea
            className="w-full rounded-md border border-gray-800 bg-gray-900 p-3 text-white focus:border-green-500 focus:outline-none"
            rows={6}
            placeholder="A cyberpunk heist across neon-drenched Lagos..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={loading}
          />

          <div className="flex items-center gap-3">
            <button
              onClick={generateBook}
              disabled={loading || !!actionLoading || voiceLoading || coverLoading || !!billingLoading}
              className="rounded-md bg-green-500 px-6 py-2 font-semibold text-black transition hover:bg-green-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Generating..." : "Generate Book"}
            </button>
            {error && <span className="text-sm text-red-400">{error}</span>}
          </div>

          <div className="flex flex-wrap gap-2">
            {["rewrite", "expand", "shorten", "add_dialogue", "make_emotional"].map((mode) => {
              const labelMap = {
                rewrite: "Rewrite",
                expand: "Expand",
                shorten: "Shorten",
                add_dialogue: "Add dialogue",
                make_emotional: "Make emotional",
              };
              const label = labelMap[mode] || mode;
              const active = actionLoading === mode;
              return (
                <button
                  key={mode}
                  onClick={() => runTransform(mode)}
                  disabled={loading || !!actionLoading || voiceLoading || coverLoading || !!billingLoading}
                  className={`rounded-md border border-gray-700 px-4 py-2 text-sm transition ${
                    active
                      ? "bg-blue-500 text-black"
                      : "bg-gray-800 text-white hover:bg-gray-700"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  {active ? "Working..." : label}
                </button>
              );
            })}
          </div>
        </section>

        <section className="mt-8 space-y-3">
          <h2 className="text-xl font-semibold">Voice to Book</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={isRecording ? stopRecording : startRecording}
              disabled={voiceLoading || loading || !!actionLoading || coverLoading || !!billingLoading}
              className={`rounded-md px-4 py-2 font-semibold text-black transition ${
                isRecording ? "bg-red-500 hover:bg-red-400" : "bg-yellow-400 hover:bg-yellow-300"
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {isRecording ? "Stop Recording" : "Record Voice"}
            </button>
            {voiceLoading && <span className="text-sm text-gray-300">Processing audio...</span>}
            <span className="text-sm text-gray-400">Voice capture enabled (payments off).</span>
          </div>
          {transcript && (
            <div className="rounded-md bg-gray-900 p-3 text-sm text-gray-200">
              <div className="font-semibold text-white">Transcript</div>
              <div className="mt-1 whitespace-pre-wrap text-gray-200">{transcript}</div>
            </div>
          )}
        </section>

        <section className="mt-8 space-y-3">
          <h2 className="text-xl font-semibold">Narrative Memory</h2>
          <p className="text-sm text-gray-400">Store characters, tone, timeline, or other JSON that will be injected into generation and transforms.</p>
          <textarea
            className="w-full rounded-md border border-gray-800 bg-gray-900 p-3 font-mono text-sm text-white focus:border-green-500 focus:outline-none"
            rows={8}
            value={memoryText}
            onChange={(e) => setMemoryText(e.target.value)}
            disabled={memoryLoading || memorySaving}
          />
          <div className="flex items-center gap-3">
            <button
              onClick={saveMemory}
              disabled={memorySaving}
              className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-black transition hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {memorySaving ? "Saving..." : "Save Memory"}
            </button>
            {memoryLoading && <span className="text-sm text-gray-400">Loading memory...</span>}
          </div>
        </section>

        <section className="mt-8 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Visual Memory Dashboard</h2>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="rounded-md border border-gray-800 bg-gray-900 p-2 text-sm text-white focus:border-green-500 focus:outline-none"
                placeholder="Book ID (optional)"
                value={characterFilterBookId}
                onChange={(e) => setCharacterFilterBookId(e.target.value)}
              />
              <button
                onClick={() => fetchDashboard(undefined, characterFilterBookId)}
                disabled={dashboardLoading}
                className="rounded-md border border-gray-700 px-3 py-1 text-sm font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {dashboardLoading ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          {dashboard ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-md border border-gray-800 bg-gray-900 p-3">
                <div className="text-sm font-semibold text-white">Characters</div>
                <div className="mt-2 space-y-1 text-sm text-gray-200">
                  {dashboard.formatted?.characters?.length ? (
                    dashboard.formatted.characters.map((c, idx) => (
                      <div key={idx} className="rounded-md bg-gray-800 px-2 py-1">{c}</div>
                    ))
                  ) : (
                    <div className="text-gray-500">None yet.</div>
                  )}
                </div>
              </div>

              <div className="rounded-md border border-gray-800 bg-gray-900 p-3">
                <div className="text-sm font-semibold text-white">Tone</div>
                <div className="mt-2 text-sm text-gray-200">{dashboard.formatted?.tone || "Not set"}</div>
              </div>

              <div className="rounded-md border border-gray-800 bg-gray-900 p-3">
                <div className="text-sm font-semibold text-white">World Rules</div>
                <div className="mt-2 space-y-1 text-sm text-gray-200">
                  {dashboard.formatted?.world_rules?.length ? (
                    dashboard.formatted.world_rules.map((rule, idx) => (
                      <div key={idx} className="rounded-md bg-gray-800 px-2 py-1">{rule}</div>
                    ))
                  ) : (
                    <div className="text-gray-500">None yet.</div>
                  )}
                </div>
              </div>

              <div className="rounded-md border border-gray-800 bg-gray-900 p-3">
                <div className="text-sm font-semibold text-white">Timeline</div>
                <div className="mt-2 text-sm text-gray-200">{dashboard.formatted?.timeline || "Not set"}</div>
              </div>

              <div className="rounded-md border border-gray-800 bg-gray-900 p-3">
                <div className="text-sm font-semibold text-white">Recent Events</div>
                <div className="mt-2 space-y-1 text-sm text-gray-200">
                  {dashboard.formatted?.recent_events?.length ? (
                    dashboard.formatted.recent_events.map((evt, idx) => (
                      <div key={idx} className="rounded-md bg-gray-800 px-2 py-1">{evt}</div>
                    ))
                  ) : (
                    <div className="text-gray-500">None yet.</div>
                  )}
                </div>
              </div>

              <div className="rounded-md border border-gray-800 bg-gray-900 p-3">
                <div className="text-sm font-semibold text-white">Chapter Summaries</div>
                <div className="mt-2 space-y-1 text-sm text-gray-200">
                  {dashboard.formatted?.chapter_summaries?.length ? (
                    dashboard.formatted.chapter_summaries.map((sum, idx) => (
                      <div key={idx} className="rounded-md bg-gray-800 px-2 py-1">{sum}</div>
                    ))
                  ) : (
                    <div className="text-gray-500">None yet.</div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-gray-800 bg-gray-900 p-3 text-sm text-gray-400">No memory loaded yet.</div>
          )}
        </section>

        <section className="mt-8 space-y-3">
          <h2 className="text-xl font-semibold">Character Tracker</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-2 rounded-md border border-gray-800 bg-gray-900 p-3">
              <input
                className="w-full rounded-md border border-gray-800 bg-gray-950 p-2 text-sm text-white focus:border-green-500 focus:outline-none"
                placeholder="Name"
                value={characterForm.name}
                onChange={(e) => setCharacterForm({ ...characterForm, name: e.target.value })}
              />
              <input
                className="w-full rounded-md border border-gray-800 bg-gray-950 p-2 text-sm text-white focus:border-green-500 focus:outline-none"
                placeholder="Role (e.g., Protagonist)"
                value={characterForm.role}
                onChange={(e) => setCharacterForm({ ...characterForm, role: e.target.value })}
              />
              <input
                className="w-full rounded-md border border-gray-800 bg-gray-950 p-2 text-sm text-white focus:border-green-500 focus:outline-none"
                placeholder="Traits (comma separated)"
                value={characterForm.traits}
                onChange={(e) => setCharacterForm({ ...characterForm, traits: e.target.value })}
              />
              <input
                className="w-full rounded-md border border-gray-800 bg-gray-950 p-2 text-sm text-white focus:border-green-500 focus:outline-none"
                placeholder="Book ID (optional)"
                value={characterForm.bookId}
                onChange={(e) => setCharacterForm({ ...characterForm, bookId: e.target.value })}
              />
              <textarea
                className="w-full rounded-md border border-gray-800 bg-gray-950 p-2 text-sm text-white focus:border-green-500 focus:outline-none"
                placeholder="Summary / notes"
                rows={3}
                value={characterForm.summary}
                onChange={(e) => setCharacterForm({ ...characterForm, summary: e.target.value })}
              />
              <button
                onClick={createCharacter}
                disabled={charactersLoading}
                className="w-full rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-black transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {charactersLoading ? "Saving..." : "Save Character"}
              </button>
            </div>

            <div className="space-y-2 rounded-md border border-gray-800 bg-gray-900 p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-white">Character Roster</div>
                <button
                  onClick={() => fetchCharacters(undefined, characterFilterBookId)}
                  disabled={charactersLoading}
                  className="rounded-md border border-gray-700 px-3 py-1 text-xs font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {charactersLoading ? "Reloading..." : "Reload"}
                </button>
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {characters.length === 0 ? (
                  <div className="text-sm text-gray-400">No characters yet.</div>
                ) : (
                  characters.map((c) => (
                    <div key={c.id} className="rounded-md border border-gray-800 bg-gray-950 p-3 text-sm text-gray-100">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white">{c.name}</span>
                        <span className="text-xs text-gray-400">{c.role || ""}</span>
                      </div>
                      {c.summary && <div className="mt-1 text-gray-300">{c.summary}</div>}
                      {Array.isArray(c.traits) && c.traits.length > 0 && (
                        <div className="mt-1 text-xs text-gray-400">Traits: {c.traits.join(", ")}</div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="mt-8 space-y-3">
          <h2 className="text-xl font-semibold">Book Cover Generator</h2>
          <input
            className="w-full rounded-md border border-gray-800 bg-gray-900 p-3 text-white focus:border-green-500 focus:outline-none"
            placeholder="Describe the cover (or leave blank to use your title)"
            value={coverPrompt}
            onChange={(e) => setCoverPrompt(e.target.value)}
            disabled={coverLoading || loading || !!actionLoading || voiceLoading || !!billingLoading || plan === "free"}
          />
          <div className="flex items-center gap-3">
            <button
              onClick={generateCover}
              disabled={coverLoading || loading || !!actionLoading || voiceLoading || !!billingLoading}
              className="rounded-md bg-purple-500 px-4 py-2 font-semibold text-black transition hover:bg-purple-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {coverLoading ? "Generating..." : "Generate Cover"}
            </button>
            {coverImage && <span className="text-sm text-gray-300">Cover ready below.</span>}
            <span className="text-sm text-gray-400">Covers enabled (payments off).</span>
          </div>
          {coverImage && (
            <div className="overflow-hidden rounded-md border border-gray-800 bg-gray-900 p-3">
              <img
                src={coverImage}
                alt="Generated book cover"
                className="w-full max-w-md rounded-md"
              />
            </div>
          )}
        </section>

        <section className="mt-8 space-y-3">
          <h2 className="text-xl font-semibold">Export & Download</h2>
          <p className="text-sm text-gray-400">Use an existing export ID and render the current draft into PDF or DOCX. Content uses the draft text above.</p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="flex-1 min-w-[200px] rounded-md border border-gray-800 bg-gray-900 p-3 text-sm text-white focus:border-green-500 focus:outline-none"
              placeholder="Export ID (from /api/exports)"
              value={exportId}
              onChange={(e) => setExportId(e.target.value)}
              disabled={exportLoading}
            />
            <button
              onClick={renderExport}
              disabled={exportLoading || !exportId.trim()}
              className="rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-black transition hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {exportLoading ? "Rendering..." : "Render Export"}
            </button>
          </div>
          <span className="text-sm text-gray-400">Exports enabled (payments off).</span>
          {exportUrl && (
            <a
              className="inline-block rounded-md border border-gray-700 bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
              href={exportUrl}
              target="_blank"
              rel="noreferrer"
            >
              Download export
            </a>
          )}
        </section>

        <section className="mt-8 space-y-3">
          <h2 className="text-xl font-semibold">Billing</h2>
          <div className="text-sm text-gray-300">Plan: {plan || "free"}</div>
          <div className="rounded-md border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-300">
            Payments are disabled in this environment. Upgrades and billing portals are turned off.
          </div>
        </section>

        <section className="mt-8">
          <h2 className="text-xl font-semibold">Draft</h2>
          <pre className="mt-3 whitespace-pre-wrap rounded-md bg-gray-900 p-4 text-sm leading-relaxed">
            {book || "Your draft will appear here."}
          </pre>
        </section>
      </div>
    </div>
  );
}
