#!/usr/bin/env node
// unbloat-check: keeps a repository free of process artifacts, history told in its docs, repeated prose and doc
// growth nobody decided on. A repository opts in with a .unbloat.json at its root; `unbloat-check --init` writes one.
// Usage is in ../references/check.md.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';

const SELF = fileURLToPath(import.meta.url);
// The config file names, newest first (.lean.json is the name lean-check used). CONFIG is the one the repository
// being checked has, set by configOf; commands check one repository at a time.
const NAMES = ['.unbloat.json', '.lean.json'];
let CONFIG = NAMES[0];
// The config as a regular file in the working tree; a symlink could read any file the user can.
function readConfig(root) {
  const st = lstatSync(join(root, CONFIG), { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error(`${CONFIG} must be a regular file, not a link or folder`);
  return readFileSync(join(root, CONFIG), 'utf8');
}
const configOf = root => { const n = NAMES.find(n => existsSync(join(root, n))); if (n) CONFIG = n; return n ?? null; };
// For --staged the index decides: a config deleted from the working tree but still staged still gates the commit.
const stagedConfigOf = root => {
  const staged = git(root, ['ls-files', '-z', '--stage', '--', ...NAMES]).toString().split('\0');
  const entry = NAMES.map(n => staged.find(e => e.endsWith(`\t${n}`))).find(Boolean);
  if (!entry) return null;
  const [mode, n] = entry.split('\t');
  CONFIG = n;
  if (!/^100(?:644|755) [a-f0-9]+ 0$/.test(mode)) throw new Error(`${CONFIG} must be a regular staged file`);
  return n;
};
// Path containment that holds across drives: relative() returns an absolute path when there's no common root.
// A path with symlinks resolved (macOS's /var is /private/var); a path that doesn't exist yet keeps its last parts.
const real = path => { try { return realpathSync(path); } catch { return dirname(path) === path ? path : join(real(dirname(path)), basename(path)); } };
const inside = (parent, child) => { const rel = relative(parent, child); return !isAbsolute(rel) && rel !== '..' && !/^\.\.[\\/]/.test(rel); };
const MARK = '# unbloat-check pre-commit hook';
const OLD_MARK = '# lean-check pre-commit hook';

// Paths that hold process rather than product. No exception keeps a process doc (PLAN.md and the like). A note or
// record named for a handoff, ledger or receipt, or kept in reviews/ or evidence/, is process too, but only as a
// document or data file: code, config, templates and assets with such names are product, and a document that is
// product goes in "allow" with its reason.
const PROCESS_DOCS = ['**/PLAN.md', '**/HANDOFF.md', '**/TRACKER.md', '**/*IMPLEMENTATION_PLAN*.md', '**/ACCEPTANCE*.md'];
const PROCESS_NAMES = ['**/*handoff*', '**/*ledger*', '**/*receipt*', '**/reviews/**', '**/evidence/**'];
// In a folder named for one (handoff/, ledgers/), only notes count: a package or service of that name is product.
const PROCESS_FOLDERS = ['**/*handoff*/**', '**/*ledger*/**', '**/*receipt*/**'];
const NOTE_EXT = /\.(?:md|markdown|txt|rst|log)$/i;
const RECORD_EXT = /\.(?:md|markdown|txt|rst|log|json|jsonl|ndjson|csv|tsv)$/i;
// Paths that usually hold run records; a product file with such a name goes in "allow", with its reason.
const RECORD_FILES = ['**/*review*.md', '**/*.log', '**/reports/**', '**/RESULTS*.md'];
const WHY_FILE = 'plans, handoffs, ledgers, receipts, reviews, evidence, run reports and logs stay in chat or outside ' +
  'the repository (the session scratchpad, /tmp). Measurements that back a product decision live beside the scripts ' +
  'that reproduce them, as current facts';
// Run records inside files: JSON keys that time-stamp or score a run, and test counts in prose (they go stale).
const RECORD_KEYS = /"(?:checkedAt|testedAt|reviewedAt|acceptedAt|verifiedAt|[A-Za-z]*TestsPassed|testsPassed)"\s*:/;
const TEST_COUNTS = /\b\d[\d,]* (?:tests?|checks?|cases?|fixtures?) (?:passed|pass|green|matched)\b|\b(?:matched|passed) all \d[\d,]*\b|\b\d+ ?\/ ?\d+ tests? (?:passed|pass|green)\b/i;
// The exception lists in the config, and the field each entry names. Every entry carries a "reason".
const LISTS = { allow: 'path', allowPhrases: 'pattern', skip: 'path', dupSkip: 'path', allowLarge: 'path', keep: 'path' };

// Wording that tells the repository's history or its review process instead of what it does now.
const PHRASES = [
  [/\bindependent (?:\w+ )?review(?:er|s)?\b/i, 'review process'],
  [/\bsecond reviewers?\b|\breviewers? (?:spotted|found|accepted|flagged)\b/i, 'review process'],
  [/\b(?:acceptance|review|evidence) (?:ledgers?|receipts?|rounds?|campaigns?|gates?|items?)\b/i, 'process records'],
  [/\b(?:fixed in|after|from|in|review) round[- ]?\d+\b|\bround[- ]?\d+ (?:of )?(?:review|fixes|findings)\b/i, 'history'],
  [/\b(?:first|initial|original) slice\b/i, 'history'],
  [/\bthe user (?:approved|asked|explicitly|subsequently|later)\b/i, 'conversation history'],
  [/\b(?:after|from|per) the (?:\w+ )?review\b(?![ \t]+(?:period|date|window|deadline|process|queue|step|stage|page|form|meeting|board|panel|cycle|request))/i, 'history'],
  [/\b(?:before|for|needs?|owner'?s?|reviewer'?s?|final) sign[- ]off\b/i, 'review process'],
  [/\b(?:PLAN|HANDOFF|TRACKER)\.md\b/, 'tracker files'],
  [/\bT-(?:GATE|\d{2})\b/, 'tracker IDs'],
  [/\bacceptance (?:items?|runs?)\b|\baccepted (?:runs?|as a (?:local )?release candidate)\b/i, 'process records'],
];

// Not scanned, linked or counted in the budgets: lockfiles, licence texts, vendored and generated files, and a copy
// of this skill installed in an agent folder (.claude/skills/unbloat, .agents/skills/unbloat), whose docs quote bloat.
const SKIP = ['**/package-lock.json', '**/*.lock', '**/third-party/**', '**/licenses/**', '**/vendor/**',
  '**/node_modules/**', 'dist/**', '.*/**/skills/unbloat/**', ...NAMES];
const LICENCES = ['**/LICENSE', '**/LICENSE.*', '**/LICENSE-*', '**/LICENCE', '**/LICENCE.*', '**/License.*',
  '**/COPYING', '**/COPYING.*', '**/NOTICE', '**/NOTICE.*', '**/OFL.txt', '**/*-OFL.txt'];
const INSTRUCTIONS = ['**/AGENTS.md', '**/CLAUDE.md', '**/SKILL.md', '.cursorrules', '.github/copilot-instructions.md'];
const LARGE_KB = 512;
const DUP_WORDS = 12;
const CACHES = ['.mypy_cache', '.pytest_cache', '.ruff_cache', '__pycache__', '.cache'];
const KEEP = ['node_modules', '.venv', '.models', 'models'];
const SCRATCH = ['.scratch', 'scratch', 'tmp', '.tmp', 'out', 'work', 'outputs'];

// --- small helpers

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(r.stderr).trim()}`);
  return r.stdout;
}

function glob(pattern, flags = 'i') {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { re += '(?:[\\s\\S]*/)?'; i += 2; } else { re += '[\\s\\S]*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, flags);
}
const matcher = (patterns, flags) => { const res = patterns.map(p => glob(p, flags)); return path => res.some(r => r.test(path)); };
const processDoc = matcher(PROCESS_DOCS);
const processName = ((names, folders) => path => (names(path) && RECORD_EXT.test(path)) || (folders(path) && NOTE_EXT.test(path)))(
  matcher(PROCESS_NAMES), matcher(PROCESS_FOLDERS));

function repoRoot(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return null;
  }
}

// A repeated group whose body holds alternation, a repeat or another group can take exponential time on a long line:
// (x|xx)+, (x+)+, ((x))*. Such a pattern is refused rather than run.
function riskyRepeat(pattern) {
  const open = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') i++;
    else if (pattern[i] === '(') open.push(i);
    else if (pattern[i] === ')' && open.length > 0) {
      const body = pattern.slice(open.pop() + 1, i).replace(/^\?:/, '').replace(/\\./g, '');
      if (/[|+*?{}()]/.test(body) && /[+*{]/.test(pattern[i + 1] ?? '')) return true;
    }
  }
  return false;
}

function loadConfig(text, where) {
  let c;
  try { c = JSON.parse(text); } catch (e) { throw new Error(`${where}: ${e.message}`); }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${where}: must be a JSON object`);
  const config = { allow: [], allowPhrases: [], skip: [], dupSkip: [], allowLarge: [], keep: [], budgets: {}, ...c };
  // Shape problems are reported by exceptionProblems; the checks then run on what is usable.
  config.invalid = [];
  for (const list of Object.keys(LISTS)) if (!Array.isArray(config[list])) { config.invalid.push(`"${list}" must be a list`); config[list] = []; }
  if (!config.budgets || typeof config.budgets !== 'object' || Array.isArray(config.budgets)) {
    config.invalid.push('"budgets" must be an object'); config.budgets = {};
  }
  for (const [group, n] of Object.entries(config.budgets))
    if (!Number.isInteger(n) || n < 0) { config.invalid.push(`budgets.${group} must be a whole number of lines`); delete config.budgets[group]; }
  for (const w of config.allowPhrases) {
    if (!w || typeof w.pattern !== 'string') continue;
    if (w.paths !== undefined && !(Array.isArray(w.paths) && w.paths.every(p => typeof p === 'string'))) {
      config.invalid.push(`allowPhrases pattern ${w.pattern}: "paths" must be a list of globs`); w.paths = [];
    }
    try { if (riskyRepeat(w.pattern)) throw new Error('a repeated group with alternation, a repeat or a group inside can hang the check'); new RegExp(w.pattern, 'i'); }
    catch (e) { config.invalid.push(`allowPhrases pattern ${w.pattern}: ${e.message}`); w.pattern = '(?!)'; }
  }
  return config;
}
// The globs of one exception list (entries without a reason still count, and are reported).
const globs = (config, list) => config[list].filter(e => e && typeof e === 'object' && typeof e.path === 'string').map(e => e.path);

function exceptionProblems(config, add) {
  for (const text of config.invalid) add(CONFIG, 0, text);
  for (const [list, key] of Object.entries(LISTS)) {
    config[list].forEach((e, i) => {
      if (!e || typeof e !== 'object' || typeof e[key] !== 'string' || e[key] === '')
        add(CONFIG, 0, `${list}[${i}] must be { "${key}": ..., "reason": ... }`);
      else if (typeof e.reason !== 'string' || e.reason.trim() === '')
        add(CONFIG, 0, `${list}[${i}] (${e[key]}) needs a "reason": why it is product, not process`);
    });
  }
}

const exceptionRows = config => Object.keys(LISTS).flatMap(list => config[list].filter(e => e && typeof e === 'object')
  .map(e => `${list} ${e[LISTS[list]]}${e.paths ? ` (in ${e.paths.join(', ')})` : ''}: ${e.reason ?? '(no reason)'}`));

function listExceptions(config) {
  const rows = exceptionRows(config);
  if (rows.length > 0) console.log(`unbloat-check: ${rows.length} exception(s) in ${CONFIG}\n${rows.map(r => `  ${shown(r)}`).join('\n')}`);
}

const lineCount = text => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
const isText = buf => !buf.subarray(0, 8000).includes(0);

// --- what is checked: the index (a commit about to be made) or the working tree (tracked plus new files)

// The content of a submodule or nested repository is another repository's: its path is listed so that links into
// it resolve, and nothing under it is read.
const SUBMODULE = Buffer.alloc(0);

function readIndex(root) {
  // Entries are "<mode> <object> <stage>\t<path>"; blobs are asked for by object id, so no path is ever parsed
  // out of git's newline-framed batch output.
  const entries = git(root, ['ls-files', '-z', '--stage']).toString().split('\0').filter(Boolean)
    .map(e => { const tab = e.indexOf('\t'); const [mode, object] = e.slice(0, tab).split(' '); return { mode, object, path: e.slice(tab + 1) }; })
    .filter((e, i, all) => all.findIndex(o => o.path === e.path) === i);
  const blobs = entries.filter(e => e.mode !== '160000');
  const out = git(root, ['cat-file', '--batch'], blobs.map(e => `${e.object}\n`).join(''));
  const files = new Map(entries.filter(e => e.mode === '160000').map(e => [e.path, SUBMODULE]));
  let at = 0;
  for (const { path: p } of blobs) {
    const nl = out.indexOf(10, at);
    const header = out.subarray(at, nl).toString();
    at = nl + 1;
    if (header.endsWith('missing')) continue;
    const size = Number(header.split(' ')[2]);
    files.set(p, out.subarray(at, at + size));
    at += size + 1;
  }
  return files;
}

function readTree(root) {
  const paths = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0');
  const files = new Map();
  for (const p of new Set(paths.filter(Boolean))) {
    // Git stores a symlink as its target's path, so that is what is checked. A folder is a submodule or a nested
    // repository (git lists it with a trailing slash when untracked), so it is listed, not read.
    if (throughLink(root, p)) continue; // a folder committed as a real one, now a link: reading it would leave the repository
    const abs = join(root, p);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) continue; // deleted in the working tree
    if (st.isSymbolicLink()) files.set(p, Buffer.from(readlinkSync(abs)));
    else if (st.isFile()) files.set(p, readFileSync(abs));
    else if (st.isDirectory()) files.set(p.replace(/\/$/, ''), SUBMODULE);
  }
  return files;
}
// Whether a folder on the way to p is a link.
const throughLink = (root, p) => {
  const folders = p.split('/').slice(0, -1);
  return folders.some((_, k) => lstatSync(join(root, ...folders.slice(0, k + 1)), { throwIfNoEntry: false })?.isSymbolicLink());
};

// --- the checks

function check(files, config) {
  const problems = [];
  const add = (path, line, text) => problems.push({ path, line, text });
  exceptionProblems(config, add);
  const allowed = matcher(globs(config, 'allow')), licence = matcher(LICENCES, '');
  const skipped = (m => path => licence(path) || m(path))(matcher([...SKIP, ...globs(config, 'skip')]));
  const dupSkipped = matcher(globs(config, 'dupSkip')), large = matcher(globs(config, 'allowLarge'));
  const recordFile = matcher(RECORD_FILES), instruction = matcher(INSTRUCTIONS, '');
  const waivers = config.allowPhrases.filter(w => w && typeof w.pattern === 'string')
    .map(w => ({ re: new RegExp(w.pattern, 'i'), paths: matcher(w.paths ?? ['**']) }));
  // Only this fixed expression runs in the VM; patterns remain data. The deadline bounds native regex work.
  const waiverContext = createContext({ patterns: [], line: '' });
  const waiverTest = new Script('patterns.some(re => re.test(line))');
  const waived = (path, line) => {
    waiverContext.patterns = waivers.filter(w => w.paths(path)).map(w => w.re);
    if (waiverContext.patterns.length === 0) return false;
    waiverContext.line = line;
    try { return waiverTest.runInContext(waiverContext, { timeout: 100 }); }
    catch (e) {
      if (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new Error(`${CONFIG}: allowPhrases matching exceeded 100 ms; simplify the patterns`);
      throw e;
    }
  };
  const dirs = new Set();
  for (const p of files.keys()) for (let d = posix.dirname(p); d !== '.'; d = posix.dirname(d)) dirs.add(d);
  const sentences = new Map();
  const totals = { docs: 0, instructions: 0 };

  for (const [path, buf] of files) {
    if (processDoc(path)) add(path, 0, `process file: ${WHY_FILE}. No exception keeps it`);
    else if (processName(path) && !allowed(path)) add(path, 0, `process file: ${WHY_FILE}. A product file of this name goes in "allow" with its reason`);
    else if (recordFile(path) && !allowed(path)) add(path, 0, `run record: ${WHY_FILE}. A product file of this name goes in "allow" with its reason`);
    if (buf.length > LARGE_KB * 1024 && !large(path))
      add(path, 0, `${Math.round(buf.length / 1024)} KB tracked; generated media and evidence stay out of Git ` +
        '(a real asset goes in "allowLarge")');
    if (!isText(buf) || skipped(path)) continue;
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    const md = path.toLowerCase().endsWith('.md'), json = path.toLowerCase().endsWith('.json');
    lines.forEach((line, i) => {
      for (const [re, why] of PHRASES) {
        const m = line.match(re);
        if (!m || waived(path, line)) continue;
        add(path, i + 1, `"${m[0]}" (${why}): say what the project does now, not how it got here`);
      }
      const record = json ? line.match(RECORD_KEYS) : md ? line.match(TEST_COUNTS) : null;
      if (record && !waived(path, line))
        add(path, i + 1, `"${record[0]}" (run record): results of a run go stale; keep them out of the repository`);
    });
    if (instruction(path)) totals.instructions += lineCount(text);
    if (!md) continue;
    totals.docs += lineCount(text);
    links(path, text, files, dirs, add);
    if (!dupSkipped(path)) prose(path, text, sentences);
  }

  for (const places of sentences.values()) {
    if (places.length < 2) continue;
    const [first, ...rest] = places;
    add(first.path, first.line, `the same sentence is also at ${rest.map(p => `${p.path}:${p.line}`).join(', ')}; ` +
      'keep each fact in one place and point to it');
  }
  for (const [group, lines] of Object.entries(totals)) {
    const budget = config.budgets[group];
    if (budget !== undefined && lines > budget)
      add(CONFIG, 0, `${group}: ${lines} lines, over the budget of ${budget}. Cut it, or raise budgets.${group} ` +
        `in ${CONFIG} in this commit and say why in its message`);
  }
  return { problems, totals };
}

function links(path, text, files, dirs, add) {
  const base = posix.dirname(path);
  const lines = text.split('\n');
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    for (const m of line.matchAll(/\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      let target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/') || /[{$]/.test(target)) continue;
      target = target.replace(/[#?].*$/, '');
      try { target = decodeURIComponent(target); } catch { /* keep as written */ }
      const full = posix.normalize(posix.join(base, target)).replace(/\/$/, '');
      if (full.startsWith('..')) continue;
      const parts = full.split('/');
      const inSubmodule = parts.some((_, k) => files.get(parts.slice(0, k + 1).join('/')) === SUBMODULE);
      if (!files.has(full) && !dirs.has(full) && full !== '.' && !inSubmodule) add(path, i + 1, `link to ${m[1]}, which isn't in the repository`);
    }
  });
}

// Sentences are read across a paragraph's wrapped lines. A list item or a table row starts its own paragraph, and
// each sentence is reported at the line it starts on.
function prose(path, text, sentences) {
  let fenced = false, para = [];
  const flush = () => {
    let joined = '';
    const starts = [];
    for (const { line, at } of para) { if (joined) joined += ' '; starts.push([joined.length, at]); joined += line.trim(); }
    para = [];
    const lineAt = offset => starts.filter(([o]) => o <= offset).pop()?.[1] ?? 0;
    let from = 0;
    for (const cut of [...joined.matchAll(/(?<=[.!?;:])\s+|\s\|\s/g), { index: joined.length, 0: '' }]) {
      const part = joined.slice(from, cut.index);
      const line = lineAt(from);
      from = cut.index + cut[0].length;
      const words = part.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) ?? [];
      if (words.length < DUP_WORDS) continue;
      const key = words.join(' ');
      if (!sentences.has(key)) sentences.set(key, []);
      const places = sentences.get(key);
      if (!places.some(p => p.path === path && p.line === line)) places.push({ path, line });
    }
  };
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { flush(); fenced = !fenced; return; }
    if (fenced) return;
    if (/^\s*$|^\s*(#|<!--)/.test(line)) { flush(); return; }
    if (/^\s*(?:[-*+]|\d+[.)])\s|^\s*\|/.test(line)) flush();
    para.push({ line, at: i + 1 });
    if (/^\s*\|/.test(line)) flush();
  });
  flush();
}

// Repository names and config text can hold terminal control sequences; they are printed escaped.
const shown = text => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

function report(problems) {
  const sorted = [...problems].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  for (const p of sorted) console.error(shown(`${p.path}${p.line ? `:${p.line}` : ''}: ${p.text}`));
}

// --- commands

function run(root, staged) {
  if (staged) stagedConfigOf(root); else configOf(root);
  const configText = staged ? git(root, ['show', `:${CONFIG}`]).toString() : readConfig(root);
  const config = loadConfig(configText, CONFIG);
  const files = staged ? readIndex(root) : readTree(root);
  const { problems, totals } = check(files, config);
  if (problems.length > 0) {
    report(problems);
    console.error(`\nunbloat-check: ${problems.length} problem(s) in ${root}`);
    return 1;
  }
  const lowered = Object.entries(totals).filter(([g, n]) => config.budgets[g] !== undefined && n < config.budgets[g]);
  if (!staged) {
    listExceptions(config);
    console.log(`unbloat-check: ok (${files.size} files; docs ${totals.docs}, instructions ${totals.instructions} lines)`);
  }
  if (staged && lowered.length > 0) ratchet(root, configText, lowered);
  else if (lowered.length > 0) console.log(`unbloat-check: budgets can drop (${lowered.map(([g, n]) => `${g} ${n}`).join(', ')}); the next commit lowers them`);
  return 0;
}

// Budgets only move down on their own: a commit that shrinks the docs lowers them and stages the config with it.
function ratchet(root, configText, lowered) {
  // The config has unstaged edits (git's view, so CRLF checkouts compare equal): leave it to the person editing it.
  if (spawnSync('git', ['diff', '--quiet', '--', CONFIG], { cwd: root }).status !== 0) return;
  const config = JSON.parse(configText);
  for (const [group, lines] of lowered) config.budgets[group] = lines;
  const path = join(root, CONFIG), st = lstatSync(path, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error(`${CONFIG} must be a regular file, not a link or folder`);
  // Replacing the directory entry cannot write through a link swapped in after the type check.
  const temp = mkdtempSync(join(root, '.unbloat-'));
  try {
    const pending = join(temp, CONFIG);
    writeFileSync(pending, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: st.mode & 0o777 });
    renameSync(pending, path);
  } finally { rmSync(temp, { recursive: true, force: true }); }
  git(root, ['add', CONFIG]);
  console.log(`unbloat-check: lowered ${lowered.map(([g, n]) => `${g} to ${n}`).join(', ')} lines (${CONFIG} staged)`);
}

function init(root) {
  // Any entry with a config name, even a link to nowhere, means the repository has decided; never write through it.
  const present = NAMES.find(n => lstatSync(join(root, n), { throwIfNoEntry: false }));
  if (present && !configOf(root)) { console.error(`unbloat-check: ${present} exists but isn't a regular file`); return 1; }
  if (configOf(root)) {
    console.error(`unbloat-check: ${join(root, CONFIG)} already exists, so this repository is opted in` +
      (CONFIG === NAMES[0] ? '' : ` (to use the newer name: git mv ${CONFIG} ${NAMES[0]})`));
    return 1;
  }
  const path = join(root, CONFIG);
  const files = readTree(root);
  const { totals } = check(files, loadConfig('{}', CONFIG));
  // Large files already tracked are listed for a person to give each a reason (or remove it).
  const allowLarge = [...files].filter(([, b]) => b.length > LARGE_KB * 1024).map(([p]) => ({ path: p, reason: '' }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const config = { allow: [], allowPhrases: [], skip: [], dupSkip: [], allowLarge, keep: [], budgets: totals };
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  const hook = installHook(root);
  console.log(`unbloat-check: wrote ${path} (budgets: docs ${totals.docs}, instructions ${totals.instructions} lines)`);
  // A hook that wasn't installed leaves the commits unchecked, so the init has not finished.
  const status = run(root, false);
  return hook === 'manual' ? 1 : status;
}

// Returns 'installed', 'current', or 'manual' (a hook the project owns, or one that can't be moved aside, needs a
// person to add the check to it; the reason is printed).
function installHook(root, { quiet = false } = {}) {
  const say = text => { if (!quiet) console.error(text); };
  let hooks = git(root, ['rev-parse', '--git-path', 'hooks']).toString().trim();
  if (!isAbsolute(hooks)) hooks = join(root, hooks);
  const hook = join(hooks, 'pre-commit');
  const gitDir = real(resolve(root, git(root, ['rev-parse', '--git-common-dir']).toString().trim()));
  const repo = real(root), hookDir = real(hooks);
  const line = `node ${shq(SELF.split('\\').join('/'))} --staged`;
  if (inside(repo, hookDir) && !inside(gitDir, hookDir)) {
    // core.hooksPath points into the work tree (husky, .githooks): the project owns that hook, so it is never
    // rewritten. A hook there that already runs the check is enough.
    const current = existsSync(hook) ? readFileSync(hook, 'utf8') : '';
    if (runsCheck(current)) return 'current';
    say(`unbloat-check: hooks live in ${relative(root, hooks)}/ (core.hooksPath), which the project owns; ` +
      `add this line to its pre-commit hook: ${line}`);
    return 'manual';
  }
  if (!inside(repo, hookDir) && !inside(gitDir, hookDir)) {
    // A shared hooks folder (core.hooksPath outside the repository) serves other repositories too: never written.
    say(`unbloat-check: hooks live in ${hooks} (core.hooksPath), outside this repository; add this line to its pre-commit hook, ` +
      `or unset core.hooksPath here: ${line}`);
    return 'manual';
  }
  const body = `#!/bin/sh
${MARK}: runs the hook that was here before (pre-commit.local), if any,
# then unbloat-check on what is about to be committed. Written by unbloat-check --install-hook.
chained="$(dirname "$0")/pre-commit.local"
if [ -x "$chained" ]; then "$chained" "$@" || exit $?; fi
installed=${shq(SELF.split('\\').join('/'))}
script="\${UNBLOAT_CHECK:-$installed}"
if [ -f "$script" ] && command -v node >/dev/null 2>&1; then
  node "$script" --staged || exit 1
else
  echo "unbloat-check isn't installed here ($script), so this commit wasn't checked; set UNBLOAT_CHECK to its path" >&2
fi
exit 0
`;
  // A link is the project's: writing through it would write wherever it points, even outside the repository.
  if (lstatSync(hook, { throwIfNoEntry: false })?.isSymbolicLink()) {
    say(`unbloat-check: ${hook} is a link, which the project owns, so it is not rewritten; add this line to it: ${line}`);
    return 'manual';
  }
  if (existsSync(hook)) {
    const current = readFileSync(hook, 'utf8');
    if (current === body) return 'current';
    const ours = current.includes(MARK) || current.includes(OLD_MARK);
    // A project's own hook that already runs the check is left as it is.
    if (!ours && runsCheck(current)) return 'current';
    if (!ours && quiet) return 'manual'; // a session start never moves the project's own hook; --install-hook does
    if (!ours) {
      const local = join(hooks, 'pre-commit.local');
      if (existsSync(local)) {
        say(`unbloat-check: ${hook} and ${local} both exist, so neither is moved; add this line to ${hook}: ${line}`);
        return 'manual';
      }
      renameSync(hook, local);
      say(`unbloat-check: moved the existing pre-commit hook to ${local}; it runs first, then the check`);
    }
  }
  mkdirSync(hooks, { recursive: true });
  writeFileSync(hook, body);
  chmodSync(hook, 0o755);
  return 'installed';
}
// Whether a hook runs the check: a top-level node or npx command that calls the script with --staged, before any
// top-level exit. A comment, an echo or a line after the exit never runs it.
const runsCheck = hook => {
  const lines = hook.split('\n');
  const exit = lines.findIndex(l => /^exit\b/.test(l));
  return lines.slice(0, exit < 0 ? lines.length : exit)
    .some(l => /^\s*(?:exec\s+)?(?:node|npx)\s/.test(l) && /(?:unbloat|lean)-check\.mjs.*--staged/.test(l));
};
// A single-quoted shell word: no expansion happens inside it.
const shq = text => `'${text.replace(/'/g, `'\\''`)}'`;

// The write-time guard for Claude Code and Codex hooks: the tool call arrives as JSON on stdin; a call that would
// create a process file in an opted-in repository, or skip the pre-commit hook, is denied.
function guard(input) {
  const call = JSON.parse(input || '{}');
  const tool = call.tool_name ?? call.tool;
  const args = call.tool_input ?? call;
  const cwd = call.cwd ?? process.cwd();
  const targets = [];
  let reason = null;
  if (['Write', 'NotebookEdit'].includes(tool)) targets.push(args.file_path ?? args.notebook_path);
  if (tool === 'apply_patch') {
    for (const m of String(args.command ?? args.patch ?? '').matchAll(/^\*\*\* (?:Add File|Move to): (.+)$/gm)) targets.push(m[1].trim());
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    // The guard reads common forms; the pre-commit hook and the end-of-turn gate catch whatever it misses.
    let here = cwd; // a `cd dir` segment moves where the later ones run
    const visit = (command, bash, depth) => {
      for (const words of segments(command, bash)) {
        const w = commandWords(words);
        if (['cd', 'set-location', 'pushd'].includes(w[0]?.word.toLowerCase()) && w[1]) { here = resolve(here, w[1].word); continue; }
        const inner = shellString(words);
        if (inner !== null && depth < 3) visit(inner, !/^(?:pwsh|powershell)$/i.test(w[0].word), depth + 1);
        const commitDir = noVerifyCommit(words);
        if (commitDir !== null && repoGated(resolve(here, commitDir)))
          reason = 'unbloat-check: this commit skips the unbloat-check pre-commit hook (--no-verify, -n or core.hooksPath). Fix what it reports instead.';
        targets.push(...writeTargets(words).filter(Boolean).map(t => resolve(here, t.replace(/^(?:~|\$HOME|\$\{HOME\})(?=[\\/]|$)/, homedir()))));
      }
    };
    visit(String(args.command ?? ''), tool === 'Bash', 0);
  }
  for (let target of targets.filter(Boolean)) {
    if (reason) break;
    target = target.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
    if (target.includes('$')) continue; // a shell variable this guard cannot resolve
    const abs = resolve(cwd, target);
    if (existsSync(abs)) continue; // editing what is already there is the pre-commit check's business
    const root = repoRoot(dirname(abs));
    if (!root || !configOf(root)) continue;
    let config;
    try { config = loadConfig(readConfig(root), CONFIG); } catch { config = loadConfig('{}', CONFIG); } // allow nothing
    const rel = relative(root, abs).split('\\').join('/');
    if (processDoc(rel) || (processName(rel) && !matcher(globs(config, 'allow'))(rel))) reason = `unbloat-check: ${rel} is a process file: ${WHY_FILE}.`;
    else if (matcher(RECORD_FILES)(rel) && !matcher(globs(config, 'allow'))(rel)) reason = `unbloat-check: ${rel} looks like a run record: ${WHY_FILE}.`;
  }
  if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  return 0;
}
// A shell command as segments of words, split at ; & | && || ( ) and newlines. Adjacent quoted and plain pieces
// join into one word (PL''AN.md is PLAN.md); a word with any quoted piece is marked quoted. Heredoc bodies are
// dropped: they are text, not commands. A backslash escapes the next character in bash; in PowerShell it's a path
// separator.
function segments(command, escapes) {
  const unescape = text => (escapes ? text.replace(/\\(.)/g, '$1') : text);
  const text = command.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, '$3');
  const out = [[]];
  let word = null;
  const end = () => { if (word) out[out.length - 1].push(word); word = null; };
  const piece = (part, quoted) => { word ??= { word: '', quoted: false }; word.word += part; word.quoted ||= quoted; };
  const re = /([ \t\r]+)|(&&|\|\||[|;&\n()`])|(>>|>\||>|<)|\$'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:[^\s"'|;&<>()`\\]|\\.)+)/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) end();
    else if (m[2]) { end(); out.push([]); }
    else if (m[3]) { end(); out[out.length - 1].push({ op: m[3] }); }
    else if (m[4] !== undefined) piece(m[4].replace(/\\(.)/g, '$1'), true);
    else if (m[5] !== undefined) piece(unescape(m[5]), true);
    else if (m[6] !== undefined) piece(m[6], true);
    else piece(unescape(m[7]), false);
  }
  end();
  return out.filter(seg => seg.length > 0);
}

// The words of a segment's command: shell keywords, variable assignments and wrappers (sudo, env) in front dropped.
function commandWords(words) {
  const w = words.filter(t => t.word !== undefined);
  const skip = ['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time', 'sudo', 'command', 'env', 'exec', 'nohup'];
  let i = 0;
  while (i < w.length && (skip.includes(w[i].word) || /^[A-Za-z_]\w*=/.test(w[i].word))) i++;
  return w.slice(i);
}

// The directory a commit that skips the pre-commit hook runs in (`git [-C dir] commit --no-verify | -n`, or a
// `-c core.hooksPath=...` that points the hook elsewhere), or null if this segment isn't one.
function noVerifyCommit(words) {
  const w = commandWords(words);
  if (w[0]?.word !== 'git') return null;
  let dir = '.', i = 1, hooksMoved = false;
  for (; i < w.length && w[i].word.startsWith('-'); i++) {
    if (w[i].word === '-C') { const next = w[++i]?.word ?? '.'; dir = isAbsolute(next) ? next : join(dir, next); }
    else if (w[i].word === '-c') { if (/^core\.hookspath=/i.test(w[++i]?.word ?? '')) hooksMoved = true; }
  }
  if (w[i]?.word !== 'commit') return null;
  if (hooksMoved) return dir;
  // Options with a separate value (-m msg, -F file, -C/-c commit, -t file, and their long forms) skip it.
  const valued = /^(?:-[mFcCt]|--(?:message|file|reuse-message|reedit-message|template|author|date|fixup|squash|cleanup|trailer))$/;
  for (let j = i + 1; j < w.length; j++) {
    const word = w[j].word;
    if (word === '--') break;
    if (valued.test(word)) { j++; continue; }
    if (word === '--no-verify') return dir;
    if (/^-[A-Za-z]/.test(word)) for (const c of word.slice(1)) { if (c === 'n') return dir; if ('mFcCt'.includes(c)) break; }
  }
  return null;
}

// Files a segment writes: > >> >| redirections, tee's and touch's file arguments, the destination of cp, mv and
// install, and PowerShell's file cmdlets.
function writeTargets(words) {
  const targets = [];
  words.forEach((t, i) => { if (['>', '>>', '>|'].includes(t.op)) targets.push(words[i + 1]?.word); });
  const w = commandWords(words);
  const cmd = (w[0]?.word ?? '').toLowerCase();
  const args = w.slice(1).filter(t => t.quoted || !t.word.startsWith('-')).map(t => t.word);
  if (cmd === 'tee' || cmd === 'touch') targets.push(...args);
  if (['cp', 'mv', 'install', 'copy-item', 'move-item'].includes(cmd) && args.length > 1) targets.push(args[args.length - 1]);
  if (['set-content', 'add-content', 'out-file', 'new-item'].includes(cmd)) {
    const named = w.findIndex(t => /^-(?:path|filepath|literalpath)$/i.test(t.word));
    targets.push(named >= 0 ? w[named + 1]?.word : args[0]);
  }
  return targets;
}

// A segment that runs a shell on a command string (bash -c "...", sh -lc '...'): the string, else null.
function shellString(words) {
  const w = commandWords(words);
  if (!['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell'].includes((w[0]?.word ?? '').toLowerCase())) return null;
  const i = w.findIndex((t, j) => j > 0 && /^-(?:[a-z]*c|command)$/i.test(t.word));
  return i > 0 ? w[i + 1]?.word ?? null : null;
}
const repoGated = cwd => { const r = repoRoot(cwd); return r !== null && configOf(r); };

// Session start (Claude Code and Codex hooks): an opted-in repository without the pre-commit hook gets it, unless
// the project already has a hook of its own there.
function sessionStart(input) {
  let cwd = process.cwd();
  try { cwd = JSON.parse(input || '{}').cwd ?? cwd; } catch { /* not JSON: use the process's cwd */ }
  const root = repoRoot(cwd);
  if (root && configOf(root) && installHook(root, { quiet: true }) === 'installed') console.log(`unbloat-check: installed the pre-commit hook in ${root}`);
  return 0;
}

// The end-of-turn gate (Claude Code and Codex Stop hooks). --turn-start, on the prompt, records
// the commit the turn starts from; --stop checks what changed since (commits, edits and new files) and, if that
// brought problems, asks the agent to fix them before it finishes, at most MAX_SENDS times a turn. The record lives
// in the repository's git folder, never its tree.
const MAX_SENDS = 2;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// One record per agent session (the hook's session_id), so sessions in one repository don't share a turn.
const turnFile = (root, session) => resolve(root, git(root, ['rev-parse', '--git-path',
  `unbloat-turn${session ? `-${String(session).replace(/[^\w-]/g, '_')}` : ''}.json`]).toString().trim());
const hookSession = input => { try { return JSON.parse(input || '{}').session_id ?? ''; } catch { return ''; } };
const zpaths = buf => buf.toString().split('\0').filter(Boolean);
// Git's object id for a file's bytes. Hashed here, not by git hash-object: that would run the repository's clean
// filters, and its stdin list breaks on a newline in a file name.
const blobId = buf => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
// Each uncommitted path with its content hash ("" once deleted): what a turn found already changed.
function dirtyNow(root) {
  const paths = [...new Set([...zpaths(git(root, ['diff', '-z', '--name-only', 'HEAD'])),
    ...zpaths(git(root, ['ls-files', '-z', '--others', '--exclude-standard']))])];
  return Object.fromEntries(paths.map(p => [p, existsSync(join(root, p)) ? blobId(readFileSync(join(root, p))) : '']));
}
const head = root => { try { return git(root, ['rev-parse', 'HEAD']).toString().trim(); } catch { return null; } };
const hookCwd = input => { try { return JSON.parse(input || '{}').cwd ?? process.cwd(); } catch { return process.cwd(); } };

function turnStart(input) {
  const root = repoRoot(hookCwd(input));
  if (!root || !configOf(root)) return 0;
  let dirty = {};
  try { dirty = head(root) ? dirtyNow(root) : {}; } catch { /* unusual paths: count everything as the turn's */ }
  writeFileSync(turnFile(root, hookSession(input)), JSON.stringify({ base: head(root), sends: 0, dirty }) + '\n');
  return 0;
}

function stop(input) {
  const root = repoRoot(hookCwd(input));
  if (!root || !configOf(root)) return 0;
  const record = turnFile(root, hookSession(input));
  let turn = { base: null, sends: 0, dirty: {} };
  let recorded = false;
  try { turn = { ...turn, ...JSON.parse(readFileSync(record, 'utf8')) }; recorded = true; } catch { /* no record: changes since HEAD */ }
  if (turn.sends >= MAX_SENDS) return 0;
  // Every block counts as a send, including a broken config, so a turn can't be held open forever.
  const send = reason => {
    writeFileSync(record, JSON.stringify({ ...turn, sends: turn.sends + 1 }) + '\n');
    console.log(JSON.stringify({ decision: 'block', reason }));
    return 0;
  };
  // A turn that began before the first commit counts everything it committed: diff from the empty tree.
  const base = turn.base ?? (recorded ? EMPTY_TREE : head(root));
  const now = (() => { try { return head(root) ? dirtyNow(root) : {}; } catch { return {}; } })();
  // Paths that were already changed when the turn began, and still hold the same content, aren't this turn's.
  const changed = new Set([
    ...(base ? zpaths(git(root, ['diff', '-z', '--name-only', base])) : []),
    ...zpaths(git(root, ['ls-files', '-z', '--others', '--exclude-standard'])),
  ].filter(p => !(p in turn.dirty) || turn.dirty[p] !== now[p]));
  if (changed.size === 0) return 0;
  let config;
  try { config = loadConfig(readConfig(root), CONFIG); } catch (e) {
    return send(`unbloat-check: ${e.message}. Fix the config before you finish.`);
  }
  const { problems } = check(readTree(root), config);
  // Problems in what the turn touched, and the config's own (budgets, exceptions): both fail the next commit.
  // A repeated sentence is reported at its first place, so the copies it names count too.
  const mine = problems.filter(p => p.path === CONFIG || changed.has(p.path) || [...changed].some(c => p.text.includes(` ${c}:`)));
  if (mine.length === 0) return 0;
  const list = mine.slice(0, 20).map(p => `- ${p.path}${p.line ? `:${p.line}` : ''}: ${p.text}`).join('\n');
  const more = mine.length > 20 ? `\n- and ${mine.length - 20} more (run unbloat-check)` : '';
  return send(`unbloat-check: what this turn changed in ${root} has ${mine.length} problem(s) the next commit would ` +
    `fail on. Fix them before you finish; an exception is only for product files or wording, with its reason.\n${list}${more}`);
}

// Ignored and untracked build-up: caches, scratch and output folders, by size and age. Reports; never deletes.
function disk(root) {
  configOf(root);
  const config = loadConfig(readConfig(root), CONFIG);
  const out = git(root, ['status', '--porcelain', '-z', '--ignored', '--untracked-files=normal']).toString().split('\0');
  // Environments and models are left out; the repository's own "keep" entries are listed apart, with their reasons.
  const env = matcher(KEEP.flatMap(k => [k, `${k}/`, `**/${k}/`]));
  // A plain path to a folder is kept as that folder, with or without its trailing slash.
  const kept = config.keep.filter(e => e && typeof e.path === 'string').map(e => {
    const path = !/[*?]/.test(e.path) && !e.path.endsWith('/') && lstatSync(join(root, e.path), { throwIfNoEntry: false })?.isDirectory()
      ? `${e.path}/` : e.path;
    return { ...e, path, is: matcher([path]) };
  });
  const keepOf = rel => kept.find(k => k.is(rel));
  const keep = rel => env(rel) || keepOf(rel) !== undefined;
  // A folder that holds a kept path isn't a candidate as a whole: its other contents are listed one by one.
  const holdsKept = rel => rel.endsWith('/') && kept.some(k => k.path !== rel && k.path.startsWith(rel));
  const holdsEnv = (abs, depth) => depth > 0 && (lstatSync(abs, { throwIfNoEntry: false })?.isDirectory() ?? false) &&
    readdirSync(abs, { withFileTypes: true }).some(c => c.isDirectory() && (KEEP.includes(c.name) || holdsEnv(join(abs, c.name), depth - 1)));
  const rows = [], keptRows = [];
  for (const k of kept) {
    const abs = join(root, k.path.replace(/\/$/, ''));
    if (!existsSync(abs)) { keptRows.push({ rel: k.path, size: 0, days: null, reason: `${k.reason} (missing)` }); continue; }
    keptRows.push({ rel: k.path, size: sizeOf(abs), days: Math.floor((Date.now() - statSync(abs).mtimeMs) / 86400000), reason: k.reason });
  }
  const add = (rel, kind) => {
    if (keep(rel)) return;
    const abs = join(root, rel);
    if (holdsKept(rel) || holdsEnv(abs, 3)) {
      for (const child of readdirSync(abs, { withFileTypes: true })) add(`${rel}${child.name}${child.isDirectory() ? '/' : ''}`, kind);
      return;
    }
    const size = sizeOf(abs);
    const days = Math.floor((Date.now() - (lstatSync(abs, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())) / 86400000);
    if (size >= 1 << 20 || kind === 'scratch/output' || kind === 'untracked') rows.push({ rel, size, days, kind });
  };
  for (const entry of out) {
    if (!entry.startsWith('!! ') && !entry.startsWith('?? ')) continue;
    const rel = entry.slice(3);
    if (NAMES.includes(rel)) continue;
    const name = rel.replace(/\/$/, '').split('/').pop();
    const kind = CACHES.includes(name) ? 'cache' : SCRATCH.includes(name) ? 'scratch/output' : entry.startsWith('??') ? 'untracked' : 'ignored';
    // A scratch or output folder is listed by what's in it, so "keep" can name the parts that should stay.
    if (kind === 'scratch/output' && rel.endsWith('/') && !keep(rel)) {
      let files = 0, size = 0, newest = 0;
      for (const child of readdirSync(join(root, rel), { withFileTypes: true })) {
        if (child.isDirectory()) { add(`${rel}${child.name}/`, kind); continue; }
        if (keep(`${rel}${child.name}`)) continue;
        const st = statSync(join(root, rel, child.name), { throwIfNoEntry: false });
        if (!st) continue;
        files++; size += st.size; newest = Math.max(newest, st.mtimeMs);
      }
      if (files > 0) rows.push({ rel: `${rel}* (${files} file${files === 1 ? '' : 's'})`, size, days: Math.floor((Date.now() - newest) / 86400000), kind });
    } else add(rel, kind);
  }
  rows.sort((a, b) => b.size - a.size);
  for (const r of rows) console.log(`${fmt(r.size).padStart(9)}  ${String(r.days).padStart(4)} d  ${r.kind.padEnd(14)} ${shown(r.rel)}`);
  if (rows.length === 0) console.log('nothing ignored or untracked worth a look');
  if (keptRows.length > 0) {
    console.log(`kept (${CONFIG} "keep"):`);
    for (const r of keptRows) console.log(`${fmt(r.size).padStart(9)}  ${r.days === null ? '   -' : String(r.days).padStart(4)} d  ${shown(r.rel)}: ${shown(r.reason)}`);
  }
  return 0;
}
function sizeOf(abs) {
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of readdirSync(abs, { withFileTypes: true })) if (!e.isSymbolicLink()) total += sizeOf(join(abs, e.name));
  return total;
}
const fmt = n => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

function opted(dirs) {
  const roots = [];
  for (const d of dirs) {
    if (!lstatSync(d, { throwIfNoEntry: false })?.isDirectory()) { console.error(`unbloat-check: ${d} is not a folder`); continue; }
    for (const e of [d, ...readdirSync(d).map(n => join(d, n))]) {
      const r = configOf(e) && existsSync(join(e, '.git')) ? resolve(e) : null;
      if (r && !roots.includes(r)) roots.push(r);
    }
  }
  return roots;
}

// --changes=FILE: exceptions added (or reworded) and budgets raised since the snapshot in FILE; --save makes the
// current state the snapshot. A repository the snapshot doesn't have counts as wholly new.
function changes(roots, file, save) {
  const before = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { repos: {} };
  const now = {};
  let added = 0, raised = 0;
  for (const root of roots) {
    configOf(root);
    const config = loadConfig(readConfig(root), CONFIG);
    now[root] = { exceptions: exceptionRows(config), budgets: config.budgets };
    if (save) continue;
    const old = before.repos[root] ?? { exceptions: [], budgets: {} };
    const rows = now[root].exceptions.filter(r => !old.exceptions.includes(r)).map(r => `  new: ${r}`);
    const last = () => String(git(root, ['log', '-1', '--format=%h %s', '--', CONFIG])).trim();
    for (const [group, n] of Object.entries(old.budgets)) {
      const current = config.budgets[group];
      if (current === undefined) rows.push(`  removed: the ${group} budget (was ${n}) (${last()})`);
      else if (current > n) rows.push(`  raised: ${group} ${n} -> ${current} (${last()})`);
    }
    added += rows.filter(r => r.startsWith('  new')).length;
    raised += rows.filter(r => r.startsWith('  raised') || r.startsWith('  removed')).length;
    if (rows.length > 0) console.log(`--- ${root}\n${rows.join('\n')}`);
  }
  if (save) {
    writeFileSync(file, `${JSON.stringify({ saved: new Date().toISOString(), repos: now }, null, 2)}\n`);
    console.log(`unbloat-check: saved the exceptions and budgets of ${roots.length} repositories to ${file}`);
  } else console.log(`unbloat-check: ${added} new exception(s), ${raised} raised or removed budget(s) since ${before.saved ?? 'no snapshot'}`);
  return 0;
}

function main(argv) {
  const has = flag => argv.includes(flag);
  const stdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };
  if (has('--help') || has('-h')) {
    console.log(readFileSync(join(dirname(SELF), '..', 'references', 'check.md'), 'utf8'));
    return 0;
  }
  if (has('--guard')) return guard(stdin());
  if (has('--session-start')) return sessionStart(stdin());
  if (has('--turn-start')) return turnStart(stdin());
  if (has('--stop')) return stop(stdin());
  const dirs = argv.filter(a => !a.startsWith('--'));
  const snapshot = argv.find(a => a.startsWith('--changes='))?.slice('--changes='.length);
  if (snapshot) {
    const roots = has('--all') ? opted(dirs.length ? dirs : [process.cwd()]) : [repoRoot(dirs[0] ?? process.cwd())].filter(Boolean);
    return changes(roots.filter(r => configOf(r)), resolve(snapshot), has('--save'));
  }
  if (has('--all')) {
    let status = 0;
    for (const root of opted(dirs.length ? dirs : [process.cwd()])) {
      console.log(`\n--- ${root}`);
      if (has('--disk')) disk(root);
      else status = Math.max(status, run(root, false));
    }
    return status;
  }
  const root = repoRoot(dirs[0] ?? process.cwd());
  if (!root) { console.error('unbloat-check: not inside a git repository'); return 2; }
  if (has('--init')) return init(root);
  if (has('--staged')) return stagedConfigOf(root) ? run(root, true) : 0; // no staged config: not opted in
  if (!configOf(root)) {
    console.error(`unbloat-check: ${root} has no ${CONFIG}; run unbloat-check --init to opt in`);
    return 2;
  }
  if (has('--install-hook')) {
    const result = installHook(root);
    if (result === 'manual') return 1;
    console.log(result === 'installed' ? 'unbloat-check: installed the pre-commit hook' : 'unbloat-check: the pre-commit hook is current');
    return 0;
  }
  if (has('--disk')) return disk(root);
  return run(root, has('--staged'));
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`unbloat-check: ${e.message}`);
  process.exitCode = 1;
}
