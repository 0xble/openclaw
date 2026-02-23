import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveThreadTitleLlmSettings } from "./thread-title-llm.js";

describe("resolveThreadTitleLlmSettings", () => {
  it("defaults to deterministic strategy", () => {
    const settings = resolveThreadTitleLlmSettings(undefined, {});
    expect(settings.strategy).toBe("deterministic");
    expect(settings.modelRef).toBeUndefined();
    expect(settings.timeoutMs).toBe(12_000);
    expect(settings.allowOverwriteCurrentTitle).toBe(false);
  });

  it("normalizes shorthand gemini model refs", () => {
    const settings = resolveThreadTitleLlmSettings(undefined, {
      OPENCLAW_THREAD_TITLE_STRATEGY: "llm",
      OPENCLAW_THREAD_TITLE_MODEL: "gemini-3-flash",
      OPENCLAW_THREAD_TITLE_OVERWRITE_EXISTING: "true",
    });
    expect(settings.strategy).toBe("llm");
    expect(settings.modelRef).toBe("google/gemini-3-flash");
    expect(settings.allowOverwriteCurrentTitle).toBe(true);
  });

  it("prefers config env vars over process env", () => {
    const cfg: OpenClawConfig = {
      env: {
        vars: {
          OPENCLAW_THREAD_TITLE_STRATEGY: "llm",
          OPENCLAW_THREAD_TITLE_MODEL: "google/gemini-3-flash",
          OPENCLAW_THREAD_TITLE_TIMEOUT_MS: "9000",
          OPENCLAW_THREAD_TITLE_OVERWRITE_EXISTING: "yes",
        },
      },
    };
    const settings = resolveThreadTitleLlmSettings(cfg, {
      OPENCLAW_THREAD_TITLE_STRATEGY: "deterministic",
      OPENCLAW_THREAD_TITLE_MODEL: "anthropic/claude-3-5-haiku-latest",
      OPENCLAW_THREAD_TITLE_TIMEOUT_MS: "30000",
      OPENCLAW_THREAD_TITLE_OVERWRITE_EXISTING: "false",
    });
    expect(settings.strategy).toBe("llm");
    expect(settings.modelRef).toBe("google/gemini-3-flash");
    expect(settings.timeoutMs).toBe(9000);
    expect(settings.allowOverwriteCurrentTitle).toBe(true);
  });
});
