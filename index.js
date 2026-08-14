'use strict';

/**
 * jscpd reporter that writes clone metrics directly as a CodeCharta 1.3
 * cc.json file - no intermediate jscpd-report.json round-trip.
 *
 * jscpd resolves a reporter name that isn't one of its built-ins by trying
 * `require('@jscpd/<name>-reporter').default` and then
 * `require('jscpd-<name>-reporter').default` (see apps/jscpd/src/init/reporters.ts
 * in the jscpd repo). That's why this package must be installed under the
 * exact name `jscpd-codecharta-reporter` for `"reporters": ["codecharta"]`
 * in .jscpd.json to resolve it automatically.
 *
 * jscpd calls `new ReporterClass(options).report(clones, statistic)`, where
 * `options` is the fully resolved IOptions object (see @jscpd/core) and
 * `clones` is an array of IClone:
 *   {
 *     format: string,
 *     duplicationA: { sourceId: string, start: {line}, end: {line}, ... },
 *     duplicationB: { sourceId: string, start: {line}, end: {line}, ... },
 *   }
 * This differs from the shape of jscpd's own JSON report (`firstFile`/
 * `secondFile` with plain `name`/`start`/`end`) - that shape is produced by
 * jscpd's built-in JsonReporter, not by jscpd itself, so we adapt from
 * IClone directly here (see `toClonePair` below).
 *
 * Zero runtime dependencies: only Node.js built-ins (fs, path, crypto).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JSCPD_DOCUMENTATION = 'https://jscpd.dev/';
const DEFAULT_OUTPUT_FILENAME = 'codecharta-clones.cc.json';

class ConversionError extends Error {}

// ---------------------------------------------------------------------------
// jscpd IClone[] -> normalized clone pairs
// ---------------------------------------------------------------------------

function toClonePair(clone, cloneIndex) {
  const a = clone && clone.duplicationA;
  const b = clone && clone.duplicationB;
  if (!a || !b) {
    throw new ConversionError(`Clone ${cloneIndex + 1} is missing duplicationA/duplicationB`);
  }
  return {
    first: { name: a.sourceId, start: a.start && a.start.line, end: a.end && a.end.line },
    second: { name: b.sourceId, start: b.start && b.start.line, end: b.end && b.end.line },
  };
}

// ---------------------------------------------------------------------------
// Conversion core (clone pairs -> CodeCharta 1.3 document)
// ---------------------------------------------------------------------------

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

// A resolved source file. `codecharta_path` uniquely identifies the file and
// is used as the map key everywhere below.
function resolveSourceFile(value, projectRoot, cloneId, sourceFileCache) {
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
        'Set reportersOptions.codecharta.projectRoot in .jscpd.json if jscpd runs from a different directory.'
    );
  }

  const relativeParts = relativePath.split(path.sep);
  const codecharta_path = '/root/' + relativeParts.join('/');
  const sourceFile = { fileSystemPath, codecharta_path, relativeParts };
  sourceFileCache.set(value, sourceFile);
  return sourceFile;
}

function resolveSide(side, projectRoot, cloneId, sourceFileCache) {
  if (typeof side !== 'object' || side === null) {
    throw new ConversionError(`Clone ${cloneId} has a missing file location`);
  }
  const sourceFile = resolveSourceFile(side.name, projectRoot, cloneId, sourceFileCache);
  const start = parseLine(side.start, 'start line', cloneId);
  const end = parseLine(side.end, 'end line', cloneId);
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

function collectCloneData(clonePairs, projectRoot) {
  // files:  codecharta_path -> { sourceFile, intervals: Set<"start:end">, clonePairIds: Set<number> }
  // edges:  "fromPath toPath" -> { fromFile, toFile, fromIntervals, toIntervals, clonePairIds }
  const files = new Map();
  const edges = new Map();
  const sourceFileCache = new Map();

  let cloneId = 0;
  for (const clonePair of clonePairs) {
    cloneId += 1;
    const first = resolveSide(clonePair.first, projectRoot, cloneId, sourceFileCache);
    const second = resolveSide(clonePair.second, projectRoot, cloneId, sourceFileCache);

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
  }

  return { files, edges };
}

function countLines(filePath) {
  // Counts a final line that does not end in a newline.
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

function convert(clonePairs, { projectRoot, projectName }) {
  const { files, edges: edgeData } = collectCloneData(clonePairs, projectRoot);
  const { attributes: fileAttributes, lineCounts } = buildFileAttributes(files);
  const nodes = buildNodes(files, fileAttributes);
  const edges = buildEdges(edgeData, lineCounts);
  const data = buildCodechartaData(projectName, nodes, edges);
  return {
    document: wrapWithChecksum(data),
    fileCount: fileAttributes.size,
    edgeCount: edges.length,
  };
}

// ---------------------------------------------------------------------------
// IReporter
// ---------------------------------------------------------------------------

class CodechartaReporter {
  constructor(options) {
    this.options = options || {};
  }

  // Called by jscpd as: new CodechartaReporter(options).report(clones, statistic)
  report(clones) {
    const reporterOptions = (this.options.reportersOptions && this.options.reportersOptions.codecharta) || {};
    const projectRoot = path.resolve(reporterOptions.projectRoot || process.cwd());
    const projectName = reporterOptions.projectName || `${path.basename(projectRoot)} clones`;
    const outputPath = path.resolve(
      reporterOptions.output || path.join(this.options.output || '.', DEFAULT_OUTPUT_FILENAME)
    );

    try {
      const clonePairs = (clones || []).map(toClonePair);
      const { document, fileCount, edgeCount } = convert(clonePairs, { projectRoot, projectName });
      writeOutput(outputPath, document);
      console.log(
        `[jscpd-codecharta-reporter] wrote ${fileCount} clone-annotated files and ${edgeCount} clone-coupling edges to ${outputPath}`
      );
    } catch (error) {
      if (error instanceof ConversionError) {
        console.error(`[jscpd-codecharta-reporter] error: ${error.message}`);
        return;
      }
      throw error;
    }
  }
}

module.exports = CodechartaReporter;
module.exports.default = CodechartaReporter;
module.exports.CodechartaReporter = CodechartaReporter;
module.exports.ConversionError = ConversionError;
// Exported for the test suite; not part of the public API.
module.exports._internals = { toClonePair, convert, collectCloneData };
