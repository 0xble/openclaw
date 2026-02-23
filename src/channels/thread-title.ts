import { deriveConversationTitle, isDefaultThreadPlaceholder } from "./conversation-title.js";

export type ThreadTitleErrorClass = "permission" | "rate_limit" | "not_found" | "unknown";

export type ThreadTitleState = {
  threadKey: string;
  status: "pending" | "applied" | "disabled" | "retry_after";
  attempts?: number;
  lastAttemptAt?: number;
  appliedAt?: number;
  appliedTitle?: string;
  lastProposedTitle?: string;
  retryAfter?: number;
  lastErrorClass?: ThreadTitleErrorClass;
};

export type ThreadTitleTarget = {
  channel: string;
  accountId?: string;
  conversationId?: string;
  threadId?: string | number;
  to?: string;
};

export type ThreadTitleProvider = {
  channel: string;
  resolveThreadKey?: (target: ThreadTitleTarget) => string | undefined;
  getCurrentTitle?: (target: ThreadTitleTarget) => Promise<string | undefined>;
  setTitle: (target: ThreadTitleTarget, title: string) => Promise<void>;
  classifyError?: (error: unknown) => ThreadTitleErrorClass;
  retryAfterMs?: (error: unknown, errorClass: ThreadTitleErrorClass) => number | undefined;
};

export type ThreadTitleStateStore = {
  get: (threadKey: string) => ThreadTitleState | undefined;
  set: (threadKey: string, state: ThreadTitleState) => void;
};

export type ThreadTitleResult = {
  outcome: "applied" | "skipped" | "failed";
  reason: string;
  title?: string;
  threadKey?: string;
  errorClass?: ThreadTitleErrorClass;
};

const DEFAULT_MAX_ENTRIES = 5_000;

function resolveDefaultThreadKey(target: ThreadTitleTarget): string | undefined {
  const channel = target.channel.trim().toLowerCase();
  const conversationId = target.conversationId?.trim() ?? target.to?.trim() ?? "";
  const threadId = target.threadId != null ? String(target.threadId).trim() : "";
  if (!channel || !conversationId || !threadId) {
    return undefined;
  }
  return `${channel}:${conversationId}:${threadId}`;
}

function setStoreState(
  store: ThreadTitleStateStore,
  state: ThreadTitleState,
): ThreadTitleState | undefined {
  if (!state.threadKey) {
    return undefined;
  }
  store.set(state.threadKey, state);
  return state;
}

export function createInMemoryThreadTitleStateStore(
  maxEntries = DEFAULT_MAX_ENTRIES,
): ThreadTitleStateStore {
  const stateMap = new Map<string, ThreadTitleState>();
  return {
    get(threadKey) {
      return stateMap.get(threadKey);
    },
    set(threadKey, state) {
      stateMap.delete(threadKey);
      stateMap.set(threadKey, state);
      while (stateMap.size > maxEntries) {
        const oldestKey = stateMap.keys().next().value;
        if (!oldestKey) {
          break;
        }
        stateMap.delete(oldestKey);
      }
    },
  };
}

const defaultStateStore = createInMemoryThreadTitleStateStore();

export async function applyThreadTitle(params: {
  provider: ThreadTitleProvider;
  target: ThreadTitleTarget;
  primaryText?: string;
  fallbackText?: string;
  maxChars: number;
  nowMs?: () => number;
  stateStore?: ThreadTitleStateStore;
}): Promise<ThreadTitleResult> {
  const channel = params.target.channel.trim().toLowerCase();
  const providerChannel = params.provider.channel.trim().toLowerCase();
  if (!channel || channel !== providerChannel) {
    return { outcome: "skipped", reason: "provider_mismatch" };
  }

  const resolveThreadKey = params.provider.resolveThreadKey ?? resolveDefaultThreadKey;
  const threadKey = resolveThreadKey(params.target);
  if (!threadKey) {
    return { outcome: "skipped", reason: "unsupported_target" };
  }

  const stateStore = params.stateStore ?? defaultStateStore;
  const now = params.nowMs?.() ?? Date.now();
  const existingState = stateStore.get(threadKey);
  if (existingState?.status === "disabled") {
    return { outcome: "skipped", reason: "disabled", threadKey };
  }
  if (
    existingState?.status === "retry_after" &&
    typeof existingState.retryAfter === "number" &&
    existingState.retryAfter > now
  ) {
    return { outcome: "skipped", reason: "cooldown", threadKey };
  }
  if (existingState?.status === "applied") {
    return { outcome: "skipped", reason: "already_applied", threadKey };
  }

  const title = deriveConversationTitle({
    primaryText: params.primaryText,
    fallbackText: params.fallbackText,
    maxChars: params.maxChars,
  });
  if (!title) {
    return { outcome: "skipped", reason: "no_candidate", threadKey };
  }

  const attempts = (existingState?.attempts ?? 0) + 1;
  const baseState: ThreadTitleState = {
    threadKey,
    status: "pending",
    attempts,
    lastAttemptAt: now,
    lastProposedTitle: title,
    lastErrorClass: existingState?.lastErrorClass,
    appliedAt: existingState?.appliedAt,
    appliedTitle: existingState?.appliedTitle,
    retryAfter: existingState?.retryAfter,
  };
  setStoreState(stateStore, baseState);

  if (params.provider.getCurrentTitle) {
    try {
      const currentTitle = await params.provider.getCurrentTitle(params.target);
      if (currentTitle && !isDefaultThreadPlaceholder(currentTitle)) {
        setStoreState(stateStore, {
          ...baseState,
          status: "disabled",
          appliedAt: now,
          appliedTitle: currentTitle,
        });
        return {
          outcome: "skipped",
          reason: "existing_title_present",
          threadKey,
        };
      }
    } catch {
      // Best-effort current-title check.
    }
  }

  try {
    await params.provider.setTitle(params.target, title);
    setStoreState(stateStore, {
      ...baseState,
      status: "applied",
      appliedAt: now,
      appliedTitle: title,
      retryAfter: undefined,
      lastErrorClass: undefined,
    });
    return {
      outcome: "applied",
      reason: "applied",
      title,
      threadKey,
    };
  } catch (error) {
    const errorClass = params.provider.classifyError?.(error) ?? "unknown";
    const retryAfterMs =
      params.provider.retryAfterMs?.(error, errorClass) ??
      (errorClass === "rate_limit" ? 60_000 : 15_000);
    if (errorClass === "permission" || errorClass === "not_found") {
      setStoreState(stateStore, {
        ...baseState,
        status: "disabled",
        lastErrorClass: errorClass,
      });
    } else {
      setStoreState(stateStore, {
        ...baseState,
        status: "retry_after",
        retryAfter: now + Math.max(1_000, retryAfterMs),
        lastErrorClass: errorClass,
      });
    }
    return {
      outcome: "failed",
      reason: "set_title_failed",
      title,
      threadKey,
      errorClass,
    };
  }
}
