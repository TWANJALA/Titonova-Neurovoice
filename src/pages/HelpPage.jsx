import React from "react";
import { Link } from "react-router-dom";

const HELP_SECTIONS = [
  {
    id: "getting-started",
    title: "Getting started",
    description: "Account setup and first access.",
    features: [
      {
        name: "Guest mode",
        how: "Open the workspace and start communicating immediately without creating an account.",
      },
      {
        name: "Create account",
        how: "Go to Sign Up, enter display name, email, and password, then submit to create a parent account.",
      },
      {
        name: "Sign in",
        how: "Go to Sign In, enter email/password, and the app routes you to your role-based home view.",
      },
      {
        name: "Role-based pages",
        how: "Therapist, admin, and super-admin pages appear automatically when your role includes those permissions.",
      },
    ],
  },
  {
    id: "core-workspace",
    title: "Core workspace",
    description: "Main communication workflow for daily AAC use.",
    features: [
      {
        name: "Child profile management",
        how: "Use Child Profile to switch, add, rename, or delete child profiles.",
      },
      {
        name: "Workspace mode",
        how: "Toggle Child Mode for fast speaking or Parent Mode for coaching, settings, and analytics.",
      },
      {
        name: "Sentence Builder",
        how: "Tap words and phrases to build text, then use Speak, Undo, Clear, or Save Phrase.",
      },
      {
        name: "Word Grid / Word Board",
        how: "Tap tiles to add words; tap star to favorite; filter using category and board tabs.",
      },
      {
        name: "Quick Phrases",
        how: "Tap any saved phrase to speak quickly, pin top phrases, and remove phrases no longer needed.",
      },
      {
        name: "Emergency phrase",
        how: "In Child Mode, tap the red I NEED HELP button for immediate emergency speech output.",
      },
    ],
  },
  {
    id: "smart-ai",
    title: "Smart AI communication",
    description: "Adaptive prediction, explainability, and learning loops.",
    features: [
      {
        name: "Smart Suggestions",
        how: "Use the suggested words panel while composing sentences for faster communication.",
      },
      {
        name: "Anticipated Next words",
        how: "Tap Anticipated Next chips to continue likely next tokens with fewer taps.",
      },
      {
        name: "Auto-Sentence",
        how: "Tap a suggested sentence to speak instantly, or long-press to edit before speaking.",
      },
      {
        name: "Why? explainability",
        how: "Open Why? on smart words/phrases/sentences to see ranking reasons and confidence details.",
      },
      {
        name: "Adaptive phrase suggestions",
        how: "Use repeated spoken phrases; the app promotes them into adaptive suggestions automatically.",
      },
      {
        name: "Digital twin personalization",
        how: "Keep using the app per child profile; intent, routine, and phrase pattern models improve over time.",
      },
    ],
  },
  {
    id: "accessibility-voice",
    title: "Accessibility and voice",
    description: "Controls for different motor, sensory, and language needs.",
    features: [
      {
        name: "Large tiles and hold-to-select",
        how: "Enable these in Parent Mode under Accessibility + Voice for easier targeting.",
      },
      {
        name: "Scan + Select",
        how: "Turn on Scan + Select, adjust scan interval, then use Select Highlighted to choose words.",
      },
      {
        name: "Cursor Mode",
        how: "Enable cursor mode to insert/edit words at a precise sentence position.",
      },
      {
        name: "Dual Language preview",
        how: "Turn on Dual Language to show translated sentence previews before speaking.",
      },
      {
        name: "Text-to-Speech settings",
        how: "Set provider, voice, rate, pitch, and volume in Parent Mode under Accessibility + Voice.",
      },
      {
        name: "Gesture shortcuts",
        how: "In Child Mode, swipe right to Speak, swipe down to Clear, and double-tap for quick speak.",
      },
    ],
  },
  {
    id: "progress",
    title: "Progress and coaching",
    description: "Goal tracking and caregiver intelligence tools.",
    features: [
      {
        name: "Daily speaking goal",
        how: "Set or apply suggested goals, then track progress, streak, and seven-day average.",
      },
      {
        name: "Insights and Progress Stories",
        how: "Review generated coaching insights and weekly progress summaries in Parent Mode.",
      },
      {
        name: "Parent Dashboard",
        how: "Use dashboard cards to monitor trends, auto-sentence quality, speed, and top words.",
      },
      {
        name: "Therapy goal modes",
        how: "Switch between Balanced, Expand Vocabulary, and Fastest Path to change AI recommendation priorities.",
      },
      {
        name: "Word management",
        how: "Search, filter, and add custom words to keep the board aligned to real-life routines.",
      },
    ],
  },
  {
    id: "billing",
    title: "Plans, checkout, and billing",
    description: "Subscription controls and plan-dependent capabilities.",
    features: [
      {
        name: "Pricing page",
        how: "Go to Pricing to compare Basic, Pro, and Premium and switch monthly/yearly intervals.",
      },
      {
        name: "Checkout",
        how: "Click Choose Plan to start Stripe checkout and return with activation status updates.",
      },
      {
        name: "Manage Billing portal",
        how: "Use Manage Billing to update payment methods, invoices, and active subscription settings.",
      },
      {
        name: "Backup tools (Pro/Premium)",
        how: "Use Export Backup and Import Backup under Sync + Backup when your plan includes backup tools.",
      },
      {
        name: "Auto-Speak (Pro/Premium)",
        how: "Enable Auto-Speak from Sync + Backup to speak selected content automatically.",
      },
    ],
  },
  {
    id: "professional",
    title: "Therapist, admin, and MCO tools",
    description: "Professional and organization-level workflows.",
    features: [
      {
        name: "Therapist Workspace",
        how: "Load child/caseload data, assign vocabulary sets, update goals, and export session reports.",
      },
      {
        name: "Admin Population Dashboard",
        how: "Load organization-wide data, filter cohorts, review KPIs/risk alerts, and export executive summaries.",
      },
      {
        name: "Super Admin Activity Dashboard",
        how: "Track global user activity, active-user trends, engagement levels, and export user activity CSV.",
      },
      {
        name: "MCO Outcomes Dashboard",
        how: "Analyze population outcomes and cost-oriented trends; export risk, therapist, and pilot packet reports.",
      },
    ],
  },
];

export default function HelpPage() {
  return (
    <main style={pageStyle}>
      <div style={shellStyle}>
        <header style={heroStyle}>
          <p style={eyebrowStyle}>Help Center</p>
          <h1 style={titleStyle}>Titonova NeuroVoice User Guide</h1>
          <p style={subtitleStyle}>
            Every major feature with practical usage steps for families, therapists, and admin teams.
          </p>
          <div style={actionRowStyle}>
            <Link to="/app" style={primaryLinkStyle}>
              Open Workspace
            </Link>
            <Link to="/pricing" style={secondaryLinkStyle}>
              View Plans
            </Link>
          </div>
          <div style={anchorRowStyle}>
            {HELP_SECTIONS.map((section) => (
              <a key={section.id} href={`#${section.id}`} style={anchorStyle}>
                {section.title}
              </a>
            ))}
          </div>
        </header>

        <section style={sectionGridStyle}>
          {HELP_SECTIONS.map((section) => (
            <article key={section.id} id={section.id} style={sectionCardStyle}>
              <h2 style={sectionTitleStyle}>{section.title}</h2>
              <p style={sectionDescriptionStyle}>{section.description}</p>
              <div style={featureListStyle}>
                {section.features.map((feature) => (
                  <div key={`${section.id}-${feature.name}`} style={featureCardStyle}>
                    <h3 style={featureTitleStyle}>{feature.name}</h3>
                    <p style={featureHowStyle}>{feature.how}</p>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}

const pageStyle = {
  minHeight: "100vh",
  padding: "18px min(3vw, 28px) 28px",
  background:
    "radial-gradient(980px 440px at 5% -8%, rgba(66, 145, 255, 0.3) 0%, transparent 62%), radial-gradient(760px 400px at 100% 0%, rgba(52, 214, 175, 0.2) 0%, transparent 66%), linear-gradient(165deg, #020817 0%, #06152d 44%, #0d2446 100%)",
  color: "#e8f4ff",
};

const shellStyle = {
  maxWidth: 1140,
  margin: "0 auto",
  display: "grid",
  gap: 14,
};

const heroStyle = {
  padding: 16,
  borderRadius: 16,
  border: "1px solid rgba(141, 186, 236, 0.42)",
  background: "linear-gradient(165deg, rgba(8, 24, 47, 0.88), rgba(8, 21, 41, 0.92))",
  boxShadow: "0 16px 34px rgba(2, 9, 20, 0.44)",
};

const eyebrowStyle = {
  margin: 0,
  fontSize: 12,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "#8ec8f7",
  fontWeight: 700,
};

const titleStyle = {
  margin: "6px 0 8px",
  fontSize: "clamp(1.45rem, 3.2vw, 2.2rem)",
  lineHeight: 1.1,
};

const subtitleStyle = {
  margin: 0,
  color: "#b6d3ea",
  lineHeight: 1.45,
};

const actionRowStyle = {
  marginTop: 12,
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};

const primaryLinkStyle = {
  textDecoration: "none",
  borderRadius: 999,
  padding: "8px 12px",
  border: "1px solid rgba(121, 225, 188, 0.7)",
  background: "linear-gradient(145deg, rgba(19, 101, 73, 0.85), rgba(16, 77, 58, 0.82))",
  color: "#e7fff4",
  fontWeight: 700,
  fontSize: 13,
};

const secondaryLinkStyle = {
  textDecoration: "none",
  borderRadius: 999,
  padding: "8px 12px",
  border: "1px solid rgba(130, 172, 214, 0.6)",
  background: "rgba(16, 42, 68, 0.76)",
  color: "#deefff",
  fontWeight: 700,
  fontSize: 13,
};

const anchorRowStyle = {
  marginTop: 12,
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
};

const anchorStyle = {
  textDecoration: "none",
  borderRadius: 999,
  padding: "4px 10px",
  border: "1px solid rgba(130, 172, 214, 0.52)",
  background: "rgba(13, 36, 60, 0.66)",
  color: "#cde4f9",
  fontSize: 12,
};

const sectionGridStyle = {
  display: "grid",
  gap: 12,
};

const sectionCardStyle = {
  borderRadius: 14,
  border: "1px solid rgba(133, 177, 220, 0.35)",
  background: "linear-gradient(165deg, rgba(9, 27, 46, 0.84), rgba(7, 21, 39, 0.9))",
  padding: 12,
};

const sectionTitleStyle = {
  margin: "0 0 4px",
  fontSize: 18,
};

const sectionDescriptionStyle = {
  margin: "0 0 10px",
  color: "#a9cae5",
  fontSize: 13,
};

const featureListStyle = {
  display: "grid",
  gap: 8,
  gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
};

const featureCardStyle = {
  borderRadius: 10,
  border: "1px solid rgba(127, 171, 213, 0.32)",
  background: "rgba(15, 39, 64, 0.72)",
  padding: "10px 10px 9px",
};

const featureTitleStyle = {
  margin: "0 0 5px",
  fontSize: 14,
  color: "#e9f7ff",
};

const featureHowStyle = {
  margin: 0,
  color: "#c0d9ee",
  lineHeight: 1.45,
  fontSize: 13,
};
