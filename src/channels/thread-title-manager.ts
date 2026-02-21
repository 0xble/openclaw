import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded-runner.js";
import { isControlCommandMessage } from "../auto-reply/command-detection.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath, updateSessionStoreEntry } from "../config/sessions.js";
import type {
  NativeThreadTitleErrorClass,
  NativeThreadTitleState,
} from "../config/sessions/types.js";
import type { ResolvedAgentRoute } from "../routing/resolve-route.js";
import { isDefaultThreadPlaceholder } from "./conversation-title.js";

const RATE_LIMIT_RE = /\b429\b|rate[\s_-]*limit|too many requests/i;
const PERMISSION_RE =
  /\b403\b|missing_scope|not enough rights|forbidden|permission|can_manage_topics|not authorized/i;
const NOT_FOUND_RE =
  /thread not found|topic not found|chat not found|channel_not_found|\b404\b|not found/i;

const RATE_LIMIT_RETRY_MS = 5 * 60_000;
const NOT_FOUND_RETRY_MS = 30 * 60_000;
const PENDING_LEASE_MS = 60_000;
const MAX_PENDING_ATTEMPTS = 5_000;
const AI_TITLE_TIMEOUT_MS = 8_000;
const AI_FAILURE_BACKOFF_MS = 10 * 60_000;
const AI_TITLE_PROVIDER = "google";
const AI_TITLE_MODEL = "gemini-3-flash-preview";
const SLASH_COMMAND_RE = /^\/[a-z0-9_]+(?:\s|$)/i;
const STICKER_PLACEHOLDER_RE = /^\[Sticker(?: [^\]]+)?\](?:\s+.*)?$/i;
const MEDIA_PLACEHOLDER_TOKEN_RE = /<media:[^>]+>(?:\s*\([^)]*\))?/gi;
const SLACK_MEDIA_PLACEHOLDER_TOKEN_RE =
  /\[(?:Slack file|Forwarded image|attached)(?::\s*[^\]]+)?\]/gi;

const inFlightRenames = new Map<string, Promise<void>>();
const appliedThreadTitles = new Map<string, { title: string }>();
let aiTitleDisabledUntil = 0;

export type NativeThreadRef =
  | {
      provider: "slack";
      accountId: string;
      channelId: string;
      threadTs: string;
    }
  | {
      provider: "telegram";
      accountId: string;
      chatId: string;
      threadId: number;
      threadKind: "forum" | "dm";
    };

export function buildNativeThreadKey(threadRef: NativeThreadRef): string {
  if (threadRef.provider === "slack") {
    return `slack:${threadRef.accountId}:${threadRef.channelId}:${threadRef.threadTs}`;
  }
  return `telegram:${threadRef.accountId}:${threadRef.chatId}:${threadRef.threadKind}:${String(
    threadRef.threadId,
  )}`;
}

function rememberAppliedThreadTitleWithTitle(params: { threadKey: string; title: string }) {
  appliedThreadTitles.delete(params.threadKey);
  appliedThreadTitles.set(params.threadKey, { title: params.title });
  if (appliedThreadTitles.size <= MAX_PENDING_ATTEMPTS) {
    return;
  }
  const oldestKey = appliedThreadTitles.keys().next().value;
  if (oldestKey) {
    appliedThreadTitles.delete(oldestKey);
  }
}

function classifyRenameError(error: unknown): NativeThreadTitleErrorClass {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "");
  if (PERMISSION_RE.test(text)) {
    return "permission";
  }
  if (RATE_LIMIT_RE.test(text)) {
    return "rate_limit";
  }
  if (NOT_FOUND_RE.test(text)) {
    return "not_found";
  }
  return "unknown";
}

function resolveRetryDelayMs(params: {
  errorClass: NativeThreadTitleErrorClass;
  attempts: number;
}): number {
  if (params.errorClass === "permission") {
    return 0;
  }
  if (params.errorClass === "rate_limit") {
    return RATE_LIMIT_RETRY_MS;
  }
  if (params.errorClass === "not_found") {
    return NOT_FOUND_RETRY_MS;
  }
  const exponential = 60_000 * 2 ** Math.max(0, params.attempts - 1);
  return Math.min(exponential, 60 * 60_000);
}

function sanitizeAiTitle(params: {
  rawTitle?: string;
  maxChars: number;
  sourceText?: string;
}): string | undefined {
  if (typeof params.rawTitle !== "string") {
    return undefined;
  }
  const firstLine = params.rawTitle
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return undefined;
  }
  let title = firstLine
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^\d+[).:-]\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) {
    return undefined;
  }
  title = title.replace(/[;:,.!?]+$/g, "").trim();
  if (title.length > params.maxChars) {
    title = title.slice(0, params.maxChars).trim();
  }
  if (!title || title.length < 2) {
    return undefined;
  }
  if (isDefaultThreadPlaceholder(title)) {
    return undefined;
  }
  const wordCount = title.split(/\s+/).filter(Boolean).length;
  if (wordCount < 1 || wordCount > 8) {
    return undefined;
  }
  const normalizedSource = params.sourceText?.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalizedSource && title.toLowerCase() === normalizedSource) {
    return undefined;
  }
  return title;
}

function normalizeTitlePromptSource(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let text = value
    .replace(/<@[^>]+>/g, " ")
    .replace(/\[[^\]]*message id:[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return undefined;
  }
  if (
    isDefaultThreadPlaceholder(text) ||
    SLASH_COMMAND_RE.test(text) ||
    isControlCommandMessage(text)
  ) {
    return undefined;
  }
  if (STICKER_PLACEHOLDER_RE.test(text)) {
    return undefined;
  }
  text = text
    .replace(MEDIA_PLACEHOLDER_TOKEN_RE, " ")
    .replace(SLACK_MEDIA_PLACEHOLDER_TOKEN_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return undefined;
  }
  return text;
}

async function maybeGenerateAiThreadTitle(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  threadKey: string;
  primaryText?: string;
  fallbackText?: string;
  maxChars: number;
  log?: (message: string) => void;
}): Promise<string | undefined> {
  const now = Date.now();
  if (now < aiTitleDisabledUntil) {
    return undefined;
  }

  const promptSeed = [params.primaryText, params.fallbackText]
    .map((value) => normalizeTitlePromptSource(value))
    .find((value) => typeof value === "string" && value.length > 0);
  if (!promptSeed) {
    return undefined;
  }

  let tempDir: string | undefined;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-thread-title-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sessionId = `thread-title-${Date.now()}`;
    const prompt = [
      "Generate a concise chat thread title from the message below.",
      "Requirements:",
      "- 2 to 5 words.",
      "- Title Case.",
      "- Summarize intent; do not copy the sentence verbatim.",
      "- No quotes, no trailing punctuation.",
      "",
      `Message: ${promptSeed}`,
      "",
      "Reply with ONLY the title.",
    ].join("\n");
    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionKey: `thread-title:${params.threadKey}`,
      agentId: params.route.agentId,
      sessionFile,
      workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.route.agentId),
      agentDir: resolveAgentDir(params.cfg, params.route.agentId),
      config: params.cfg,
      prompt,
      provider: AI_TITLE_PROVIDER,
      model: AI_TITLE_MODEL,
      disableTools: true,
      timeoutMs: AI_TITLE_TIMEOUT_MS,
      runId: `${sessionId}-run`,
    });
    const aiRaw = result.payloads?.find((payload) => typeof payload.text === "string")?.text;
    const aiTitle = sanitizeAiTitle({
      rawTitle: aiRaw,
      maxChars: params.maxChars,
      sourceText: promptSeed,
    });
    return aiTitle;
  } catch (error) {
    aiTitleDisabledUntil = Date.now() + AI_FAILURE_BACKOFF_MS;
    params.log?.(`thread title ai generation failed for ${params.threadKey}: ${String(error)}`);
    return undefined;
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function markRenameAttempt(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  sessionKey?: string;
  threadKey: string;
  title: string;
}): Promise<{ shouldApply: boolean; attempts: number }> {
  if (!params.sessionKey) {
    return { shouldApply: true, attempts: 1 };
  }
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  const now = Date.now();
  const updated = await updateSessionStoreEntry({
    storePath,
    sessionKey: params.sessionKey,
    update: async (entry) => {
      const state = entry.nativeThreadTitle;
      if (state?.threadKey === params.threadKey) {
        if (state.status === "disabled") {
          return null;
        }
        if (state.status === "applied") {
          return null;
        }
        if (state.retryAfter && state.retryAfter > now) {
          const titleChanged = state.lastProposedTitle !== params.title;
          const canRetryEarly =
            state.status === "retry_after" && state.lastErrorClass === "unknown" && titleChanged;
          if (!canRetryEarly) {
            return null;
          }
        }
        if (
          state.status === "pending" &&
          state.lastAttemptAt &&
          now - state.lastAttemptAt < PENDING_LEASE_MS
        ) {
          return null;
        }
      }
      const attempts = (state?.threadKey === params.threadKey ? state.attempts : 0) ?? 0;
      const nextState: NativeThreadTitleState = {
        threadKey: params.threadKey,
        status: "pending",
        attempts: attempts + 1,
        lastAttemptAt: now,
        lastProposedTitle: params.title,
        retryAfter: undefined,
        appliedAt: undefined,
        appliedTitle: undefined,
        lastErrorClass: undefined,
      };
      return {
        nativeThreadTitle: nextState,
      };
    },
  });
  const state = updated?.nativeThreadTitle;
  if (!state || state.threadKey !== params.threadKey || state.status !== "pending") {
    return {
      shouldApply: false,
      attempts: state?.attempts ?? 0,
    };
  }
  return {
    shouldApply: true,
    attempts: state.attempts ?? 1,
  };
}

async function markRenameResult(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  sessionKey?: string;
  threadKey: string;
  title: string;
  attempts: number;
  errorClass?: NativeThreadTitleErrorClass;
}) {
  if (!params.sessionKey) {
    return;
  }
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  await updateSessionStoreEntry({
    storePath,
    sessionKey: params.sessionKey,
    update: async (entry) => {
      const state = entry.nativeThreadTitle;
      if (!state || state.threadKey !== params.threadKey) {
        return null;
      }
      if (!params.errorClass) {
        const nextState: NativeThreadTitleState = {
          threadKey: params.threadKey,
          status: "applied",
          attempts: params.attempts,
          lastAttemptAt: Date.now(),
          appliedAt: Date.now(),
          appliedTitle: params.title,
          lastProposedTitle: params.title,
        };
        return { nativeThreadTitle: nextState };
      }
      if (params.errorClass === "permission") {
        const nextState: NativeThreadTitleState = {
          ...state,
          status: "disabled",
          attempts: params.attempts,
          lastAttemptAt: Date.now(),
          lastErrorClass: params.errorClass,
        };
        return { nativeThreadTitle: nextState };
      }
      const retryDelayMs = resolveRetryDelayMs({
        errorClass: params.errorClass,
        attempts: params.attempts,
      });
      const nextState: NativeThreadTitleState = {
        ...state,
        status: "retry_after",
        attempts: params.attempts,
        lastAttemptAt: Date.now(),
        lastErrorClass: params.errorClass,
        retryAfter: Date.now() + retryDelayMs,
      };
      return { nativeThreadTitle: nextState };
    },
  });
}

function findAppliedThreadTitleInStore(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  threadKey: string;
}): string | undefined {
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.route.agentId,
    });
    const store = loadSessionStore(storePath);
    for (const entry of Object.values(store)) {
      const state = entry.nativeThreadTitle;
      if (!state || state.threadKey !== params.threadKey || state.status !== "applied") {
        continue;
      }
      const appliedTitle = state.appliedTitle ?? state.lastProposedTitle;
      if (
        typeof appliedTitle === "string" &&
        appliedTitle.trim().length > 0 &&
        !isDefaultThreadPlaceholder(appliedTitle)
      ) {
        return appliedTitle;
      }
    }
  } catch {
    // Best-effort guard only; failures should not block rename attempts.
  }
  return undefined;
}

export function requestNativeThreadTitleRename(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  sessionKey?: string;
  threadRef: NativeThreadRef;
  primaryText?: string;
  fallbackText?: string;
  maxChars: number;
  applyTitle: (title: string) => Promise<void>;
  log?: (message: string) => void;
}) {
  const threadKey = buildNativeThreadKey(params.threadRef);
  const inMemoryApplied = appliedThreadTitles.get(threadKey);
  if (inMemoryApplied) {
    return;
  }
  if (inFlightRenames.has(threadKey)) {
    return;
  }
  const job = (async () => {
    const persistedAppliedTitle = findAppliedThreadTitleInStore({
      cfg: params.cfg,
      route: params.route,
      threadKey,
    });
    if (persistedAppliedTitle) {
      rememberAppliedThreadTitleWithTitle({ threadKey, title: persistedAppliedTitle });
      return;
    }
    const title = await maybeGenerateAiThreadTitle({
      cfg: params.cfg,
      route: params.route,
      threadKey,
      primaryText: params.primaryText,
      fallbackText: params.fallbackText,
      maxChars: params.maxChars,
      log: params.log,
    });
    if (!title) {
      return;
    }
    const latestInMemoryApplied = appliedThreadTitles.get(threadKey);
    if (latestInMemoryApplied) {
      return;
    }
    const attempt = await markRenameAttempt({
      cfg: params.cfg,
      route: params.route,
      sessionKey: params.sessionKey,
      threadKey,
      title,
    });
    if (!attempt.shouldApply) {
      return;
    }
    try {
      await params.applyTitle(title);
      rememberAppliedThreadTitleWithTitle({ threadKey, title });
      await markRenameResult({
        cfg: params.cfg,
        route: params.route,
        sessionKey: params.sessionKey,
        threadKey,
        title,
        attempts: attempt.attempts,
      });
    } catch (error) {
      const errorClass = classifyRenameError(error);
      params.log?.(`thread title rename failed (${errorClass}) for ${threadKey}: ${String(error)}`);
      await markRenameResult({
        cfg: params.cfg,
        route: params.route,
        sessionKey: params.sessionKey,
        threadKey,
        title,
        attempts: attempt.attempts,
        errorClass,
      });
    }
  })().finally(() => {
    inFlightRenames.delete(threadKey);
  });
  inFlightRenames.set(threadKey, job);
  void job;
}

export async function waitForThreadTitleRenamesForTest() {
  const pending = [...inFlightRenames.values()];
  if (pending.length === 0) {
    return;
  }
  await Promise.allSettled(pending);
}

export function clearThreadTitleRenamesForTest() {
  inFlightRenames.clear();
  appliedThreadTitles.clear();
}
