'use strict';

/**
 * Plain-Node smoke test (no test framework, no npm dependency). Runs the
 * actual CLI as a subprocess against a hand-crafted jscpd-report.json whose
 * shape mirrors what jscpd 5.0.15's own `json` reporter produces (verified
 * manually: `duplicates[].firstFile/secondFile.{name,start,end}`).
 *
 * Run: node test/convert.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI_PATH = path.join(__dirname, '..', 'jscpd-to-cc.js');

function withTempProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-to-codecharta-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(dir, relativePath, content) {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

withTempProject((projectRoot) => {
  const linesA = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const linesB = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const fileA = writeFile(projectRoot, 'src/A.java', linesA);
  const fileB = writeFile(projectRoot, 'src/B.java', linesB);

  // Shape verified against a real `jscpd --reporters json --absolute` run on jscpd 5.0.15.
  const report = {
    duplicates: [
      {
        format: 'java',
        firstFile: { name: fileA, start: 1, end: 10, startLoc: { line: 1, column: 1 }, endLoc: { line: 10, column: 1 } },
        secondFile: { name: fileB, start: 1, end: 10, startLoc: { line: 1, column: 1 }, endLoc: { line: 10, column: 1 } },
        fragment: 'irrelevant for conversion',
        lines: 10,
        tokens: 40,
      },
    ],
    statistics: {},
  };

  const reportPath = writeFile(projectRoot, 'reports/jscpd/jscpd-report.json', JSON.stringify(report));
  const outputPath = path.join(projectRoot, 'reports/jscpd/codecharta-clones.cc.json');

  execFileSync(
    process.execPath,
    [CLI_PATH, reportPath, '--output', outputPath, '--project-root', projectRoot, '--project-name', 'smoke-test clones'],
    { stdio: 'inherit' }
  );

  assert.ok(fs.existsSync(outputPath), 'expected cc.json to be written');
  const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

  assert.strictEqual(written.data.projectName, 'smoke-test clones');
  assert.strictEqual(written.data.apiVersion, '1.3');
  assert.strictEqual(written.data.edges.length, 1);

  const edge = written.data.edges[0];
  assert.strictEqual(edge.fromNodeName, '/root/src/A.java');
  assert.strictEqual(edge.toNodeName, '/root/src/B.java');
  assert.strictEqual(edge.attributes.shared_clone_lines, 10);

  const root = written.data.nodes[0];
  const srcFolder = root.children.find((c) => c.name === 'src');
  assert.ok(srcFolder, 'expected a src folder node');
  const nodeA = srcFolder.children.find((c) => c.name === 'A.java');
  assert.strictEqual(nodeA.attributes.duplicated_lines, 10);
  assert.strictEqual(nodeA.attributes.clone_coverage, 50);

  // checksum must match a fresh recompute (mergeable-map contract)
  const crypto = require('crypto');
  const recomputed = crypto.createHash('md5').update(JSON.stringify(written.data)).digest('hex');
  assert.strictEqual(written.checksum, recomputed);

  console.log('ok - smoke test passed');
});
