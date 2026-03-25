import { logAnalytics } from "../firebase";

export type AuthEventOutcome = "success" | "error";
export type AuthMethod = "password" | "unknown";
export type SpeakEventSource =
  | "sentence_builder"
  | "quick_phrase"
  | "auto_sentence"
  | "ghost_sentence"
  | "emergency_button";
export type WorkspaceMode = "child" | "parent";

export type SignInEventPayload = {
  outcome: AuthEventOutcome;
  method?: AuthMethod;
  role?: string | null;
  destinationPath?: string | null;
  errorCode?: string | null;
};

export type SignUpEventPayload = {
  outcome: AuthEventOutcome;
  method?: AuthMethod;
  role?: string | null;
  destinationPath?: string | null;
  hasDisplayName?: boolean;
  errorCode?: string | null;
};

export type SignOutEventPayload = {
  role?: string | null;
  currentPath?: string | null;
};

export type SpeakClickedEventPayload = {
  source: SpeakEventSource;
  workspaceMode: WorkspaceMode;
  childProfileId?: string | null;
  languageCode?: string | null;
  wordCount: number;
  characterCount: number;
  autoSentenceSource?: string | null;
};

const normalizeInt = (value: unknown) => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
};

const normalizeText = (value: unknown) => {
  const parsed = String(value ?? "").trim();
  return parsed || undefined;
};

export function trackSignInEvent(payload: SignInEventPayload) {
  return logAnalytics("sign_in", {
    method: payload.method ?? "password",
    outcome: payload.outcome,
    role: normalizeText(payload.role),
    destination_path: normalizeText(payload.destinationPath),
    error_code: normalizeText(payload.errorCode),
  });
}

export function trackSignUpEvent(payload: SignUpEventPayload) {
  return logAnalytics("sign_up", {
    method: payload.method ?? "password",
    outcome: payload.outcome,
    role: normalizeText(payload.role),
    destination_path: normalizeText(payload.destinationPath),
    has_display_name: Boolean(payload.hasDisplayName),
    error_code: normalizeText(payload.errorCode),
  });
}

export function trackSignOutEvent(payload: SignOutEventPayload = {}) {
  return logAnalytics("sign_out", {
    role: normalizeText(payload.role),
    current_path: normalizeText(payload.currentPath),
  });
}

export function trackSpeakClickedEvent(payload: SpeakClickedEventPayload) {
  return logAnalytics("speak_clicked", {
    source: payload.source,
    workspace_mode: payload.workspaceMode,
    child_profile_id: normalizeText(payload.childProfileId),
    language_code: normalizeText(payload.languageCode),
    word_count: normalizeInt(payload.wordCount),
    character_count: normalizeInt(payload.characterCount),
    auto_sentence_source: normalizeText(payload.autoSentenceSource),
  });
}

export function normalizeAuthErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    return normalizeText((error as { code?: unknown }).code) ?? "unknown";
  }
  return "unknown";
}
