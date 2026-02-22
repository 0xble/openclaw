import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

const state = vi.hoisted(() => ({
  cfg: {} as OpenClawConfig,
  entry: undefined as SessionEntry | undefined,
  sessionKey: "agent:main:main",
  modelRef: { provider: "openai", model: "gpt-4o-mini" },
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: (sessionKey: string) => ({
      cfg: state.cfg,
      storePath: undefined,
      entry: state.entry,
      canonicalKey: sessionKey,
    }),
    readSessionMessages: () => [],
    resolveSessionModelRef: () => state.modelRef,
  };
});

const { chatHandlers } = await import("./chat.js");

async function runChatHistory(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  sessionKey: string;
  catalog?: Array<{ provider: string; id: string; reasoning?: boolean }>;
}) {
  state.cfg = params.cfg;
  state.entry = params.entry;
  state.sessionKey = params.sessionKey;
  const loadGatewayModelCatalog = vi.fn(async () =>
    (params.catalog ?? []).map((entry) => ({
      provider: entry.provider,
      id: entry.id,
      name: `${entry.provider}/${entry.id}`,
      reasoning: entry.reasoning,
    })),
  );
  const respond = vi.fn();
  await chatHandlers["chat.history"]({
    params: { sessionKey: params.sessionKey },
    respond: respond as never,
    context: {
      loadGatewayModelCatalog,
      logGateway: { debug: vi.fn() },
    } as never,
    req: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return {
    call: respond.mock.calls.at(-1) ?? [],
    loadGatewayModelCatalog,
  };
}

describe("chat.history thinking default precedence", () => {
  it("uses session override first", async () => {
    const { call, loadGatewayModelCatalog } = await runChatHistory({
      cfg: {
        agents: {
          defaults: { thinkingDefault: "low" },
          list: [{ id: "ops", thinkingDefault: "high" }],
        },
      } as OpenClawConfig,
      entry: {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        thinkingLevel: "minimal",
      } as SessionEntry,
      sessionKey: "agent:ops:main",
    });

    expect(call[0]).toBe(true);
    expect(call[1]).toMatchObject({ thinkingLevel: "minimal" });
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  it("uses per-agent default before global default", async () => {
    const { call, loadGatewayModelCatalog } = await runChatHistory({
      cfg: {
        agents: {
          defaults: { thinkingDefault: "low" },
          list: [{ id: "ops", thinkingDefault: "high" }],
        },
      } as OpenClawConfig,
      entry: {
        sessionId: "sess-2",
        updatedAt: Date.now(),
      } as SessionEntry,
      sessionKey: "agent:ops:main",
    });

    expect(call[0]).toBe(true);
    expect(call[1]).toMatchObject({ thinkingLevel: "high" });
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  it("uses global default when per-agent default is absent", async () => {
    const { call, loadGatewayModelCatalog } = await runChatHistory({
      cfg: {
        agents: {
          defaults: { thinkingDefault: "medium" },
          list: [{ id: "ops" }],
        },
      } as OpenClawConfig,
      entry: {
        sessionId: "sess-3",
        updatedAt: Date.now(),
      } as SessionEntry,
      sessionKey: "agent:ops:main",
    });

    expect(call[0]).toBe(true);
    expect(call[1]).toMatchObject({ thinkingLevel: "medium" });
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  it("falls back to model reasoning when no defaults are set", async () => {
    const { call, loadGatewayModelCatalog } = await runChatHistory({
      cfg: {} as OpenClawConfig,
      entry: {
        sessionId: "sess-4",
        updatedAt: Date.now(),
      } as SessionEntry,
      sessionKey: "agent:main:main",
      catalog: [{ provider: "openai", id: "gpt-4o-mini", reasoning: true }],
    });

    expect(call[0]).toBe(true);
    expect(call[1]).toMatchObject({ thinkingLevel: "low" });
    expect(loadGatewayModelCatalog).toHaveBeenCalledTimes(1);
  });
});
