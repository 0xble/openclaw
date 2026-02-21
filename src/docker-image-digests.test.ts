import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const DIGEST_PINNED_DOCKERFILES = [
  "Dockerfile",
  "Dockerfile.sandbox",
  "Dockerfile.sandbox-browser",
  "scripts/docker/cleanup-smoke/Dockerfile",
  "scripts/docker/install-sh-e2e/Dockerfile",
  "scripts/docker/install-sh-nonroot/Dockerfile",
  "scripts/docker/install-sh-smoke/Dockerfile",
  "scripts/e2e/Dockerfile",
  "scripts/e2e/Dockerfile.qr-import",
] as const;
const existingDigestDockerfiles = DIGEST_PINNED_DOCKERFILES.filter((dockerfilePath) =>
  existsSync(resolve(repoRoot, dockerfilePath)),
);
const dependabotPath = resolve(repoRoot, ".github/dependabot.yml");
const itIfDigestDockerfilesPresent = existingDigestDockerfiles.length > 0 ? it : it.skip;
const itIfDependabotPresent = existsSync(dependabotPath) ? it : it.skip;

type DependabotDockerGroup = {
  patterns?: string[];
};

type DependabotUpdate = {
  "package-ecosystem"?: string;
  directory?: string;
  schedule?: { interval?: string };
  groups?: Record<string, DependabotDockerGroup>;
};

type DependabotConfig = {
  updates?: DependabotUpdate[];
};

describe("docker base image pinning", () => {
  itIfDigestDockerfilesPresent(
    "pins selected Dockerfile FROM lines to immutable sha256 digests",
    async () => {
      for (const dockerfilePath of existingDigestDockerfiles) {
        const dockerfile = await readFile(resolve(repoRoot, dockerfilePath), "utf8");
        const fromLine = dockerfile
          .split(/\r?\n/)
          .find((line) => line.trimStart().startsWith("FROM "));
        expect(fromLine, `${dockerfilePath} should define a FROM line`).toBeDefined();
        expect(fromLine, `${dockerfilePath} FROM must be digest-pinned`).toMatch(
          /^FROM\s+\S+@sha256:[a-f0-9]{64}$/,
        );
      }
    },
  );

  itIfDependabotPresent(
    "keeps Dependabot Docker updates enabled for root Dockerfiles",
    async () => {
      const raw = await readFile(dependabotPath, "utf8");
      const config = parse(raw) as DependabotConfig;
      const dockerUpdate = config.updates?.find(
        (update) => update["package-ecosystem"] === "docker" && update.directory === "/",
      );

      expect(dockerUpdate).toBeDefined();
      expect(dockerUpdate?.schedule?.interval).toBe("weekly");
      expect(dockerUpdate?.groups?.["docker-images"]?.patterns).toContain("*");
    },
  );
});
