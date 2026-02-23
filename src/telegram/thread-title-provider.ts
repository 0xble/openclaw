import type { Bot } from "grammy";
import type { ThreadTitleProvider, ThreadTitleTarget } from "../channels/thread-title.js";
import { renameForumTopicTelegram } from "./send.js";

function textFromError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") {
      return message;
    }
    const description = Reflect.get(error, "description");
    if (typeof description === "string") {
      return description;
    }
  }
  return "";
}

function classifyTelegramTitleError(
  error: unknown,
): "permission" | "rate_limit" | "not_found" | "unknown" {
  const message = textFromError(error).toLowerCase();
  if (!message) {
    return "unknown";
  }
  if (
    [
      "not enough rights",
      "forbidden",
      "have no rights",
      "can't be edited",
      "cannot edit",
      "bot was kicked",
    ].some((token) => message.includes(token))
  ) {
    return "permission";
  }
  if (
    ["too many requests", "retry after", "flood control", "rate limit", "429"].some((token) =>
      message.includes(token),
    )
  ) {
    return "rate_limit";
  }
  if (
    ["thread not found", "topic not found", "chat not found", "message to edit not found"].some(
      (token) => message.includes(token),
    )
  ) {
    return "not_found";
  }
  return "unknown";
}

export function createTelegramThreadTitleProvider(params: {
  api: Bot["api"];
  token?: string;
  accountId?: string;
}): ThreadTitleProvider {
  return {
    channel: "telegram",
    resolveThreadKey(target: ThreadTitleTarget): string | undefined {
      const chatId = target.conversationId?.trim();
      const topicId = target.threadId != null ? Math.trunc(Number(target.threadId)) : NaN;
      if (!chatId || !Number.isFinite(topicId) || topicId <= 1) {
        return undefined;
      }
      return `telegram:${chatId}:${String(topicId)}`;
    },
    async setTitle(target: ThreadTitleTarget, title: string): Promise<void> {
      const chatId = target.conversationId?.trim();
      const topicId = target.threadId != null ? Math.trunc(Number(target.threadId)) : NaN;
      const trimmedTitle = title.trim();
      if (!chatId || !Number.isFinite(topicId) || topicId <= 1 || !trimmedTitle) {
        return;
      }
      await renameForumTopicTelegram(chatId, topicId, trimmedTitle, {
        token: params.token,
        accountId: params.accountId,
        api: params.api,
      });
    },
    classifyError: classifyTelegramTitleError,
    retryAfterMs(error, errorClass): number | undefined {
      if (errorClass !== "rate_limit") {
        return undefined;
      }
      const message = textFromError(error);
      const match = /retry after\s+(\d+)/i.exec(message);
      if (!match?.[1]) {
        return undefined;
      }
      const seconds = Number.parseInt(match[1], 10);
      return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
    },
  };
}
