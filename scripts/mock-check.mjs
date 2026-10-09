#!/usr/bin/env node
// mock-check — decontamination gate for the `patch` codebase.
//
// WHY: external deps (Claude SDK, Telegram, Calendar, Todoist, FCM, Groq) may be
// mocked in UNIT TESTS, because a final integration round exercises the real
// thing. The contamination this catches is mocks that have leaked OUT of unit
// tests into places that make a real boot silently run fakes:
//   - INTERNAL/local/free components (Whisper-local, Kokoro, Silero VAD) selected
//     as mock ANYWHERE outside a unit test — they're ours and free.
//   - mock selected as a runtime DEFAULT (`?? 'mock'`) — silent when env unset.
//   - mock wired into a BOOT / dev / e2e / verify path (compose verify stacks,
//     dev scripts) — the stack you bring up to "verify" must not be fake.
//   - docs that document a mock as THE default / way-to-run for a backend.
//
// It fires on real ASSIGNMENTS (`X_BACKEND = / : / ?? mock`), not on enum lists,
// error strings, or "not a mock" notes. It does NOT scan unit tests, the prod
// compose, or the working logs (plan.json / build-context.json) — those carry
// honest prose about mocks and are reviewed by eye, not linted.
//
// Exits non-zero on any un-allowlisted contaminant, so it can gate the pipeline.
// Bless a genuinely-legit line with `mock-check:allow <why>` on it or the line
// above; the reason is printed so blessings stay visible. NO FALLBACKS — this is
// a detector; it reports precise file:line and never rewrites source.
//
//   node scripts/mock-check.mjs            # scan, report, exit 1 on contaminant
//   node scripts/mock-check.mjs --quiet    # contaminants + summary only

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const QUIET = process.argv.includes('--quiet');

// ---- policy -------------------------------------------------------------
// Components patch runs on its own box, for free. Their only fake value is
// `mock`; `groq`/`local`/`silero`/`real` are genuine backends.
const INTERNAL = new Set(['WHISPER_BACKEND', 'KOKORO_BACKEND', 'VAD_BACKEND']);
const EXTERNAL = new Set(['SDK_BACKEND']);

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', 'models', '.dev-data', '.patch',
  'coverage', '.turbo', 'build', 'out',
]);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.lock', '.onnx', '.bin', '.wav', '.pcm']);
// Working logs full of honest prose about mocks — reviewed by eye, not linted.
const SKIP_FILE = /(-plan\.json|build-context\.json)$/;

const isTest = (p) => /(^|[\\/])test[\\/]/.test(p) || /\.test\.[cm]?[jt]sx?$/.test(p);
const isComposeVerify = (p) => /docker-compose.*\.ya?ml$/.test(basename(p)) && !p.includes(`${sep}deploy${sep}`);
const isProdCompose = (p) => p.includes(`${sep}deploy${sep}`) && /docker-compose/.test(p);
const isScript = (p) => /(^|[\\/])scripts[\\/].*\.(sh|mjs|js|ts)$/.test(p) && !basename(p).startsWith('mock-check');
const isDoc = (p) => p.endsWith('.md');
const isRuntimeSrc = (p) => /[\\/]src[\\/]/.test(p) && /\.[cm]?tsx?$/.test(p) && !isTest(p);

// Real assignment of a backend to `mock`: `X_BACKEND = mock` / `: mock` / `?? 'mock'`.
// `['"\]]*` absorbs the `']` in `env['X_BACKEND']`. Mock must sit immediately
// after the operator, so enum lists (`'groq' | 'local' | 'mock'`) and error
// strings (`expected ... 'mock'`) — where mock is NOT after an operator — miss.
const ASSIGN = /\b(SDK_BACKEND|WHISPER_BACKEND|KOKORO_BACKEND|VAD_BACKEND)\b['"\]]*\s*(\?\?|:|=)\s*['"]?mock\b/g;
const ASSIGN_DEFAULT = /\b(SDK_BACKEND|WHISPER_BACKEND|KOKORO_BACKEND|VAD_BACKEND)\b['"\]]*\s*\?\?\s*['"]mock\b/;
// Lines that name a backend + mock but aren't contamination.
const EXCLUDE = /expected\b|Invalid |or switch|not a mock|no mock\b|unverifiable|NOT exercised|does NOT|no default|not the default|never the default/i;
// Boot-path mock/fixture env seams.
const BOOT_ENV = /\bPATCH_\w*_MOCK\b\s*[:=]\s*["']?1\b|\bPATCH_GCAL_FIXTURE\b/;
// Docs presenting mock as the DEFAULT: a real (un-escaped) table cell that is
// exactly `mock`, or prose adjacency "mock (default)" / "default ... mock".
const DOC_TABLE_DEFAULT = /(?<!\\)\|\s*`?mock`?\s*\|/;
const DOC_PROSE_DEFAULT = /\bmock\b[^.\n]{0,30}\bdefault\b|\bdefault\b[^.\n]{0,30}\bmock\b/i;
const NAMES_BACKEND = /\b(SDK_BACKEND|WHISPER_BACKEND|KOKORO_BACKEND|VAD_BACKEND)\b/;
// Whole-line comment in sh/yaml (`#`) or ts/js (`//`, or a `*` jsdoc body line).
const COMMENT_ONLY = /^\s*(#|\/\/|\*(?!\/))/;

/**
 * Is this line blessed by a `mock-check:allow <why>` marker?
 *
 * On the line itself, or on the line above it — except that a line inside a
 * `\`-continued shell command CANNOT carry a comment of its own, and neither can
 * the continuation above it: a `#` line spliced into the middle of the command
 * terminates it and silently drops every remaining argument. So for those, walk
 * up to the line above the start of the block, which is the first place a comment
 * is legal. A non-continuation line is unaffected — the walk stops immediately.
 */
function blessed(lines, i) {
  if (/mock-check:\s*allow/i.test(lines[i])) return true;
  let j = i - 1;
  while (j >= 0 && /\\\s*$/.test(lines[j])) j--;
  return j >= 0 && /mock-check:\s*allow/i.test(lines[j]);
}

const findings = [];
function add(rule, why, file, i, line) {
  findings.push({ rule, why, file, line: i + 1, snippet: line.trim().slice(0, 140) });
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (!SKIP_EXT.has(name.slice(name.lastIndexOf('.'))) && !SKIP_FILE.test(name)) yield p;
  }
}

const WHY = {
  'internal-mock': 'INTERNAL/local/free component (Whisper-local/Kokoro/Silero) assigned to mock outside a unit test — fakes prove nothing and there is no reason to mock what we own. Use the real backend.',
  'sdk-default-mock': 'EXTERNAL Claude SDK is the runtime DEFAULT mock — a boot with the env unset silently runs the echo bot. Make `real` the default or require explicit selection.',
  'sdk-boot-mock': 'EXTERNAL mock wired into a boot/verify/dev path — the stack you bring up to verify must not run a fake Claude. Confine SDK mock to unit tests.',
  'boot-mock-env': 'A mock/fixture seam (`PATCH_*_MOCK=1` / `PATCH_GCAL_FIXTURE`) set in a boot/verify/dev path — makes the verify stack serve canned data and can suppress the real-credential boot gate.',
  'doc-default-mock': 'Docs present a mock as THE default / way-to-run for a backend. The default and the bring-up recipe must be real; reframe mock as unit-test-only.',
};

for (const p of walk(ROOT)) {
  const rel = relative(ROOT, p);
  if (isProdCompose(p)) continue;
  const k = {
    test: isTest(rel), compose: isComposeVerify(rel), script: isScript(rel),
    doc: isDoc(rel), runtime: isRuntimeSrc(rel),
  };
  if (!k.compose && !k.script && !k.doc && !k.runtime) continue; // unknown kind: skip
  if (k.test) continue;                                          // unit tests may mock
  let lines;
  try { lines = readFileSync(p, 'utf8').split('\n'); } catch { continue; }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (blessed(lines, i)) continue;
    // A commented-out line sets nothing. `--help` text listing `PATCH_*_MOCK=1`
    // as an available flag, or a compose line parked behind `#`, is documentation
    // — flagging it taught people to delete the docs, not the contamination.
    // Markdown is exempt from this: `#` there is a heading, not a comment.
    if (!k.doc && COMMENT_ONLY.test(line)) continue;

    if (k.doc) {
      if (NAMES_BACKEND.test(line) && !EXCLUDE.test(line) && (DOC_TABLE_DEFAULT.test(line) || DOC_PROSE_DEFAULT.test(line)))
        add('doc-default-mock', WHY['doc-default-mock'], rel, i, line);
      continue;
    }

    if ((k.compose || k.script) && BOOT_ENV.test(line))
      add('boot-mock-env', WHY['boot-mock-env'], rel, i, line);

    if (!EXCLUDE.test(line)) {
      for (const m of line.matchAll(ASSIGN)) {
        const name = m[1];
        if (INTERNAL.has(name)) add('internal-mock', WHY['internal-mock'], rel, i, line);
        else if (EXTERNAL.has(name)) {
          if (k.runtime && ASSIGN_DEFAULT.test(line)) add('sdk-default-mock', WHY['sdk-default-mock'], rel, i, line);
          else if (k.compose || k.script) add('sdk-boot-mock', WHY['sdk-boot-mock'], rel, i, line);
        }
      }
    }
  }
}

// ---- report -------------------------------------------------------------
const byRule = {};
for (const f of findings) (byRule[f.rule] ??= []).push(f);

if (findings.length === 0) {
  console.log('\n✓ mock-check: clean — no mock contamination found.\n');
  process.exit(0);
}
console.log(`\n✗ mock-check: ${findings.length} contaminant(s) across ${Object.keys(byRule).length} rule(s):\n`);
for (const [rule, items] of Object.entries(byRule)) {
  console.log(`  [${rule}] ${items[0].why}`);
  for (const f of items) console.log(`      ${f.file}:${f.line}  ${f.snippet}`);
  console.log('');
}
console.log('Fix by removing/correcting each line, or bless a genuine case with a `mock-check:allow <why>` comment.\n');
process.exit(1);
