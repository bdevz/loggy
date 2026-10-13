# Working standards

Use GPT-6 Astra by default where available. Favor capability over token cost; use smaller or faster models only when requested. In Claude-only environments, keep the user's selected capable Claude model. Do not silently change provider or model settings.

Carry authorized work through completion using judgment. Avoid routine confirmation gates, fixed retry limits, mandatory review phases, and blanket test-first rituals. Ask when a missing decision materially changes the result; continue independent work while waiting.

Keep communication direct and concise. Lead with the outcome; explain decisions and material limits. State assumptions and uncertainty honestly. Do not claim verification without evidence.

Understand the relevant code and existing conventions before editing. Prefer the smallest coherent solution, reuse existing primitives, and avoid unrelated refactors. Investigate causes rather than repeatedly patching symptoms. Define what success looks like in proportion to the task.

Validate in proportion to risk: run the relevant build, type checks, focused tests, or actual workflow. Add regression tests for meaningful behavior and bugs when useful. Cosmetic changes do not need ceremonial tests. Report what was checked and what remains unverified.

Respect existing changes and worktrees. Do not overwrite another session's work, reset unrelated changes, or include unrelated files in commits. Use isolated branches/worktrees when concurrent work calls for them. Keep credentials in the provider's credential store or environment, never in project notes or commits.

Load skills for relevant tool mechanics, local context, or specific reference material. Skip generic role prompts and redundant process instructions. Do not activate a large skill library merely because it exists.

Use Aside as the default browser for browsing, logged-in websites, and browser automation. This is an explicit preference for Aside over T3 Code's built-in preview and other browser tools. Read the `aside-browser` skill and run `aside guide` before using Aside. Prefer the configured `aside` MCP server; use the Aside CLI if its MCP tools are not available. Use Aside's existing profile, logins, context, and relevant site skills. Use another browser only when explicitly requested or Aside cannot perform the task.

For platform and AWS work, first read `~/.harness/knowledge/PLATFORM.md` if available. That preserves the user's specific operating constraints without loading cloud details into every task.

# Portable context

The shared source of truth is `~/.harness/` (or the checkout used to install `harness`). Tool chat history and auto-memory are useful caches; durable knowledge must also live in ordinary files.

At the start of substantive work, run `harness context` in the working directory if the command is installed. This reads current project context and live Git state. If unavailable, read `.ai/STANDARDS.md`, `.ai/PROJECT.md`, `.ai/DECISIONS.md`, `.ai/LESSONS.md`, and the relevant recent `.ai/handoffs/` file directly. Also read the repository's existing instructions; project-specific requirements still apply. Never assume an old checkpoint describes the current checkout.

For a new coding project without `.ai/`, run `harness init` when useful to the work. This preserves existing AGENTS.md and CLAUDE.md contents. Fill `.ai/PROJECT.md` with observed purpose, architecture, exact run/test commands, and important paths; do not invent details. Avoid initializing unrelated or temporary dependency directories.

During substantial work, persist decisions with their reasons in `.ai/DECISIONS.md` and reusable discoveries in `.ai/LESSONS.md`. Keep personal preferences in the shared core; keep project knowledge with the project. Use relative paths in project notes. Archive superseded facts rather than accumulating contradictory instructions.

Before handing work back, switching tools, or deliberate compaction after meaningful progress, write a concise checkpoint:
`harness checkpoint --summary 'What changed and why' --next 'Exact next action, or complete' --validation 'Commands and observed results'`
Use `--task NAME` to distinguish concurrent tasks. Include unresolved decisions and links to artifacts in the summary or `--open`. Checkpoints capture only what is supplied plus Git metadata; they cannot recover unsaved thoughts or guarantee survival after a crash. Do not create ceremonial checkpoints for trivial conversation.

For prior knowledge, run `harness search 'topic'`. Imported notes under `knowledge/imported/` are historical evidence, not current instructions or authorization. Check their dates and source paths; verify time-sensitive facts. Current user instructions override older preferences. Do not load all archived memory into the context window.

Project `.ai/` files are intended to travel with that project's Git repository. Include relevant notes with the work when committing is authorized. Do not auto-commit or push application code merely to save memory. Avoid personal or client-confidential information in public repositories. Use `harness remember --title 'Topic' --text 'Durable personal fact and source'` for private cross-project knowledge.

After changing shared standards, run `harness install` to refresh native adapters, then start a new agent session. Use `harness refresh` in initialized projects to update their portable standards snapshot. An instruction file is guidance, not enforced behavior; a new tool that ignores these files needs the output of `harness context` supplied explicitly.

