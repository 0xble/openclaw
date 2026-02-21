import type { WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadWebMediaMock = vi.fn();

class MockLocalMediaAccessError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "LocalMediaAccessError";
  }
}

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("./accounts.js", () => ({
  resolveSlackAccount: () => ({
    accountId: "default",
    botToken: "xoxb-test",
    botTokenSource: "config",
    config: {},
  }),
}));

vi.mock("../web/media.js", () => ({
  LocalMediaAccessError: MockLocalMediaAccessError,
  loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
}));

const { sendMessageSlack } = await import("./send.js");

type SlackSendTestClient = WebClient & {
  conversations: {
    open: ReturnType<typeof vi.fn>;
  };
  chat: {
    postMessage: ReturnType<typeof vi.fn>;
  };
  files: {
    uploadV2: ReturnType<typeof vi.fn>;
  };
};

function createSlackSendTestClient(): SlackSendTestClient {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D123" } })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
    files: {
      uploadV2: vi.fn(async () => ({ files: [{ id: "F123" }] })),
    },
  } as unknown as SlackSendTestClient;
}

describe("sendMessageSlack media fallback", () => {
  beforeEach(() => {
    loadWebMediaMock.mockReset();
  });

  it("falls back to text when media path is blocked by local roots", async () => {
    const client = createSlackSendTestClient();
    loadWebMediaMock.mockRejectedValueOnce(
      new MockLocalMediaAccessError(
        "path-not-allowed",
        "Local media path is not under an allowed directory: ./card.png",
      ),
    );

    const result = await sendMessageSlack("channel:C123", "Here is the updated card", {
      token: "xoxb-test",
      client,
      mediaUrl: "./card.png",
      mediaLocalRoots: ["/tmp"],
    });

    expect(client.files.uploadV2).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: expect.stringContaining("Here is the updated card"),
      }),
    );
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("outside allowed directories"),
      }),
    );
    expect(result).toEqual({ messageId: "171234.567", channelId: "C123" });
  });

  it("sends a generic warning when media-only upload fails", async () => {
    const client = createSlackSendTestClient();
    loadWebMediaMock.mockRejectedValueOnce(new Error("upload failed"));

    const result = await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      client,
      mediaUrl: "https://example.com/image.png",
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: "Warning: Could not attach media. Sending text only.",
      }),
    );
    expect(result).toEqual({ messageId: "171234.567", channelId: "C123" });
  });
});
