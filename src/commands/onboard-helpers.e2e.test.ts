import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.resetModules();
});

const loadOnboardHelpers = async () => await import("./onboard-helpers.js");

const mocks = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn<
    (
      argv: string[],
      options?: { timeoutMs?: number; windowsVerbatimArguments?: boolean },
    ) => Promise<{ stdout: string; stderr: string; code: number; signal: null; killed: boolean }>
  >(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  })),
  pickPrimaryTailnetIPv4: vi.fn<() => string | undefined>(() => undefined),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
}));

vi.mock("../config/sessions.js", () => ({
  resolveSessionTranscriptsDirForAgent: () => "/tmp/openclaw/sessions",
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

vi.mock("../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/openclaw/workspace",
  ensureAgentWorkspace: vi.fn(async ({ dir }: { dir: string }) => ({ dir })),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("openUrl", () => {
  it("quotes URLs on win32 so '&' is not treated as cmd separator", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");

    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost";

    const { openUrl } = await loadOnboardHelpers();
    const ok = await openUrl(url);
    expect(ok).toBe(true);

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);
    const [argv, options] = mocks.runCommandWithTimeout.mock.calls[0] ?? [];
    expect(argv?.slice(0, 4)).toEqual(["cmd", "/c", "start", '""']);
    expect(argv?.at(-1)).toBe(`"${url}"`);
    expect(options).toMatchObject({
      timeoutMs: 5_000,
      windowsVerbatimArguments: true,
    });

    platformSpy.mockRestore();
  });
});

describe("resolveBrowserOpenCommand", () => {
  it("marks win32 commands as quoteUrl=true", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { resolveBrowserOpenCommand } = await loadOnboardHelpers();
    const resolved = await resolveBrowserOpenCommand();
    expect(resolved.argv).toEqual(["cmd", "/c", "start", ""]);
    expect(resolved.quoteUrl).toBe(true);
    platformSpy.mockRestore();
  });
});

describe("resolveControlUiLinks", () => {
  it("uses customBindHost for custom bind", async () => {
    const { resolveControlUiLinks } = await loadOnboardHelpers();
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.1.100",
    });
    expect(links.httpUrl).toBe("http://192.168.1.100:18789/");
    expect(links.wsUrl).toBe("ws://192.168.1.100:18789");
  });

  it("falls back to loopback for invalid customBindHost", async () => {
    const { resolveControlUiLinks } = await loadOnboardHelpers();
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.001.100",
    });
    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });

  it("uses tailnet IP for tailnet bind", async () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const { resolveControlUiLinks } = await loadOnboardHelpers();
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "tailnet",
    });
    expect(links.httpUrl).toBe("http://100.64.0.9:18789/");
    expect(links.wsUrl).toBe("ws://100.64.0.9:18789");
  });

  it("keeps loopback for auto even when tailnet is present", async () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const { resolveControlUiLinks } = await loadOnboardHelpers();
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "auto",
    });
    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });
});

describe("normalizeGatewayTokenInput", () => {
  it("returns empty string for undefined or null", async () => {
    const { normalizeGatewayTokenInput } = await loadOnboardHelpers();
    expect(normalizeGatewayTokenInput(undefined)).toBe("");
    expect(normalizeGatewayTokenInput(null)).toBe("");
  });

  it("trims string input", async () => {
    const { normalizeGatewayTokenInput } = await loadOnboardHelpers();
    expect(normalizeGatewayTokenInput("  token  ")).toBe("token");
  });

  it("returns empty string for non-string input", async () => {
    const { normalizeGatewayTokenInput } = await loadOnboardHelpers();
    expect(normalizeGatewayTokenInput(123)).toBe("");
  });

  it('rejects literal string coercion artifacts ("undefined"/"null")', async () => {
    const { normalizeGatewayTokenInput } = await loadOnboardHelpers();
    expect(normalizeGatewayTokenInput("undefined")).toBe("");
    expect(normalizeGatewayTokenInput("null")).toBe("");
  });
});

describe("validateGatewayPasswordInput", () => {
  it("requires a non-empty password", async () => {
    const { validateGatewayPasswordInput } = await loadOnboardHelpers();
    expect(validateGatewayPasswordInput("")).toBe("Required");
    expect(validateGatewayPasswordInput("   ")).toBe("Required");
  });

  it("rejects literal string coercion artifacts", async () => {
    const { validateGatewayPasswordInput } = await loadOnboardHelpers();
    expect(validateGatewayPasswordInput("undefined")).toBe(
      'Cannot be the literal string "undefined" or "null"',
    );
    expect(validateGatewayPasswordInput("null")).toBe(
      'Cannot be the literal string "undefined" or "null"',
    );
  });

  it("accepts a normal password", async () => {
    const { validateGatewayPasswordInput } = await loadOnboardHelpers();
    expect(validateGatewayPasswordInput(" secret ")).toBeUndefined();
  });
});
