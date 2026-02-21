import { describe, expect, it } from "vitest";
import {
  connectOk,
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway talk.config", () => {
  it("returns redacted talk config for read scope", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        voiceId: "voice-123",
        apiKey: "secret-key-abc",
      },
      session: {
        mainKey: "main-test",
      },
      ui: {
        seamColor: "#112233",
      },
    });

    await withServer(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
      const res = await rpcReq<{ config?: { talk?: { apiKey?: string; voiceId?: string } } }>(
        ws,
        "talk.config",
        {},
      );
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.voiceId).toBe("voice-123");
      expect(res.payload?.config?.talk?.apiKey).toBe("__OPENCLAW_REDACTED__");
    });
  });

  it("requires operator.talk.secrets for includeSecrets", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        apiKey: "secret-key-abc",
      },
    });

    await withServer(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
      const res = await rpcReq(ws, "talk.config", { includeSecrets: true });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("missing scope: operator.talk.secrets");
    });
  });

  it("returns secrets for operator.talk.secrets scope", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    const { listDevicePairing, approveDevicePairing } = await import("../infra/device-pairing.js");
    const { WebSocket } = await import("ws");
    await writeConfigFile({
      talk: {
        apiKey: "secret-key-abc",
      },
    });

    const started = await startServerWithClient("secret");
    const ws = started.ws;
    let ws2: InstanceType<typeof WebSocket> | undefined;
    try {
      const first = await connectReq(ws, {
        token: "secret",
        scopes: ["operator.read", "operator.write", "operator.talk.secrets"],
      });
      if (!first.ok) {
        expect(first.error?.message ?? "").toContain("pairing required");
        const pending = await listDevicePairing();
        const request = pending.pending.find((entry) =>
          (entry.scopes ?? []).includes("operator.talk.secrets"),
        );
        expect(request).toBeTruthy();
        if (!request) {
          throw new Error("expected pending pairing request for operator.talk.secrets");
        }
        await approveDevicePairing(request.requestId);
      }

      ws.close();
      const ws2Socket = new WebSocket(`ws://127.0.0.1:${started.port}`);
      ws2 = ws2Socket;
      await new Promise<void>((resolve) => ws2Socket.once("open", resolve));
      await connectOk(ws2Socket, {
        token: "secret",
        scopes: ["operator.read", "operator.write", "operator.talk.secrets"],
      });
      const res = await rpcReq<{ config?: { talk?: { apiKey?: string } } }>(
        ws2Socket,
        "talk.config",
        {
          includeSecrets: true,
        },
      );
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.apiKey).toBe("secret-key-abc");
    } finally {
      ws2?.close();
      ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
