import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { createConfigIO } from "./io.js";

async function writeFutureTouchedConfig(configPath: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        meta: {
          lastTouchedVersion: "9999.1.1",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

describe("config io future-version warning", () => {
  it("warns for future-touched config by default", async () => {
    await withTempHome("openclaw-config-future-warning-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await writeFutureTouchedConfig(configPath);
      const warn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: () => {} },
      });

      await io.readConfigFileSnapshot();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Config was last written by a newer OpenClaw"),
      );
    });
  });

  it("suppresses the warning when notes are disabled", async () => {
    await withTempHome("openclaw-config-future-warning-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await writeFutureTouchedConfig(configPath);
      const warn = vi.fn();
      const io = createConfigIO({
        env: { OPENCLAW_SUPPRESS_NOTES: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: () => {} },
      });

      await io.readConfigFileSnapshot();

      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Config was last written by a newer OpenClaw"),
      );
    });
  });
});
