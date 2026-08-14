#!/usr/bin/env node
'use strict';

/**
 * Remove all edges from a cc.json, keeping every node attribute.
 *
 * Written for one specific need: a gitlogparser map carries two very
 * different things at once - valuable per-file history metrics on the nodes
 * (age, churn, number of authors) and temporal-coupling edges. Merging the
 * whole map into a clone map mixes two edge types that the visualization
 * cannot tell apart once a building is selected, because it draws every edge
 * of that building regardless of the selected edge metric. Stripping the
 * edges keeps the history metrics and leaves the clone couplings as the only
 * edges in the map.
 *
 * The input file is left alone unless --output points back at it.
 *
 * Zero runtime dependencies on purpose: only Node.js built-ins (fs, path,
 * crypto) are used, so this file can be dropped into any project as-is.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class StripError extends Error {}

function printHelp() {
  console.log(`Usage: strip-edges <input> [options]

Remove all edges from a cc.json while keeping every node attribute.

Arguments:
  input                     cc.json to read

Options:
  -o, --output <path>       write result here (default: overwrite <input>)
  -h, --help                show this help
`);
}

function parseArgs(argv) {
  const args = { input: undefined, output: undefined };
  const positional = [];

  const takeValue = (option, iRef) => {
    iRef.i += 1;
    const value = argv[iRef.i];
    if (value === undefined) {
      throw new StripError(`Option ${option} requires a value`);
    }
    return value;
  };

  const iRef = { i: 0 };
  for (; iRef.i < argv.length; iRef.i += 1) {
    const arg = argv[iRef.i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '-o' || arg === '--output') {
      args.output = takeValue(arg, iRef);
    } else if (arg.startsWith('--output=')) {
      args.output = arg.slice('--output='.length);
    } else if (arg.startsWith('-')) {
      throw new StripError(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new StripError('Missing input cc.json - see --help');
  }
  if (positional.length > 1) {
    throw new StripError(`Unexpected extra argument: ${positional[1]}`);
  }

  args.input = positional[0];
  args.output = args.output || args.input;
  return args;
}

// Accepts both the {checksum, data} wrapper ccsh writes and a bare project.
function readProject(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new StripError(`Cannot read ${filePath}: ${error.message}`);
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new StripError(`Invalid JSON in ${filePath}: ${error.message}`);
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new StripError(`${filePath} does not contain a cc.json object`);
  }

  const data = document.data !== undefined ? document.data : document;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new StripError(`${filePath} does not contain a cc.json project`);
  }
  return data;
}

// A descriptor for an attribute that no longer occurs anywhere would leave the
// visualization offering a metric with no data behind it, so descriptors that
// only ever belonged to edges go too. Names that are also node attributes stay.
function stripEdges(data) {
  const removedEdges = Array.isArray(data.edges) ? data.edges.length : 0;
  data.edges = [];

  const edgeTypes = (data.attributeTypes && data.attributeTypes.edges) || {};
  const edgeOnlyNames = Object.keys(edgeTypes);
  if (data.attributeTypes) data.attributeTypes.edges = {};

  const nodeTypes = (data.attributeTypes && data.attributeTypes.nodes) || {};
  if (data.attributeDescriptors) {
    for (const name of edgeOnlyNames) {
      if (nodeTypes[name] === undefined) delete data.attributeDescriptors[name];
    }
  }

  return { removedEdges, removedNames: edgeOnlyNames };
}

function wrapWithChecksum(data) {
  const compact = JSON.stringify(data);
  const checksum = crypto.createHash('md5').update(compact, 'utf8').digest('hex');
  return { checksum, data };
}

function writeOutput(outputPath, document) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(document, null, 2) + '\n', 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);

  try {
    const data = readProject(inputPath);
    const { removedEdges, removedNames } = stripEdges(data);
    writeOutput(outputPath, wrapWithChecksum(data));
    const names = removedNames.length > 0 ? ` (${removedNames.join(', ')})` : '';
    console.log(`Removed ${removedEdges} edges${names} and kept all node attributes in ${outputPath}`);
    return 0;
  } catch (error) {
    if (error instanceof StripError || error.code === 'ENOENT' || error.code === 'EACCES') {
      console.error(`error: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { StripError, parseArgs, readProject, stripEdges, wrapWithChecksum };
