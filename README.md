# log1 Slack MVP

This repository contains a runnable Slack bot for two common Log1 workflows:

- `/log1 update [candidate]` searches Log1 submissions and builds a Block Kit update modal.
- `/log1 feedback [candidate]` builds a feedback modal for the candidate's next interview.
- Modal submissions update a submission or record interview feedback with optimistic version checks.
- Modal command IDs are scoped to workspace, actor, operation, and payload fingerprint. Concurrent retries share one in-flight operation in the process.

`RealLog1Port` connects to `https://api.log1.com` with the actor's `Authorization: Token ...` credential. It implements submission search and detail reads, the documented submission PUT endpoint, interview reads, and supervisor feedback multipart writes. The `npm start` production entrypoint injects this adapter automatically; programmatic `createServer` callers must still provide it explicitly. Local mode remains explicit and uses the seeded in-memory fixture.

## Run locally

```sh
npm install
npm run build
npm test
npm run demo
npm start
```

Run the read-only live smoke check with a token supplied through the environment. The command prints only IDs, names, statuses, and interview counts. It never prints the token.

```sh
LOG1_SMOKE_TOKEN='...' LOG1_SMOKE_QUERY='candidate name' npm run smoke:live
```

The demo prints the help response, both modal payloads, a successful update, a replayed update, and successful feedback. The HTTP server listens on `PORT` (default `3000`) and exposes:

- `POST /slack/commands` for URL-encoded slash command payloads.
- `POST /slack/interactions` for Slack's JSON interaction payload or URL-encoded `payload` envelope.
- `GET /health` for a local health check.

Local mode is explicit. Use `createServer({ mode: "local" })` or run `LOGGY_MODE=local npm start`. It accepts requests without Slack credentials and maps non-empty Slack `user_id`/`team_id` values to the demo actor token. The server defaults to production mode and fails closed unless `SLACK_SIGNING_SECRET`, a workspace-scoped Log1 actor credential, and either an injected `SlackApi` or workspace-scoped Slack bot token are configured. Production requests are rejected unless the `X-Slack-Request-Timestamp` is fresh and the `X-Slack-Signature` HMAC matches the raw request body.

For one workspace, set `SLACK_BOT_TOKEN_<TEAM_ID>` and `LOG1_ACTOR_TOKEN_<TEAM_ID>`. A global token is accepted only when paired with the matching `SLACK_BOT_TOKEN_WORKSPACE_ID` or `LOG1_ACTOR_TOKEN_WORKSPACE_ID`. For a credential store, inject `authResolver` instead of using environment variables. Never put a Log1 token in Slack metadata, block values, logs, or this repository.

The modal builders and parser are transport-friendly Block Kit values. Slash commands acknowledge immediately and open a loading modal before querying Log1. The bot replaces that view with the form or a result message through `views.update`. This keeps Log1 latency outside Slack's short trigger lifetime. Modal submissions validate `type: "view_submission"`, `view.type: "modal"`, and an exact callback/block/action registry. Valid shapes are cleared immediately and mutations run in the background.

## Socket Mode deployment

For a Cashew-style long-running host, use the Socket Mode entrypoint. It uses the Slack Bolt `App` with `socketMode: true`, so no public HTTP endpoint is required:

```sh
SLACK_WORKSPACE_ID='T123' \
SLACK_APP_TOKEN_T123='xapp-...' \
SLACK_BOT_TOKEN_T123='xoxb-...' \
LOG1_ACTOR_TOKEN_T123='...' \
npm run start:socket
```

`SLACK_APP_TOKEN_<TEAM_ID>` is the app-level token with `connections:write`; `SLACK_BOT_TOKEN_<TEAM_ID>` is the installed bot token. The process accepts one Slack installation and resolves its Log1 actor token from the same workspace-scoped environment convention. Set `SLACK_WORKSPACE_ID` explicitly, or omit it only when exactly one `SLACK_APP_TOKEN_<TEAM_ID>` variable is present. The Socket Mode process handles `/log1` and both modal callbacks through the same routing, parser, services, and live `RealLog1Port` used by the HTTP transport. The existing `npm start` HTTP entrypoint remains available for deployments that provide public HTTPS request URLs.

`run.ps1` is the Cashew-style Windows keep-alive runner. On the host, place the workspace-scoped values in `C:\loggy\.env`, run `npm install`, and launch `powershell -ExecutionPolicy Bypass -File .\run.ps1` from the interactive desktop session. The runner loads the file into the process environment, writes only process output to `logs\stdout.log`, and restarts the Socket Mode worker after an exit.

## Using the live adapter

Production construction is:

```ts
createServer({
  log1Port: new RealLog1Port(),
  authResolver,
  slackApi,
});
```

Inject a custom `Log1Port` for tests or a different provider. Inject a `SlackApi` implementation for the Slack Web API, or set a workspace-scoped Slack bot token for the built-in `createSlackWebApi` adapter. Inject an `authResolver` that maps a Slack workspace/user to a short-lived Log1 credential. The four methods are the complete application seam:

```text
findSubmissions(actor, query)
getSubmission(actor, id)
updateSubmission(command)
recordFeedback(command)
```

The live adapter checks `permission.update` before either mutation, rejects unsupported status/note writes because the observed submission endpoint does not expose those fields, and derives the optimistic version from Log1's `modified` timestamp. Log1 does not expose a numeric revision or ETag in the observed contract, so this is a preflight check rather than an atomic compare-and-swap guarantee. Live update fields are client, rate, employer, email, phone, work type, and vendor contact ID.

Live feedback maps the Slack form to Log1's current questionnaire. It sends coding involved, final round, rating, what went well, issues faced, and remarks. Recommendation is retained in the Slack/domain result for the local workflow, but is not a Log1 questionnaire field in the observed API.

## Slack setup for a real deployment

The source code does not register a slash command in Slack. Slack shows `/log1` only after you create or import the app and install it in the target workspace.

The repository includes [`slack-app-manifest.json`](slack-app-manifest.json) configured for Socket Mode. It requires a running worker with an app-level token and an installed bot token. No public request URL is needed.

To register the command:

1. Open Slack's app management page and choose **Create New App**, then **From an app manifest**.
2. Select the target workspace, choose JSON, paste the manifest, and create the app.
3. Install the app in that workspace. Reinstall it after changing scopes.
4. Create an app-level token with `connections:write` and configure the worker as described in [Socket Mode deployment](#socket-mode-deployment).
5. Start the worker and confirm that its log says `Log1 Slack Socket Mode app connected.`
6. Run `/log1 help`, then `/log1 update candidate name` in that workspace.

The manifest carries the Cashew bot's existing ConsultAdd scopes so the new app can use the same approved Slack capabilities. The Log1 code currently uses `commands` and `chat:write`. It enables interactivity and Socket Mode, and keeps token rotation disabled because this deployment reads a static workspace-scoped bot token from its environment. It does not subscribe to Events API events.

For an HTTP deployment instead, disable Socket Mode and set the slash command request URL to `https://YOUR_HOST/slack/commands` and the interactivity URL to `https://YOUR_HOST/slack/interactions`. Set the credentials below and run `npm start`. Replace `T123` with the Slack team ID in each variable name.

```sh
SLACK_SIGNING_SECRET='...'
SLACK_BOT_TOKEN_T123='xoxb-...'
LOG1_ACTOR_TOKEN_T123='...'
```

Restart the server after changing credentials. `GET /health` returns `200` only when the signing secret, a workspace-scoped Log1 credential, the live Log1 adapter, and the Slack Web API transport are configured.

Slack expects an acknowledgement within three seconds. Keep signature verification, parsing, acknowledgement, and opening the loading view on the fast path. Log1 lookup runs after the view opens and updates that existing view when it finishes. Never put a Log1 access token in `private_metadata`, block values, logs, or a repository. Map the Slack team/user pair to an encrypted credential or short-lived provider token in a server-side credential store. The current environment resolver uses one Log1 credential per workspace, so Log1 permissions come from that account. The in-memory idempotency store does not survive process restarts. Production needs a durable store with an atomic uniqueness constraint before it can claim restart-safe retries.

## Project layout

- `src/domain.ts` — branded IDs, discriminated domain types, results/errors, and `Log1Port`.
- `src/log1-port.ts` — deterministic in-memory adapter and `RealLog1Port` export.
- `src/real-log1-port.ts` — fixed-origin Log1 API adapter and boundary parsing.
- `src/services.ts` — update and feedback services with in-memory idempotency.
- `src/slack.ts` — signature verification, slash routing, Block Kit builders, and modal parsing.
- `src/server.ts` — tiny Node HTTP transport for Slack payloads.
- `src/demo.ts` — local user-visible flow.
- `src/loggy.test.ts` — built-in test runner coverage for the main behavior and failure modes.

The HTTP transport uses Node's standard library. The Socket Mode entrypoint adds `@slack/bolt`; TypeScript and Node type declarations remain development dependencies.
