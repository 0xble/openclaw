import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { generateThreadTitleViaLLM, resolveThreadTitleLlmSettings } from "./thread-title-llm.js";

function createConfig(defaultModel: string, envVars?: Record<string, string>): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: defaultModel,
      },
    },
    ...(envVars ? { env: { vars: envVars } } : {}),
  };
}

describe("resolveThreadTitleLlmSettings", () => {
  it("defaults to deterministic strategy", () => {
    const settings = resolveThreadTitleLlmSettings(undefined, {});
    expect(settings.strategy).toBe("deterministic");
    expect(settings.modelRef).toBeUndefined();
    expect(settings.timeoutMs).toBe(3_000);
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

  it("clamps timeoutMs to minimum 1ms", () => {
    const settings = resolveThreadTitleLlmSettings(undefined, {
      OPENCLAW_THREAD_TITLE_TIMEOUT_MS: "1",
    });
    expect(settings.timeoutMs).toBe(1);
  });
});

describe("generateThreadTitleViaLLM", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns a title from a successful Google API response", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '"Debug Nginx Config"' }] } }],
      }),
    } as Response);

    const title = await generateThreadTitleViaLLM({
      cfg: createConfig("google/gemini-2.0-flash", {
        GEMINI_API_KEY: "test-key",
      }),
      primaryText: "help me debug the nginx config",
      maxChars: 24,
      target: { channel: "telegram", conversationId: "chat", threadId: "42" },
    });

    expect(title).toBe("Debug Nginx Config");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [urlArg, opts] = mockFetch.mock.calls[0];
    const urlStr = typeof urlArg === "string" ? urlArg : (urlArg as URL).toString();
    expect(urlStr).toContain("generativelanguage.googleapis.com");
    expect(urlStr).toContain("key=test-key");
    const body = JSON.parse(opts?.body as string);
    expect(body.generationConfig.temperature).toBe(0);
  });

  it("returns a title from a successful Anthropic API response", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: "Fix Auth Bug" }],
      }),
    } as Response);

    const title = await generateThreadTitleViaLLM({
      cfg: createConfig("anthropic/claude-3-5-haiku-latest", {
        ANTHROPIC_API_KEY: "test-key",
      }),
      primaryText: "the auth token refresh is broken",
      maxChars: 24,
      target: { channel: "slack", conversationId: "C123", threadId: "123.456" },
    });

    expect(title).toBe("Fix Auth Bug");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [urlArg, opts] = mockFetch.mock.calls[0];
    const urlStr = typeof urlArg === "string" ? urlArg : (urlArg as URL).toString();
    expect(urlStr).toContain("api.anthropic.com");
    const headers = opts?.headers as Record<string, string> | undefined;
    expect(headers?.["x-api-key"]).toBe("test-key");
  });

  it("returns undefined on API error (500)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    } as Response);

    const title = await generateThreadTitleViaLLM({
      cfg: createConfig("google/gemini-2.0-flash", {
        GEMINI_API_KEY: "test-key",
      }),
      primaryText: "help me debug the nginx config",
      maxChars: 24,
      target: { channel: "telegram", conversationId: "chat", threadId: "42" },
    });

    expect(title).toBeUndefined();
  });

  it("returns undefined on fetch timeout", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });

    const title = await generateThreadTitleViaLLM({
      cfg: createConfig("google/gemini-2.0-flash", {
        GEMINI_API_KEY: "test-key",
      }),
      primaryText: "help me debug the nginx config",
      maxChars: 24,
      target: { channel: "telegram", conversationId: "chat", threadId: "42" },
      timeoutMs: 1,
    });

    expect(title).toBeUndefined();
  });

  it("returns undefined when no API key is available", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const savedGemini = process.env.GEMINI_API_KEY;
    const savedGoogle = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const title = await generateThreadTitleViaLLM({
        cfg: createConfig("google/gemini-2.0-flash"),
        primaryText: "help me debug the nginx config",
        maxChars: 24,
        target: { channel: "telegram", conversationId: "chat", threadId: "42" },
      });

      expect(title).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      if (savedGemini !== undefined) {
        process.env.GEMINI_API_KEY = savedGemini;
      }
      if (savedGoogle !== undefined) {
        process.env.GOOGLE_API_KEY = savedGoogle;
      }
    }
  });

  it("returns undefined when no text is provided", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);

    const title = await generateThreadTitleViaLLM({
      cfg: createConfig("google/gemini-2.0-flash", {
        GEMINI_API_KEY: "test-key",
      }),
      maxChars: 24,
      target: { channel: "telegram", conversationId: "chat", threadId: "42" },
    });

    expect(title).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns undefined for unsupported provider", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);

    const title = await generateThreadTitleViaLLM({
      cfg: createConfig("openai/gpt-4o"),
      primaryText: "help me debug the nginx config",
      maxChars: 24,
      target: { channel: "telegram", conversationId: "chat", threadId: "42" },
    });

    expect(title).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sanitizes LLM output (strips quotes, headers, extra whitespace)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '# "Config  Nginx"\n\nSome extra text' }] } }],
      }),
    } as Response);

    const title = await generateThreadTitleViaLLM({
      cfg: createConfig("google/gemini-2.0-flash", {
        GEMINI_API_KEY: "test-key",
      }),
      primaryText: "how should i configure nginx",
      maxChars: 24,
      target: { channel: "telegram", conversationId: "chat", threadId: "42" },
    });

    expect(title).toBe("Config Nginx");
  });
});
