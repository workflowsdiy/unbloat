// node --test: unbloat-check against throwaway git repositories.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'unbloat', 'scripts', 'unbloat-check.mjs');
const check = (cwd, args = [], input, options = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, input, encoding: 'utf8', ...options });
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const CLI_LIMIT = { timeout: 2000, killSignal: 'SIGKILL' };

// Every temporary folder the suite makes is removed when it ends.
const temps = [];
const temp = prefix => { const dir = mkdtempSync(join(tmpdir(), prefix)); temps.push(dir); return dir; };
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

// A symlink for a test that needs one. Where the system can't make one, the test is skipped, not passed.
function link(t, target, path) {
  try { symlinkSync(target, path); return true; } catch { t.skip('this system cannot make symlinks'); return false; }
}

function repo(files, config = { budgets: {} }, name = '.unbloat.json') {
  const dir = temp('unbloat-check-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'core.excludesFile', join(dir, '.git', 'no-global-excludes')); // the machine's ignores don't apply
  git(dir, 'config', 'core.hooksPath', join(dir, '.git', 'hooks')); // nor its hooks folder or signing
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [path, text] of Object.entries({ ...files, [name]: JSON.stringify(config) })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, 'add', '-A');
  return dir;
}

test('a clean repository passes', () => {
  const r = check(repo({ 'README.md': '# Tool\n\nIt renders pages.\n', 'src/a.js': 'export const a = 1;\n' }));
  assert.equal(r.status, 0, r.stderr);
});

test('process docs always fail; other process and run-record names pass only when allowed with a reason', () => {
  const dir = repo({ 'PLAN.md': 'x\n', 'evidence/run.json': '{}\n', 'notes/review-3.md': 'x\n', 'build.log': 'x\n', 'reports/a.json': '{}\n', 'RESULTS.md': 'x\n' });
  const r = check(dir);
  assert.equal(r.status, 1);
  for (const p of ['PLAN.md', 'evidence/run.json']) assert.match(r.stderr, new RegExp(`^${p}: process file`, 'm'));
  for (const p of ['notes/review-3.md', 'build.log', 'reports/a.json', 'RESULTS.md']) assert.match(r.stderr, new RegExp(`^${p}: run record`, 'm'));
  const why = 'product file';
  writeFileSync(join(dir, '.unbloat.json'), JSON.stringify({ allow: ['evidence/**', 'PLAN.md', 'notes/**', '*.log', 'reports/**', 'RESULTS.md'].map(path => ({ path, reason: why })) }));
  const after = check(dir);
  assert.equal(after.status, 1);
  assert.match(after.stderr, /^PLAN\.md: process file/m); // a process doc: no exception keeps it
  assert.doesNotMatch(after.stderr, /evidence\/run\.json|build\.log|RESULTS\.md|reports\/a\.json|review-3/);
});

test('source code in an evidence/ or reviews/ package is product; its other files are process', () => {
  const r = check(repo({ 'src/app/evidence/pack.py': 'x = 1\n', 'src/app/reviews/score.ts': 'export {};\n', 'src/app/evidence/run.json': '{}\n' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^src\/app\/evidence\/run\.json: process file/m);
  assert.doesNotMatch(r.stderr, /pack\.py|score\.ts/);
});

test('every exception needs a reason, and a plain run lists them', () => {
  const dir = repo({ 'build.log': 'x\n' }, { allow: ['build.log'] });
  assert.match(check(dir).stderr, /allow\[0\] must be \{ "path": \.\.\., "reason": \.\.\. \}/);
  writeFileSync(join(dir, '.unbloat.json'), JSON.stringify({ allow: [{ path: 'build.log', reason: ' ' }] }));
  assert.match(check(dir).stderr, /allow\[0\] \(build\.log\) needs a "reason"/);
  writeFileSync(join(dir, '.unbloat.json'), JSON.stringify({ allow: [{ path: 'build.log', reason: 'the build tool reads it' }] }));
  const ok = check(dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /allow build\.log: the build tool reads it/);
});

test('run records inside files: JSON run keys and test counts in docs', () => {
  const r = check(repo({ 'smoke.json': '{\n  "checkedAt": "2026-10-10",\n  "runnerTestsPassed": 28\n}\n', 'README.md': 'All 184 tests passed.\nIt matched all 28 fixtures.\n' }));
  assert.equal(r.status, 1);
  for (const at of ['smoke.json:2', 'smoke.json:3', 'README.md:1', 'README.md:2']) assert.match(r.stderr, new RegExp(`^${at.replace('.', '\\.')}: .*run record`, 'm'));
});

test('history and process wording fails; allowPhrases waives product vocabulary', () => {
  const dir = repo({ 'README.md': 'Fixed in round 3 after the independent review.\nThe first slice is done.\n' });
  const r = check(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /README\.md:1: "Fixed in round 3"/);
  assert.match(r.stderr, /README\.md:1: "independent review"/);
  assert.match(r.stderr, /README\.md:2: "first slice"/);
  writeFileSync(join(dir, '.unbloat.json'), JSON.stringify({ allowPhrases: [{ pattern: 'round 3|independent review|first slice', paths: ['README.md'], reason: 'quoted on purpose' }] }));
  assert.equal(check(dir).status, 0);
});

test('a real sign-off phrase is product vocabulary; a review sign-off is not', () => {
  assert.equal(check(repo({ 'a.py': '# a real sign-off such as "Thank you." is kept\n' })).status, 0);
  assert.equal(check(repo({ 'a.md': 'Review changes before sign-off.\n' })).status, 1);
});

test('a sentence repeated across docs fails, except in dupSkip paths', () => {
  const s = 'The renderer captures every frame through the browser and pipes it straight into the encoder.';
  const dir = repo({ 'README.md': `${s}\n`, 'docs/ARCH.md': `Intro.\n\n${s}\n`, 'skill/SKILL.md': `${s}\n` });
  const r = check(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the same sentence is also at/);
  writeFileSync(join(dir, 'docs/ARCH.md'), 'Intro.\n');
  writeFileSync(join(dir, '.unbloat.json'), JSON.stringify({ dupSkip: [{ path: 'skill/**', reason: 'installed on its own' }] }));
  assert.equal(check(dir).status, 0);
});

test('a link to a missing file fails; links to files, folders, anchors and URLs pass', () => {
  const ok = repo({ 'README.md': '[a](docs/a.md) [d](docs) [x](#top) [u](https://example.com) [s](docs/a.md#part)\n', 'docs/a.md': 'A.\n' });
  assert.equal(check(ok).status, 0);
  const r = check(repo({ 'README.md': 'See [the plan](docs/missing.md).\n' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /link to docs\/missing\.md/);
});

test('budgets: growth fails; a staged commit that shrinks the docs lowers the budget and stages the config', () => {
  const dir = repo({ 'README.md': 'one\ntwo\nthree\n' }, { budgets: { docs: 2 } });
  assert.match(check(dir).stderr, /docs: 3 lines, over the budget of 2/);
  writeFileSync(join(dir, '.unbloat.json'), JSON.stringify({ budgets: { docs: 5 } }));
  git(dir, 'add', '-A');
  const r = check(dir, ['--staged']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lowered docs to 3/);
  assert.equal(JSON.parse(git(dir, 'show', ':.unbloat.json').stdout).budgets.docs, 3);
});

test('instruction budgets count .cursorrules as well as Markdown instruction files', () => {
  const r = check(repo({ 'AGENTS.md': 'a\n', '.cursorrules': 'b\nc\n' }, { budgets: { instructions: 2 } }));
  assert.match(r.stderr, /instructions: 3 lines, over the budget of 2/);
});

test('--staged checks the index, not the working tree', () => {
  const dir = repo({ 'README.md': 'Fine.\n' });
  writeFileSync(join(dir, 'README.md'), 'After the review this changed.\n'); // not staged
  assert.equal(check(dir, ['--staged']).status, 0);
  git(dir, 'add', '-A');
  assert.equal(check(dir, ['--staged']).status, 1);
});

test('--init writes .unbloat.json with current budgets and a pre-commit hook that blocks a process file', () => {
  const dir = temp('unbloat-check-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), '# Tool\n\nIt renders.\n');
  const r = check(dir, ['--init']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, '.unbloat.json'), 'utf8')).budgets.docs, 3);
  assert.ok(existsSync(join(dir, '.git/hooks/pre-commit')));
  writeFileSync(join(dir, 'HANDOFF.md'), 'next steps\n');
  git(dir, 'add', '-A');
  const commit = spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(commit.status, 0);
  assert.match(commit.stderr, /HANDOFF\.md: process file/);
});

test('the guard denies creating a process file or committing with --no-verify in an opted-in repo only', () => {
  const dir = repo({ 'README.md': 'x\n' });
  const deny = input => JSON.parse(check(dir, ['--guard'], JSON.stringify({ cwd: dir, ...input })).stdout || '{}').hookSpecificOutput;
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: join(dir, 'HANDOFF.md') } })?.permissionDecision, 'deny');
  assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: join(dir, 'src/new.js') } }), undefined);
  assert.equal(deny({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: reviews/r1.md\n+x\n*** End Patch' } })?.permissionDecision, 'deny');
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' } })?.permissionDecision, 'deny');
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'echo done > PLAN.md' } })?.permissionDecision, 'deny');
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'git commit -m "x" 2>&1' } }), undefined);
  // ~ and $HOME are the home folder, not a folder named "~" inside the repository
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'run >> ~/unbloat-check-guard-test/run.log' } }), undefined);
  assert.equal(deny({ tool_name: 'Bash', tool_input: { command: 'run >> "$HOME/unbloat-check-guard-test/run.log"' } }), undefined);
  const other = temp('unbloat-check-');
  git(other, 'init', '-q');
  const r = check(other, ['--guard'], JSON.stringify({ cwd: other, tool_name: 'Write', tool_input: { file_path: join(other, 'PLAN.md') } }));
  assert.equal(r.stdout, '');
});

test('--changes reports exceptions added and budgets raised since the saved snapshot', () => {
  const dir = repo({ 'README.md': 'x\n' }, { keep: [{ path: 'a/', reason: 'fixture' }], budgets: { docs: 5 } });
  git(dir, 'commit', '-q', '-m', 'opt in');
  const snap = join(temp('unbloat-snap-'), 'snapshot.json');
  assert.match(check(dir, [`--changes=${snap}`]).stdout, /new: keep a\/: fixture/); // no snapshot: all of it is new
  assert.match(check(dir, [`--changes=${snap}`, '--save']).stdout, /saved .* 1 repositories/);
  assert.match(check(dir, [`--changes=${snap}`]).stdout, /0 new exception\(s\), 0 raised or removed budget\(s\) since 20/);
  writeFileSync(join(dir, '.unbloat.json'), JSON.stringify({ keep: [{ path: 'a/', reason: 'fixture' }, { path: 'b/', reason: 'cache' }], budgets: { docs: 9 } }));
  git(dir, 'commit', '-q', '-am', 'Keep b/ and grow the docs');
  const out = check(dir, [`--changes=${snap}`]).stdout;
  assert.match(out, /new: keep b\/: cache/);
  assert.doesNotMatch(out, /new: keep a\//);
  assert.match(out, /raised: docs 5 -> 9 \([0-9a-f]+ Keep b\/ and grow the docs\)/);
});

test('--disk lists ignored build-up, and kept folders apart with their reasons', () => {
  const dir = repo({ '.gitignore': '.scratch/\n', 'README.md': 'x\n' }, { keep: [{ path: '.scratch/fixture/', reason: 'test input' }] });
  mkdirSync(join(dir, '.scratch/old'), { recursive: true });
  mkdirSync(join(dir, '.scratch/fixture'), { recursive: true });
  writeFileSync(join(dir, '.scratch/old/a.txt'), 'x');
  writeFileSync(join(dir, '.scratch/fixture/b.txt'), 'y');
  const out = check(dir, ['--disk']).stdout;
  assert.match(out, /scratch\/output +\.scratch\/old\//);
  assert.match(out, /kept \(\.unbloat\.json "keep"\):\n.*\.scratch\/fixture\/: test input/);
});

test('a repository with the older .lean.json is checked the same way, one config per repository under --all', () => {
  const legacy = repo({ 'PLAN.md': 'x\n' }, { budgets: {} }, '.lean.json');
  const r = check(legacy);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^PLAN\.md: process file/m);
  const parent = temp('unbloat-all-');
  const a = repo({ 'README.md': 'x\n' }, { keep: [{ path: 'a/', reason: 'new name' }] });
  const b = repo({ 'README.md': 'x\n' }, { keep: [{ path: 'b/', reason: 'old name' }] }, '.lean.json');
  renameSync(a, join(parent, 'a'));
  renameSync(b, join(parent, 'b'));
  const all = check(parent, ['--all', parent]);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /exception\(s\) in \.unbloat\.json\n {2}keep a\/: new name/);
  assert.match(all.stdout, /exception\(s\) in \.lean\.json\n {2}keep b\/: old name/);
});

test('--install-hook replaces a lean-check hook, keeps a project hook that runs the check, and moves any other aside', () => {
  const dir = repo({ 'README.md': 'x\n' });
  const hook = join(dir, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\n# lean-check pre-commit hook: old\n');
  assert.equal(check(dir, ['--install-hook']).status, 0);
  assert.match(readFileSync(hook, 'utf8'), /# unbloat-check pre-commit hook/);
  assert.ok(!existsSync(join(dir, '.git/hooks/pre-commit.local')));
  writeFileSync(hook, '#!/bin/sh\nnode tools/unbloat-check.mjs --staged\n');
  check(dir, ['--install-hook']);
  assert.match(readFileSync(hook, 'utf8'), /tools\/unbloat-check\.mjs/);
  writeFileSync(hook, '#!/bin/sh\nnpm run lint\n');
  check(dir, ['--install-hook']);
  assert.match(readFileSync(join(dir, '.git/hooks/pre-commit.local'), 'utf8'), /npm run lint/);
});

test('found in real repositories: no false repeat within one line, case-sensitive instruction names, product wording', () => {
  const row = '| Claude Code with the full plugin marketplace and all of its installed skills | claude code with the full plugin marketplace and all of its installed skills |';
  const r = check(repo({ 'docs/agents.md': `${row}\n`, 'AGENTS.md': 'a\n', 'src/a.js': '// the user selected these skills\n' }, { budgets: { instructions: 1 } }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unbloat-check: ok \(\d+ files; docs 2, instructions 1 lines\)/);
});

test('--disk leaves out the config; a hooks folder tracked in the repository is never rewritten', () => {
  const dir = repo({ 'README.md': 'x\n', '.husky/pre-commit': 'npm test\n' });
  assert.doesNotMatch(check(dir, ['--disk']).stdout, /\.unbloat\.json/);
  git(dir, 'config', 'core.hooksPath', '.husky');
  const r = check(dir, ['--install-hook']);
  assert.match(r.stderr, /hooks live in \.husky\/ \(core\.hooksPath\).*add this line/);
  assert.equal(readFileSync(join(dir, '.husky/pre-commit'), 'utf8'), 'npm test\n');
  assert.ok(!existsSync(join(dir, '.husky/pre-commit.local')));
});

test('the installed hook still runs a moved-aside hook that is executable', () => {
  const dir = repo({ 'README.md': 'x\n' });
  writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho chained-hook-ran >&2\nexit 1\n');
  chmodSync(join(dir, '.git/hooks/pre-commit'), 0o755);
  check(dir, ['--install-hook']);
  git(dir, 'add', '-A');
  const commit = spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(commit.status, 0);
  assert.match(commit.stderr, /chained-hook-ran/);
});

test('a moved-aside hook that is not executable does not run, as git would not run it', () => {
  const dir = repo({ 'README.md': 'x\n' });
  writeFileSync(join(dir, '.git/hooks/pre-commit'), 'echo chained-hook-ran >&2\nexit 1\n');
  check(dir, ['--install-hook']);
  git(dir, 'add', '-A');
  const commit = spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd: dir, encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  assert.doesNotMatch(commit.stderr, /chained-hook-ran/);
});

test('the end-of-turn gate sends back only problems the turn brought, at most twice a turn', () => {
  const dir = repo({ 'README.md': 'Fixed in round 3.\n' }, { allowPhrases: [] });
  git(dir, 'commit', '-q', '-m', 'an old problem in a file the turn leaves alone');
  const hook = (flag) => check(dir, [flag], JSON.stringify({ cwd: dir })).stdout;
  hook('--turn-start');
  assert.equal(hook('--stop'), ''); // nothing changed this turn
  writeFileSync(join(dir, 'PLAN.md'), 'next steps\n');
  writeFileSync(join(dir, 'docs.md'), 'It renders pages after the review.\n');
  const sent = JSON.parse(hook('--stop'));
  assert.equal(sent.decision, 'block');
  assert.match(sent.reason, /PLAN\.md: process file/);
  assert.match(sent.reason, /docs\.md:1: "after the review"/);
  assert.doesNotMatch(sent.reason, /README\.md/);
  assert.equal(JSON.parse(hook('--stop')).decision, 'block');
  assert.equal(hook('--stop'), ''); // two sends a turn
  hook('--turn-start');
  assert.equal(hook('--stop'), ''); // what was already changed when the turn began isn't this turn's
  writeFileSync(join(dir, 'PLAN.md'), 'more steps\n');
  assert.equal(JSON.parse(hook('--stop')).decision, 'block'); // until the turn changes it, with a fresh count
  assert.equal(check(temp('unbloat-check-'), ['--stop'], '{}').stdout, ''); // not a repository
});

test('each agent session keeps its own turn record', () => {
  const dir = repo({ 'README.md': 'x\n' });
  git(dir, 'commit', '-q', '-m', 'start');
  const hook = (flag, session) => check(dir, [flag], JSON.stringify({ cwd: dir, session_id: session })).stdout;
  hook('--turn-start', 'a');
  writeFileSync(join(dir, 'PLAN.md'), 'x\n');
  hook('--turn-start', 'b'); // b starts after a wrote PLAN.md
  assert.equal(hook('--stop', 'b'), '');
  assert.equal(JSON.parse(hook('--stop', 'a')).decision, 'block');
});

test('--staged takes the config from the index', () => {
  const dir = repo({ 'PLAN.md': 'x\n' });
  rmSync(join(dir, '.unbloat.json')); // deleted from the working tree, still staged
  assert.equal(check(dir, ['--staged']).status, 1);
  git(dir, 'rm', '-q', '--cached', '.unbloat.json');
  assert.equal(check(dir, ['--staged']).status, 0); // opted out in the commit itself
});

test('source code with a process-sounding name is product; a handoff folder is not', () => {
  const r = check(repo({ 'src/receipt.ts': 'export {};\n', 'db/evidence/schema.sql': 'select 1;\n', 'handoff/next.md': 'x\n' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^handoff\/next\.md: process file/m);
  assert.doesNotMatch(r.stderr, /receipt\.ts|schema\.sql/);
});

test('licence files are skipped by their names only, and a bad config is reported, not obeyed', () => {
  const r = check(repo({ 'docs/roofline.md': 'After the review it changed.\n', 'LICENSE': 'After the review.\n' }));
  assert.match(r.stderr, /docs\/roofline\.md:1/);
  assert.doesNotMatch(r.stderr, /^LICENSE/m);
  const bad = check(repo({ 'README.md': 'x\n' }, { allow: null, budgets: { docs: 'oops' }, allowPhrases: [{ pattern: '(', reason: 'x' }] }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /"allow" must be a list/);
  assert.match(bad.stderr, /budgets\.docs must be a whole number/);
  assert.match(bad.stderr, /allowPhrases pattern \(/);
});

test('a link with parentheses in its path resolves', () => {
  const r = check(repo({ 'README.md': '[API](docs/api(v1).md)\n', 'docs/api(v1).md': 'API.\n' }));
  assert.equal(r.status, 0, r.stderr);
});

test('hook install: no collision with pre-commit.local, a missing hooks folder, a path that is not shell syntax', () => {
  const dir = repo({ 'README.md': 'x\n' });
  writeFileSync(join(dir, '.git/hooks/pre-commit'), 'echo one\n');
  writeFileSync(join(dir, '.git/hooks/pre-commit.local'), 'echo two\n');
  const r = check(dir, ['--install-hook']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /both exist, so neither is moved/);
  assert.equal(readFileSync(join(dir, '.git/hooks/pre-commit.local'), 'utf8'), 'echo two\n');
  rmSync(join(dir, '.git/hooks'), { recursive: true });
  assert.equal(check(dir, ['--install-hook']).status, 0);
  assert.match(readFileSync(join(dir, '.git/hooks/pre-commit'), 'utf8'), /^installed='[^']*unbloat-check\.mjs'$/m);
});

test('the guard reads quoted, tee, PowerShell and git -C forms, and ignores commit text that is only text', () => {
  const dir = repo({ 'README.md': 'x\n' });
  const outside = temp('unbloat-outside-');
  const denied = (command, tool = 'Bash', cwd = dir) =>
    JSON.parse(check(cwd, ['--guard'], JSON.stringify({ cwd, tool_name: tool, tool_input: { command } })).stdout || '{}').hookSpecificOutput?.permissionDecision === 'deny';
  mkdirSync(join(dir, 'my dir'));
  assert.ok(denied('printf x > "my dir/PLAN.md"'));
  assert.ok(denied('tee -a -- notes.txt PLAN.md < x'));
  assert.ok(denied('Set-Content -Path PLAN.md -Value x', 'PowerShell'));
  assert.ok(denied(`git -C '${dir}' commit --no-verify -m x`, 'Bash', outside));
  assert.ok(denied(`git -C ${dir.split('\\').join('/')} commit --no-verify -m x`, 'Bash', outside));
  assert.ok(denied(`git -C ${dir} commit --no-verify -m x`, 'PowerShell', outside));
  assert.ok(denied(`Out-File ${join(dir, 'PLAN.md')}`, 'PowerShell'));
  assert.ok(denied('git commit -anm x'));
  assert.ok(!denied('echo "git commit --no-verify"'));
  assert.ok(!denied('git commit -m "Fix -n flag docs"'));
  assert.ok(!denied("cat > notes.txt <<'EOF'\nrun git commit --no-verify > PLAN.md\nEOF"));
});

test('--disk lists the rest of a folder that holds a kept path, not the folder', () => {
  const dir = repo({ '.gitignore': '.cache/\n', 'README.md': 'x\n' }, { keep: [{ path: '.cache/live/', reason: 'in use' }] });
  mkdirSync(join(dir, '.cache/live'), { recursive: true });
  mkdirSync(join(dir, '.cache/old'), { recursive: true });
  writeFileSync(join(dir, '.cache/old/a.bin'), Buffer.alloc(2 << 20));
  writeFileSync(join(dir, '.cache/live/b.bin'), Buffer.alloc(2 << 20));
  const out = check(dir, ['--disk']).stdout;
  assert.match(out, /\.cache\/old\//);
  assert.doesNotMatch(out, / \.cache\/\n/);
});

test('--changes reports a removed budget', () => {
  const dir = repo({ 'README.md': 'x\n' }, { budgets: { docs: 5 } });
  git(dir, 'commit', '-q', '-m', 'opt in');
  const snap = join(temp('unbloat-snap-'), 'snapshot.json');
  check(dir, [`--changes=${snap}`, '--save']);
  writeFileSync(join(dir, '.unbloat.json'), JSON.stringify({ budgets: {} }));
  assert.match(check(dir, [`--changes=${snap}`]).stdout, /removed: the docs budget \(was 5\)/);
});

test('templates and components with process-sounding names are product', () => {
  const r = check(repo({ 'templates/receipt.html': '<p></p>\n', 'src/reviews/Card.vue': '<template/>\n' }));
  assert.equal(r.status, 0, r.stderr);
});

test('a hook moved aside runs first, so what it stages is checked too', () => {
  const dir = repo({ 'README.md': 'x\n' });
  writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho x > PLAN.md\ngit add PLAN.md\n');
  chmodSync(join(dir, '.git/hooks/pre-commit'), 0o755);
  check(dir, ['--install-hook']);
  git(dir, 'add', '-A');
  const commit = spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(commit.status, 0);
  assert.match(commit.stderr, /PLAN\.md: process file/);
});

test('the guard: newline-separated, quoted, cd and comment-only cases', () => {
  const dir = repo({ 'README.md': 'x\n' });
  const outside = temp('unbloat-outside-');
  const denied = (command, cwd = dir) =>
    JSON.parse(check(cwd, ['--guard'], JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } })).stdout || '{}').hookSpecificOutput?.permissionDecision === 'deny';
  assert.ok(denied('git status\ngit commit --no-verify -m x'));
  assert.ok(denied('git commit "--no-verify" -m x'));
  assert.ok(denied(`cd '${dir}' && git commit --no-verify -m x`, outside));
  assert.ok(denied(`cd '${dir}' && echo x > PLAN.md`, outside));
  assert.ok(!denied('git commit -m "-n is a flag" --author "A <a@b.c>"'));
});

test('hooks: a project hook that only mentions the check in a comment is not current; ..hooks is inside the repository', () => {
  const dir = repo({ 'README.md': 'x\n', '..hooks/pre-commit': 'npm test\n' });
  git(dir, 'config', 'core.hooksPath', '..hooks');
  const r = check(dir, ['--install-hook']);
  assert.equal(r.status, 1);
  assert.equal(readFileSync(join(dir, '..hooks/pre-commit'), 'utf8'), 'npm test\n');
  writeFileSync(join(dir, '..hooks/pre-commit'), '# node tools/unbloat-check.mjs --staged\nexit 0\n');
  assert.equal(check(dir, ['--install-hook']).status, 1);
});

test('config and links: allowPhrases paths must be a list; an encoded # in a link resolves', () => {
  const bad = check(repo({ 'README.md': 'x\n' }, { allowPhrases: [{ pattern: 'x', paths: 'README.md', reason: 'product' }] }));
  assert.match(bad.stderr, /"paths" must be a list of globs/);
  assert.equal(check(repo({ 'README.md': '[x](a%23b.md)\n', 'a#b.md': 'x\n' })).status, 0);
});

test('--disk: a scratch folder holding a model folder is opened up, and a dangling link does not crash it', t => {
  const dir = repo({ '.gitignore': '.scratch/\nlink\n', 'README.md': 'x\n' });
  mkdirSync(join(dir, '.scratch/job/models'), { recursive: true });
  writeFileSync(join(dir, '.scratch/job/models/model.bin'), 'w');
  writeFileSync(join(dir, '.scratch/job/out.txt'), 'o');
  if (!link(t, join(dir, 'missing'), join(dir, 'link'))) return;
  const r = check(dir, ['--disk']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /\.scratch\/job\/\s*$/m);
  assert.doesNotMatch(r.stdout, /models/);
});

test('a sentence repeated across wrapped lines is found, at the line it starts on', () => {
  const s1 = 'The renderer captures every frame through the\nbrowser and pipes it straight into the encoder.';
  const s2 = 'Intro.\n\nThe renderer captures every frame through the browser\nand pipes it straight into the encoder.';
  const r = check(repo({ 'README.md': `${s1}\n`, 'docs/a.md': `${s2}\n`, 'docs/list.md': '- one item that is short\n- another item\n' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /README\.md:1: the same sentence is also at docs\/a\.md:3/);
});

test('an untracked symlink to a folder, as the skills CLI installs, is read as a link, not a file', t => {
  const dir = repo({ '.agents/skills/x/SKILL.md': 'x\n' });
  mkdirSync(join(dir, '.claude/skills'), { recursive: true });
  if (!link(t, '../../.agents/skills/x', join(dir, '.claude/skills/x'))) return;
  const r = check(dir);
  assert.equal(r.status, 0, r.stderr);
});

test('a copy of this skill installed in an agent folder is vendored; its source folder is still checked', () => {
  const quoted = 'A PLAN.md is a process file.\n';
  const r = check(repo({ '.claude/skills/unbloat/references/check.md': quoted, '.agents/skills/unbloat/SKILL.md': quoted,
    'skills/unbloat/references/check.md': quoted }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^skills\/unbloat\/references\/check\.md:1: "PLAN\.md"/m);
  assert.doesNotMatch(r.stderr, /^\.(?:claude|agents)\//m);
});

test('found by the final review: product names and prose, a repo regex, a linked config, an empty repo, keep without a slash', () => {
  const product = check(repo({ 'packages/ledger/package.json': '{}\n', 'assets/receipt.png': 'x', 'services/handoff/config.yaml': 'a: 1\n',
    'README.md': 'Acceptance criteria are listed. If the user requested a refund, it is notified after the review period. Read the next slice. An 80/20 test split.\n' }));
  assert.equal(product.status, 0, product.stderr);
  assert.equal(check(repo({ 'docs/handoff.md': 'x\n' })).status, 1); // a handoff note is still process
  const slow = repo({ 'README.md': `after the review ${'x'.repeat(40)}!\n` }, { allowPhrases: [{ pattern: '(x+x+)+y', reason: 'r' }] });
  const started = Date.now();
  assert.match(check(slow).stderr, /can hang the check/);
  assert.ok(Date.now() - started < 5000);
  if (process.platform !== 'win32') { // making a symlink on Windows needs extra rights
    const linked = repo({ 'README.md': 'x\n' });
    rmSync(join(linked, '.unbloat.json'));
    spawnSync('ln', ['-s', '/etc/hosts', join(linked, '.unbloat.json')]);
    const r = check(linked);
    assert.match(r.stderr, /must be a regular file/);
    assert.doesNotMatch(r.stderr, /Host|localhost/);
  }
  const empty = repo({ 'README.md': 'x\n' });
  git(empty, 'rm', '-q', '--cached', '-r', '.');
  check(empty, ['--turn-start'], JSON.stringify({ cwd: empty }));
  git(empty, 'add', '-A');
  writeFileSync(join(empty, 'PLAN.md'), 'x\n');
  git(empty, 'add', 'PLAN.md');
  git(empty, 'commit', '-q', '--no-verify', '-m', 'first');
  assert.equal(JSON.parse(check(empty, ['--stop'], JSON.stringify({ cwd: empty })).stdout).decision, 'block');
  const kept = repo({ '.gitignore': '.scratch/\n', 'README.md': 'x\n' }, { keep: [{ path: '.scratch/fixture', reason: 'input' }] });
  mkdirSync(join(kept, '.scratch/fixture'), { recursive: true });
  writeFileSync(join(kept, '.scratch/fixture/a.txt'), 'x');
  assert.doesNotMatch(check(kept, ['--disk']).stdout, /scratch\/output +\.scratch\/fixture/);
  assert.match(check(repo({ 'README.md': 'x\n' }), ['--all', '/no/such/folder']).stderr, /is not a folder/);
  writeFileSync(join(kept, '.unbloat.json'), '{');
  const broken = check(kept);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /^unbloat-check: \.unbloat\.json: /m);
  assert.doesNotMatch(broken.stderr, /at \w+ \(/); // one line, no stack trace
});

test('the guard sees commits and writes inside compound commands, shells and quoting tricks', () => {
  const dir = repo({ 'README.md': 'x\n' });
  const denied = command =>
    JSON.parse(check(dir, ['--guard'], JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: { command } })).stdout || '{}').hookSpecificOutput?.permissionDecision === 'deny';
  for (const command of ['if true; then git commit --no-verify -m x; fi', 'bash -c "git commit --no-verify -m x"',
    '(git commit --no-verify -m x)', 'git -c core.hooksPath=/dev/null commit -m x', 'echo x >| PLAN.md',
    "printf x > PL''AN.md", "printf x > $'PLAN.md'", 'touch PLAN.md', 'cp README.md PLAN.md'])
    assert.ok(denied(command), command);
  assert.ok(!denied('git -c user.name=x commit -m "fine"'));
});

test('hooks: a shared hooks folder outside the repository is never written; a session start leaves a project hook alone', () => {
  const shared = temp('unbloat-shared-');
  writeFileSync(join(shared, 'pre-commit'), 'echo shared\n');
  const dir = repo({ 'README.md': 'x\n' });
  git(dir, 'config', 'core.hooksPath', shared);
  const r = check(dir, ['--install-hook']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside this repository/);
  assert.equal(readFileSync(join(shared, 'pre-commit'), 'utf8'), 'echo shared\n');
  assert.ok(!existsSync(join(shared, 'pre-commit.local')));
  const own = repo({ 'README.md': 'x\n' });
  writeFileSync(join(own, '.git/hooks/pre-commit'), 'exec pre-commit run\n');
  check(own, ['--session-start'], JSON.stringify({ cwd: own }));
  assert.equal(readFileSync(join(own, '.git/hooks/pre-commit'), 'utf8'), 'exec pre-commit run\n');
  assert.ok(!existsSync(join(own, '.git/hooks/pre-commit.local')));
});

test('security review: --init never writes through a config link, and control characters are printed escaped', () => {
  const dir = temp('unbloat-check-');
  git(dir, 'init', '-q');
  if (process.platform !== 'win32') {
    spawnSync('ln', ['-s', join(dir, 'elsewhere.json'), join(dir, '.unbloat.json')]);
    assert.equal(check(dir, ['--init']).status, 1);
    assert.ok(!existsSync(join(dir, 'elsewhere.json')));
  }
  if (process.platform === 'win32') return; // Windows file names can't hold control characters
  const r = check(repo({ 'notes/review-\x1b]52;c;aGk=\x07.md': 'x\n' }));
  assert.doesNotMatch(r.stderr, /\x1b/);
  assert.match(r.stderr, /\\x1b\]52/);
});

test('a malformed config is sent back at most twice a turn, like any other problem', () => {
  const dir = repo({ 'README.md': 'x\n' });
  git(dir, 'commit', '-q', '-m', 'start');
  const hook = flag => check(dir, [flag], JSON.stringify({ cwd: dir })).stdout;
  hook('--turn-start');
  writeFileSync(join(dir, '.unbloat.json'), '{');
  writeFileSync(join(dir, 'docs.md'), 'x\n');
  assert.match(JSON.parse(hook('--stop')).reason, /must be|Unexpected|JSON/);
  assert.equal(JSON.parse(hook('--stop')).decision, 'block');
  assert.equal(hook('--stop'), ''); // the turn's two sends are used up
});

test('--init exits 1 when the hook cannot be installed, and still checks the repository', () => {
  const shared = temp('unbloat-shared-');
  const dir = temp('unbloat-check-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'core.hooksPath', shared);
  const r = check(dir, ['--init']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside this repository/);
  assert.ok(!existsSync(join(shared, 'pre-commit')));
});

test('a link into a submodule resolves: the submodule is another repository, so its files are not read', () => {
  const dir = repo({ 'README.md': '[guide](sub/guide.md)\n' });
  git(dir, 'commit', '-q', '-m', 'start');
  const head = git(dir, 'rev-parse', 'HEAD').stdout.trim();
  git(dir, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub/.git'), 'gitdir: /nowhere\n');
  writeFileSync(join(dir, 'sub/guide.md'), 'x\n');
  const tree = check(dir);
  assert.equal(tree.status, 0, tree.stderr);
  git(dir, 'commit', '-q', '-m', 'add the submodule');
  const index = check(dir, ['--staged']);
  assert.equal(index.status, 0, index.stderr);
});

test('--install-hook never writes through a link: a dangling or existing link target outside the repository is left alone', t => {
  const outside = temp('unbloat-outside-');
  const dangling = join(outside, 'made-by-hook');
  const dir = repo({ 'README.md': 'x\n' });
  if (!link(t, dangling, join(dir, '.git/hooks/pre-commit'))) return;
  assert.equal(check(dir, ['--install-hook']).status, 1);
  assert.ok(!existsSync(dangling));
  const existing = join(outside, 'kept');
  writeFileSync(existing, '# unbloat-check pre-commit hook\nkept\n');
  const other = repo({ 'README.md': 'x\n' });
  symlinkSync(existing, join(other, '.git/hooks/pre-commit'));
  assert.equal(check(other, ['--install-hook']).status, 1);
  assert.equal(readFileSync(existing, 'utf8'), '# unbloat-check pre-commit hook\nkept\n');
});

test('a tracked file under a folder that is now a link is not read from outside the repository', t => {
  const dir = repo({ 'docs/notes.md': 'x\n' });
  git(dir, 'commit', '-q', '-m', 'start');
  const outside = temp('unbloat-outside-');
  writeFileSync(join(outside, 'notes.md'), 'Fixed in round 3.\n');
  rmSync(join(dir, 'docs'), { recursive: true });
  if (!link(t, outside, join(dir, 'docs'))) return;
  const r = check(dir);
  assert.equal(r.status, 0, r.stderr);
});

test('a file whose name holds a newline is one file to the end-of-turn gate', t => {
  if (process.platform === 'win32') { t.skip('Windows filenames cannot contain newlines'); return; }
  const dir = repo({ 'README.md': 'x\n' });
  git(dir, 'commit', '-q', '-m', 'start');
  writeFileSync(join(dir, 'pre\nexisting.md'), 'Fixed in round 3.\n'); // changed before the turn: not this turn's
  const hook = flag => check(dir, [flag], JSON.stringify({ cwd: dir })).stdout;
  hook('--turn-start');
  assert.equal(hook('--stop'), '');
});


test('a user regex that can backtrack exponentially is refused rather than run', () => {
  const dir = repo({ 'README.md': `${'x'.repeat(30)}!\n` }, { allowPhrases: [{ pattern: '(x|xx)+y', reason: 'r' }] });
  const started = Date.now();
  const r = check(dir);
  assert.match(r.stderr, /can hang the check/);
  assert.ok(Date.now() - started < 5000);
});

test('adjacent-quantifier waivers fail within the matching deadline in both CLI modes', () => {
  const dir = repo({ 'README.md': `${'after the review ' + 'x'.repeat(64) + '!\n'}`.repeat(3) },
    { allowPhrases: [{ pattern: 'x+x+x+x+x+y', paths: ['README.md'], reason: 'fixture vocabulary' }] });
  for (const args of [[], ['--staged']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' });
    assert.ifError(r.error);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /allowPhrases matching exceeded 100 ms/);
  }
});

test('bounded waiver matching preserves native regex syntax and path scoping', () => {
  const dir = repo({ 'README.md': 'after the review\n' }, { allowPhrases: [
    { pattern: '(?<=after )the (review)\\b', paths: ['README.md'], reason: 'product vocabulary' }
  ] });
  assert.equal(check(dir).status, 0);
  assert.equal(check(dir, ['--staged']).status, 0);
  writeFileSync(join(dir, 'other.md'), 'after the review\n');
  assert.match(check(dir).stderr, /other\.md:1/);
});

test('both config names reject symlink mode in the index even without filesystem symlinks', () => {
  for (const name of ['.unbloat.json', '.lean.json']) {
    const dir = repo({ 'README.md': 'x\n' }, { budgets: { docs: 999 } }, name);
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: '{"budgets":{"docs":999}}', encoding: 'utf8' });
    assert.equal(blob.status, 0, blob.stderr);
    assert.equal(git(dir, 'update-index', '--cacheinfo', `120000,${blob.stdout.trim()},${name}`).status, 0);
    const r = check(dir, ['--staged']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /must be a regular staged file/);
    assert.equal(JSON.parse(readFileSync(join(dir, name), 'utf8')).budgets.docs, 999);
  }
});

test('a staged JSON-shaped config symlink never rewrites its dummy referent', t => {
  if (process.platform === 'win32') { t.skip('JSON-shaped filenames are not valid on Windows'); return; }
  for (const name of ['.unbloat.json', '.lean.json']) {
    const dir = repo({ 'README.md': 'x\n' }, { budgets: { docs: 999 } }, name);
    const leaf = '{"budgets":{"docs":999}}', target = join(dir, leaf);
    writeFileSync(target, 'dummy content\n');
    rmSync(join(dir, name));
    if (!link(t, leaf, join(dir, name))) return;
    assert.equal(git(dir, 'add', '--', name).status, 0);
    const r = check(dir, ['--staged']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /must be a regular staged file/);
    assert.equal(readFileSync(target, 'utf8'), 'dummy content\n');
  }
});

test('ratcheting replaces the config without modifying another hard link to it', () => {
  const dir = repo({ 'README.md': 'x\n' }, { budgets: { docs: 999 } });
  const copy = join(temp('unbloat-copy-'), 'config.json');
  linkSync(join(dir, '.unbloat.json'), copy);
  const r = check(dir, ['--staged']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(copy, 'utf8')).budgets.docs, 999);
  assert.equal(JSON.parse(git(dir, 'show', ':.unbloat.json').stdout).budgets.docs, 1);
});

test('configured scanner globs have a deadline in worktree and staged modes', () => {
  const slow = 'a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b', stem = 'a'.repeat(64);
  for (const [list, ext, text] of [
    ['skip', '.txt', 'x\n'], ['allow', '.log', 'x\n'], ['dupSkip', '.md', 'x\n'],
    ['allowLarge', '.txt', 'x'.repeat(512 * 1024 + 1)], ['allowPhrases', '.md', 'after the review\n']
  ]) {
    const entry = list === 'allowPhrases' ? { pattern: 'after the review', paths: [slow], reason: 'fixture' } : { path: slow, reason: 'fixture' };
    const dir = repo({ [stem + ext]: text }, { [list]: [entry] });
    for (const args of [[], ['--staged']]) {
      const r = check(dir, args, undefined, CLI_LIMIT);
      assert.ifError(r.error);
      assert.equal(r.status, 1, `${list}: ${r.stderr}`);
      assert.match(r.stderr, /path glob matching exceeded 100 ms/);
    }
  }
});

test('configured guard and disk globs have the same deadline', () => {
  const slow = 'a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b', stem = 'a'.repeat(64);
  const guarded = repo({ 'README.md': 'x\n' }, { allow: [{ path: slow, reason: 'fixture' }] });
  const input = JSON.stringify({ cwd: guarded, tool_name: 'Write', tool_input: { file_path: join(guarded, `${stem}.log`) } });
  const guard = check(guarded, ['--guard'], input, CLI_LIMIT);
  assert.ifError(guard.error);
  assert.equal(guard.status, 1, guard.stderr);
  assert.match(guard.stderr, /path glob matching exceeded 100 ms/);
  const disk = repo({ 'README.md': 'x\n', '.gitignore': '*.tmp\n' }, { keep: [{ path: slow, reason: 'fixture' }] });
  writeFileSync(join(disk, `${stem}.tmp`), 'x\n');
  const r = check(disk, ['--disk'], undefined, CLI_LIMIT);
  assert.ifError(r.error);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /path glob matching exceeded 100 ms/);
});

test('turn hooks hash symlink text without reading the outside file or a FIFO target', t => {
  const dir = repo({ 'README.md': 'x\n' });
  assert.equal(git(dir, 'commit', '-qm', 'start').status, 0);
  const target = join(temp('unbloat-outside-'), 'dummy.txt'), leaf = join(dir, 'linked.txt');
  writeFileSync(target, 'dummy content\n');
  if (!link(t, target, leaf)) return;
  const targetText = readlinkSync(leaf);
  const expected = spawnSync('git', ['hash-object', '--stdin'], { cwd: dir, input: targetText, encoding: 'utf8' });
  assert.equal(expected.status, 0, expected.stderr);
  const input = JSON.stringify({ cwd: dir, session_id: 'link-read' });
  const started = check(dir, ['--turn-start'], input, CLI_LIMIT);
  assert.ifError(started.error);
  assert.equal(started.status, 0, started.stderr);
  const record = () => JSON.parse(readFileSync(join(dir, '.git/unbloat-turn-link-read.json'), 'utf8'));
  assert.equal(record().dirty['linked.txt'], expected.stdout.trim());
  writeFileSync(target, 'changed outside content\n');
  const stopped = check(dir, ['--stop'], input, CLI_LIMIT);
  assert.ifError(stopped.error);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, '');
  if (process.platform !== 'win32') {
    rmSync(target);
    const fifo = spawnSync('mkfifo', [target], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr);
    for (const flag of ['--turn-start', '--stop']) {
      const r = check(dir, [flag], input, CLI_LIMIT);
      assert.ifError(r.error);
      assert.equal(r.status, 0, r.stderr);
    }
    assert.equal(record().dirty['linked.txt'], expected.stdout.trim());
  }
});

test('turn hooks skip tracked paths whose parent directory became a symlink', t => {
  const dir = repo({ 'docs/notes.txt': 'x\n' });
  assert.equal(git(dir, 'commit', '-qm', 'start').status, 0);
  const outside = temp('unbloat-outside-');
  writeFileSync(join(outside, 'notes.txt'), 'outside dummy\n');
  rmSync(join(dir, 'docs'), { recursive: true });
  if (!link(t, outside, join(dir, 'docs'))) return;
  const input = JSON.stringify({ cwd: dir, session_id: 'parent-link' });
  const r = check(dir, ['--turn-start'], input, CLI_LIMIT);
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(readFileSync(join(dir, '.git/unbloat-turn-parent-link.json'), 'utf8'));
  assert.equal(state.dirty['docs/notes.txt'], '');
  const stopped = check(dir, ['--stop'], input, CLI_LIMIT);
  assert.ifError(stopped.error);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, '');
});

test('--changes escapes controls in exception reasons, commit subjects and snapshot metadata', () => {
  const dir = repo({ 'README.md': 'x\n' }, { budgets: { docs: 1 } });
  const snapshot = join(temp('unbloat-snapshot-'), 'snapshot.json');
  assert.equal(check(dir, [`--changes=${snapshot}`, '--save']).status, 0);
  const before = JSON.parse(readFileSync(snapshot, 'utf8'));
  before.saved = '\x1b[33msnapshot\x07';
  writeFileSync(snapshot, JSON.stringify(before));
  writeFileSync(join(dir, '.unbloat.json'), JSON.stringify({
    allow: [{ path: '*.log', reason: '\x1b[31mreason\x07' }], budgets: { docs: 2 }
  }));
  assert.equal(git(dir, 'add', '.unbloat.json').status, 0);
  const committed = git(dir, 'commit', '-qm', '\x1b[32msubject\x07');
  assert.equal(committed.status, 0, committed.stderr);
  const r = check(dir, [`--changes=${snapshot}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  for (const text of ['\\x1b[31mreason\\x07', '\\x1b[32msubject\\x07', '\\x1b[33msnapshot\\x07']) assert.ok(r.stdout.includes(text), r.stdout);
});

test('a hook that only names the check in an echo, or after an exit, is not current', () => {
  const dir = repo({ 'README.md': 'x\n', '..hooks/pre-commit': 'echo "node tools/unbloat-check.mjs --staged"\n' });
  git(dir, 'config', 'core.hooksPath', '..hooks');
  assert.equal(check(dir, ['--install-hook']).status, 1);
  writeFileSync(join(dir, '..hooks/pre-commit'), 'exit 0\nnode tools/unbloat-check.mjs --staged\n');
  assert.equal(check(dir, ['--install-hook']).status, 1);
});
