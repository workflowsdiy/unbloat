---
name: unbloat
description: Safely strip the bloat that builds up in a codebase, most of all an AI-written one, without changing what the product does. Removes dead, unused or duplicated code and dependencies, stale or repeated docs and comments, agent instructions and skills that don't change the outcome, process files (plans, handoffs, review reports, run logs, evidence), history told in docs, and build-up on disk. Then it can keep the repository lean with a pre-commit gate. Use when asked to unbloat, de-bloat, clean up, slim down, deslop or make a project lean, to audit it for bloat, or to opt a repository into unbloat-check.
license: MIT
---

# Unbloat

Bloat is anything that costs reading, tokens, upkeep or disk without changing what the product does or how
well an agent works on it. Unbloat removes it in small, verified, reversible steps. The product's behaviour,
public API, commands, flags, file formats and data stay exactly as they are.

**Mode.** "Audit" or "review" means report only: change nothing. "Clean", "unbloat" or "slim down" means apply
the safe changes and report the rest. If the request names a part (the docs, one package), stay inside it.

**Never:** change behaviour or a public contract; weaken, skip or delete a test that is the only cover for
something; remove licences, notices, version pins, security checks or anything costly to recreate (model
weights, datasets, signed assets); rewrite Git history; delete anything permanently (move it to the trash);
touch files another person or agent is changing; or install a tool without the user's OK.

## 1. Baseline

- Run `git status`. Work on a new branch (or worktree) from a clean tree; leave others' uncommitted work alone.
  If other agent sessions are running in this repository, keep off the files they're changing.
- Read the repository's instruction files (AGENTS.md, CLAUDE.md, .cursorrules, skills) and README, and follow
  their rules for checks, commits and PRs.
- Record the before numbers: tracked files and lines (`git ls-files | wc -l` and their line count), Markdown
  lines, and the instruction text an agent loads every session: always-loaded files plus each skill's
  `description:` line (`git grep -h '^description:' -- '*SKILL.md' | wc -c`), if the repository has skills.
- Run the project's build and tests. **Code removal needs a green baseline.** If it's red, or can't run
  (dependencies not installed and no OK to install them), say so in the report, label code findings
  "grep-verified, build not run", and limit changes to docs, process files and disk.
- Run the gate as a scanner: `node <this skill>/scripts/unbloat-check.mjs` in an opted-in repository, or
  `--init` in a throwaway clone (`git clone <repo> /tmp/unbloat-scan`) if it isn't opted in. Add `--disk` for
  ignored and untracked build-up. In an opted-in repository, check that each exception it lists is still product.
  The gate catches mechanical bloat only (process files, wording, verbatim repeats, broken links, growth);
  paraphrased duplicates, stale claims and dead code still need reading.

## 2. Gather evidence before judging

Run the dead-code, duplication and link tools the project already has, or that its ecosystem runs without
installing anything ([references/tools.md](references/tools.md)). Tool output is a list of leads, each one still
to be verified, never a delete list.

## 3. Review, read-only

Go through the repository against [references/catalog.md](references/catalog.md): code, docs and comments,
agent instructions and skills, files, tests, disk. In a large repository (tens of thousands of lines or
more), split the reading across parallel read-only subagents if your agent has them (one per area or package; small models are fine for finding
leads). Tell them to change nothing, run nothing with side effects, and return findings as text: `path:line`,
what is bloat, the evidence (a grep, a tool result, the code), the proposed change, and whether it could
change behaviour.

## 4. Verify every finding yourself

Expect a good share of leads to be wrong. For each one:

- Search for every kind of use, not just imports (the traps in the catalog: reflection, string lookups,
  entry points, config files, other repositories, generated code).
- If the reason it exists isn't obvious, find it (`git log -S`, `git blame`) before removing it. A guard or a
  strange line often fixes a real bug.
- Sort it: **safe** (provably unused or redundant, covered by checks), **owner's call** (could change
  behaviour, touches a public API, can't be recreated, or lies outside the repository), or **drop**.

## 5. Apply in small steps

- One kind of change per commit (dead code, a dependency, docs, instructions, process files), with a message
  that says what went and why it was safe.
- Run the affected checks after each step and the full build and tests at the end. If anything turns red,
  revert that step; don't patch around it.
- Before simplifying live code that has no tests, write a characterization test that pins down what it does
  now, then simplify.
- A fact you remove from a doc must still live in one place, or in code or a check that enforces it. Fix every
  link that pointed at a removed file.
- Move untracked files you remove to the trash (`trash` on macOS, `gio trash` on Linux, the Recycle Bin on
  Windows), and only after the user agrees to each one. If no trash command is available, list the files and
  ask; never `rm -rf`. Ignored files that hold data (databases, uploads, `.env` and credentials, downloaded
  datasets or models) are never cleanup candidates, however big or old.

## 6. Keep it lean (optional)

If the user wants the repository kept lean, run `node <this skill>/scripts/unbloat-check.mjs --init`. It writes
`.unbloat.json` with today's doc budgets, installs a pre-commit hook and lists what's left. Fix what it reports,
or add an exception with its reason. Exceptions are for product files and product wording only, never to keep
a process file. Never delete or rename a live product file to satisfy the gate; if the gate calls one a process
file, report it as a false positive. Details: [references/check.md](references/check.md).

## 7. Report

Short, in the chat. Nothing about the audit gets written into the repository. Include:

- before → after: files, lines, Markdown lines and instruction text loaded every session;
- what was removed or simplified, grouped by kind, with the commits;
- the checks you ran and their results;
- the owner's calls, each with its risk and your recommendation.
