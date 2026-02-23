import { describe, expect, it, vi } from "vitest";
import { createSlackThreadTitleProvider } from "./thread-title-provider.js";

describe("createSlackThreadTitleProvider", () => {
  it("calls assistant.threads.setTitle when available", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const provider = createSlackThreadTitleProvider({
      app: {
        client: {
          assistant: {
            threads: {
              setTitle,
            },
          },
        },
      } as never,
      botToken: "xoxb-test",
    });

    await provider.setTitle(
      {
        channel: "slack",
        conversationId: "C123",
        threadId: "1711111111.000100",
      },
      "Roadmap planning",
    );

    expect(setTitle).toHaveBeenCalledWith({
      token: "xoxb-test",
      channel_id: "C123",
      thread_ts: "1711111111.000100",
      title: "Roadmap planning",
    });
  });

  it("falls back to apiCall when assistant helper is unavailable", async () => {
    const apiCall = vi.fn().mockResolvedValue(undefined);
    const provider = createSlackThreadTitleProvider({
      app: {
        client: {
          apiCall,
        },
      } as never,
      botToken: "xoxb-test",
    });

    await provider.setTitle(
      {
        channel: "slack",
        conversationId: "C456",
        threadId: "111.222",
      },
      "Release blockers",
    );

    expect(apiCall).toHaveBeenCalledWith("assistant.threads.setTitle", {
      token: "xoxb-test",
      channel_id: "C456",
      thread_ts: "111.222",
      title: "Release blockers",
    });
  });

  it("classifies common Slack errors", () => {
    const provider = createSlackThreadTitleProvider({
      app: { client: {} } as never,
      botToken: "xoxb-test",
    });

    expect(provider.classifyError?.({ data: { error: "missing_scope" } })).toBe("permission");
    expect(provider.classifyError?.({ data: { error: "rate_limited" } })).toBe("rate_limit");
    expect(provider.classifyError?.({ data: { error: "thread_not_found" } })).toBe("not_found");
    expect(provider.classifyError?.(new Error("unexpected"))).toBe("unknown");
  });
});
