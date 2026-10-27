# What counts as bloat

Each section lists what to look for, then the traps: things that look like bloat and aren't.

## Code

- Dead or unreachable code, unused exports, files, functions, types, flags and config keys.
- Unused dependencies, and dependencies that duplicate each other or the standard library.
- Duplicated helpers, copy-pasted blocks that differ only by names, and parallel implementations of one
  thing (a v2 next to the v1 it replaced).
- Needless indirection: wrappers that only forward, single-use factories and interfaces, abstraction layers
  with one implementation and no plan for a second.
- Defensive code for cases that can't happen: try/catch that only re-throws or logs and swallows, null checks
  on values the type system guarantees, retries and fallbacks nobody measured a need for.
- Commented-out code, debug prints, leftover feature flags that are always on or always off.

**Traps.** Before calling something unused, check uses that aren't imports: reflection and dynamic imports,
string-keyed lookups (registries, routes, templates, i18n keys), framework entry points (decorators, routes,
plugins, migrations, CLI commands), dispatch by name pattern (`convert_<tag>`, `handle_<event>`, `test_*`),
code started from a shell script or `python -c`, code run in another context (a browser's `page.evaluate`, a worker, a
subprocess), files found by name (tests, fixtures, config), Docker and CI files, scripts another repository
calls, generated code and its inputs, platform-conditional code (`#if`, build tags), and files whose hash or
checksum is pinned somewhere. A library's public API is used by code you can't see: leave it unless the owner
decides to remove it.

## Docs and comments

- Anything that disagrees with the code: removed features, old flags, wrong paths, old numbers.
- The same fact in more than one place, including an instruction file that restates the README. Keep it in
  one place and link to it. The gate finds only word-for-word repeats; paraphrases need reading.
- History, in docs and comments: "after the review", "in round 3", "previously", "used to", "no longer",
  "replaces the old…", "Regression:", dated status logs, changelogs inside a README. Git keeps history; docs
  and comments say what the code does now, and why. A real CHANGELOG file that releases need stays.
- Dated operational status ("the server is off now"): restate it as a standing rule, or remove it.
- Test counts and run results in prose ("all 184 tests pass"): they go stale on the next commit.
Not bloat: generated docs that a script keeps in sync, and words like "legacy" or "compat" that name a
format or mode the product still supports.

- Comments that restate the code, banner comments, and docstrings longer than the function they describe.
- Length for its own sake: intros, summaries of the section just read, and generic advice any engineer knows.

## Agent instructions and skills

AGENTS.md, CLAUDE.md, .cursorrules, Copilot instructions, skills, plugin manifests, memory notes, and any
prompt file an automation or agent loads (the gate's budget counts only the standard names). These
load into an agent's context, so their cost repeats every session and grows with every agent run. Studies of
AGENTS.md files find they seldom raise task success and add over 20% to inference cost. What helps is the
rules an agent wouldn't follow by default. Test each paragraph:

1. **Does it change what the agent does?** Drop anything the model already does well on its own: generic
   coding advice, language basics, "write clean code", standard framework usage.
2. **Is it true now?** Drop rules for removed tools, paths or workflows.
3. **Is it said once?** Instructions repeated across files or skills drift apart and contradict each other.
4. **Does it need to load every session?** Move detail into reference files the agent opens only when it needs
   them; keep skill descriptions short, because every installed skill's description loads every session.
5. **Is it ritual?** A workflow step that writes a file nobody reads (a brief, a story list, a plan), or that
   runs a ceremony the agent would do anyway, costs every time it runs. Fold several of them into one line of
   workflow.

Keep the rules that protect correctness, safety, security, licences, money, data or the owner's stated
preferences, even when they're long. Keep known traps the model gets wrong by default, such as API quirks,
version-specific behaviour and platform limits.

## Files

- Process files: plans, handoffs, trackers, ledgers, receipts, review reports, acceptance checklists, evidence
  folders, run logs and results. They belong in the chat, the issue tracker or the PR, not the tree.
- One-off scripts, experiments and old outputs that nothing runs, reads or cites.
- Large generated media, build outputs and caches that are tracked by mistake.
- Measurements that back a product decision aren't bloat. They live beside the script that reproduces them,
  stated as current facts.

## Tests

Remove a test only when another test covers the same behaviour, or when it tests code you removed. Never weaken
an assertion to make a cleanup pass. Merge near-identical tests into one table-driven test if the project
already uses that style.

## Disk

Ignored and untracked build-up: caches, old build outputs, scratch and output folders, stale worktrees and
branches, old container images. `unbloat-check --disk` lists them by size and age and deletes nothing. Keep
environments, downloaded models and anything listed in `keep`; move the rest to the trash after the user
agrees.
