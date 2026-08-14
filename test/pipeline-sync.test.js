'use strict';

/**
 * Keeps jscpd-to-cc-pipeline.sh and the README's "Full pipeline" section in
 * sync. The script is what people actually run, the README block is what they
 * read - a step added to one and forgotten in the other is exactly the kind of
 * drift that makes a documented pipeline stop matching reality.
 *
 * Run: node test/pipeline-sync.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'jscpd-to-cc-pipeline.sh'), 'utf8');

// The fenced bash block right after the "Full pipeline" heading.
function pipelineBlock(markdown) {
  const heading = markdown.indexOf('### Full pipeline');
  assert.notStrictEqual(heading, -1, 'README must keep a "### Full pipeline" section');
  const open = markdown.indexOf('```bash', heading);
  const close = markdown.indexOf('```', open + '```bash'.length);
  assert.ok(open !== -1 && close !== -1, 'the Full pipeline section must contain a bash block');
  return markdown.slice(open + '```bash'.length, close);
}

// "ccsh merge", "jscpd-to-cc", ... - the invocation that starts each command,
// ignoring comments and continuation lines.
function invocations(bash) {
  const found = new Set();
  for (const rawLine of bash.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const ccsh = line.match(/^ccsh\s+([a-z-]+)/);
    if (ccsh) {
      found.add(`ccsh ${ccsh[1]}`);
      continue;
    }
    const command = line.match(/^(jscpd-to-cc|fix-merged-edges|strip-edges|jscpd|git)\b/);
    if (command) found.add(command[1]);
  }
  return found;
}

function mentions(haystack, command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s"'$=])${escaped}([\\s"'\\\\]|$)`, 'm').test(haystack);
}

const documented = invocations(pipelineBlock(README));
assert.ok(documented.size >= 5, `expected a multi-step pipeline in the README, got ${[...documented]}`);

for (const command of documented) {
  assert.ok(mentions(SCRIPT, command), `README documents "${command}" but jscpd-to-cc-pipeline.sh never runs it`);
}

// ...and nothing the script runs may be missing from the README.
const scripted = new Set([...SCRIPT.matchAll(/^\s*ccsh\s+([a-z-]+)/gm)].map((m) => `ccsh ${m[1]}`));
for (const command of scripted) {
  assert.ok(documented.has(command), `jscpd-to-cc-pipeline.sh runs "${command}" but the README does not document it`);
}

// The repair step is easy to drop from either side and its absence is silent.
assert.ok(documented.has('fix-merged-edges'), 'the README pipeline must include the fix-merged-edges step');
assert.ok(mentions(SCRIPT, 'fix-merged-edges'), 'the script must include the fix-merged-edges step');

console.log(`ok - README and jscpd-to-cc-pipeline.sh agree on ${documented.size} pipeline steps`);
