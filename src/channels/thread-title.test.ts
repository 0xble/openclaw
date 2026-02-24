import { describe, expect, it, vi } from "vitest";
import {
  applyThreadTitle,
  createInMemoryThreadTitleStateStore,
  type ThreadTitleProvider,
  type ThreadTitleTarget,
} from "./thread-title.js";

function createTarget(overrides: Partial<ThreadTitleTarget> = {}): ThreadTitleTarget {
  return {
    channel: "slack",
    conversationId: "C123",
    threadId: "1711111111.000100",
    ...overrides,
  };
}

describe("applyThreadTitle", () => {
  it("applies once and skips repeated attempts for the same thread key", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const provider: ThreadTitleProvider = {
      channel: "slack",
      setTitle,
    };
    const stateStore = createInMemoryThreadTitleStateStore();
    const target = createTarget();

    const first = await applyThreadTitle({
      provider,
      target,
      primaryText: "Please summarize deployment checklist",
      maxChars: 80,
      stateStore,
    });
    expect(first.outcome).toBe("applied");
    expect(setTitle).toHaveBeenCalledTimes(1);

    const second = await applyThreadTitle({
      provider,
      target,
      primaryText: "Please summarize deployment checklist",
      maxChars: 80,
      stateStore,
    });
    expect(second.outcome).toBe("skipped");
    expect(second.reason).toBe("already_applied");
    expect(setTitle).toHaveBeenCalledTimes(1);
  });

  it("skips when no meaningful title candidate exists", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const provider: ThreadTitleProvider = {
      channel: "slack",
      setTitle,
    };
    const result = await applyThreadTitle({
      provider,
      target: createTarget(),
      primaryText: "/status",
      maxChars: 80,
      stateStore: createInMemoryThreadTitleStateStore(),
    });
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("no_candidate");
    expect(setTitle).not.toHaveBeenCalled();
  });

  it("disables future attempts on permission errors", async () => {
    const setTitle = vi.fn().mockRejectedValue(new Error("missing_scope"));
    const provider: ThreadTitleProvider = {
      channel: "slack",
      setTitle,
      classifyError: () => "permission",
    };
    const stateStore = createInMemoryThreadTitleStateStore();
    const target = createTarget();

    const first = await applyThreadTitle({
      provider,
      target,
      primaryText: "Investigate queue timeout in worker",
      maxChars: 80,
      stateStore,
    });
    expect(first.outcome).toBe("failed");
    expect(first.errorClass).toBe("permission");
    expect(setTitle).toHaveBeenCalledTimes(1);

    const second = await applyThreadTitle({
      provider,
      target,
      primaryText: "Investigate queue timeout in worker",
      maxChars: 80,
      stateStore,
    });
    expect(second.outcome).toBe("skipped");
    expect(second.reason).toBe("disabled");
    expect(setTitle).toHaveBeenCalledTimes(1);
  });

  it("enforces retry cooldown on rate-limit errors", async () => {
    const setTitle = vi.fn().mockRejectedValue(new Error("rate_limited"));
    const provider: ThreadTitleProvider = {
      channel: "slack",
      setTitle,
      classifyError: () => "rate_limit",
      retryAfterMs: () => 60_000,
    };
    const stateStore = createInMemoryThreadTitleStateStore();
    const target = createTarget();
    let now = 1_000;

    const first = await applyThreadTitle({
      provider,
      target,
      primaryText: "Ship release checklist",
      maxChars: 80,
      stateStore,
      nowMs: () => now,
    });
    expect(first.outcome).toBe("failed");
    expect(first.errorClass).toBe("rate_limit");
    expect(setTitle).toHaveBeenCalledTimes(1);

    now += 30_000;
    const second = await applyThreadTitle({
      provider,
      target,
      primaryText: "Ship release checklist",
      maxChars: 80,
      stateStore,
      nowMs: () => now,
    });
    expect(second.outcome).toBe("skipped");
    expect(second.reason).toBe("cooldown");
    expect(setTitle).toHaveBeenCalledTimes(1);

    now += 31_000;
    await applyThreadTitle({
      provider,
      target,
      primaryText: "Ship release checklist",
      maxChars: 80,
      stateStore,
      nowMs: () => now,
    });
    expect(setTitle).toHaveBeenCalledTimes(2);
  });

  it("skips if provider and target channels do not match", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const provider: ThreadTitleProvider = {
      channel: "telegram",
      setTitle,
    };
    const result = await applyThreadTitle({
      provider,
      target: createTarget({ channel: "slack" }),
      primaryText: "hello world",
      maxChars: 80,
      stateStore: createInMemoryThreadTitleStateStore(),
    });
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("provider_mismatch");
    expect(setTitle).not.toHaveBeenCalled();
  });

  it("uses llm strategy title when generator returns a valid candidate", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const provider: ThreadTitleProvider = {
      channel: "slack",
      setTitle,
    };
    const result = await applyThreadTitle({
      provider,
      target: createTarget(),
      primaryText: "yooooooooooooooooooo",
      maxChars: 80,
      strategy: "llm",
      generateLlmTitle: async () => "Daily Standup Follow-ups",
      stateStore: createInMemoryThreadTitleStateStore(),
    });
    expect(result.outcome).toBe("applied");
    expect(result.title).toBe("Daily Standup Follow-ups");
    expect(setTitle).toHaveBeenCalledWith(expect.anything(), "Daily Standup Follow-ups");
  });

  it("falls back to deterministic title when llm strategy returns nothing", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const provider: ThreadTitleProvider = {
      channel: "slack",
      setTitle,
    };
    const result = await applyThreadTitle({
      provider,
      target: createTarget(),
      primaryText: "Please review q1 launch checklist",
      maxChars: 80,
      strategy: "llm",
      generateLlmTitle: async () => undefined,
      stateStore: createInMemoryThreadTitleStateStore(),
    });
    expect(result.outcome).toBe("applied");
    expect(result.title).toBe("Please review q1 launch checklist");
  });

  it("overwrites non-default current title when it matches the seed text", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const provider: ThreadTitleProvider = {
      channel: "telegram",
      getCurrentTitle: vi.fn().mockResolvedValue("yoooooooooooooooooo"),
      setTitle,
    };
    const result = await applyThreadTitle({
      provider,
      target: createTarget({ channel: "telegram" }),
      primaryText: "yoooooooooooooooooo",
      fallbackText: "yoooooooooooooooooo",
      maxChars: 80,
      strategy: "llm",
      generateLlmTitle: async () => "Casual Check-in",
      stateStore: createInMemoryThreadTitleStateStore(),
    });
    expect(result.outcome).toBe("applied");
    expect(result.title).toBe("Casual Check-in");
    expect(setTitle).toHaveBeenCalledTimes(1);
  });

  it("skips when isFirstMessage is false (stateless restart guard)", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const provider: ThreadTitleProvider = {
      channel: "slack",
      setTitle,
    };
    const result = await applyThreadTitle({
      provider,
      target: createTarget(),
      primaryText: "Deploy the new feature branch",
      maxChars: 80,
      isFirstMessage: false,
      stateStore: createInMemoryThreadTitleStateStore(),
    });
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("not_first_message");
    expect(setTitle).not.toHaveBeenCalled();
  });

  it("applies when isFirstMessage is true", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const provider: ThreadTitleProvider = {
      channel: "slack",
      setTitle,
    };
    const result = await applyThreadTitle({
      provider,
      target: createTarget(),
      primaryText: "Deploy the new feature branch",
      maxChars: 80,
      isFirstMessage: true,
      stateStore: createInMemoryThreadTitleStateStore(),
    });
    expect(result.outcome).toBe("applied");
    expect(setTitle).toHaveBeenCalledTimes(1);
  });

  it("applies when isFirstMessage is omitted (backward compat)", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const provider: ThreadTitleProvider = {
      channel: "slack",
      setTitle,
    };
    const result = await applyThreadTitle({
      provider,
      target: createTarget(),
      primaryText: "Deploy the new feature branch",
      maxChars: 80,
      stateStore: createInMemoryThreadTitleStateStore(),
    });
    expect(result.outcome).toBe("applied");
    expect(setTitle).toHaveBeenCalledTimes(1);
  });
});
