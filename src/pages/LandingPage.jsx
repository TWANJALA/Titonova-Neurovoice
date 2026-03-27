import React from "react";
import { Link } from "react-router-dom";

const styles = `
  :root {
    --bg-1: #050716;
    --bg-2: #07182e;
    --ink-1: #f3fbff;
    --ink-2: #b8cde0;
    --accent-1: #4de2c0;
    --accent-2: #5ea8ff;
    --accent-3: #ffc65d;
    --line: rgba(255, 255, 255, 0.14);
    --panel: rgba(255, 255, 255, 0.06);
  }

  .landing {
    min-height: 100vh;
    color: var(--ink-1);
    background: radial-gradient(1200px 600px at 5% -5%, #123f69 0%, transparent 55%),
      radial-gradient(900px 500px at 85% 10%, #0f3757 0%, transparent 60%),
      linear-gradient(160deg, var(--bg-1), var(--bg-2));
    font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
    position: relative;
    overflow: hidden;
  }

  .skip-link {
    position: absolute;
    left: 10px;
    top: 10px;
    transform: translateY(-140%);
    background: #e7f9ff;
    color: #03243a;
    padding: 10px 12px;
    border-radius: 10px;
    z-index: 30;
    font-weight: 700;
    text-decoration: none;
    transition: transform 140ms ease;
  }

  .skip-link:focus {
    transform: translateY(0);
  }

  .landing::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image: linear-gradient(var(--line) 1px, transparent 1px),
      linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 44px 44px;
    mask-image: radial-gradient(circle at center, black 15%, transparent 80%);
    opacity: 0.16;
    pointer-events: none;
  }

  .orb {
    position: absolute;
    border-radius: 999px;
    filter: blur(10px);
    opacity: 0.65;
    pointer-events: none;
    animation: drift 10s ease-in-out infinite;
  }

  .orb.a { width: 380px; height: 380px; top: -120px; right: -100px; background: #2a6dff44; }
  .orb.b { width: 300px; height: 300px; left: -90px; top: 210px; background: #2ce9bf33; animation-delay: 1.5s; }
  .orb.c { width: 240px; height: 240px; right: 22%; bottom: -70px; background: #ffe19130; animation-delay: 2.2s; }

  .shell {
    width: min(1140px, 92vw);
    margin: 0 auto;
    position: relative;
    z-index: 2;
    padding-bottom: 60px;
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 26px 0 16px;
  }

  .topbar-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .brand {
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 700;
    font-size: 0.85rem;
    color: #cbdef1;
  }

  .ghost-link {
    color: var(--ink-1);
    text-decoration: none;
    border: 1px solid var(--line);
    padding: 10px 14px;
    border-radius: 999px;
    transition: all 200ms ease;
    background: rgba(255, 255, 255, 0.02);
  }

  .ghost-link:hover { border-color: #8ec6ff; transform: translateY(-1px); }

  .ghost-link:focus-visible,
  .cta:focus-visible,
  .quick-link:focus-visible {
    outline: 3px solid #9dd7ff;
    outline-offset: 2px;
  }

  .hero {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 22px;
    align-items: stretch;
    margin-top: 18px;
  }

  .hero-card {
    border: 1px solid var(--line);
    background: linear-gradient(145deg, rgba(255,255,255,0.1), rgba(255,255,255,0.03));
    border-radius: 24px;
    padding: 30px;
    backdrop-filter: blur(6px);
    box-shadow: 0 20px 40px rgba(0,0,0,0.22);
    animation: reveal 700ms ease both;
  }

  .eyebrow {
    color: var(--accent-1);
    font-size: 0.78rem;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    margin: 0 0 10px;
    font-weight: 700;
  }

  .headline {
    margin: 0;
    line-height: 1.03;
    font-size: clamp(2rem, 5vw, 4.2rem);
    font-weight: 700;
    text-wrap: balance;
  }

  .headline .shine {
    background: linear-gradient(90deg, #ffffff, #a9dbff 45%, #8effd6 95%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .subcopy {
    margin: 16px 0 24px;
    color: var(--ink-2);
    max-width: 56ch;
    line-height: 1.6;
  }

  .badge-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 14px;
  }

  .badge {
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    font-size: 0.84rem;
    color: #dff2ff;
    background: rgba(255, 255, 255, 0.06);
  }

  .cta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .cta {
    text-decoration: none;
    color: #02101d;
    background: linear-gradient(110deg, var(--accent-1), #9ef2de);
    padding: 12px 18px;
    border-radius: 999px;
    font-weight: 700;
    border: 1px solid #8cf3dc;
    transition: transform 180ms ease;
  }

  .cta:hover { transform: translateY(-2px); }

  .cta.alt {
    color: #e8f4ff;
    background: transparent;
    border-color: #6caef3;
  }

  .quick-links {
    margin-top: 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .quick-link {
    color: #cae9ff;
    text-decoration: none;
    border-bottom: 1px dashed #76a9d6;
    padding-bottom: 2px;
  }

  .radar {
    position: relative;
    border: 1px solid var(--line);
    border-radius: 24px;
    background: radial-gradient(circle at center, rgba(77, 226, 192, 0.16), transparent 58%), #060d20;
    overflow: hidden;
    animation: reveal 780ms 120ms ease both;
  }

  .radar-grid {
    position: absolute;
    inset: 0;
    background-image: linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px);
    background-size: 34px 34px;
  }

  .pulse {
    position: absolute;
    border: 1px solid #55ffd89c;
    border-radius: 999px;
    inset: 18%;
    animation: pulse 3.4s ease-out infinite;
  }

  .pulse.two { animation-delay: 1.2s; }

  .radar-copy {
    position: absolute;
    left: 20px;
    right: 20px;
    bottom: 16px;
    color: #e1f4ff;
    display: grid;
    gap: 6px;
  }

  .radar-title {
    margin: 0;
    font-size: clamp(1.15rem, 2.2vw, 1.45rem);
    font-weight: 900;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #f5fdff;
    text-shadow: 0 0 12px rgba(101, 234, 198, 0.45);
    animation: intelligenceGlow 2.1s ease-in-out infinite;
  }

  .radar-detail {
    margin: 0;
    font-size: 0.98rem;
    line-height: 1.55;
    color: #d2e9fb;
    font-weight: 700;
    animation: intelligenceRise 900ms 120ms ease both;
  }

  .feature-grid {
    margin-top: 20px;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }

  .feature {
    border: 1px solid var(--line);
    background: var(--panel);
    border-radius: 16px;
    padding: 14px;
    animation: reveal 760ms ease both;
  }

  .feature:nth-child(2) { animation-delay: 100ms; }
  .feature:nth-child(3) { animation-delay: 180ms; }
  .feature:nth-child(4) { animation-delay: 240ms; }
  .feature:nth-child(5) { animation-delay: 300ms; }
  .feature:nth-child(6) { animation-delay: 360ms; }

  .feature h3 {
    margin: 0 0 8px;
    font-size: 1rem;
  }

  .feature p {
    margin: 0;
    color: var(--ink-2);
    line-height: 1.5;
    font-size: 0.95rem;
  }

  .metrics {
    margin-top: 18px;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }

  .how-section {
    margin-top: 20px;
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 14px;
    background: rgba(255, 255, 255, 0.05);
  }

  .how-title {
    margin: 0 0 10px;
    font-size: 1.15rem;
  }

  .how-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .step {
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 12px;
    background: rgba(255, 255, 255, 0.04);
  }

  .step strong {
    display: block;
    margin-bottom: 6px;
    color: #e7f6ff;
  }

  .step p {
    margin: 0;
    color: var(--ink-2);
    line-height: 1.45;
    font-size: 0.92rem;
  }

  .metric {
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 14px;
    background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02));
  }

  .metric strong {
    font-size: 1.8rem;
    color: #e5fbff;
    display: block;
  }

  .metric span {
    color: var(--ink-2);
    font-size: 0.92rem;
  }

  @keyframes reveal {
    from { opacity: 0; transform: translateY(14px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes drift {
    0%, 100% { transform: translate(0, 0); }
    50% { transform: translate(0, -16px); }
  }

  @keyframes pulse {
    0% { transform: scale(0.74); opacity: 0.9; }
    80% { transform: scale(1.45); opacity: 0; }
    100% { opacity: 0; }
  }

  @keyframes intelligenceGlow {
    0%, 100% {
      text-shadow: 0 0 10px rgba(101, 234, 198, 0.36);
      transform: translateY(0);
    }
    50% {
      text-shadow: 0 0 18px rgba(101, 234, 198, 0.6);
      transform: translateY(-1px);
    }
  }

  @keyframes intelligenceRise {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @media (max-width: 900px) {
    .topbar {
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
    }

    .hero { grid-template-columns: 1fr; }
    .feature-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .metrics { grid-template-columns: 1fr; }
    .how-grid { grid-template-columns: 1fr; }
    .radar { min-height: 260px; }
  }

  @media (max-width: 620px) {
    .topbar { padding-top: 18px; }
    .hero-card { padding: 20px; }
    .feature-grid { grid-template-columns: 1fr; }
    .headline { font-size: clamp(1.9rem, 10vw, 2.6rem); }
    .radar { min-height: 220px; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
    }
  }
`;

export default function LandingPage() {
  return (
    <main className="landing">
      <style>{styles}</style>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <div className="orb a" />
      <div className="orb b" />
      <div className="orb c" />

      <div className="shell">
        <header className="topbar">
          <div className="brand">Titonova NeuroVoice</div>
          <div className="topbar-actions">
            <Link to="/pricing" className="ghost-link">
              Pricing
            </Link>
            <Link to="/app" className="ghost-link">
              Open Workspace
            </Link>
          </div>
        </header>

        <section className="hero" id="main-content">
          <article className="hero-card">
            <p className="eyebrow">Global AAC That Works</p>
            <h1 className="headline">
              For non-verbal people: Help every child speak with confidence using a <span className="shine">clinically aligned AAC platform</span> trusted by families and therapists worldwide.
            </h1>
            <div className="badge-row">
              <span className="badge">No account required</span>
              <span className="badge">Kid-friendly controls</span>
              <span className="badge">Runs in browser</span>
            </div>
            <p className="subcopy">
              Start speaking in under a minute. Choose a child profile, tap words to build a sentence, and use smart
              suggestions to communicate faster with less effort.
            </p>
            <div className="cta-row">
              <Link to="/app" className="cta">
                Start Now
              </Link>
              <Link to="/pricing" className="cta alt">
                View Plans
              </Link>
              <a href="#features" className="cta alt">
                See Features
              </a>
            </div>
            <div className="quick-links">
              <a href="#how" className="quick-link">
                How it works
              </a>
              <a href="#features" className="quick-link">
                Why families choose it
              </a>
            </div>
          </article>

          <aside className="radar">
            <div className="radar-grid" />
            <div className="pulse" />
            <div className="pulse two" />
            <div className="radar-copy">
              <h3 className="radar-title">Live Intelligence</h3>
              <p className="radar-detail">
                Suggests next words, tracks progress, and learns each child&apos;s voice patterns over time.
              </p>
            </div>
          </aside>
        </section>

        <section id="features" className="feature-grid">
          <article className="feature">
            <h3>Child-Centric Profiles</h3>
            <p>Separate vocabulary, goals, analytics, and learning state for each child.</p>
          </article>
          <article className="feature">
            <h3>Predictive AAC Engine</h3>
            <p>Contextual suggestions tuned by real usage and phrase patterns.</p>
          </article>
          <article className="feature">
            <h3>Therapy-Ready Tracking</h3>
            <p>Daily goals, streaks, and trend metrics for sessions and home routines.</p>
          </article>
          <article className="feature">
            <h3>Quick Phrase Layer</h3>
            <p>Reusable phrases with adaptive suggestions from recent communication history.</p>
          </article>
          <article className="feature">
            <h3>Offline-First Feel</h3>
            <p>Fast local interactions designed for calm, low-friction communication moments.</p>
          </article>
          <article className="feature">
            <h3>Caregiver Control</h3>
            <p>Import/export backups, tune goals, and personalize experience without complexity.</p>
          </article>
        </section>

        <section className="metrics">
          <div className="metric">
            <strong>1-Tap</strong>
            <span>Emergency speak and phrase launch actions</span>
          </div>
          <div className="metric">
            <strong>Per-Child</strong>
            <span>Fully isolated model, goals, and custom words</span>
          </div>
          <div className="metric">
            <strong>Adaptive</strong>
            <span>Continuously learning suggestions and phrase ranking</span>
          </div>
        </section>

        <section id="how" className="how-section">
          <h2 className="how-title">How it works</h2>
          <div className="how-grid">
            <article className="step">
              <strong>1. Pick a child profile</strong>
              <p>Each child keeps separate words, goals, history, and learning state.</p>
            </article>
            <article className="step">
              <strong>2. Build and speak</strong>
              <p>Tap word tiles or phrases, then speak instantly with one clear action.</p>
            </article>
            <article className="step">
              <strong>3. Track progress</strong>
              <p>Review streaks, usage trends, and adaptive phrase suggestions over time.</p>
            </article>
          </div>
        </section>
      </div>
    </main>
  );
}
