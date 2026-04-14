import type { OpenClawConfig } from "../config/types.openclaw.js";

export type CancelAcpSessionAdmin = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason: string;
}) => Promise<void>;

export type KillSubagentRunAdminResult = {
  found: boolean;
  killed: boolean;
  runId?: string;
  sessionKey?: string;
  cascadeKilled?: number;
  cascadeLabels?: string[];
};

export type KillSubagentRunAdmin = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}) => Promise<KillSubagentRunAdminResult>;

export type AbortReplyRunBySessionKey = (sessionKey: string) => boolean;

export type TaskRegistryControlRuntime = {
  abortReplyRunBySessionKey: AbortReplyRunBySessionKey;
  getAcpSessionManager: () => {
    cancelSession: CancelAcpSessionAdmin;
  };
  killSubagentRunAdmin: KillSubagentRunAdmin;
};
