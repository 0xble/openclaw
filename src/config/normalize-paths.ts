import os from "node:os";
import path from "node:path";
import { expandHomePrefix, resolveRequiredHomeDir } from "../infra/home-dir.js";
import { isPlainObject } from "../utils.js";
import type { OpenClawConfig } from "./types.js";

const PATH_VALUE_RE = /^~(?=$|[\\/])/;

const PATH_KEY_RE = /(dir|path|paths|file|root|workspace)$/i;
const PATH_LIST_KEYS = new Set(["paths", "pathPrepend"]);

type NormalizeConfigPathsOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
};

function resolvePathForConfig(
  value: string,
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredHomeDir(env, homedir),
      env,
      homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

function normalizeStringValue(
  key: string | undefined,
  value: string,
  options: NormalizeConfigPathsOptions,
): string {
  if (!PATH_VALUE_RE.test(value.trim())) {
    return value;
  }
  if (!key) {
    return value;
  }
  if (PATH_KEY_RE.test(key) || PATH_LIST_KEYS.has(key)) {
    return resolvePathForConfig(value, options.env ?? process.env, options.homedir ?? os.homedir);
  }
  return value;
}

function normalizeAny(
  key: string | undefined,
  value: unknown,
  options: NormalizeConfigPathsOptions,
): unknown {
  if (typeof value === "string") {
    return normalizeStringValue(key, value, options);
  }

  if (Array.isArray(value)) {
    const normalizeChildren = Boolean(key && PATH_LIST_KEYS.has(key));
    return value.map((entry) => {
      if (typeof entry === "string") {
        return normalizeChildren ? normalizeStringValue(key, entry, options) : entry;
      }
      if (Array.isArray(entry)) {
        return normalizeAny(undefined, entry, options);
      }
      if (isPlainObject(entry)) {
        return normalizeAny(undefined, entry, options);
      }
      return entry;
    });
  }

  if (!isPlainObject(value)) {
    return value;
  }

  for (const [childKey, childValue] of Object.entries(value)) {
    const next = normalizeAny(childKey, childValue, options);
    if (next !== childValue) {
      value[childKey] = next;
    }
  }

  return value;
}

/**
 * Normalize "~" paths in path-ish config fields.
 *
 * Goal: accept `~/...` consistently across config file + env overrides, while
 * keeping the surface area small and predictable.
 */
export function normalizeConfigPaths(
  cfg: OpenClawConfig,
  options: NormalizeConfigPathsOptions = {},
): OpenClawConfig {
  if (!cfg || typeof cfg !== "object") {
    return cfg;
  }
  normalizeAny(undefined, cfg, options);
  return cfg;
}
