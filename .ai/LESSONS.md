# Lessons

Record reusable project facts as: date — observation — evidence — when it applies.
Keep this short. Move detailed procedures into topic files and link them here.

2026-10-13 — Log1 authenticates with `Authorization: Token <actor-token>` at `https://api.log1.com`; workspace credentials must be resolved outside Slack modal metadata — live API inspection — applies to production adapter wiring.

2026-10-13 — Log1 submission detail returns `{ data, permission }`, while list endpoints return `{ counts, data }`; interview rows carry a nested `submission.id` — live API inspection — applies to response parsing and candidate matching.

2026-10-13 — Supervisor feedback is multipart with a JSON `feedback_form`; required fields include coding involved, final round, rating, and remark, plus one of strengths or issues — live question endpoint inspection — applies to feedback validation and writes.

2026-10-13 — Slack slash commands appear only after a Slack app manifest is imported and installed; source routes alone do not create `/log1` — workspace admin inspection — applies whenever a new command is added.

