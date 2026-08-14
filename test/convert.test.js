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

  const reportPath = writeFile(projectRoot, 'reports/jscpd-report.json', JSON.stringify(report));
  const outputPath = path.join(projectRoot, 'reports/codecharta-clones.cc.json');

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

// Clone coupling is symmetric, so a pair must yield exactly one edge no matter
// which side jscpd happened to report first. The converter orders each pair
// lexicographically; without that, the same two files would produce two
// contradictory edges and CodeCharta would draw the pair twice.
withTempProject((projectRoot) => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const zebra = writeFile(projectRoot, 'src/Zebra.java', lines);
  const alpha = writeFile(projectRoot, 'src/Alpha.java', lines);
  const middle = writeFile(projectRoot, 'src/Middle.java', lines);

  const clone = (first, firstStart, second, secondStart) => ({
    format: 'java',
    firstFile: { name: first, start: firstStart, end: firstStart + 9 },
    secondFile: { name: second, start: secondStart, end: secondStart + 9 },
    lines: 10,
    tokens: 40,
  });

  const report = {
    duplicates: [
      // same pair, reported in both orders
      clone(zebra, 10, alpha, 5),
      clone(alpha, 40, zebra, 60),
      // a third file that sorts between the other two
      clone(zebra, 80, middle, 1),
      clone(middle, 30, alpha, 90),
    ],
    statistics: {},
  };

  const reportPath = writeFile(projectRoot, 'reports/jscpd-report.json', JSON.stringify(report));
  const outputPath = path.join(projectRoot, 'reports/out.cc.json');

  execFileSync(
    process.execPath,
    [CLI_PATH, reportPath, '--output', outputPath, '--project-root', projectRoot],
    { stdio: 'inherit' }
  );

  const edges = JSON.parse(fs.readFileSync(outputPath, 'utf8')).data.edges;
  const pairs = edges.map((e) => `${e.fromNodeName} ${e.toNodeName}`);

  assert.deepStrictEqual(
    pairs.slice().sort(),
    [
      '/root/src/Alpha.java /root/src/Middle.java',
      '/root/src/Alpha.java /root/src/Zebra.java',
      '/root/src/Middle.java /root/src/Zebra.java',
    ],
    'each pair must appear exactly once, always with the lexicographically smaller path as source'
  );

  for (const edge of edges) {
    assert.ok(edge.fromNodeName < edge.toNodeName, `edge ${edge.fromNodeName} -> ${edge.toNodeName} is not ordered`);
  }

  const alphaZebra = edges.find((e) => e.toNodeName.endsWith('Zebra.java') && e.fromNodeName.endsWith('Alpha.java'));
  assert.strictEqual(
    alphaZebra.attributes.shared_clone_pair_count,
    2,
    'both clone pairs of the same file pair must aggregate onto one edge'
  );

  // Zebra is in 3 clone pairs but shares them with only 2 other files - that
  // difference is the whole point of clone_partner_count.
  const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  const src = written.data.nodes[0].children.find((c) => c.name === 'src');
  const zebraNode = src.children.find((c) => c.name === 'Zebra.java');
  assert.strictEqual(zebraNode.attributes.clone_pair_count, 3);
  assert.strictEqual(zebraNode.attributes.clone_partner_count, 2);
  const middleNode = src.children.find((c) => c.name === 'Middle.java');
  assert.strictEqual(middleNode.attributes.clone_partner_count, 2);

  console.log('ok - one edge per file pair, ordered lexicographically');
});
