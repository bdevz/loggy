# Decisions

Record consequential choices as: date — decision — reason — alternatives/tradeoffs — evidence.
Mark a superseded decision explicitly instead of silently retaining both as current.

2026-10-13 — Superseded: keep `RealLog1Port` behind an explicit production injection — the production entrypoint now constructs the reviewed adapter automatically, while programmatic `createServer` callers still inject it explicitly — this makes `npm start` usable with configured workspace credentials without changing the fail-closed health gate — `src/server.ts` startServer health test and workspace credential resolver.

2026-10-13 — Wire `RealLog1Port` automatically from the production entrypoint while retaining explicit injection in `createServer` — the deployed process must use the reviewed Log1 adapter, but tests and alternate providers need a narrow injection seam — local mode still selects the deterministic fixture and production health remains unavailable until Slack signing, workspace credentials, Slack transport, and the adapter are configured — `src/server.ts`, `src/server.test.ts`, and the 26-test suite.

2026-10-13 — Model live submission fields separately from legacy status and note changes — Log1's observed PUT accepts client, rate, employer, email, phone, work type, and vendor contact ID but does not expose status or note — preserving the old fields in the live request would send unsupported data — authenticated API inspection and `src/real-log1-port.test.ts`.

2026-10-13 — Map feedback to Log1 questionnaire IDs 44, 55, 49, 47, 48, and 50 — the live API validates required yes/no, rating, and remark answers by question ID — the older recommendation and numeric score labels do not match the questionnaire — authenticated API inspection and multipart payload tests.

2026-10-13 — Ship a Slack app manifest template with `/log1` and interactivity routes — Slack does not register slash commands from application source, and the installed app must point at public HTTPS endpoints — static workspace-scoped bot tokens mean token rotation stays disabled until an OAuth refresh flow exists — `slack-app-manifest.json` and README setup instructions.

