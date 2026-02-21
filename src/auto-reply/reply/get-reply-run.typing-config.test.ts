import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { TemplateContext } from "../templating.js";
import { resolveConfiguredTypingMode } from "./get-reply-run.js";

function buildParams(overrides?: {
  cfg?: OpenClawConfig;
  sessionCfg?: OpenClawConfig["session"];
  agentCfg?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
  sessionCtx?: TemplateContext;
}) {
  return {
    cfg: overrides?.cfg ?? { channels: {}, agents: { defaults: {} } },
    sessionCfg: overrides?.sessionCfg ?? {},
    agentCfg:
      overrides?.agentCfg ?? ({} as NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>),
    sessionCtx: overrides?.sessionCtx ?? {},
  };
}

describe("resolveConfiguredTypingMode", () => {
  it("prefers session override over slack override", () => {
    const resolved = resolveConfiguredTypingMode(
      buildParams({
        cfg: {
          channels: { slack: { typingMode: "never" } },
          agents: { defaults: {} },
        } as OpenClawConfig,
        sessionCfg: { typingMode: "message" },
        sessionCtx: { Provider: "slack" } as TemplateContext,
      }),
    );
    expect(resolved).toBe("message");
  });

  it("uses account-level slack typingMode when present", () => {
    const resolved = resolveConfiguredTypingMode(
      buildParams({
        cfg: {
          channels: {
            slack: {
              typingMode: "instant",
              accounts: { default: { typingMode: "never" } },
            },
          },
          agents: { defaults: {} },
        } as OpenClawConfig,
        sessionCtx: { Provider: "slack", AccountId: "default" } as TemplateContext,
      }),
    );
    expect(resolved).toBe("never");
  });

  it("normalizes session account id when resolving account-level slack typingMode", () => {
    const resolved = resolveConfiguredTypingMode(
      buildParams({
        cfg: {
          channels: {
            slack: {
              typingMode: "instant",
              accounts: { primary: { typingMode: "never" } },
            },
          },
          agents: { defaults: {} },
        } as OpenClawConfig,
        sessionCtx: { Provider: "slack", AccountId: "PRIMARY" } as TemplateContext,
      }),
    );
    expect(resolved).toBe("never");
  });

  it("matches account-level slack typingMode when account key casing differs", () => {
    const resolved = resolveConfiguredTypingMode(
      buildParams({
        cfg: {
          channels: {
            slack: {
              typingMode: "instant",
              accounts: { Primary: { typingMode: "never" } },
            },
          },
          agents: { defaults: {} },
        } as OpenClawConfig,
        sessionCtx: { Provider: "slack", AccountId: "primary" } as TemplateContext,
      }),
    );
    expect(resolved).toBe("never");
  });

  it("uses base slack typingMode when account override is missing", () => {
    const resolved = resolveConfiguredTypingMode(
      buildParams({
        cfg: {
          channels: { slack: { typingMode: "never" } },
          agents: { defaults: {} },
        } as OpenClawConfig,
        sessionCtx: { Provider: "slack", AccountId: "missing" } as TemplateContext,
      }),
    );
    expect(resolved).toBe("never");
  });

  it("falls back to agent defaults for non-slack providers", () => {
    const resolved = resolveConfiguredTypingMode(
      buildParams({
        agentCfg: { typingMode: "thinking" },
        sessionCtx: { Provider: "telegram" } as TemplateContext,
      }),
    );
    expect(resolved).toBe("thinking");
  });
});
