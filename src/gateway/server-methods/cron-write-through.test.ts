import { describe, expect, it, vi } from "vitest";
import {
  maybeWriteCronStoreThroughDotfiles,
  resolveCronWriteThroughConfig,
} from "./cron-write-through.js";

describe("cron write-through config", () => {
  it("defaults to off", () => {
    const cfg = resolveCronWriteThroughConfig({});
    expect(cfg.mode).toBe("off");
    expect(cfg.bin).toBe("chezmoi");
  });

  it("supports explicit required mode", () => {
    const cfg = resolveCronWriteThroughConfig({
      OPENCLAW_CRON_WRITE_THROUGH_MODE: "required",
    });
    expect(cfg.mode).toBe("required");
  });
});

describe("maybeWriteCronStoreThroughDotfiles", () => {
  it("runs chezmoi re-add when enabled", async () => {
    const runExecFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await maybeWriteCronStoreThroughDotfiles("~/cron/jobs.json", {
      env: { OPENCLAW_CRON_WRITE_THROUGH: "1" },
      runExecFn,
    });

    expect(runExecFn).toHaveBeenCalledTimes(1);
    const [bin, args] = runExecFn.mock.calls[0] as [string, string[], { timeoutMs: number }];
    expect(bin).toBe("chezmoi");
    expect(args[0]).toBe("re-add");
    expect(args[1]).toContain("/cron/jobs.json");
  });

  it("logs and continues in best-effort mode", async () => {
    const runExecFn = vi.fn().mockRejectedValue(new Error("boom"));
    const warn = vi.fn();

    await maybeWriteCronStoreThroughDotfiles("/tmp/jobs.json", {
      env: { OPENCLAW_CRON_WRITE_THROUGH_MODE: "best-effort" },
      runExecFn,
      warn,
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("skips re-add when cron store path is already in dotfiles source", async () => {
    const runExecFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await maybeWriteCronStoreThroughDotfiles(
      "~/dotfiles/private_dot_openclaw/private_cron/jobs.json",
      {
        env: { OPENCLAW_CRON_WRITE_THROUGH_MODE: "required" },
        runExecFn,
      },
    );

    expect(runExecFn).not.toHaveBeenCalled();
  });

  it("throws in required mode", async () => {
    const runExecFn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(
      maybeWriteCronStoreThroughDotfiles("/tmp/jobs.json", {
        env: { OPENCLAW_CRON_WRITE_THROUGH_MODE: "required" },
        runExecFn,
      }),
    ).rejects.toThrow("write-through failed");
  });
});
