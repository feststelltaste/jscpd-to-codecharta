'use strict';

/**
 * Plain-Node smoke test (no test framework, no npm dependency). Runs the
 * actual CLI as a subprocess against a map shaped like a gitlogparser output:
 * history metrics on the nodes, temporal-coupling edges between them.
 *
 * Run: node test/strip-edges.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI_PATH = path.join(__dirname, '..', 'strip-edges.js');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-edges-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

withTempDir((dir) => {
  const project = {
    projectName: 'git fixture',
    apiVersion: '1.3',
    nodes: [
      {
        name: 'root',
        type: 'Folder',
        attributes: {},
        link: '',
        children: [
          { name: 'A.java', type: 'File', attributes: { number_of_authors: 3, age_in_weeks: 40 }, link: '', children: [] },
          { name: 'B.java', type: 'File', attributes: { number_of_authors: 1, age_in_weeks: 12 }, link: '', children: [] },
        ],
      },
    ],
    edges: [
      { fromNodeName: '/root/A.java', toNodeName: '/root/B.java', attributes: { temporal_coupling: 0.5 } },
      { fromNodeName: '/root/B.java', toNodeName: '/root/A.java', attributes: { temporal_coupling: 0.375 } },
    ],
    attributeTypes: {
      nodes: { number_of_authors: 'absolute', age_in_weeks: 'absolute' },
      edges: { temporal_coupling: 'absolute' },
    },
    attributeDescriptors: {
      temporal_coupling: { title: 'Temporal Coupling' },
      number_of_authors: { title: 'Number of Authors' },
    },
    blacklist: [],
  };

  const inputPath = path.join(dir, 'git.cc.json');
  const compact = JSON.stringify(project);
  const checksum = crypto.createHash('md5').update(compact, 'utf8').digest('hex');
  fs.writeFileSync(inputPath, JSON.stringify({ checksum, data: project }, null, 2), 'utf8');

  const outputPath = path.join(dir, 'git-metrics-only.cc.json');
  execFileSync(process.execPath, [CLI_PATH, inputPath, '--output', outputPath], { stdio: 'inherit' });

  const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.deepStrictEqual(written.data.edges, [], 'all edges must be gone');

  // The point of the tool: the node metrics are what we keep.
  const fileA = written.data.nodes[0].children[0];
  assert.strictEqual(fileA.attributes.number_of_authors, 3);
  assert.strictEqual(fileA.attributes.age_in_weeks, 40);
  assert.strictEqual(written.data.attributeTypes.nodes.number_of_authors, 'absolute');

  // An edge-only metric left behind would show up in the visualization as a
  // selectable metric with no data.
  assert.deepStrictEqual(written.data.attributeTypes.edges, {});
  assert.strictEqual(written.data.attributeDescriptors.temporal_coupling, undefined);
  assert.ok(written.data.attributeDescriptors.number_of_authors, 'node descriptors must survive');

  const recomputed = crypto.createHash('md5').update(JSON.stringify(written.data)).digest('hex');
  assert.strictEqual(written.checksum, recomputed, 'checksum must be recomputed after rewriting');

  const untouched = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  assert.strictEqual(untouched.data.edges.length, 2, 'the input map must stay usable for a separate analysis');

  console.log('ok - strips edges, keeps node metrics');
});
