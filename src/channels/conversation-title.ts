import { isControlCommandMessage } from "../auto-reply/command-detection.js";

const SLASH_COMMAND_RE = /^\/[a-z0-9_]+(?:\s|$)/i;
const LOW_SIGNAL_RE = /^(?:hi|hello|hey|yo|ok|okay|test|ping)$/i;
const STICKER_PLACEHOLDER_RE = /^\[Sticker(?: [^\]]+)?\](?:\s+.*)?$/i;
const ATTACHMENT_PLACEHOLDER_TOKEN_RE = /<media:[^>]+>(?:\s*\([^)]*\))?/gi;
const SLACK_ATTACHMENT_PLACEHOLDER_TOKEN_RE =
  /\[(?:Slack file|Forwarded image|attached)(?::\s*[^\]]+)?\]/gi;
const ATTACHMENT_SECTION_TOKEN_RE = /\[(?:Image|Audio|Video)(?:\s+\d+\/\d+)?\]/gi;
const ATTACHMENT_SECTION_LABEL_RE = /\b(?:User text|Description|Transcript):/gi;
const FILE_OPEN_TAG_RE = /<file\b[^>]*\bname="([^"]+)"[^>]*>/gi;
const FILE_CLOSE_TAG_RE = /<\/file>/gi;
const ATTACHMENT_NOTE_HEADER_RE = /\[(?:media|attachment) attached:\s*\d+\s+files\]/gi;
const ATTACHMENT_NOTE_ENTRY_RE =
  /\[(?:media|attachment) attached(?: \d+\/\d+)?:\s*([^\]|]+)(?:\s*\([^)]+\))?(?:\s*\|[^\]]+)?\]/gi;
const SLACK_ATTACHMENT_NAME_TOKEN_RE = /\[(?:Slack file|Forwarded image|attached):\s*([^\]]+)\]/gi;

const DEFAULT_THREAD_PLACEHOLDERS = new Set([
  "new conversation",
  "new thread",
  "new chat",
  "untitled",
  "general",
  "no title",
]);

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[;:,.!?]+$/, "").trim();
}

function pickAttachmentName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const head = (trimmed.split("|")[0]?.trim() ?? trimmed).replace(/\s+\([^)]+\)\s*$/g, "");
  const normalizedPath = head.replace(/\\/g, "/");
  const name = normalizedPath.split("/").at(-1)?.trim() || head;
  const withoutQuotes = name.replace(/^['"`]+|['"`]+$/g, "").trim();
  const candidate = stripTrailingPunctuation(withoutQuotes);
  return candidate || undefined;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeAttachmentTokens(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (STICKER_PLACEHOLDER_RE.test(trimmed)) {
    return "";
  }

  return trimmed
    .replace(FILE_OPEN_TAG_RE, (_match, rawName: string) => {
      const decoded = decodeXmlEntities(rawName);
      const candidate = pickAttachmentName(decoded) ?? decoded.trim();
      return candidate ? ` ${candidate} ` : " ";
    })
    .replace(FILE_CLOSE_TAG_RE, " ")
    .replace(ATTACHMENT_SECTION_TOKEN_RE, " ")
    .replace(ATTACHMENT_SECTION_LABEL_RE, " ")
    .replace(ATTACHMENT_NOTE_HEADER_RE, " ")
    .replace(ATTACHMENT_NOTE_ENTRY_RE, (_match, pathValue: string) => {
      const candidate = pickAttachmentName(pathValue);
      return candidate ? ` ${candidate} ` : " ";
    })
    .replace(SLACK_ATTACHMENT_NAME_TOKEN_RE, (_match, rawName: string) => {
      const candidate = pickAttachmentName(rawName);
      return candidate ? ` ${candidate} ` : " ";
    })
    .replace(ATTACHMENT_PLACEHOLDER_TOKEN_RE, " ")
    .replace(SLACK_ATTACHMENT_PLACEHOLDER_TOKEN_RE, " ")
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

    title = normalizeAttachmentTokens(title);
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

export function isDefaultThreadPlaceholder(value?: string): boolean {
  if (!value) {
    return true;
  }
  return DEFAULT_THREAD_PLACEHOLDERS.has(value.trim().toLowerCase());
}
