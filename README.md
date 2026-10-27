<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <img src="assets/banner.svg" alt="unbloat: clean up what your coding agent left behind, and keep it from coming back" width="720">
  </picture>
</p>

<p align="center"><b>Your agent writes fast and almost never deletes. unbloat does the deleting.</b></p>

<p align="center">
  <img alt="Node 20+" src="https://img.shields.io/badge/Node-20%2B-339933?logo=nodedotjs&logoColor=white">
  <img alt="skills: 1" src="https://img.shields.io/badge/skills-1-5856D6">
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white">
  <img alt="Codex skill" src="https://img.shields.io/badge/Codex-skill-10A37F">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-E3B341">
</p>

<p align="center">
  <a href="#what-unbloat-does">What it does</a> ·
  <a href="#how-it-compares">How it compares</a> ·
  <a href="#install">Install</a> ·
  <a href="#use">Use</a>
</p>

**unbloat** is a skill your coding agent uses to find and remove bloat (dead code, stale docs, bloated
instruction files, leftover plans and reports) without changing what your project does. It comes with a gate,
`unbloat-check`, that stops the bloat from building up again. It works with Claude Code, Codex and any agent that
reads [Agent Skills](https://agentskills.io) (a `SKILL.md` folder of instructions and scripts).

https://github.com/user-attachments/assets/e9817805-9fc8-4314-9b41-efed397f80c4

## Sound familiar?

Coding agents write fast and almost never delete. After a few weeks of agent-built work, a repository tends to
collect:

- `PLAN.md`, `HANDOFF.md` and `review-round-3.md` files, written once and never read again;
- a helper written for the third time, because the agent didn't find the first two;
- docs that describe the code as it was three refactors ago, or say "all 184 tests pass";
- comments like "fixed after the review" that tell history instead of what the code does;
- an `AGENTS.md` or `CLAUDE.md` that grows every week, with rules that repeat or contradict each other;
- caches, scratch folders and old build output, adding up to gigabytes.

None of it fails a test or a lint, so nothing flags it, and it stays.

## Why it matters to your agent

Your agent reads everything in the repository as true. A stale doc sends it down the wrong path, a duplicated
helper gets a fourth copy, and a contradictory rule gets followed half the time. Instruction files load into
every session, so every spare line is paid for on every run: a
[study of AGENTS.md files](https://arxiv.org/abs/2602.11988) found they seldom improve task success while
adding over 20% to inference cost. Anthropic's
[context engineering guide](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
aims for the "smallest set of high-signal tokens". The code side is growing too: GitClear's
[2025 report](https://www.gitclear.com/ai_assistant_code_quality_2025_research) found copy-pasted lines rising
from 8.3% to 12.3% of changes between 2021 and 2024, while moved (refactored) lines fell from 25% to under 10%.

## What unbloat does

**A deep clean.** Ask your agent to "unbloat this repo" and it works through
[a catalog of bloat](skills/unbloat/references/catalog.md): code, docs and comments, agent instructions and
skills, process files, tests and disk. It gathers evidence with your ecosystem's own tools first (knip,
vulture, deadcode, cargo-machete), checks each lead against the traps that make live code look dead, and removes
things in small commits from a passing test run, undoing any step that breaks one. It asks you before removing
anything that could change behaviour, can't be recreated, or holds data. Say "audit" instead and it only reports.

**A gate that keeps it lean.** Once a repository opts in, `unbloat-check` runs in three places:

- **at commit:** a pre-commit hook fails on process files, history told in docs, test counts, repeated
  sentences, broken links, oversized files, and docs growing past their line budget;
- **while the agent works:** a write guard refuses to create `PLAN.md` and similar files, or to commit with
  `--no-verify`;
- **at the end of a turn:** if what the agent just changed would fail the next commit, the agent is sent back to
  fix it before it finishes (at most twice a turn).

Every exception needs a written reason, and budgets only go down on their own. The gate catches mechanical bloat;
dead code, paraphrased duplicates and stale claims still need the deep clean.

## How it compares

| | What it covers | How it decides | Runs on every commit |
|---|---|---|---|
| [deslop](https://github.com/brianlovin/agent-config/blob/main/skills/deslop/SKILL.md) and similar skills | code in the current branch's diff | the agent's judgment | no |
| [ai-slop-cleaner](https://github.com/Yeachan-Heo/oh-my-claudecode) (oh-my-claudecode) | code: dead code, duplication, needless wrappers | locks behaviour with tests, then a cleanup plan | no |
| [knip](https://knip.dev), [vulture](https://github.com/jendrikseipp/vulture), [deadcode](https://pkg.go.dev/golang.org/x/tools/cmd/deadcode) | one language's unused code | static analysis | if you add them to CI |
| **unbloat** | code, docs, instructions and skills, process files, disk | those tools' evidence, then verified judgment, from a passing test run | yes, plus the write guard and end-of-turn gate |

unbloat doesn't replace the dead-code tools; it runs them when your project has them. It doesn't find bugs or
redesign your architecture either. Its job is the bloat nothing else is watching.

## Why it exists

unbloat grew out of cleaning up real projects built mostly by Claude Code and Codex: plans and reports nobody
reopened, docs that contradicted each other and the code, and instruction files and skills nobody dared to trim.
Each cleanup helped, then the same problems came back. The checks that kept catching them became
`unbloat-check`, and the cleanup itself became the skill.

## Install

Needs Node 20 or later and Git.

Claude Code, as a plugin. This adds the skill and the gate's hooks, which do nothing in a repository until it
opts in:

```bash
claude plugin marketplace add workflowsdiy/unbloat
claude plugin install unbloat@unbloat
```

Any agent the [skills CLI](https://github.com/vercel-labs/skills) supports, including Claude Code and Codex:

```bash
npx skills add workflowsdiy/unbloat
```

Codex, by hand (to add the gate's hooks too, see [check.md](skills/unbloat/references/check.md)):

```bash
git clone https://github.com/workflowsdiy/unbloat ~/unbloat
mkdir -p ~/.agents/skills
ln -s ~/unbloat/skills/unbloat ~/.agents/skills/unbloat
```

## Use

Ask your agent:

- "Unbloat this repo", "slim down the docs" or "trim our AGENTS.md" to clean;
- "Audit this repo for bloat" for a report only;
- "Opt this repo into unbloat-check" to turn on the gate. This writes `.unbloat.json` with today's doc budgets,
  installs a pre-commit hook (an existing hook still runs first), and lists anything already failing.

How the deep clean works is in [SKILL.md](skills/unbloat/SKILL.md). The gate's rules, exceptions and hooks are
in [check.md](skills/unbloat/references/check.md).

## Development

Run the tests with `node --test`. MIT licence.
