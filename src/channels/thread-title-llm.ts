import { parseModelRef } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ThreadTitleStrategy, ThreadTitleTarget } from "./thread-title.js";

const log = createSubsystemLogger("thread-title-llm");
const DEFAULT_TIMEOUT_MS = 3_000;
const SUPPORTED_PROVIDERS = new Set(["google", "anthropic"]);

function normalizeStrategy(raw?: string): ThreadTitleStrategy {
  const value = raw?.trim().toLowerCase();
  if (value === "llm" || value === "hybrid") {
    return value;
  }
  return "deterministic";
}

function normalizeThreadTitleModelRef(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes("/")) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  if (lower.includes("gemini")) {
    return `google/${trimmed}`;
  }
  if (lower.includes("claude")) {
    return `anthropic/${trimmed}`;
  }
  return trimmed;
}

function sanitizeLlmTitleCandidate(raw: string): string | undefined {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return undefined;
  }
  const cleaned = firstLine
    .replace(/^#+\s*/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

type ThreadTitleLlmSettings = {
  strategy: ThreadTitleStrategy;
  modelRef?: string;
  timeoutMs: number;
  allowOverwriteCurrentTitle: boolean;
};

function resolveConfigEnvVar(cfg: OpenClawConfig, key: string): string | undefined {
  const nested = cfg.env?.vars?.[key];
  if (typeof nested === "string" && nested.trim().length > 0) {
    return nested;
  }
  const sugar = cfg.env?.[key];
  if (typeof sugar === "string" && sugar.trim().length > 0) {
    return sugar;
  }
  return undefined;
}

function resolveThreadTitleEnvValue(
  cfg: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const fromConfig = cfg ? resolveConfigEnvVar(cfg, key) : undefined;
  if (fromConfig) {
    return fromConfig;
  }
  const fromProcess = env[key];
  return typeof fromProcess === "string" && fromProcess.trim().length > 0 ? fromProcess : undefined;
}

export function resolveThreadTitleLlmSettings(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): ThreadTitleLlmSettings {
  const strategy = normalizeStrategy(
    resolveThreadTitleEnvValue(cfg, env, "OPENCLAW_THREAD_TITLE_STRATEGY"),
  );
  const configuredModelRef = normalizeThreadTitleModelRef(
    resolveThreadTitleEnvValue(cfg, env, "OPENCLAW_THREAD_TITLE_MODEL"),
  );
  const timeoutRaw = Number.parseInt(
    resolveThreadTitleEnvValue(cfg, env, "OPENCLAW_THREAD_TITLE_TIMEOUT_MS") ?? "",
    10,
  );
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.min(60_000, Math.max(1, timeoutRaw))
      : DEFAULT_TIMEOUT_MS;
  const allowOverwriteRaw = resolveThreadTitleEnvValue(
    cfg,
    env,
    "OPENCLAW_THREAD_TITLE_OVERWRITE_EXISTING",
  )
    ?.trim()
    .toLowerCase();
  const allowOverwriteCurrentTitle =
    allowOverwriteRaw === "1" || allowOverwriteRaw === "true" || allowOverwriteRaw === "yes";
  return {
    strategy,
    modelRef: configuredModelRef,
    timeoutMs,
    allowOverwriteCurrentTitle,
  };
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

function resolveGoogleApiKey(
  cfg: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return (
    resolveThreadTitleEnvValue(cfg, env, "GEMINI_API_KEY") ??
    resolveThreadTitleEnvValue(cfg, env, "GOOGLE_API_KEY")
  );
}

function resolveAnthropicApiKey(
  cfg: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return resolveThreadTitleEnvValue(cfg, env, "ANTHROPIC_API_KEY");
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildTitlePrompt(maxChars: number, sourceText: string): string {
  return [
    `Name a chat topic in 13-${maxChars} chars. Title case. Output ONLY the name.`,
    "Capture the action and subject. Never abbreviate words except: API, CLI, DB, TG, CI, UI.",
    "",
    '"turn on the living room lights" -> "Turn On Lights"',
    '"can you check my recent emails" -> "Check Emails"',
    '"the deploy pipeline is broken" -> "Fix Deploy"',
    '"how should i configure nginx" -> "Config Nginx"',
    '"send a message to the team" -> "Team Message"',
    '"why does the icon look wrong" -> "Fix Icon"',
    '"start the migration to v2" -> "Migrate To V2"',
    '"cleanup after testing" -> "Cleanup Testing"',
    '"help me write a blog post" -> "Write Blog Post"',
    '"what is the weather today" -> "Weather Today"',
    "",
    sourceText,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Provider-specific fetch helpers
// ---------------------------------------------------------------------------

async function fetchGoogleTitle(params: {
  model: string;
  prompt: string;
  apiKey: string;
  signal: AbortSignal;
}): Promise<string | undefined> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${params.model}:generateContent?key=${params.apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: params.prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 64,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
    signal: params.signal,
  });
  if (!resp.ok) {
    log.debug(`google title API ${resp.status}: ${await resp.text().catch(() => "")}`);
    return undefined;
  }
  const json = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || undefined;
}

async function fetchAnthropicTitle(params: {
  model: string;
  prompt: string;
  apiKey: string;
  signal: AbortSignal;
}): Promise<string | undefined> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": params.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: 64,
      temperature: 0,
      messages: [{ role: "user", content: params.prompt }],
    }),
    signal: params.signal,
  });
  if (!resp.ok) {
    log.debug(`anthropic title API ${resp.status}: ${await resp.text().catch(() => "")}`);
    return undefined;
  }
  const json = (await resp.json()) as {
    content?: Array<{ text?: string }>;
  };
  return json.content?.[0]?.text?.trim() || undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateThreadTitleViaLLM(params: {
  cfg: OpenClawConfig;
  primaryText?: string;
  fallbackText?: string;
  maxChars: number;
  target: ThreadTitleTarget;
  modelRef?: string;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const primaryText = params.primaryText?.trim();
  const fallbackText = params.fallbackText?.trim();
  if (!primaryText && !fallbackText) {
    return undefined;
  }

  const defaultModel = params.cfg.agents?.defaults?.model;
  const defaultModelRef = typeof defaultModel === "string" ? defaultModel : defaultModel?.primary;
  const configuredModelRef =
    normalizeThreadTitleModelRef(params.modelRef) ?? normalizeThreadTitleModelRef(defaultModelRef);
  if (!configuredModelRef) {
    return undefined;
  }
  const parsedRef = parseModelRef(configuredModelRef, "anthropic");
  if (!parsedRef || !SUPPORTED_PROVIDERS.has(parsedRef.provider)) {
    return undefined;
  }

  const env = process.env;
  const apiKey =
    parsedRef.provider === "google"
      ? resolveGoogleApiKey(params.cfg, env)
      : resolveAnthropicApiKey(params.cfg, env);
  if (!apiKey) {
    log.debug(`no API key for ${parsedRef.provider}, skipping LLM title generation`);
    return undefined;
  }

  const sourceText = [primaryText, fallbackText]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n\n")
    .slice(0, 6_000);
  if (!sourceText) {
    return undefined;
  }

  const prompt = buildTitlePrompt(params.maxChars, sourceText);
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const rawText =
      parsedRef.provider === "google"
        ? await fetchGoogleTitle({
            model: parsedRef.model,
            prompt,
            apiKey,
            signal: controller.signal,
          })
        : await fetchAnthropicTitle({
            model: parsedRef.model,
            prompt,
            apiKey,
            signal: controller.signal,
          });
    if (!rawText) {
      return undefined;
    }
    return sanitizeLlmTitleCandidate(rawText);
  } catch (err) {
    const isAbort =
      err instanceof DOMException ||
      (err instanceof Error && err.name === "AbortError") ||
      (err instanceof TypeError && String(err.message).includes("abort"));
    log.debug(
      `thread title generation ${isAbort ? "timed out" : "failed"} (${parsedRef.provider}/${parsedRef.model}): ${String(err)}`,
    );
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
