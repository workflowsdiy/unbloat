# unbloat-check

A gate that keeps an opted-in repository lean: no process files, no history told in its docs, each fact in one
place, and no doc growth nobody decided on. It needs Node 20 or later and Git, and no packages. A repository
opts in with a `.unbloat.json` at its root (`.lean.json`, the older name, works too).

Run it from the repository you're checking, by the path where the skill is installed (for example
`node ~/.agents/skills/unbloat/scripts/unbloat-check.mjs`; shortened to `unbloat-check.mjs` below).

```bash
node unbloat-check.mjs --init          # opt in: writes .unbloat.json, installs the hook, checks (exit 1 while problems remain or the hook isn't installed)
node unbloat-check.mjs                 # check the working tree (tracked and new files)
node unbloat-check.mjs --staged        # what the pre-commit hook runs: the index
node unbloat-check.mjs --disk          # ignored/untracked build-up by size and age; deletes nothing
node unbloat-check.mjs --all DIR...    # DIR and its immediate subfolders that are opted in (add --disk)
node unbloat-check.mjs --install-hook  # (re)install the pre-commit hook
node unbloat-check.mjs --all DIR... --changes=FILE         # exceptions added and budgets raised since FILE
node unbloat-check.mjs --all DIR... --changes=FILE --save  # make the current state FILE's snapshot
```

## What fails

- **Process docs**, which no exception can keep: `PLAN.md`, `HANDOFF.md`, `TRACKER.md`, implementation plans
  and acceptance files.
- **Other process files:** documents and data files (Markdown, text, logs, JSON, CSV) named for a handoff,
  ledger or receipt, or kept in `reviews/` or `evidence/`, and notes in a folder named for one. Code, config,
  templates and assets with such names are product; a product document with such a name goes in `allow`.
- **Run records:** files named like `*review*.md`, `*.log`, `reports/…` or `RESULTS*.md` (a product file with
  such a name goes in `allow`), JSON keys that stamp or score a run (`checkedAt`, `*TestsPassed`…), and test
  counts in docs ("184 tests passed").
- **History and process wording** in any text file: independent or second reviewers, ledgers, review rounds,
  "first slice", "the user approved", sign-off, tracker IDs.
- **Repeated prose:** a sentence of 12 or more words that appears in two places across the Markdown files.
- **Broken links** to files that aren't in the repository, and **tracked files over 512 KB**.
- **Budgets:** Markdown lines (`docs`) and instruction-file lines (`instructions`: AGENTS.md, CLAUDE.md,
  SKILL.md, `.cursorrules`, `.github/copilot-instructions.md`). A commit that shrinks them lowers the budget
  and stages the config with it. Growing past a budget means raising it in the config in the same commit, with
  the reason in the commit message.

The contents of lockfiles, licence texts, `vendor/`, `third-party/`, `node_modules/` and `dist/` are never
scanned; their names and sizes still are.

## Exceptions

Every exception is an object with a `reason` saying why it is product, not process; a plain run lists them all.

| List | Entry | For |
|---|---|---|
| `allow` | `{ "path", "reason" }` | a product file whose name looks like a run record |
| `allowPhrases` | `{ "pattern", "paths", "reason" }` | a regex for lines that use the flagged words as product vocabulary |
| `skip` | `{ "path", "reason" }` | not scanned, link-checked or counted in the budgets |
| `dupSkip` | `{ "path", "reason" }` | left out of the repeated-prose check, e.g. a skill installed on its own |
| `allowLarge` | `{ "path", "reason" }` | a real asset over 512 KB |
| `keep` | `{ "path", "reason" }` | ignored folders meant to stay; `--disk` lists them apart |

Paths are globs relative to the repository root: `*` matches within one folder, `**/` any number of folders, and
`docs/**` everything under `docs/`. A `keep` path to a folder needs no trailing slash. An `allowPhrases`
pattern is a regular expression; a repeated group that holds alternation, a repeat or another group, such as
`(a+)+` or `(x|xx)+`, is refused because it can hang the check.

## The write guard

Run with `--guard` on a Claude Code or Codex `PreToolUse` hook's JSON (on stdin), it denies a tool call that
would create a process file in an opted-in repository, or that would commit there with `--no-verify`. It reads
redirections, `tee`, PowerShell's file cmdlets, `apply_patch` and the Write tool; the pre-commit hook catches
anything else. It is a first line, not a wall: shells allow too many forms to parse them all, and the
pre-commit hook and the end-of-turn gate are the backstops. With `--session-start`, it installs the pre-commit
hook in an opted-in repository that has no pre-commit hook yet; a project's own hook is left alone (only
`--install-hook` moves one aside), and a hooks folder outside the repository is never written.

## The end-of-turn gate

`--turn-start` (on `UserPromptSubmit`) records the commit a turn starts from. `--stop` (on `Stop`) checks what
the turn changed (commits, edits and new files) and, if that brought problems the next commit would fail on,
sends the agent back to fix them before it finishes, at most twice a turn. The record lives in the repository's
Git folder, never its tree.

All four hooks do nothing outside an opted-in repository, and each agent session keeps its own turn record.
The Claude Code plugin wires them up in `hooks/hooks.json`. For Codex, add them to `~/.codex/hooks.json`, with
the script's absolute path where you installed the skill:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "^(Bash|apply_patch)$", "hooks": [{ "type": "command", "command": "node /path/to/unbloat/scripts/unbloat-check.mjs --guard" }] }],
    "SessionStart": [{ "matcher": "startup|resume", "hooks": [{ "type": "command", "command": "node /path/to/unbloat/scripts/unbloat-check.mjs --session-start" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/unbloat/scripts/unbloat-check.mjs --turn-start" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/unbloat/scripts/unbloat-check.mjs --stop" }] }]
  }
}
```

Where `core.hooksPath` points into the repository (husky, `.githooks/`), or `pre-commit` is a link, that hook belongs
to the project: it is never rewritten, and `--install-hook` prints the line to add to it and exits 1. Otherwise an
existing hook moves to `pre-commit.local` and runs first if it is executable, so anything it stages is checked too.
The pre-commit hook calls this script by its absolute path; set `UNBLOAT_CHECK` to override it.
If Node or the script is missing, the hook warns and lets the commit through, so a moved or updated install
never blocks every commit; the next session start reinstalls it.
