# Lessons

Record reusable project facts as: date — observation — evidence — when it applies.
Keep this short. Move detailed procedures into topic files and link them here.

2026-10-13 — Log1 authenticates with `Authorization: Token <actor-token>` at `https://api.log1.com`; workspace credentials must be resolved outside Slack modal metadata — live API inspection — applies to production adapter wiring.

2026-10-13 — Log1 submission detail returns `{ data, permission }`, while list endpoints return `{ counts, data }`; interview rows carry a nested `submission.id` — live API inspection — applies to response parsing and candidate matching.

2026-10-13 — Supervisor feedback is multipart with a JSON `feedback_form`; required fields include coding involved, final round, rating, and remark, plus one of strengths or issues — live question endpoint inspection — applies to feedback validation and writes.

2026-10-13 — Slack slash commands appear only after a Slack app manifest is imported and installed; source routes alone do not create `/log1` — workspace admin inspection — applies whenever a new command is added.

2026-10-13 — The authorized bb-alien host may prefer unroutable IPv6 addresses for SSH; `ssh -4 bb-alien` reaches the same Windows host over Tailscale IPv4 — direct retry on the deployment path — use the bounded IPv4 option when the default connection times out, then inspect the scheduled task and live Slack behavior before restarting anything.
2026-10-13 — The separate Cashew receiver is a foreground long-running Python process at `C:\\cashew\\loggy-receive.py`; an SSH command that starts it stays attached and can time out or break its pipe even while the receiver remains alive — `tasklist` and process command-line inspection — treat that SSH timeout as transport/process-detachment behavior, and use the existing host runner or a detached task for lifecycle management.
