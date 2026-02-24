import type { App } from "@slack/bolt";
import type { ThreadTitleProvider, ThreadTitleTarget } from "../channels/thread-title.js";

type SlackSetTitlePayload = {
  token: string;
  channel_id: string;
  thread_ts: string;
  title: string;
};

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNestedString(root: unknown, path: string[]): string | undefined {
  let current: unknown = root;
  for (const key of path) {
    const obj = readObject(current);
    if (!obj) {
      return undefined;
    }
    current = obj[key];
  }
  return readString(current);
}

function classifySlackTitleError(
  error: unknown,
): "permission" | "rate_limit" | "not_found" | "unknown" {
  const candidates = [
    readNestedString(error, ["data", "error"]),
    readNestedString(error, ["data", "needed"]),
    readNestedString(error, ["code"]),
    readNestedString(error, ["message"]),
    typeof error === "string" ? error : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

  if (
    candidates.some((value) =>
      [
        "missing_scope",
        "not_allowed_token_type",
        "not_authed",
        "invalid_auth",
        "account_inactive",
        "forbidden",
        "access_denied",
      ].some((token) => value.includes(token)),
    )
  ) {
    return "permission";
  }
  if (
    candidates.some((value) =>
      ["thread_not_found", "channel_not_found", "message_not_found", "not_found"].some((token) =>
        value.includes(token),
      ),
    )
  ) {
    return "not_found";
  }
  if (
    candidates.some((value) =>
      ["rate_limited", "ratelimited", "429", "too many requests"].some((token) =>
        value.includes(token),
      ),
    )
  ) {
    return "rate_limit";
  }
  return "unknown";
}

function resolveRetryAfterMs(error: unknown): number | undefined {
  const retryAfterHeader =
    readNestedString(error, ["data", "headers", "retry-after"]) ??
    readNestedString(error, ["headers", "retry-after"]);
  const retryAfterSeconds = Number.parseInt((retryAfterHeader ?? "").trim(), 10);
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return undefined;
  }
  return retryAfterSeconds * 1000;
}

export function createSlackThreadTitleProvider(params: {
  app: App;
  botToken: string;
}): ThreadTitleProvider {
  return {
    channel: "slack",
    resolveThreadKey(target: ThreadTitleTarget): string | undefined {
      const channelId = target.conversationId?.trim();
      const threadTs = target.threadId != null ? String(target.threadId).trim() : "";
      if (!channelId || !threadTs) {
        return undefined;
      }
      return `slack:${channelId}:${threadTs}`;
    },
    async setTitle(target: ThreadTitleTarget, title: string): Promise<void> {
      const channelId = target.conversationId?.trim();
      const threadTs = target.threadId != null ? String(target.threadId).trim() : "";
      const trimmedTitle = title.trim();
      if (!channelId || !threadTs || !trimmedTitle) {
        return;
      }

      const payload: SlackSetTitlePayload = {
        token: params.botToken,
        channel_id: channelId,
        thread_ts: threadTs,
        title: trimmedTitle,
      };
      const client = params.app.client as unknown as {
        assistant?: {
          threads?: {
            setTitle?: (args: SlackSetTitlePayload) => Promise<unknown>;
          };
        };
        apiCall?: (method: string, args: SlackSetTitlePayload) => Promise<unknown>;
      };

      if (client.assistant?.threads?.setTitle) {
        await client.assistant.threads.setTitle(payload);
        return;
      }
      if (typeof client.apiCall === "function") {
        await client.apiCall("assistant.threads.setTitle", payload);
        return;
      }
      throw new Error("Slack thread title API is unavailable");
    },
    classifyError: classifySlackTitleError,
    retryAfterMs: resolveRetryAfterMs,
  };
}
