import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { parseModelRef } from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ThreadTitleStrategy, ThreadTitleTarget } from "./thread-title.js";

const log = createSubsystemLogger("thread-title-llm");
const DEFAULT_TIMEOUT_MS = 12_000;
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
      ? Math.min(60_000, Math.max(3_000, timeoutRaw))
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

  const sourceText = [primaryText, fallbackText]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n\n")
    .slice(0, 6_000);
  if (!sourceText) {
    return undefined;
  }

  let tempDir: string | undefined;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-thread-title-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentId = resolveDefaultAgentId(params.cfg);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const agentDir = resolveAgentDir(params.cfg, agentId);
    const prompt = [
      `Name a chat topic in 13-${params.maxChars} chars. Title case. Output ONLY the name.`,
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
    const result = await runEmbeddedPiAgent({
      sessionId: `thread-title-generator-${Date.now()}`,
      sessionKey: "temp:thread-title-generator",
      agentId,
      sessionFile,
      workspaceDir,
      agentDir,
      config: params.cfg,
      prompt,
      disableTools: true,
      provider: parsedRef.provider,
      model: parsedRef.model,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      runId: `thread-title-gen-${Date.now()}`,
    });
    const rawText =
      result.payloads
        ?.filter((payload) => payload.isError !== true)
        .map((payload) => payload.text?.trim())
        .find((text): text is string => Boolean(text && text.length > 0)) ?? "";
    return sanitizeLlmTitleCandidate(rawText);
  } catch (err) {
    log.debug(`thread title generation failed: ${String(err)}`);
    return undefined;
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
