'use strict';

/**
 * Plain-Node smoke test (no test framework, no npm dependency) that exercises
 * CodechartaReporter exactly the way jscpd would: construct with an IOptions
 * object, call report(clones, statistic) with fake IClone data, then check
 * the written cc.json.
 *
 * Run: node test/smoke.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodechartaReporter = require('../index.js');

function withTempProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-codecharta-reporter-'));
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

function fakeClone(fileA, startA, endA, fileB, startB, endB) {
  return {
    format: 'java',
    duplicationA: { sourceId: fileA, start: { line: startA }, end: { line: endA } },
    duplicationB: { sourceId: fileB, start: { line: startB }, end: { line: endB } },
  };
}

withTempProject((projectRoot) => {
  const linesA = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const linesB = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  writeFile(projectRoot, 'src/A.java', linesA);
  writeFile(projectRoot, 'src/B.java', linesB);

  const clones = [
    fakeClone(path.join(projectRoot, 'src/A.java'), 1, 10, path.join(projectRoot, 'src/B.java'), 1, 10),
  ];

  const outputPath = path.join(projectRoot, 'reports/jscpd/codecharta-clones.cc.json');
  const reporter = new CodechartaReporter({
    output: path.join(projectRoot, 'reports/jscpd'),
    reportersOptions: {
      codecharta: {
        projectRoot,
        projectName: 'smoke-test clones',
      },
    },
  });

  reporter.report(clones, undefined);

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
  const fileA = srcFolder.children.find((c) => c.name === 'A.java');
  assert.strictEqual(fileA.attributes.duplicated_lines, 10);
  assert.strictEqual(fileA.attributes.clone_coverage, 50);

  // module.exports.default must resolve too, since jscpd always does
  // `require('jscpd-codecharta-reporter').default`.
  assert.strictEqual(require('../index.js').default, CodechartaReporter);

  console.log('ok - smoke test passed');
});
