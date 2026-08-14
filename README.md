# jscpd-to-codecharta

Convert a [jscpd](https://jscpd.dev/) JSON clone-detection report into a
mergeable [CodeCharta](https://codecharta.com/) 1.3 `cc.json` file.

Each duplicated file becomes a CodeCharta leaf annotated with clone metrics;
each pair of files that share a clone becomes one aggregated, symmetric edge
("clone coupling") between them. Merge the result with a source-metrics map
(e.g. `ccsh unifiedparser`) or a git-history map (`ccsh gitlogparser`) to see
duplication next to size, complexity, and churn in the same 3D city.

Zero runtime dependencies - only Node.js built-ins (`fs`, `path`, `crypto`).

## Why a separate conversion step, not a jscpd plugin

jscpd v5 (the current, Rust-based release) has no reporter plugin
mechanism at all: `create_reporter()` in the Rust source
(`rust/crates/cpd-reporter`) matches reporter names against a fixed,
compiled-in list (`console`, `json`, `xml`, `csv`, `html`, `markdown`,
`badge`, `sarif`, `ai`, `xcode`, `threshold`, `silent`, `console-full`) and
silently returns nothing for anything else - confirmed by running it. The
older TypeScript-based jscpd (v4.x) *did* support external reporter packages
(`@jscpd/<name>-reporter` / `jscpd-<name>-reporter`), but that mechanism no
longer exists in what's published as `jscpd` on npm today.

So the only viable integration point is consuming one of the built-in
reporters' output - `json` - and post-processing it, which is exactly what
this script does. Verified against jscpd 5.0.15: the
`duplicates[].firstFile/secondFile.{name,start,end}` shape is unchanged from
earlier jscpd versions.

## Requirements

- Node.js >= 16
- `jscpd` (any version whose `json` reporter produces the shape above -
  tested against 5.0.15)

## Install

```bash
npm install --save-dev jscpd
# then just drop jscpd-to-codecharta.js into your project (see below),
# or clone/copy this repo.
```

This tool isn't published to npm - it's a single, dependency-free script.
Copy `jscpd-to-codecharta.js` into your project (e.g. `scripts/`), or add
this repo as a subtree/submodule.

## Quick start

```bash
# 1. Run jscpd, keep absolute paths, ask for the json reporter
npx jscpd --config .jscpd.json --reporters json --output reports/jscpd src

# 2. Convert the report - run from the same directory as jscpd (see
#    "Merging maps" below for why that matters)
node jscpd-to-codecharta.js reports/jscpd/jscpd-report.json \
  --output reports/jscpd/codecharta-clones.cc.json \
  --project-root .
```

### Full pipeline: clones + source metrics in one map

All commands below must run from the same directory (your repository root) -
see "Merging maps" for why. `ccsh` comes from `npm install -g
codecharta-analysis`.

```bash
JSCPD_CONFIG=.jscpd.json
OUTPUT_DIR=reports/jscpd
mkdir -p "$OUTPUT_DIR"

# 1. Detect clones
npx jscpd --config "$JSCPD_CONFIG" --reporters json --output "$OUTPUT_DIR" src

# 2. Convert to CodeCharta
node jscpd-to-codecharta.js "$OUTPUT_DIR/jscpd-report.json" \
  --output "$OUTPUT_DIR/codecharta-clones.cc.json" --project-root .

# 3. Extract source metrics (size, complexity, ...)
ccsh unifiedparser --not-compressed --output-file="$OUTPUT_DIR/source.cc.json" .

# 4. Merge both maps into one
ccsh merge --not-compressed --output-file="$OUTPUT_DIR/complete.cc.json" \
  "$OUTPUT_DIR/source.cc.json" "$OUTPUT_DIR/codecharta-clones.cc.json"

# 5. Validate
ccsh check "$OUTPUT_DIR/complete.cc.json"
```

```
Usage: jscpd-to-codecharta [report] [options]

Arguments:
  report                    jscpd JSON report (default: reports/jscpd/jscpd-report.json)

Options:
  -o, --output <path>       CodeCharta output file (default: reports/jscpd/codecharta-clones.cc.json)
  --project-root <path>     source repository root used to create /root/... CodeCharta
                            paths (default: current directory)
  --project-name <name>     CodeCharta project name (default: "<project-root name> clones")
  -h, --help                show this help
```

See `examples/` for ready-to-use configs:

- `examples/minimal.jscpd.json` - smallest config to get started
- `examples/openclinica.jscpd.json` - a real-world config (Java/JS/JSP/XML,
  weak mode, `equals`/`hashCode`/import-statement boilerplate excluded)

## jscpd usage hints

- `mode: "weak"` ignores identifier/literal differences (recommended for
  spotting copy-paste-and-rename duplication); `"strict"` requires an exact
  token match.
- `minTokens`/`minLines` are your noise floor - too low and you drown in
  trivial matches (getters/setters); too high and small-but-real duplication
  hides.
- `ignorePattern` (regex, matched against file content, skips overlapping
  tokens) is the escape hatch for structurally-required boilerplate that
  isn't really "duplication". For Java, two patterns are worth having by
  default (both in `examples/openclinica.jscpd.json`):
  - generated `equals`/`hashCode` method bodies
  - `import` statements - large, near-identical import blocks across files
    otherwise create clone matches that say nothing about actual logic
    duplication:
    ```json
    "(?m)^\\s*import[\\t ]+(?:static[\\t ]+)?[A-Za-z_$][\\w.$]*(?:\\.\\*)?;[\\t ]*$"
    ```
- Always run jscpd with `"absolute": true` (or `--absolute`). This reporter
  resolves relative paths against `--project-root` too, but absolute paths
  remove any ambiguity about which directory jscpd was invoked from.

## CodeCharta usage hints

Once you have a `.cc.json`:

- **Visualize directly**: upload it at the [CodeCharta web
  visualization](https://codecharta.com/) - no install needed.
- **Local viewer**: `npm install -g codecharta-analysis`, then
  `ccsh gui reports/jscpd/codecharta-clones.cc.json`.
- **Validate** a map: `ccsh check reports/jscpd/codecharta-clones.cc.json`.

### Merging maps - making sure the paths line up

`ccsh merge` matches nodes purely by their **full path** (root name +
folder chain + file name). For a clone map to merge cleanly into a
source-metrics or git-history map (rather than creating a parallel,
un-merged tree), every tool involved must resolve relative paths against
the **same root**:

| Tool                        | Path reference point                              |
|------------------------------|----------------------------------------------------|
| `ccsh unifiedparser <path>`  | the `<path>` argument (typically `.` from repo root)|
| `ccsh gitlogparser`          | the git repository root (`git log` paths always are)|
| `jscpd-to-codecharta.js`     | `--project-root` (default: current directory)       |

Practical rule: **run all three from the same directory** (your repository
root) and pass `--project-root .` explicitly. Verified end-to-end: running
`ccsh unifiedparser .`, this converter with `--project-root .`, and `ccsh
merge` on the same project reports `N nodes were processed, 0 were added
and N were merged` - i.e. every file's clone attributes land on the exact
same node as its source metrics, and clone-coupling edges are preserved.

```bash
ccsh merge --not-compressed --output-file=complete.cc.json \
  reports/jscpd/source.cc.json \
  reports/jscpd/codecharta-clones.cc.json
```

### Metrics this tool produces

Node (file) attributes:

| Attribute              | Meaning                                                                          |
|-------------------------|-----------------------------------------------------------------------------------|
| `clone_coverage`        | % of the file's physical lines covered by at least one clone (overlaps counted once) |
| `duplicated_lines`      | Unique physical lines covered by at least one clone                              |
| `clone_instance_count`  | Number of unique cloned line ranges in the file                                  |
| `clone_pair_count`      | Number of jscpd clone pairs involving the file                                   |

Edge (clone coupling between two files) attributes:

| Attribute                 | Meaning                                                                     |
|-----------------------------|--------------------------------------------------------------------------|
| `clone_coupling`            | Shared cloned lines / line count of the smaller of the two files (0-1)   |
| `shared_clone_lines`        | Unique duplicated lines shared by the two files                          |
| `shared_clone_pair_count`   | Number of jscpd clone pairs connecting the two files                     |

In CodeCharta, map `clone_coverage` or `duplicated_lines` to a color metric
to spot duplication hot spots, and enable edges to see which files are
copy-paste-coupled to each other.

## Development

```bash
npm test   # plain-Node smoke test, no framework, no install needed
```

## License

MIT, see [LICENSE](LICENSE).
