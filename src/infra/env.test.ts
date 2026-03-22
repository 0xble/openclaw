import { describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: loggerMocks.info,
  }),
}));

import { isTruthyEnvValue, logAcceptedEnvOption, normalizeEnv, normalizeZaiEnv } from "./env.js";

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  }
}

describe("normalizeZaiEnv", () => {
  it("copies Z_AI_API_KEY to ZAI_API_KEY when missing", () => {
    withEnv({ ZAI_API_KEY: "", Z_AI_API_KEY: "zai-legacy" }, () => {
      normalizeZaiEnv();
      expect(process.env.ZAI_API_KEY).toBe("zai-legacy");
    });
  });

  it("does not override existing ZAI_API_KEY", () => {
    withEnv({ ZAI_API_KEY: "zai-current", Z_AI_API_KEY: "zai-legacy" }, () => {
      normalizeZaiEnv();
      expect(process.env.ZAI_API_KEY).toBe("zai-current");
    });
  });

  it("ignores blank legacy Z_AI_API_KEY values", () => {
    withEnv({ ZAI_API_KEY: "", Z_AI_API_KEY: "   " }, () => {
      normalizeZaiEnv();
      expect(process.env.ZAI_API_KEY).toBe("");
    });
  });

  it("does not copy when legacy Z_AI_API_KEY is unset", () => {
    withEnv({ ZAI_API_KEY: "", Z_AI_API_KEY: undefined }, () => {
      normalizeZaiEnv();
      expect(process.env.ZAI_API_KEY).toBe("");
    });
  });
});

describe("isTruthyEnvValue", () => {
  it("accepts common truthy values", () => {
    expect(isTruthyEnvValue("1")).toBe(true);
    expect(isTruthyEnvValue("true")).toBe(true);
    expect(isTruthyEnvValue(" yes ")).toBe(true);
    expect(isTruthyEnvValue("ON")).toBe(true);
  });

  it("rejects other values", () => {
    expect(isTruthyEnvValue("0")).toBe(false);
    expect(isTruthyEnvValue("false")).toBe(false);
    expect(isTruthyEnvValue("")).toBe(false);
    expect(isTruthyEnvValue(undefined)).toBe(false);
  });
});

describe("logAcceptedEnvOption", () => {
  it("logs accepted env options once with redaction and formatting", () => {
    loggerMocks.info.mockClear();

    withEnv(
      {
        VITEST: "",
        NODE_ENV: "development",
        OPENCLAW_TEST_ENV: "  line one\nline two  ",
      },
      () => {
        logAcceptedEnvOption({
          key: "OPENCLAW_TEST_ENV",
          description: "test option",
          redact: true,
        });
        logAcceptedEnvOption({
          key: "OPENCLAW_TEST_ENV",
          description: "test option",
          redact: true,
        });
      },
    );

    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    expect(loggerMocks.info).toHaveBeenCalledWith(
      "env: OPENCLAW_TEST_ENV=<redacted> (test option)",
    );
  });

  it("skips blank values and test-mode logging", () => {
    loggerMocks.info.mockClear();

    withEnv(
      {
        VITEST: "1",
        NODE_ENV: "development",
        OPENCLAW_BLANK_ENV: "value",
      },
      () => {
        logAcceptedEnvOption({
          key: "OPENCLAW_BLANK_ENV",
          description: "skipped in vitest",
        });
      },
    );

    withEnv(
      {
        VITEST: "",
        NODE_ENV: "development",
        OPENCLAW_BLANK_ENV: "   ",
      },
      () => {
        logAcceptedEnvOption({
          key: "OPENCLAW_BLANK_ENV",
          description: "blank value",
        });
      },
    );

    expect(loggerMocks.info).not.toHaveBeenCalled();
  });
});

describe("normalizeEnv", () => {
  it("normalizes the legacy ZAI env alias", () => {
    withEnv({ ZAI_API_KEY: "", Z_AI_API_KEY: "zai-legacy" }, () => {
      normalizeEnv();
      expect(process.env.ZAI_API_KEY).toBe("zai-legacy");
    });
  });

  it("drops inherited NODE_USE_SYSTEM_CA for darwin service runtimes", () => {
    withPlatform("darwin", () => {
      withEnv(
        {
          OPENCLAW_SERVICE_KIND: "gateway",
          NODE_USE_SYSTEM_CA: "1",
          NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem",
        },
        () => {
          normalizeEnv();
          expect(process.env.NODE_USE_SYSTEM_CA).toBeUndefined();
        },
      );
    });
  });

  it("preserves explicit custom CA bundles for darwin service runtimes", () => {
    withPlatform("darwin", () => {
      withEnv(
        {
          OPENCLAW_SERVICE_KIND: "gateway",
          NODE_USE_SYSTEM_CA: "1",
          NODE_EXTRA_CA_CERTS: "/custom/certs/ca.pem",
        },
        () => {
          normalizeEnv();
          expect(process.env.NODE_USE_SYSTEM_CA).toBe("1");
        },
      );
    });
  });

  it("does not touch NODE_USE_SYSTEM_CA outside darwin service runtimes", () => {
    withPlatform("linux", () => {
      withEnv(
        {
          OPENCLAW_SERVICE_KIND: "gateway",
          NODE_USE_SYSTEM_CA: "1",
          NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem",
        },
        () => {
          normalizeEnv();
          expect(process.env.NODE_USE_SYSTEM_CA).toBe("1");
        },
      );
    });

    withPlatform("darwin", () => {
      withEnv(
        {
          OPENCLAW_SERVICE_KIND: "",
          NODE_USE_SYSTEM_CA: "1",
          NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem",
        },
        () => {
          normalizeEnv();
          expect(process.env.NODE_USE_SYSTEM_CA).toBe("1");
        },
      );
    });
  });
});
