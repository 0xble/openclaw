import { describe, expect, it, vi } from "vitest";
import { createTelegramThreadTitleProvider } from "./thread-title-provider.js";

vi.mock("./send.js", () => ({
  renameForumTopicTelegram: vi.fn().mockResolvedValue({
    topicId: 271,
    name: "Roadmap",
    chatId: "-100123",
  }),
}));

describe("createTelegramThreadTitleProvider", () => {
  it("creates keys only for real forum topics (id > 1)", () => {
    const provider = createTelegramThreadTitleProvider({
      api: {} as never,
      token: "tok",
      accountId: "default",
    });
    expect(
      provider.resolveThreadKey?.({
        channel: "telegram",
        conversationId: "-100123",
        threadId: 271,
      }),
    ).toBe("telegram:-100123:271");
    expect(
      provider.resolveThreadKey?.({
        channel: "telegram",
        conversationId: "-100123",
        threadId: 1,
      }),
    ).toBeUndefined();
  });

  it("classifies common Telegram title errors", () => {
    const provider = createTelegramThreadTitleProvider({
      api: {} as never,
      token: "tok",
      accountId: "default",
    });
    expect(provider.classifyError?.(new Error("Too Many Requests: retry after 7"))).toBe(
      "rate_limit",
    );
    expect(provider.classifyError?.(new Error("Forbidden: bot was kicked"))).toBe("permission");
    expect(provider.classifyError?.(new Error("Bad Request: topic not found"))).toBe("not_found");
    expect(provider.classifyError?.(new Error("unexpected"))).toBe("unknown");
    expect(
      provider.retryAfterMs?.(new Error("Too Many Requests: retry after 7"), "rate_limit"),
    ).toBe(7000);
  });
});
