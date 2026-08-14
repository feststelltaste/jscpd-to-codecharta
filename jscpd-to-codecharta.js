#!/usr/bin/env node
'use strict';

/**
 * Convert a jscpd JSON report to a mergeable CodeCharta 1.3 cc.json file.
 *
 * The generated CodeCharta file contains clone metrics on file leaves and
 * one symmetric, aggregated edge for every pair of files that share clone
 * blocks.
 *
 * Why a separate conversion step and not a jscpd reporter plugin: jscpd v5
 * (the current, Rust-based release) has no plugin/extension mechanism at
 * all - `create_reporter()` in rust/crates/cpd-reporter matches reporter
 * names against a fixed, compiled-in list and silently returns nothing for
 * anything else. The only supported extension point is consuming one of
 * its 13 built-in reporters' output - `json` here - and post-processing it,
 * which is exactly what this script does. Verified against jscpd 5.0.15:
 * the `duplicates[].firstFile/secondFile.{name,start,end}` shape is
 * unchanged from earlier (TypeScript-based) jscpd versions.
 *
 * Zero runtime dependencies on purpose: only Node.js built-ins (fs, path,
 * crypto) are used, so this file can be dropped into any project as-is.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JSCPD_DOCUMENTATION = 'https://jscpd.dev/';

class ConversionError extends Error {}

function printHelp() {
  console.log(`Usage: jscpd-to-codecharta [report] [options]

Convert a jscpd JSON report to CodeCharta 1.3 cc.json.

Arguments:
  report                    jscpd JSON report (default: reports/jscpd/jscpd-report.json)

Options:
  -o, --output <path>       CodeCharta output file (default: reports/jscpd/codecharta-clones.cc.json)
  --project-root <path>     source repository root used to create /root/... CodeCharta
                            paths (default: current directory)
  --project-name <name>     CodeCharta project name (default: "<project-root name> clones")
  -h, --help                show this help
`);
}

function parseArgs(argv) {
  const args = {
    report: undefined,
    output: undefined,
    projectRoot: undefined,
    projectName: undefined,
  };
  const positional = [];

  const takeValue = (option, iRef) => {
    iRef.i += 1;
    const value = argv[iRef.i];
    if (value === undefined) {
      throw new ConversionError(`Option ${option} requires a value`);
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
    } else if (arg === '--project-root') {
      args.projectRoot = takeValue(arg, iRef);
    } else if (arg.startsWith('--project-root=')) {
      args.projectRoot = arg.slice('--project-root='.length);
    } else if (arg === '--project-name') {
      args.projectName = takeValue(arg, iRef);
    } else if (arg.startsWith('--project-name=')) {
      args.projectName = arg.slice('--project-name='.length);
    } else if (arg.startsWith('-')) {
      throw new ConversionError(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new ConversionError(`Unexpected extra argument: ${positional[1]}`);
  }

  args.report = positional[0] || 'reports/jscpd/jscpd-report.json';
  args.output = args.output || 'reports/jscpd/codecharta-clones.cc.json';
  args.projectRoot = args.projectRoot || process.cwd();
  return args;
}

function readReport(reportPath) {
  let raw;
  try {
    raw = fs.readFileSync(reportPath, 'utf8');
  } catch (error) {
    throw new ConversionError(`Cannot read ${reportPath}: ${error.message}`);
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new ConversionError(`Invalid JSON in ${reportPath}: ${error.message}`);
  }

  const duplicates = document && typeof document === 'object' ? document.duplicates : undefined;
  if (!Array.isArray(duplicates)) {
    throw new ConversionError(`${reportPath} does not contain a jscpd 'duplicates' array`);
  }

  duplicates.forEach((clone, index) => {
    if (typeof clone !== 'object' || clone === null || Array.isArray(clone)) {
      throw new ConversionError(`Clone ${index + 1} is not a JSON object`);
    }
  });

  return duplicates;
}

function parseLine(value, fieldName, cloneId) {
  const line = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(line)) {
    throw new ConversionError(`Clone ${cloneId} has an invalid ${fieldName}: ${JSON.stringify(value)}`);
  }
  if (line < 1) {
    throw new ConversionError(`Clone ${cloneId} has a non-positive ${fieldName}: ${line}`);
  }
  return line;
}

// A resolved source file. `codecharta_path` uniquely identifies the file
// (used as the map key everywhere below).
function parseSourceFile(value, projectRoot, cloneId, sourceFileCache) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConversionError(`Clone ${cloneId} has an empty source-file name`);
  }

  const cached = sourceFileCache.get(value);
  if (cached) return cached;

  let fileSystemPath = path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
  fileSystemPath = path.resolve(fileSystemPath);

  const relativePath = path.relative(projectRoot, fileSystemPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new ConversionError(
      `Clone ${cloneId} references a file outside project root ${projectRoot}: ${fileSystemPath}`
    );
  }

  let isFile = false;
  try {
    isFile = fs.statSync(fileSystemPath).isFile();
  } catch (error) {
    isFile = false;
  }
  if (!isFile) {
    throw new ConversionError(
      `Clone ${cloneId} source file does not exist: ${fileSystemPath}. ` +
        'Regenerate the jscpd report with "absolute": true, or set --project-root.'
    );
  }

  const relativeParts = relativePath.split(path.sep);
  const codecharta_path = '/root/' + relativeParts.join('/');
  const sourceFile = { fileSystemPath, codecharta_path, relativeParts };
  sourceFileCache.set(value, sourceFile);
  return sourceFile;
}

function parseLocation(value, projectRoot, cloneId, sourceFileCache) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConversionError(`Clone ${cloneId} has a missing file location`);
  }

  const sourceFile = parseSourceFile(value.name, projectRoot, cloneId, sourceFileCache);
  const start = parseLine(value.start, 'start line', cloneId);
  const end = parseLine(value.end, 'end line', cloneId);
  if (end < start) {
    throw new ConversionError(`Clone ${cloneId} ends before it starts: ${start}-${end}`);
  }
  return { sourceFile, interval: [start, end] };
}

function encodeInterval(start, end) {
  return `${start}:${end}`;
}

function decodeInterval(encoded) {
  return encoded.split(':').map(Number);
}

function collectCloneData(duplicates, projectRoot) {
  // files:  codecharta_path -> { sourceFile, intervals: Set<"start:end">, clonePairIds: Set<number> }
  // edges:  "fromPath toPath" -> { fromFile, toFile, fromIntervals, toIntervals, clonePairIds }
  const files = new Map();
  const edges = new Map();
  const sourceFileCache = new Map();

  duplicates.forEach((clone, index) => {
    const cloneId = index + 1;
    const first = parseLocation(clone.firstFile, projectRoot, cloneId, sourceFileCache);
    const second = parseLocation(clone.secondFile, projectRoot, cloneId, sourceFileCache);

    for (const { sourceFile, interval } of [first, second]) {
      let fileData = files.get(sourceFile.codecharta_path);
      if (!fileData) {
        fileData = { sourceFile, intervals: new Set(), clonePairIds: new Set() };
        files.set(sourceFile.codecharta_path, fileData);
      }
      fileData.intervals.add(encodeInterval(interval[0], interval[1]));
      fileData.clonePairIds.add(cloneId);
    }

    const [from, to] =
      first.sourceFile.codecharta_path <= second.sourceFile.codecharta_path
        ? [first, second]
        : [second, first];

    const edgeKey = `${from.sourceFile.codecharta_path} ${to.sourceFile.codecharta_path}`;
    let edgeData = edges.get(edgeKey);
    if (!edgeData) {
      edgeData = {
        fromFile: from.sourceFile,
        toFile: to.sourceFile,
        fromIntervals: new Set(),
        toIntervals: new Set(),
        clonePairIds: new Set(),
      };
      edges.set(edgeKey, edgeData);
    }
    edgeData.fromIntervals.add(encodeInterval(from.interval[0], from.interval[1]));
    edgeData.toIntervals.add(encodeInterval(to.interval[0], to.interval[1]));
    edgeData.clonePairIds.add(cloneId);
  });

  return { files, edges };
}

function countLines(filePath) {
  // Counts a final line that does not end in a newline, same as jscpd itself.
  const content = fs.readFileSync(filePath);
  if (content.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === 0x0a) count += 1;
  }
  if (content[content.length - 1] !== 0x0a) count += 1;
  return count;
}

function mergeIntervals(encodedIntervals, totalLines) {
  const clamped = [...encodedIntervals]
    .map(decodeInterval)
    .map(([start, end]) => [Math.max(1, start), Math.min(totalLines, end)])
    .filter(([start, end]) => start <= totalLines && end >= 1)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  if (clamped.length === 0) return [];

  const merged = [clamped[0]];
  for (const [start, end] of clamped.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

function coveredLineCount(encodedIntervals, totalLines) {
  return mergeIntervals(encodedIntervals, totalLines).reduce(
    (sum, [start, end]) => sum + (end - start + 1),
    0
  );
}

function buildFileAttributes(files) {
  const attributes = new Map(); // codecharta_path -> attributes object
  const lineCounts = new Map(); // codecharta_path -> total lines

  for (const [cckey, fileData] of files) {
    const totalLines = countLines(fileData.sourceFile.fileSystemPath);
    const duplicatedLines = coveredLineCount(fileData.intervals, totalLines);
    const cloneCoverage = totalLines ? (duplicatedLines / totalLines) * 100 : 0.0;
    lineCounts.set(cckey, totalLines);
    attributes.set(cckey, {
      clone_coverage: Math.round(cloneCoverage * 1e6) / 1e6,
      duplicated_lines: duplicatedLines,
      clone_instance_count: fileData.intervals.size,
      clone_pair_count: fileData.clonePairIds.size,
    });
  }

  return { attributes, lineCounts };
}

function insertFileLeaf(root, relativeParts, attributes) {
  if (relativeParts.length === 0) {
    throw new ConversionError('Cannot create a CodeCharta leaf without a path');
  }

  let parent = root;
  for (const folderName of relativeParts.slice(0, -1)) {
    let folder = parent.children.find((child) => child.type === 'Folder' && child.name === folderName);
    if (!folder) {
      folder = { name: folderName, type: 'Folder', attributes: {}, link: '', children: [] };
      parent.children.push(folder);
    }
    parent = folder;
  }

  parent.children.push({
    name: relativeParts[relativeParts.length - 1],
    type: 'File',
    attributes,
    link: '',
    children: [],
  });
}

function sortTree(node) {
  node.children.sort((a, b) => {
    const aIsFile = a.type === 'File' ? 1 : 0;
    const bIsFile = b.type === 'File' ? 1 : 0;
    if (aIsFile !== bIsFile) return aIsFile - bIsFile;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  node.children.forEach(sortTree);
}

function buildNodes(files, fileAttributes) {
  const root = { name: 'root', type: 'Folder', attributes: {}, link: '', children: [] };
  const sortedKeys = [...files.keys()].sort();
  for (const cckey of sortedKeys) {
    const sourceFile = files.get(cckey).sourceFile;
    insertFileLeaf(root, sourceFile.relativeParts, fileAttributes.get(cckey));
  }
  sortTree(root);
  return [root];
}

function buildEdges(edges, lineCounts) {
  const result = [];
  const sortedKeys = [...edges.keys()].sort();

  for (const key of sortedKeys) {
    const edgeData = edges.get(key);
    const fromTotal = lineCounts.get(edgeData.fromFile.codecharta_path);
    const toTotal = lineCounts.get(edgeData.toFile.codecharta_path);
    const fromCloneLines = coveredLineCount(edgeData.fromIntervals, fromTotal);
    const toCloneLines = coveredLineCount(edgeData.toIntervals, toTotal);
    const sharedCloneLines = Math.min(fromCloneLines, toCloneLines);
    const smallerFileLines = Math.min(fromTotal, toTotal);
    const cloneCoupling = smallerFileLines ? Math.min(1.0, sharedCloneLines / smallerFileLines) : 0.0;

    result.push({
      fromNodeName: edgeData.fromFile.codecharta_path,
      toNodeName: edgeData.toFile.codecharta_path,
      attributes: {
        clone_coupling: Math.round(cloneCoupling * 1e6) / 1e6,
        shared_clone_lines: sharedCloneLines,
        shared_clone_pair_count: edgeData.clonePairIds.size,
      },
    });
  }

  return result;
}

function descriptor(title, description) {
  return {
    title,
    description,
    hintLowValue: '',
    hintHighValue: '',
    link: JSCPD_DOCUMENTATION,
    direction: -1,
  };
}

function buildCodechartaData(projectName, nodes, edges) {
  return {
    projectName,
    apiVersion: '1.3',
    nodes,
    edges,
    attributeTypes: {
      nodes: {
        clone_coverage: 'relative',
        duplicated_lines: 'absolute',
        clone_instance_count: 'absolute',
        clone_pair_count: 'absolute',
      },
      edges: {
        clone_coupling: 'relative',
        shared_clone_lines: 'absolute',
        shared_clone_pair_count: 'absolute',
      },
    },
    attributeDescriptors: {
      clone_coverage: descriptor(
        'Clone Coverage',
        'Percentage of physical file lines covered by at least one jscpd clone; overlapping ranges count once'
      ),
      duplicated_lines: descriptor(
        'Duplicated Lines',
        'Unique physical file lines covered by at least one jscpd clone'
      ),
      clone_instance_count: descriptor(
        'Clone Instance Count',
        'Number of unique cloned line ranges in the file'
      ),
      clone_pair_count: descriptor('Clone Pair Count', 'Number of jscpd clone pairs involving the file'),
      clone_coupling: descriptor(
        'Clone Coupling',
        'Shared cloned lines divided by the line count of the smaller file (0 to 1)'
      ),
      shared_clone_lines: descriptor(
        'Shared Clone Lines',
        'Unique duplicated lines shared by the connected files'
      ),
      shared_clone_pair_count: descriptor(
        'Shared Clone Pair Count',
        'Number of jscpd clone pairs connecting the two files'
      ),
    },
    blacklist: [],
  };
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
  const reportPath = path.resolve(args.report);
  const outputPath = path.resolve(args.output);
  const projectRoot = path.resolve(args.projectRoot);
  const projectName = args.projectName || `${path.basename(projectRoot)} clones`;

  try {
    const duplicates = readReport(reportPath);
    const { files, edges: edgeData } = collectCloneData(duplicates, projectRoot);
    const { attributes: fileAttributes, lineCounts } = buildFileAttributes(files);
    const nodes = buildNodes(files, fileAttributes);
    const edges = buildEdges(edgeData, lineCounts);
    const data = buildCodechartaData(projectName, nodes, edges);
    writeOutput(outputPath, wrapWithChecksum(data));
    console.log(
      `Wrote ${fileAttributes.size} clone-annotated files and ${edges.length} clone-coupling edges to ${outputPath}`
    );
    return 0;
  } catch (error) {
    if (error instanceof ConversionError || error.code === 'ENOENT' || error.code === 'EACCES') {
      console.error(`error: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  ConversionError,
  parseArgs,
  readReport,
  collectCloneData,
  buildFileAttributes,
  buildNodes,
  buildEdges,
  buildCodechartaData,
  wrapWithChecksum,
};
