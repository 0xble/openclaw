import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CRON_STORE_PATH,
  DEFAULT_DOTFILES_CRON_STORE_PATH,
  loadCronStore,
  resolveCronStorePath,
} from "./store.js";

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-"));
  return {
    dir,
    storePath: path.join(dir, "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("resolveCronStorePath", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses OPENCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const result = resolveCronStorePath("~/cron/jobs.json");
    expect(result).toBe(path.resolve("/srv/openclaw-home", "cron", "jobs.json"));
  });

  it("uses OPENCLAW_CRON_DOTFILES_STORE_PATH when set", () => {
    vi.stubEnv("OPENCLAW_CRON_DOTFILES_STORE_PATH", "~/dotfiles/custom/jobs.json");
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");

    const result = resolveCronStorePath();
    expect(result).toBe(path.resolve("/srv/openclaw-home", "dotfiles", "custom", "jobs.json"));
  });

  it("uses dotfiles cron store when dotfiles path exists", () => {
    const existsSync = vi.spyOn(fsSync, "existsSync").mockReturnValue(true);

    const result = resolveCronStorePath(undefined, {});
    expect(existsSync).toHaveBeenCalled();
    expect(result).toBe(DEFAULT_DOTFILES_CRON_STORE_PATH);
  });

  it("falls back to ~/.openclaw cron store when dotfiles path is missing", () => {
    vi.spyOn(fsSync, "existsSync").mockReturnValue(false);

    const result = resolveCronStorePath(undefined, {});
    expect(result).toBe(DEFAULT_CRON_STORE_PATH);
  });
});

describe("cron store", () => {
  it("returns empty store when file does not exist", async () => {
    const store = await makeStorePath();
    const loaded = await loadCronStore(store.storePath);
    expect(loaded).toEqual({ version: 1, jobs: [] });
    await store.cleanup();
  });

  it("throws when store contains invalid JSON", async () => {
    const store = await makeStorePath();
    await fs.writeFile(store.storePath, "{ not json", "utf-8");
    await expect(loadCronStore(store.storePath)).rejects.toThrow(/Failed to parse cron store/i);
    await store.cleanup();
  });
});
