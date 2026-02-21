import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listNativeCommandSpecsForConfig,
  type NativeCommandSpec,
} from "../src/auto-reply/commands-registry.js";
import { listSkillCommandsForAgents } from "../src/auto-reply/skill-commands.js";
import {
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "../src/config/commands.js";
import { loadConfig } from "../src/config/config.js";
import { resolveSlackAccount } from "../src/slack/accounts.js";

type CliArgs = {
  apply: boolean;
  appId?: string;
  commands?: string[];
  help: boolean;
  manifestOnly: boolean;
  mode: "recommended" | "all";
  slackConfigDir: string;
  teamId?: string;
  token?: string;
};

type SlackApiErrorResponse = {
  ok: false;
  error: string;
  errors?: Array<{
    code?: string;
    message?: string;
    pointer?: string;
    related_component?: string;
  }>;
  needed?: string;
  provided?: string;
};

type SlackApiOkResponse<T> = { ok: true } & T;

type SlackManifestCommand = {
  command?: string;
  description?: string;
  should_escape?: boolean;
};

type SlackManifest = {
  features?: {
    slash_commands?: SlackManifestCommand[];
    [key: string]: unknown;
  };
  oauth_config?: {
    scopes?: {
      bot?: string[];
      user?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type SlackAuthTestResponse = {
  team_id?: string;
};

type SlackManifestExportResponse = {
  manifest: SlackManifest;
};

type SlackManifestValidateResponse = Record<string, never>;

const RECOMMENDED_COMMANDS = [
  "help",
  "commands",
  "status",
  "context",
  "whoami",
  "usage",
  "stop",
  "new",
  "reset",
  "compact",
  "think",
  "verbose",
  "model",
  "models",
] as const;

const SLACK_DESCRIPTION_MAX = 100;

function usage(): string {
  return [
    "Sync OpenClaw Slack native commands into Slack app slash commands.",
    "",
    "Usage:",
    "  node --import tsx scripts/slack-sync-native-commands.ts [options]",
    "",
    "Options:",
    "  --apply                    Apply manifest update (default: dry-run)",
    "  --app-id <A...>            Slack app id (default: parse from channels.slack.appToken)",
    "  --commands <csv>           Explicit command list override (comma-separated, no leading /)",
    "  --manifest-only            Print desired slash_commands payload and exit",
    "  --mode <recommended|all>   Command set to sync (default: recommended)",
    "  --slack-config-dir <path>  Slack CLI config dir (default: ~/.slack)",
    "  --team-id <T...>           Slack team id (required when multiple creds exist)",
    "  --token <token>            App-config token (overrides Slack CLI credentials)",
    "  -h, --help                 Show this help",
    "",
    "Examples:",
    "  node --import tsx scripts/slack-sync-native-commands.ts --manifest-only",
    "  node --import tsx scripts/slack-sync-native-commands.ts --team-id T07FF8JU7T2 --apply",
    "  node --import tsx scripts/slack-sync-native-commands.ts --app-id A0A9MLBG3K8 --mode all --apply",
  ].join("\n");
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    apply: false,
    help: false,
    manifestOnly: false,
    mode: "recommended",
    slackConfigDir: "~/.slack",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    const expectValue = (flag: string): string => {
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${flag}`);
      }
      index += 1;
      return next;
    };

    switch (current) {
      case "--apply":
        args.apply = true;
        break;
      case "--app-id":
        args.appId = expectValue("--app-id").trim();
        break;
      case "--commands": {
        const raw = expectValue("--commands");
        args.commands = raw
          .split(",")
          .map((item) => item.trim().replace(/^\/+/, ""))
          .filter(Boolean);
        break;
      }
      case "--manifest-only":
        args.manifestOnly = true;
        break;
      case "--mode": {
        const mode = expectValue("--mode").trim();
        if (mode !== "recommended" && mode !== "all") {
          throw new Error(`Invalid --mode "${mode}". Expected recommended|all`);
        }
        args.mode = mode;
        break;
      }
      case "--slack-config-dir":
        args.slackConfigDir = expectValue("--slack-config-dir").trim();
        break;
      case "--team-id":
        args.teamId = expectValue("--team-id").trim();
        break;
      case "--token":
        args.token = expectValue("--token").trim();
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  return args;
}

function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function parseAppIdFromAppToken(raw?: string): string | undefined {
  const token = raw?.trim();
  if (!token) {
    return undefined;
  }
  const match = /^xapp-\d-([a-z0-9]+)-/i.exec(token);
  return match?.[1]?.toUpperCase();
}

function normalizeSlashCommandName(raw: string): string {
  return raw.trim().replace(/^\/+/, "").toLowerCase();
}

function truncateDescription(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= SLACK_DESCRIPTION_MAX) {
    return trimmed;
  }
  if (SLACK_DESCRIPTION_MAX <= 1) {
    return trimmed.slice(0, SLACK_DESCRIPTION_MAX);
  }
  return `${trimmed.slice(0, SLACK_DESCRIPTION_MAX - 1)}…`;
}

function loadTokenFromSlackCliCredentials(params: { slackConfigDir: string; teamId?: string }): {
  token: string;
  teamId?: string;
} {
  const credentialsPath = path.join(expandHome(params.slackConfigDir), "credentials.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(credentialsPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read Slack CLI credentials at ${credentialsPath}. Run "slack auth login" first. (${String(error)})`,
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid Slack CLI credentials at ${credentialsPath}`);
  }
  const map = parsed as Record<string, { token?: string; team_id?: string }>;
  if (params.teamId) {
    const entry = map[params.teamId];
    if (!entry?.token) {
      throw new Error(
        `No token found for team ${params.teamId} in ${credentialsPath}. Run "slack auth login --team ${params.teamId}".`,
      );
    }
    return { token: entry.token, teamId: params.teamId };
  }
  const entries = Object.entries(map).filter(([, value]) => typeof value?.token === "string");
  if (entries.length === 0) {
    throw new Error(`No Slack CLI tokens found in ${credentialsPath}`);
  }
  if (entries.length > 1) {
    const knownTeams = entries.map(([teamId]) => teamId).join(", ");
    throw new Error(`Multiple teams found (${knownTeams}); pass --team-id`);
  }
  const [teamId, value] = entries[0];
  return { token: value.token ?? "", teamId };
}

async function slackApi<T>(
  method: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const json = await slackApiRaw<T>(method, token, payload);
  if (!json.ok) {
    throw slackApiError(method, json);
  }
  return json as unknown as T;
}

async function slackApiRaw<T>(
  method: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<SlackApiErrorResponse | SlackApiOkResponse<T>> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  let json: SlackApiErrorResponse | SlackApiOkResponse<T>;
  try {
    json = (await response.json()) as SlackApiErrorResponse | SlackApiOkResponse<T>;
  } catch (error) {
    throw new Error(`Slack ${method} failed with non-JSON response (${String(error)})`, {
      cause: error,
    });
  }

  return json;
}

function slackApiError(method: string, json: SlackApiErrorResponse): Error {
  const details = [
    `Slack API ${method} failed: ${json.error}`,
    json.needed ? `needed=${json.needed}` : undefined,
    json.provided ? `provided=${json.provided}` : undefined,
  ]
    .filter(Boolean)
    .join(" | ");
  if (json.error === "missing_scope") {
    return new Error(
      `${details}. Use a Slack CLI/app-config token with app_configurations:read,app_configurations:write.`,
    );
  }
  if (json.error === "not_allowed_token_type") {
    return new Error(
      `${details}. Use an app-configuration token (xoxe...) from Slack app configuration credentials.`,
    );
  }
  if (json.error === "no_permission") {
    return new Error(
      `${details}. Ensure the token can manage this app manifest and that app/team IDs match (use a Personal app config token with app_configurations:read,app_configurations:write).`,
    );
  }
  if (json.error === "invalid_manifest" && Array.isArray(json.errors) && json.errors.length > 0) {
    const issues = json.errors
      .map((entry) => `${entry.code ?? "unknown"}${entry.pointer ? `@${entry.pointer}` : ""}`)
      .join(", ");
    return new Error(`${details} | manifest_errors=${issues}`);
  }
  return new Error(details);
}

function collectNativeSlackSpecs(): NativeCommandSpec[] {
  const cfg = loadConfig();
  const account = resolveSlackAccount({ cfg });
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "slack",
    providerSetting: account.config.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  if (!nativeEnabled) {
    throw new Error(
      "Slack native commands are disabled. Set channels.slack.commands.native=true first.",
    );
  }
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "slack",
    providerSetting: account.config.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });
  const skillCommands = nativeSkillsEnabled ? listSkillCommandsForAgents({ cfg }) : [];
  return listNativeCommandSpecsForConfig(cfg, { skillCommands, provider: "slack" });
}

function selectCommandNames(params: {
  explicit?: string[];
  mode: "recommended" | "all";
  specs: NativeCommandSpec[];
}): string[] {
  const available = new Set(params.specs.map((spec) => normalizeSlashCommandName(spec.name)));
  const dedupe = (names: readonly string[]) =>
    Array.from(new Set(names.map((name) => normalizeSlashCommandName(name))));

  if (params.explicit && params.explicit.length > 0) {
    const selected = dedupe(params.explicit);
    const missing = selected.filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw new Error(
        `Requested command(s) not in OpenClaw native command set: ${missing.join(", ")}`,
      );
    }
    return selected;
  }

  if (params.mode === "all") {
    return dedupe(params.specs.map((spec) => spec.name));
  }

  return dedupe(RECOMMENDED_COMMANDS).filter((name) => available.has(name));
}

function buildDesiredSlashCommands(
  names: string[],
  specs: NativeCommandSpec[],
): SlackManifestCommand[] {
  const byName = new Map(
    specs.map((spec) => [normalizeSlashCommandName(spec.name), spec.description.trim()]),
  );
  return names.map((name) => ({
    command: `/${name}`,
    description: truncateDescription(byName.get(name) ?? `OpenClaw command /${name}`),
    should_escape: false,
  }));
}

function ensureCommandsBotScope(manifest: SlackManifest): void {
  const oauthConfig = (manifest.oauth_config ??= {});
  const scopes = (oauthConfig.scopes ??= {});
  const botScopes = Array.isArray(scopes.bot) ? scopes.bot : [];
  if (!botScopes.includes("commands")) {
    botScopes.push("commands");
  }
  scopes.bot = botScopes;
}

function buildUpdatedManifest(
  manifest: SlackManifest,
  slashCommands: SlackManifestCommand[],
): SlackManifest {
  const updated: SlackManifest = {
    ...manifest,
    features: {
      ...manifest.features,
      slash_commands: slashCommands,
    },
  };
  ensureCommandsBotScope(updated);
  return updated;
}

function hasInvalidNameManifestError(error: SlackApiErrorResponse): boolean {
  if (error.error !== "invalid_manifest" || !Array.isArray(error.errors)) {
    return false;
  }
  return error.errors.some((entry) => entry.code === "invalid_name");
}

async function findInvalidSlashCommandNames(params: {
  token: string;
  manifest: SlackManifest;
  names: string[];
  specs: NativeCommandSpec[];
}): Promise<string[]> {
  const invalid: string[] = [];
  for (const name of params.names) {
    const oneCommandManifest = buildUpdatedManifest(
      params.manifest,
      buildDesiredSlashCommands([name], params.specs),
    );
    const validation = await slackApiRaw<SlackManifestValidateResponse>(
      "apps.manifest.validate",
      params.token,
      { manifest: oneCommandManifest },
    );
    if (!validation.ok && hasInvalidNameManifestError(validation)) {
      invalid.push(name);
    }
  }
  return invalid;
}

function commandSetFromManifest(manifest: SlackManifest): Set<string> {
  const raw = manifest.features?.slash_commands ?? [];
  return new Set(
    raw.map((entry) => normalizeSlashCommandName(entry.command ?? "")).filter(Boolean),
  );
}

function sortCommands(commands: Set<string>): string[] {
  return Array.from(commands).toSorted((left, right) => left.localeCompare(right));
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const specs = collectNativeSlackSpecs();
  let selectedCommandNames = selectCommandNames({
    explicit: args.commands,
    mode: args.mode,
    specs,
  });
  if (selectedCommandNames.length === 0) {
    throw new Error("No commands selected to sync.");
  }

  let desiredSlashCommands = buildDesiredSlashCommands(selectedCommandNames, specs);
  if (args.manifestOnly) {
    console.log(JSON.stringify({ slash_commands: desiredSlashCommands }, null, 2));
    return;
  }

  const cfg = loadConfig();
  const account = resolveSlackAccount({ cfg });
  const appId = args.appId ?? parseAppIdFromAppToken(account.appToken);
  if (!appId) {
    throw new Error("Missing app id. Pass --app-id or configure channels.slack.appToken.");
  }

  const credential = args.token
    ? { token: args.token, teamId: args.teamId }
    : loadTokenFromSlackCliCredentials({
        slackConfigDir: args.slackConfigDir,
        teamId: args.teamId,
      });
  const token = credential.token;

  const auth = await slackApi<SlackAuthTestResponse>("auth.test", token, {});
  const resolvedTeamId = args.teamId ?? credential.teamId ?? auth.team_id;
  if (args.teamId && auth.team_id && args.teamId !== auth.team_id) {
    throw new Error(`Token team mismatch. Expected ${args.teamId}, got ${auth.team_id}.`);
  }
  console.log(`Using team: ${resolvedTeamId ?? "unknown"}`);
  console.log(`Using app: ${appId}`);

  const exported = await slackApi<SlackManifestExportResponse>("apps.manifest.export", token, {
    app_id: appId,
  });
  const currentSet = commandSetFromManifest(exported.manifest);
  let desiredSet = new Set(selectedCommandNames);
  const toAdd = sortCommands(new Set([...desiredSet].filter((name) => !currentSet.has(name))));
  const toRemove = sortCommands(new Set([...currentSet].filter((name) => !desiredSet.has(name))));

  console.log(`Mode: ${args.mode}`);
  console.log(
    `Desired commands (${selectedCommandNames.length}): ${selectedCommandNames.map((name) => `/${name}`).join(", ")}`,
  );
  console.log(`Changes: add=${toAdd.length} remove=${toRemove.length}`);
  if (toAdd.length > 0) {
    console.log(`Add: ${toAdd.map((name) => `/${name}`).join(", ")}`);
  }
  if (toRemove.length > 0) {
    console.log(`Remove: ${toRemove.map((name) => `/${name}`).join(", ")}`);
  }

  let updatedManifest = buildUpdatedManifest(exported.manifest, desiredSlashCommands);

  if (!args.apply) {
    console.log("Dry-run only. Re-run with --apply to update Slack app manifest.");
    return;
  }

  const validation = await slackApiRaw<SlackManifestValidateResponse>(
    "apps.manifest.validate",
    token,
    { manifest: updatedManifest },
  );
  if (!validation.ok && hasInvalidNameManifestError(validation)) {
    const invalid = await findInvalidSlashCommandNames({
      token,
      manifest: exported.manifest,
      names: selectedCommandNames,
      specs,
    });
    if (invalid.length > 0) {
      const invalidSet = new Set(invalid);
      selectedCommandNames = selectedCommandNames.filter((name) => !invalidSet.has(name));
      if (selectedCommandNames.length === 0) {
        throw new Error(
          `All requested commands were rejected by Slack naming rules: ${invalid.join(", ")}`,
        );
      }
      desiredSlashCommands = buildDesiredSlashCommands(selectedCommandNames, specs);
      desiredSet = new Set(selectedCommandNames);
      updatedManifest = buildUpdatedManifest(exported.manifest, desiredSlashCommands);
      console.log(
        `Skipping invalid slash command name(s): ${invalid.map((name) => `/${name}`).join(", ")}`,
      );
    }
  } else if (!validation.ok) {
    throw slackApiError("apps.manifest.validate", validation);
  }

  const updated = await slackApiRaw("apps.manifest.update", token, {
    app_id: appId,
    manifest: updatedManifest,
  });
  if (!updated.ok) {
    throw slackApiError("apps.manifest.update", updated);
  }

  const verified = await slackApi<SlackManifestExportResponse>("apps.manifest.export", token, {
    app_id: appId,
  });
  const verifiedSet = commandSetFromManifest(verified.manifest);
  const missing = [...desiredSet].filter((name) => !verifiedSet.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Manifest update applied but missing commands after verify: ${missing.join(", ")}`,
    );
  }
  console.log("Slack manifest updated and verified.");
}

main().catch((error: unknown) => {
  console.error(String(error));
  process.exitCode = 1;
});
