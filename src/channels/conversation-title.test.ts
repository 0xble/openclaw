import { describe, expect, it } from "vitest";
import { deriveConversationTitle } from "./conversation-title.js";

describe("deriveConversationTitle", () => {
  it("returns normalized title text", () => {
    expect(
      deriveConversationTitle({
        primaryText: "  Build   openclaw  slack rename  ",
        maxChars: 80,
      }),
    ).toBe("Build openclaw slack rename");
  });

  it("skips slash commands when no fallback is available", () => {
    expect(
      deriveConversationTitle({
        primaryText: "/t high",
        maxChars: 80,
      }),
    ).toBeUndefined();
  });

  it("uses fallback when slash command text is rejected", () => {
    expect(
      deriveConversationTitle({
        primaryText: "/t high",
        fallbackText: "should be used",
        maxChars: 80,
      }),
    ).toBe("should be used");
  });

  it("skips low-signal greetings", () => {
    expect(
      deriveConversationTitle({
        primaryText: "hi",
        maxChars: 80,
      }),
    ).toBeUndefined();
  });

  it("falls back when primary text is empty", () => {
    expect(
      deriveConversationTitle({
        primaryText: " ",
        fallbackText: "Rename telegram forum topic",
        maxChars: 80,
      }),
    ).toBe("Rename telegram forum topic");
  });

  it("skips control-command-like text when no other candidate exists", () => {
    expect(
      deriveConversationTitle({
        primaryText: "stop",
        maxChars: 80,
      }),
    ).toBeUndefined();
  });

  it("uses fallback when control-command text is rejected", () => {
    expect(
      deriveConversationTitle({
        primaryText: "stop",
        fallbackText: "Act like a thread title",
        maxChars: 80,
      }),
    ).toBe("Act like a thread title");
  });

  it("ignores media placeholder text and uses fallback", () => {
    expect(
      deriveConversationTitle({
        primaryText: "<media:image>",
        fallbackText: "Actual user text is preferred",
        maxChars: 80,
      }),
    ).toBe("Actual user text is preferred");
  });

  it("skips placeholder-only inputs without fallback", () => {
    expect(
      deriveConversationTitle({
        primaryText: "[Slack file: report.pdf] [Slack file: chart.png]",
        maxChars: 80,
      }),
    ).toBeUndefined();
  });

  it("strips placeholder tokens when user text is present", () => {
    expect(
      deriveConversationTitle({
        primaryText: "Please review [Slack file: report.pdf]",
        maxChars: 80,
      }),
    ).toBe("Please review");
  });
});
