import { homedir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { logWarn } from "../../logger.js";
import { runExec } from "../../process/exec.js";

export type CronWriteThroughMode = "off" | "best-effort" | "required";

type RunExecFn = typeof runExec;
type WarnFn = (message: string) => void;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_CHARS = 280;

const trimMaybe = (value: string | undefined) => value?.trim() ?? "";

function normalizeMode(raw: string | undefined): CronWriteThroughMode {
  const value = trimMaybe(raw).toLowerCase();
  if (!value || value === "off" || value === "0" || value === "false" || value === "no") {
    return "off";
  }
  if (value === "required" || value === "strict") {
    return "required";
  }
  return "best-effort";
}

function parseTimeoutMs(raw: string | undefined): number {
  const value = Number.parseInt(trimMaybe(raw), 10);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return value;
}

function expandHomeTarget(targetPath: string): string {
  const trimmed = targetPath.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function isWithinDirectory(targetPath: string, directoryPath: string) {
  const target = path.resolve(targetPath);
  const directory = path.resolve(directoryPath);
  if (target === directory) {
    return true;
  }
  return target.startsWith(`${directory}${path.sep}`);
}

function isDotfilesSourcePath(targetPath: string, env: NodeJS.ProcessEnv) {
  const configured = trimMaybe(env.OPENCLAW_DOTFILES_SOURCE_DIR) || "~/dotfiles";
  const sourceDir = expandHomeTarget(configured);
  if (!sourceDir) {
    return false;
  }
  return isWithinDirectory(targetPath, sourceDir);
}

function formatExecError(err: unknown): string {
  if (err == null) {
    return "unknown error";
  }
  if (typeof err === "string") {
    return err.slice(0, MAX_ERROR_CHARS);
  }
  const message =
    err instanceof Error ? err.message : inspect(err, { depth: 2, breakLength: Infinity });
  const stderr =
    typeof (err as { stderr?: unknown }).stderr === "string"
      ? (err as { stderr: string }).stderr.trim()
      : "";
  const combined = [message, stderr].filter(Boolean).join(" | ");
  return combined.slice(0, MAX_ERROR_CHARS);
}

export function resolveCronWriteThroughConfig(env: NodeJS.ProcessEnv = process.env): {
  mode: CronWriteThroughMode;
  bin: string;
  timeoutMs: number;
} {
  const modeRaw = trimMaybe(
    env.OPENCLAW_CRON_WRITE_THROUGH_MODE || env.OPENCLAW_CRON_WRITE_THROUGH,
  );
  return {
    mode: normalizeMode(modeRaw),
    bin: trimMaybe(env.OPENCLAW_CRON_WRITE_THROUGH_BIN) || "chezmoi",
    timeoutMs: parseTimeoutMs(env.OPENCLAW_CRON_WRITE_THROUGH_TIMEOUT_MS),
  };
}

export async function maybeWriteCronStoreThroughDotfiles(
  cronStorePath: string,
  deps?: {
    env?: NodeJS.ProcessEnv;
    runExecFn?: RunExecFn;
    warn?: WarnFn;
  },
) {
  const env = deps?.env ?? process.env;
  const runExecFn = deps?.runExecFn ?? runExec;
  const warn = deps?.warn ?? logWarn;
  const { mode, bin, timeoutMs } = resolveCronWriteThroughConfig(env);
  if (mode === "off") {
    return;
  }

  const targetPath = expandHomeTarget(cronStorePath);
  if (!targetPath) {
    if (mode === "required") {
      throw new Error("cron: write-through is required but cron store path is empty");
    }
    warn("cron: write-through skipped; cron store path is empty");
    return;
  }

  if (isDotfilesSourcePath(targetPath, env)) {
    return;
  }

  try {
    await runExecFn(bin, ["re-add", targetPath], { timeoutMs });
  } catch (err) {
    const detail = formatExecError(err);
    const message = `cron: write-through failed for ${targetPath}: ${detail}`;
    if (mode === "required") {
      throw new Error(message, { cause: err });
    }
    warn(message);
  }
}
