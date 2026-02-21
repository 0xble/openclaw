import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveStorePath = vi.hoisted(() => vi.fn(() => "/tmp/sessions.json"));
const updateSessionStoreEntry = vi.hoisted(() => vi.fn());
const loadSessionStore = vi.hoisted(() => vi.fn(() => ({})));
const runEmbeddedPiAgent = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent"));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath,
  updateSessionStoreEntry,
  loadSessionStore,
}));
vi.mock("../agents/pi-embedded-runner.js", () => ({
  runEmbeddedPiAgent,
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir,
  resolveAgentDir,
}));

import {
  clearThreadTitleRenamesForTest,
  requestNativeThreadTitleRename,
  waitForThreadTitleRenamesForTest,
} from "./thread-title-manager.js";

describe("requestNativeThreadTitleRename", () => {
  beforeEach(() => {
    clearThreadTitleRenamesForTest();
    resolveStorePath.mockReset();
    resolveStorePath.mockReturnValue("/tmp/sessions.json");
    updateSessionStoreEntry.mockReset();
    loadSessionStore.mockReset();
    loadSessionStore.mockReturnValue({});
    runEmbeddedPiAgent.mockReset();
    runEmbeddedPiAgent.mockResolvedValue({
      payloads: [{ text: "Better Thread Title" }],
    });
    resolveAgentWorkspaceDir.mockReset();
    resolveAgentWorkspaceDir.mockReturnValue("/tmp/workspace");
    resolveAgentDir.mockReset();
    resolveAgentDir.mockReturnValue("/tmp/agent");
  });

  it("applies a title only once per thread", async () => {
    const entry: { nativeThreadTitle?: Record<string, unknown> } = {};
    updateSessionStoreEntry.mockImplementation(async ({ update }) => {
      const patch = await update(entry);
      if (!patch) {
        return entry;
      }
      Object.assign(entry, patch);
      return entry;
    });
    const applyTitle = vi.fn().mockResolvedValue(undefined);
    const params = {
      cfg: {},
      route: {
        agentId: "main",
        channel: "slack",
        accountId: "default",
        sessionKey: "agent:main:slack:direct:U1",
        mainSessionKey: "agent:main:slack:direct:U1",
        matchedBy: "default" as const,
      },
      sessionKey: "agent:main:slack:direct:U1",
      threadRef: {
        provider: "slack" as const,
        accountId: "default",
        channelId: "C1",
        threadTs: "123",
      },
      primaryText: "plan thread title manager",
      fallbackText: "fallback",
      maxChars: 80,
      applyTitle,
    };

    requestNativeThreadTitleRename(params);
    await waitForThreadTitleRenamesForTest();
    requestNativeThreadTitleRename(params);
    await waitForThreadTitleRenamesForTest();

    expect(applyTitle).toHaveBeenCalledTimes(1);
    expect(applyTitle).toHaveBeenCalledWith("Better Thread Title");
    expect(entry.nativeThreadTitle?.status).toBe("applied");
  });

  it("disables retries after permission failures", async () => {
    const entry: { nativeThreadTitle?: Record<string, unknown> } = {};
    updateSessionStoreEntry.mockImplementation(async ({ update }) => {
      const patch = await update(entry);
      if (!patch) {
        return entry;
      }
      Object.assign(entry, patch);
      return entry;
    });
    const applyTitle = vi.fn().mockRejectedValue(new Error("missing_scope"));
    const params = {
      cfg: {},
      route: {
        agentId: "main",
        channel: "telegram",
        accountId: "default",
        sessionKey: "agent:main:telegram:direct:123:thread:55",
        mainSessionKey: "agent:main:telegram:direct:123",
        matchedBy: "default" as const,
      },
      sessionKey: "agent:main:telegram:direct:123:thread:55",
      threadRef: {
        provider: "telegram" as const,
        accountId: "default",
        chatId: "123",
        threadId: 55,
        threadKind: "dm" as const,
      },
      primaryText: "rename this thread",
      fallbackText: "fallback",
      maxChars: 128,
      applyTitle,
    };

    requestNativeThreadTitleRename(params);
    await waitForThreadTitleRenamesForTest();
    expect(entry.nativeThreadTitle?.status).toBe("disabled");

    applyTitle.mockClear();
    requestNativeThreadTitleRename(params);
    await waitForThreadTitleRenamesForTest();
    expect(applyTitle).not.toHaveBeenCalled();
  });

  it("applies retry_after backoff for rate limits", async () => {
    const entry: { nativeThreadTitle?: Record<string, unknown> } = {};
    updateSessionStoreEntry.mockImplementation(async ({ update }) => {
      const patch = await update(entry);
      if (!patch) {
        return entry;
      }
      Object.assign(entry, patch);
      return entry;
    });
    const applyTitle = vi.fn().mockRejectedValue(new Error("429 rate limit"));
    const params = {
      cfg: {},
      route: {
        agentId: "main",
        channel: "slack",
        accountId: "default",
        sessionKey: "agent:main:slack:direct:U1",
        mainSessionKey: "agent:main:slack:direct:U1",
        matchedBy: "default" as const,
      },
      sessionKey: "agent:main:slack:direct:U1",
      threadRef: {
        provider: "slack" as const,
        accountId: "default",
        channelId: "C1",
        threadTs: "123",
      },
      primaryText: "rename this thread",
      fallbackText: "fallback",
      maxChars: 80,
      applyTitle,
    };

    requestNativeThreadTitleRename(params);
    await waitForThreadTitleRenamesForTest();
    expect(entry.nativeThreadTitle?.status).toBe("retry_after");
    expect(entry.nativeThreadTitle?.lastErrorClass).toBe("rate_limit");
    expect(typeof entry.nativeThreadTitle?.retryAfter).toBe("number");

    applyTitle.mockClear();
    requestNativeThreadTitleRename(params);
    await waitForThreadTitleRenamesForTest();
    expect(applyTitle).not.toHaveBeenCalled();
  });

  it("retries immediately for unknown errors when title changes", async () => {
    const now = Date.now();
    const entry: { nativeThreadTitle?: Record<string, unknown> } = {
      nativeThreadTitle: {
        threadKey: "telegram:default:123:dm:55",
        status: "retry_after",
        attempts: 1,
        lastAttemptAt: now - 5_000,
        lastProposedTitle: "previous title",
        lastErrorClass: "unknown",
        retryAfter: now + 60_000,
      },
    };
    updateSessionStoreEntry.mockImplementation(async ({ update }) => {
      const patch = await update(entry);
      if (!patch) {
        return entry;
      }
      Object.assign(entry, patch);
      return entry;
    });
    const applyTitle = vi.fn().mockResolvedValue(undefined);
    const params = {
      cfg: {},
      route: {
        agentId: "main",
        channel: "telegram",
        accountId: "default",
        sessionKey: "agent:main:telegram:direct:123:thread:55",
        mainSessionKey: "agent:main:telegram:direct:123",
        matchedBy: "default" as const,
      },
      sessionKey: "agent:main:telegram:direct:123:thread:55",
      threadRef: {
        provider: "telegram" as const,
        accountId: "default",
        chatId: "123",
        threadId: 55,
        threadKind: "dm" as const,
      },
      primaryText: "new title after fix",
      fallbackText: "fallback",
      maxChars: 128,
      applyTitle,
    };

    requestNativeThreadTitleRename(params);
    await waitForThreadTitleRenamesForTest();

    expect(applyTitle).toHaveBeenCalledTimes(1);
    expect(entry.nativeThreadTitle?.status).toBe("applied");
    expect(entry.nativeThreadTitle?.attempts).toBe(2);
    expect(entry.nativeThreadTitle?.appliedTitle).toBe("Better Thread Title");
  });

  it("does not retry when prior applied title exists", async () => {
    const entry: {
      nativeThreadTitle?: Record<string, unknown>;
    } = {
      nativeThreadTitle: {
        threadKey: "slack:default:C1:123",
        status: "applied",
        attempts: 1,
        appliedTitle: "New Assistant Thread",
        lastProposedTitle: "New Assistant Thread",
      },
    };
    updateSessionStoreEntry.mockImplementation(async ({ update }) => {
      const patch = await update(entry);
      if (!patch) {
        return entry;
      }
      Object.assign(entry, patch);
      return entry;
    });
    const applyTitle = vi.fn().mockResolvedValue(undefined);
    requestNativeThreadTitleRename({
      cfg: {},
      route: {
        agentId: "main",
        channel: "slack",
        accountId: "default",
        sessionKey: "agent:main:slack:direct:U1",
        mainSessionKey: "agent:main:slack:direct:U1",
        matchedBy: "default" as const,
      },
      sessionKey: "agent:main:slack:direct:U1",
      threadRef: {
        provider: "slack",
        accountId: "default",
        channelId: "C1",
        threadTs: "123",
      },
      primaryText: "rename this properly",
      fallbackText: "fallback",
      maxChars: 80,
      applyTitle,
    });
    await waitForThreadTitleRenamesForTest();

    expect(applyTitle).not.toHaveBeenCalled();
    expect(entry.nativeThreadTitle?.status).toBe("applied");
    expect(entry.nativeThreadTitle?.appliedTitle).toBe("New Assistant Thread");
    expect(entry.nativeThreadTitle?.attempts).toBe(1);
  });

  it("skips rename when another session already applied a title for the same thread", async () => {
    updateSessionStoreEntry.mockImplementation(async ({ update }) => {
      const entry: { nativeThreadTitle?: Record<string, unknown> } = {};
      const patch = await update(entry);
      if (!patch) {
        return entry;
      }
      Object.assign(entry, patch);
      return entry;
    });
    loadSessionStore.mockReturnValue({
      "agent:main:slack:direct:U2": {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        nativeThreadTitle: {
          threadKey: "slack:default:C1:123",
          status: "applied",
          appliedTitle: "Project Kickoff Plan",
          attempts: 1,
        },
      },
    });
    const applyTitle = vi.fn().mockResolvedValue(undefined);
    requestNativeThreadTitleRename({
      cfg: {},
      route: {
        agentId: "main",
        channel: "slack",
        accountId: "default",
        sessionKey: "agent:main:slack:direct:U1",
        mainSessionKey: "agent:main:slack:direct:U1",
        matchedBy: "default",
      },
      sessionKey: "agent:main:slack:direct:U1",
      threadRef: {
        provider: "slack",
        accountId: "default",
        channelId: "C1",
        threadTs: "123",
      },
      primaryText: "rename this properly",
      fallbackText: "fallback",
      maxChars: 80,
      applyTitle,
    });
    await waitForThreadTitleRenamesForTest();

    expect(applyTitle).not.toHaveBeenCalled();
  });

  it("skips rename when ai generation fails", async () => {
    const entry: { nativeThreadTitle?: Record<string, unknown> } = {};
    updateSessionStoreEntry.mockImplementation(async ({ update }) => {
      const patch = await update(entry);
      if (!patch) {
        return entry;
      }
      Object.assign(entry, patch);
      return entry;
    });
    runEmbeddedPiAgent.mockRejectedValue(new Error("no gemini auth"));
    const applyTitle = vi.fn().mockResolvedValue(undefined);

    requestNativeThreadTitleRename({
      cfg: {},
      route: {
        agentId: "main",
        channel: "telegram",
        accountId: "default",
        sessionKey: "agent:main:telegram:direct:123:thread:55",
        mainSessionKey: "agent:main:telegram:direct:123",
        matchedBy: "default",
      },
      sessionKey: "agent:main:telegram:direct:123:thread:55",
      threadRef: {
        provider: "telegram",
        accountId: "default",
        chatId: "123",
        threadId: 55,
        threadKind: "dm",
      },
      primaryText: "this is testing a rename",
      fallbackText: "fallback",
      maxChars: 128,
      applyTitle,
    });
    await waitForThreadTitleRenamesForTest();

    expect(applyTitle).not.toHaveBeenCalled();
  });
});
