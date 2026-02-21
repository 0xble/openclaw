import { isControlCommandMessage } from "../auto-reply/command-detection.js";

const SLASH_COMMAND_RE = /^\/[a-z0-9_]+(?:\s|$)/i;
const LOW_SIGNAL_RE = /^(?:hi|hello|hey|yo|ok|okay|test|ping)$/i;
const STICKER_PLACEHOLDER_RE = /^\[Sticker(?: [^\]]+)?\](?:\s+.*)?$/i;
const MEDIA_PLACEHOLDER_TOKEN_RE = /<media:[^>]+>(?:\s*\([^)]*\))?/gi;
const SLACK_MEDIA_PLACEHOLDER_TOKEN_RE =
  /\[(?:Slack file|Forwarded image|attached)(?::\s*[^\]]+)?\]/gi;

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[;:,.!?]+$/, "").trim();
}

function stripMediaPlaceholderTokens(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (STICKER_PLACEHOLDER_RE.test(trimmed)) {
    return "";
  }
  return trimmed
    .replace(MEDIA_PLACEHOLDER_TOKEN_RE, " ")
    .replace(SLACK_MEDIA_PLACEHOLDER_TOKEN_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveConversationTitle(params: {
  primaryText?: string;
  fallbackText?: string;
  maxChars: number;
}): string | undefined {
  const maxChars = Math.max(1, Math.trunc(params.maxChars));
  const sources = [params.primaryText, params.fallbackText];

  for (const source of sources) {
    if (typeof source !== "string" || !source.trim()) {
      continue;
    }

    let title = source
      .replace(/<@[^>]+>/g, " ")
      .replace(/\[[^\]]*message id:[^\]]*\]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!title) {
      continue;
    }

    if (SLASH_COMMAND_RE.test(title)) {
      continue;
    }

    title = title.replace(/^slack thread\s+/i, "");
    title = title.replace(/^[\s\-:;,.!?]+/, "").trim();
    if (!title || LOW_SIGNAL_RE.test(title)) {
      continue;
    }

    title = stripMediaPlaceholderTokens(title);
    title = stripTrailingPunctuation(title);
    if (!title || isControlCommandMessage(title)) {
      continue;
    }

    if (title.length > maxChars) {
      title = title.slice(0, maxChars).trim();
    }
    title = stripTrailingPunctuation(title);
    if (title.length < 3) {
      continue;
    }

    return title;
  }

  return undefined;
}
