'use strict';

/**
 * Plain-Node smoke test (no test framework, no npm dependency). Runs the
 * actual CLI as a subprocess against a merged map that reproduces what
 * ccsh 1.143.0 produces when two inputs share a directed edge: the first
 * input's attributes survive, the second input's are gone.
 *
 * Run: node test/fix-merged-edges.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI_PATH = path.join(__dirname, '..', 'fix-merged-edges.js');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-merged-edges-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeProject(dir, name, project) {
  const filePath = path.join(dir, name);
  const compact = JSON.stringify(project);
  const checksum = crypto.createHash('md5').update(compact, 'utf8').digest('hex');
  fs.writeFileSync(filePath, JSON.stringify({ checksum, data: project }, null, 2), 'utf8');
  return filePath;
}

function project(edges, edgeTypes, descriptors) {
  return {
    projectName: 'fixture',
    apiVersion: '1.3',
    nodes: [{ name: 'root', type: 'Folder', attributes: {}, link: '', children: [] }],
    edges,
    attributeTypes: { nodes: {}, edges: edgeTypes || {} },
    attributeDescriptors: descriptors || {},
    blacklist: [],
  };
}

const A_TO_B = { fromNodeName: '/root/A.java', toNodeName: '/root/B.java' };
const B_TO_A = { fromNodeName: '/root/B.java', toNodeName: '/root/A.java' };

withTempDir((dir) => {
  const git = writeProject(
    dir,
    'git.cc.json',
    project(
      [
        Object.assign({ attributes: { temporal_coupling: 0.5 } }, A_TO_B),
        Object.assign({ attributes: { temporal_coupling: 0.375 } }, B_TO_A),
      ],
      { temporal_coupling: 'absolute' },
      { temporal_coupling: { title: 'Temporal Coupling' } }
    )
  );

  const clones = writeProject(
    dir,
    'clones.cc.json',
    project(
      [Object.assign({ attributes: { shared_clone_lines: 7, clone_coupling: 0.25 } }, A_TO_B)],
      { shared_clone_lines: 'absolute', clone_coupling: 'relative' },
      { shared_clone_lines: { title: 'Shared Clone Lines' } }
    )
  );

  // What ccsh 1.143.0 writes: A->B kept only the first input's attributes,
  // B->A never collided, and the attributeTypes were merged correctly.
  const merged = writeProject(
    dir,
    'complete.cc.json',
    project(
      [
        Object.assign({ attributes: { temporal_coupling: 0.5 } }, A_TO_B),
        Object.assign({ attributes: { temporal_coupling: 0.375 } }, B_TO_A),
      ],
      { temporal_coupling: 'absolute' },
      { temporal_coupling: { title: 'Temporal Coupling' } }
    )
  );

  execFileSync(process.execPath, [CLI_PATH, merged, git, clones], { stdio: 'inherit' });

  const written = JSON.parse(fs.readFileSync(merged, 'utf8'));
  const edges = written.data.edges;
  assert.strictEqual(edges.length, 2, 'fixer must not add or remove edges');

  const forward = edges.find((e) => e.fromNodeName === A_TO_B.fromNodeName);
  assert.strictEqual(forward.attributes.shared_clone_lines, 7, 'lost clone attribute must come back');
  assert.strictEqual(forward.attributes.clone_coupling, 0.25);
  assert.strictEqual(forward.attributes.temporal_coupling, 0.5, 'surviving attribute must be untouched');

  const backward = edges.find((e) => e.fromNodeName === B_TO_A.fromNodeName);
  assert.deepStrictEqual(
    backward.attributes,
    { temporal_coupling: 0.375 },
    'the opposite direction is a separate edge and carries no clone data'
  );

  // A restored attribute is unusable without its type and label.
  assert.strictEqual(written.data.attributeTypes.edges.shared_clone_lines, 'absolute');
  assert.strictEqual(written.data.attributeTypes.edges.clone_coupling, 'relative');
  assert.strictEqual(written.data.attributeDescriptors.shared_clone_lines.title, 'Shared Clone Lines');

  const recomputed = crypto.createHash('md5').update(JSON.stringify(written.data)).digest('hex');
  assert.strictEqual(written.checksum, recomputed, 'checksum must be recomputed after rewriting');

  console.log('ok - restores dropped edge attributes');
});

// An attribute the merged file already carries is never overwritten, so the
// fixer can only add information back, never change what ccsh decided.
withTempDir((dir) => {
  const first = writeProject(dir, 'first.cc.json', project([Object.assign({ attributes: { coupling: 1 } }, A_TO_B)]));
  const second = writeProject(dir, 'second.cc.json', project([Object.assign({ attributes: { coupling: 9 } }, A_TO_B)]));
  const merged = writeProject(dir, 'merged.cc.json', project([Object.assign({ attributes: { coupling: 1 } }, A_TO_B)]));
  const outputPath = path.join(dir, 'out.cc.json');

  execFileSync(process.execPath, [CLI_PATH, merged, first, second, '--output', outputPath], { stdio: 'inherit' });

  const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.strictEqual(written.data.edges[0].attributes.coupling, 1);
  assert.ok(fs.existsSync(merged), 'writing elsewhere must leave the input in place');

  console.log('ok - keeps existing attribute values');
});
