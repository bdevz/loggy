# Project context

## Purpose and success criteria
Slack users run common Log1 recruiting workflows through `/log1 update` and `/log1 feedback` without opening the Log1 web app. Production uses the reviewed `RealLog1Port` adapter with workspace-scoped credentials. Local mode keeps a deterministic fixture.

## Architecture and important paths
`src/server.ts` owns Slack HTTP signature validation, workspace authentication, and background acknowledgement. `src/slack.ts` owns slash routing, Block Kit modals, strict modal parsing, and origin binding. `src/domain.ts` owns branded IDs and command types. `src/services.ts` owns idempotency. `src/real-log1-port.ts` parses the fixed Log1 API boundary and performs submission and supervisor-feedback operations. `src/log1-port.ts` contains the local fixture and re-exports `RealLog1Port`.

## Run and validate
`npm run build` type-checks the project. `npm test` runs the 27 focused tests. `npm run demo` exercises local Slack update and feedback flows. `npm run smoke:live` performs a read-only live search when `LOG1_SMOKE_TOKEN` is supplied. No live token was present in the shell during this work.

## Constraints and current work
Never print or store Log1 tokens. `npm start` wires `RealLog1Port` in production; programmatic `createServer` callers must provide a `log1Port`, Slack signing secret, workspace-scoped Log1 credentials, and Slack transport. Local mode keeps the in-memory fixture. Log1's observed submission API has no status or note update fields and no atomic numeric revision. The adapter derives an optimistic version from `modified` and checks `permission.update` before writes.

## Existing context
Use existing README, AGENTS.md, CLAUDE.md, HANDOFF.md, and docs when present. They remain intact.

