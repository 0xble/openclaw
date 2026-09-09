# Maintenance

## Background

Maintained fork: `0xble/openclaw` of `openclaw/openclaw`; maintained and
upstream branch `main`. This temporary isolated checkout is remote-only, not a
runtime canonical checkout. Accepted baseline:
`94a292686cb41ea5452f71663fabc48231452a97`. Publish only to `origin`; never
push upstream.

## Preserve

- Fork upgrade/smoke source wiring remains distinct from any install, gateway,
or Telegram runtime action.
- JSON CLI output, macOS launchd CA handling, and intentional-silence Telegram
behavior remain preserved until upstream equivalence is verified.

## Active patches

### OPENCLAW-001: `feat(fork): add bin/upgrade script for fork CLI`

- **Status:** Active; `77a03c75`, `08c7d9b3`, `3fcfa6c3`.
- **Behavior:** fork upgrade and smoke scripts cover gateway model paths without invoking them during source maintenance.
- **Surfaces:** `bin/upgrade`, `bin/smoke`.
- **Upstream issue:** None after checked 2026-09-09.
- **Upstream PR:** None after checked 2026-09-09.
- **Regression:** `bash -n bin/upgrade bin/smoke`; source tests pass; no install or gateway start.
- **Rollback:** revert this group and remove only its source wiring.
- **Retire when:** an authorized disposition retires the fork path or a verified upstream equivalent is adopted.

### OPENCLAW-002: `fix(cli): suppress config notes in json mode`

- **Status:** Active; `f671c25a`.
- **Behavior:** JSON CLI output excludes config notes.
- **Surfaces:** `src/cli/program/preaction.ts`, `src/cli/program/preaction.test.ts`, config I/O tests.
- **Upstream issue:** None after checked 2026-09-09.
- **Upstream PR:** None after checked 2026-09-09.
- **Regression:** `pnpm test -- src/cli/program/preaction.test.ts src/config/io.future-warning.test.ts` passes.
- **Rollback:** revert `f671c25a` and rerun the focused tests.
- **Retire when:** released upstream behavior is equivalent and focused tests pass after reconciliation.

### OPENCLAW-003: `fix(gateway): avoid macos launchd ca hangs`

- **Status:** Active; `544f5350`.
- **Behavior:** service environment handling avoids macOS launchd CA hangs.
- **Surfaces:** `src/daemon/service-env.ts`, `src/daemon/service-env.test.ts`, `src/infra/env.ts`, `src/infra/env.test.ts`.
- **Upstream issue:** None after checked 2026-09-09.
- **Upstream PR:** None after checked 2026-09-09.
- **Regression:** `pnpm test -- src/daemon/service-env.test.ts src/infra/env.test.ts` passes; no restart.
- **Rollback:** revert `544f5350` and preserve installed service state.
- **Retire when:** upstream release is equivalent and source proof passes.

### OPENCLAW-004: `fix(telegram): suppress empty-response fallback for intentional silent replies`

- **Status:** Active; `1d5dbef4`, `348f0988`.
- **Behavior:** intentional and thinking-only empty replies do not send fallback Telegram output.
- **Surfaces:** `src/telegram/bot-message-dispatch.ts`, test, Pi embedded handlers/tests.
- **Upstream issue:** None after checked 2026-09-09.
- **Upstream PR:** None after checked 2026-09-09.
- **Regression:** `pnpm test -- src/telegram/bot-message-dispatch.test.ts src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts` passes.
- **Rollback:** revert both commits together and rerun focused tests; do not send live messages.
- **Retire when:** released upstream behavior is equivalent and regression proof passes.

### OPENCLAW-005: `chore: remove remaining VibeTunnel references`

- **Status:** Active; `096a32fc`.
- **Behavior:** obsolete VibeTunnel references stay removed from source/docs/hooks.
- **Surfaces:** `.gitignore`, signing docs, pre-commit hook, `scripts/clawlog.sh`.
- **Upstream issue:** None after checked 2026-09-09.
- **Upstream PR:** None after checked 2026-09-09.
- **Regression:** `git grep -n VibeTunnel` returns no tracked source reference; `bash -n scripts/clawlog.sh` passes.
- **Rollback:** revert `096a32fc` only with an explicit replacement integration decision.
- **Retire when:** the removal is redundant after verified upstream adoption.

## Update

Every maintenance run fetches `origin` and latest `upstream/main`, reconciles
`main`, preserves only these active records, and runs declared regression, test,
and build proof before authorized publication. Immediately before `Updated` or
`Already current`, fetch upstream again and prove no upstream-only commits;
otherwise report `Blocked` with stage, refs, and evidence. Update this contract
with each patch addition, change, or retirement; missing coverage blocks
publication.

## Verify

```text
bash -n bin/upgrade bin/smoke scripts/clawlog.sh
pnpm format:check
pnpm test -- src/cli/program/preaction.test.ts src/config/io.future-warning.test.ts
pnpm test -- src/daemon/service-env.test.ts src/infra/env.test.ts
pnpm test -- src/telegram/bot-message-dispatch.test.ts src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts
pnpm build
git rev-list --left-right --count upstream/main...main
```

Require a fresh final fetch with zero upstream-only commits and local/`origin`
SHA parity after authorized publication. Installation, deployment, gateway start,
restart, messaging, and runtime SHA proof require separately authorized stages.