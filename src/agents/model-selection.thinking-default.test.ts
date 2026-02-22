import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveThinkingDefault } from "./model-selection.js";

describe("resolveThinkingDefault", () => {
  it("applies session > per-agent > global precedence before fallback", () => {
    const cfg = {
      agents: {
        defaults: { thinkingDefault: "low" },
      },
    } as OpenClawConfig;

    const withSession = resolveThinkingDefault({
      cfg,
      provider: "openai",
      model: "gpt-4o-mini",
      sessionThinkingDefault: "off",
      agentThinkingDefault: "high",
      globalThinkingDefault: "low",
    });
    expect(withSession).toBe("off");

    const withAgent = resolveThinkingDefault({
      cfg,
      provider: "openai",
      model: "gpt-4o-mini",
      agentThinkingDefault: "high",
      globalThinkingDefault: "low",
    });
    expect(withAgent).toBe("high");

    const withGlobal = resolveThinkingDefault({
      cfg,
      provider: "openai",
      model: "gpt-4o-mini",
      globalThinkingDefault: "medium",
    });
    expect(withGlobal).toBe("medium");
  });

  it("falls back to model reasoning when no configured defaults exist", () => {
    const thinking = resolveThinkingDefault({
      cfg: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-5",
      catalog: [
        {
          provider: "openai",
          id: "gpt-5",
          name: "GPT-5",
          reasoning: true,
        },
      ],
    });

    expect(thinking).toBe("low");
  });
});
