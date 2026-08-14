# jscpd to CodeCharta Converter

Convert a [jscpd](https://jscpd.dev/) JSON clone-detection report into a
mergeable [CodeCharta](https://codecharta.com/) 1.3 `cc.json` file.

## Core idea
Each duplicated file becomes a CodeCharta leaf annotated with clone metrics;
each pair of files that share a clone becomes one aggregated, symmetric edge
("clone coupling") between them. Merge the result with a source-metrics map
(e.g. `ccsh unifiedparser`) or a git-history map (`ccsh gitlogparser`) to see
duplication next to size, complexity, and churn in the same 3D city.

Zero runtime dependencies - only Node.js built-ins (`fs`, `path`, `crypto`).

## Requirements

- Node.js >= 16
- `jscpd` (any version whose `json` reporter produces the shape above -
  tested against 5.0.15)

## Install

```bash
npm install --save-dev jscpd
# then just drop jscpd-to-cc.js into your project (see below),
# or clone/copy this repo.
```

This tool isn't published to npm - it's a single, dependency-free script.
Either copy `jscpd-to-cc.js` into your project (e.g. `scripts/`) and
run it with `node`, or install it as a `jscpd-to-cc` command:

```bash
# directly from GitHub, as a devDependency
npm install --save-dev github:feststelltaste/jscpd-to-codecharta

# or globally, from the same GitHub URL
npm install -g github:feststelltaste/jscpd-to-codecharta

# or from a local clone, from this repo's directory
npm link

# or as a devDependency in another project, from a local clone's directory
npm install --save-dev /path/to/jscpd-to-codecharta
```

## Quick start

```bash
# 1. Run jscpd, keep absolute paths, ask for the json reporter (html is
#    optional - adds a human-browsable reports/jscpd-report.html)
jscpd --config .jscpd.json --reporters json,html --output reports

# 2. Convert the report - run from the same directory as jscpd (see
#    "Merging maps" below for why that matters)
jscpd-to-cc reports/jscpd-report.json \
  --output reports/codecharta-clones.cc.json \
  --project-root .
```

(`jscpd-to-cc` requires the CLI install from above - `npm link` or
`npm install -g/--save-dev`. Without that, run `node jscpd-to-cc.js ...`
against a copy of the script instead.)

### One-shot: the whole pipeline as a script

Copy `jscpd-to-cc-pipeline.sh` into the root of the repository you want to
analyse and run it there - it performs every step below in order, skipping
the git metrics if the directory is not a git repository:

```bash
cp /path/to/jscpd-to-codecharta/jscpd-to-cc-pipeline.sh .
./jscpd-to-cc-pipeline.sh
```

It writes `reports/complete.cc.json`.

```
Usage: jscpd-to-cc-pipeline.sh [options]

Options:
  -o, --output-dir <path>   where to write all reports (default: reports)
  -n, --project-name <name> CodeCharta project name (default: current dir name)
  -g, --git <mode>          how much git history goes into the map:
                              metrics  per-file history metrics (age, churn,
                                       number of authors), but no temporal-
                                       coupling edges (default)
                              all      also keep the temporal-coupling edges
                              none     skip git entirely - fastest, and the
                                       only option outside a git repository
  -h, --help                show this help
```

If you did not install this package globally, point `JSCPD_TO_CC_DIR` at your
checkout so the script finds `jscpd-to-cc.js`, `fix-merged-edges.js` and
`strip-edges.js`:

```bash
JSCPD_TO_CC_DIR=/path/to/jscpd-to-codecharta ./jscpd-to-cc-pipeline.sh
```

The script and the command list below are kept in sync by
`test/pipeline-sync.test.js`.

#### Why `--git metrics` is the default

**Short version: git history metrics are in the map by default. Only the
temporal-coupling *edges* are left out, because mixing two kinds of edges makes
both unreadable.**

A merged map can contain two completely different kinds of coupling:

| Edge metric | From | Means |
|---|---|---|
| `clone_coupling`, `shared_clone_lines` | this converter | these two files contain the same code |
| `temporal_coupling` | `ccsh gitlogparser` | these two files are usually changed together |

They answer different questions, and the visualization cannot keep them apart.
When you select a building, `codeMap.arrow.service.ts` draws **every** edge
attached to it, matching purely on node path:

```typescript
if (originNode && targetNode && originNode.path === node.path) {
    this.addArrow(targetNode, originNode, true)
}
```

`edge.attributes[edgeMetric]` is never consulted. The selected edge metric only
decides *whether* edges are drawn at all (`edgeMetric !== "None"`), never
*which* ones. So with both metrics in one map:

- Selecting `shared_clone_lines` and clicking a file shows its temporal-coupling
  edges too - even for a file that contains no clone at all.
- You cannot tell from the picture which arrow means what.

That was observed on a real map: `global_functions_javascript.js` has three
`temporal_coupling` edges, no clone data whatsoever, and still drew three arrows
under the `shared_clone_lines` edge metric.

`--git metrics` therefore runs `strip-edges` on the gitlogparser map before
merging. That removes its edges and keeps every node attribute, so the map still
carries `number_of_authors`, `number_of_commits`, `age_in_weeks`,
`weeks_with_commits` and the rest of the history metrics - only the arrows are
gone. Every arrow you then see is a clone coupling.

The untouched `reports/git.cc.json` is still written. To look at temporal
coupling, open that file as its own map, or run the pipeline again with
`--git all`.

A second reason for the default: with only one map carrying edges, the
`ccsh merge` bug described under "Merging maps" cannot bite, because nothing
collides. With `--git all` the pipeline runs `fix-merged-edges` to repair it.

`--git none` skips the history extraction altogether. Scanning the git log is
the slowest step on a large repository - on OpenClinica it is a 10 MB log - so
it is worth reaching for while iterating on the clone configuration. The cost is
that `age_in_weeks`, `number_of_authors`, `number_of_commits` and the other
history metrics are then missing from the map.

#### Notes for tuning the scope

The script analyses everything, which is the right default for a first look but
usually not what you want on a large repository:

- **jscpd** follows your `.jscpd.json` (patterns, ignores) but is not given
  explicit paths, so it scans the whole tree. If you only care about, say,
  `core/src/main`, add that to the config's `pattern`.
- **`ccsh unifiedparser`** is run without `--file-extensions`, so it parses
  every language it supports.
- **`git log`** is run without a pathspec, so *every tracked file* gets history
  metrics. On OpenClinica that pulled 5385 files into the map, of which 2539
  were `.gif` - files with git history but no source metrics, drowning out the
  1362 files that actually carry code metrics.

If that is too broad, restrict the `git log` line and add `--file-extensions` to
the `unifiedparser` line in your copy of the script.

### Full pipeline: clones + source metrics in one map

All commands below must run from the same directory (your repository root) -
see "Merging maps" for why. `ccsh` comes from `npm install -g
codecharta-analysis`.

```bash
mkdir -p reports

# 1. Detect clones
jscpd --config .jscpd.json --reporters json,html --output reports

# 2. Convert to CodeCharta
jscpd-to-cc reports/jscpd-report.json \
  --output reports/codecharta-clones.cc.json --project-root .

# 3. Extract source metrics (size, complexity, ...)
ccsh unifiedparser --not-compressed --output-file=reports/source.cc.json .

# 3b. Optional: extract git history metrics (age, churn, number of authors, ...)
git log --numstat --raw --topo-order --reverse -m > reports/git.log
git ls-files > reports/git-files.txt
ccsh gitlogparser log-scan --git-log=reports/git.log --repo-files=reports/git-files.txt \
  --not-compressed --output-file=reports/git.cc.json

# 3c. Keep the git history metrics, drop the temporal-coupling edges, so that
#     clone coupling is the only kind of edge in the map (see "Why --git
#     metrics is the default"). Skip this to keep both kinds.
strip-edges reports/git.cc.json --output reports/git-metrics-only.cc.json

# 4. Merge all maps into one (drop the git map here if you skipped 3b)
ccsh merge --not-compressed --output-file=reports/complete.cc.json \
  reports/source.cc.json reports/git-metrics-only.cc.json \
  reports/codecharta-clones.cc.json

# 4b. Only needed if more than one input map carries edges, i.e. if you skipped
#     3c: repair the edge attributes "ccsh merge" drops (see "Merging maps")
fix-merged-edges reports/complete.cc.json \
  reports/git.cc.json reports/codecharta-clones.cc.json

# 5. Validate
ccsh check reports/complete.cc.json
```

### CLI reference

```
Usage: jscpd-to-cc [report] [options]

Arguments:
  report                    jscpd JSON report (default: reports/jscpd-report.json)

Options:
  -o, --output <path>       CodeCharta output file (default: reports/codecharta-clones.cc.json)
  --project-root <path>     source repository root used to create /root/... CodeCharta
                            paths (default: current directory)
  --project-name <name>     CodeCharta project name (default: "<project-root name> clones")
  -h, --help                show this help
```

See `examples/` for ready-to-use configs:

- `examples/minimal.jscpd.json` - smallest config to get started
- `examples/java-js-enterprise-webapp.jscpd.json` - a real-world config (Java/JS/JSP/XML,
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
  default (both in `examples/java-js-enterprise-webapp.jscpd.json`):
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
- **Self-hosted web studio** (optional): run it locally via Docker instead -
  `docker run -p 9000:80 codecharta/codecharta-visualization`, then open
  `http://localhost:9000` and load your `.cc.json`.
- **Validate** a map: `ccsh check reports/codecharta-clones.cc.json`.

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
| `jscpd-to-cc.js`             | `--project-root` (default: current directory)       |

Practical rule: **run all three from the same directory** (your repository
root) and pass `--project-root .` explicitly. Verified end-to-end: running
`ccsh unifiedparser .`, this converter with `--project-root .`, and `ccsh
merge` on the same project reports `N nodes were processed, 0 were added
and N were merged` - i.e. every file's clone attributes land on the exact
same node as its source metrics, and clone-coupling edges are preserved.

```bash
ccsh merge --not-compressed --output-file=reports/complete.cc.json \
  reports/source.cc.json \
  reports/codecharta-clones.cc.json
```

### Merging maps - `ccsh merge` drops edge attributes

If two input maps contain an edge with the same `fromNodeName`/`toNodeName`,
`ccsh merge` keeps only the attributes of the **first** input file and
discards the other's - even when the attribute names are disjoint and a
lossless union would be possible. Node attributes in the same merge are
unioned correctly, so the result is a map whose files claim to have clones
while the edges carrying those clones are gone.

This bites as soon as a `gitlogparser` map joins a clone map, because a pair
of files that were changed together is often also a copy-paste pair. On
OpenClinica (~4000 Java files), merging 1697 `temporal_coupling` edges into
3440 clone edges silently lost 148 of the clone edges - about 4%.

`fix-merged-edges.js` repairs this. Run it after `ccsh merge` and before
`ccsh check`, passing the same source maps that were merged:

```bash
fix-merged-edges reports/complete.cc.json \
  reports/git.cc.json reports/codecharta-clones.cc.json
```

It only fills in attributes that are **missing** from a merged edge, never
overwriting a value ccsh picked, and it restores the matching
`attributeTypes.edges` and `attributeDescriptors` entries. The file is
rewritten with a fresh checksum, so the following `ccsh check` validates the
repaired map.

```
Usage: fix-merged-edges <merged> <source>... [options]

Arguments:
  merged                    cc.json produced by "ccsh merge"
  source                    the cc.json files that were merged, in the same
                            order they were passed to "ccsh merge"

Options:
  -o, --output <path>       write result here (default: overwrite <merged>)
  -h, --help                show this help
```

Verified against `ccsh` 1.143.0. The fix exists upstream in
`DependencyLens.mergeEdges`, but only on `main` as part of the unreleased
cc.json 2.0 lens rewrite - which no released toolchain reads - so this
workaround stays necessary until 2.0 ships.

### Metrics this tool produces

Node (file) attributes:

| Attribute              | Meaning                                                                          |
|-------------------------|-----------------------------------------------------------------------------------|
| `clone_coverage`        | % of the file's physical lines covered by at least one clone (overlaps counted once) |
| `duplicated_lines`      | Unique physical lines covered by at least one clone                              |
| `clone_instance_count`  | Number of unique cloned line ranges in the file                                  |
| `clone_pair_count`      | Number of jscpd clone pairs involving the file                                   |
| `clone_partner_count`   | Number of *other files* the file shares at least one clone with                  |

`clone_pair_count` and `clone_partner_count` answer different questions and
routinely differ. A file with three clone pairs against the same neighbour has
`clone_pair_count: 3` but `clone_partner_count: 1` - one copy-paste relationship,
found in three places. A file with `clone_partner_count: 12` is the opposite
case: its code is scattered across twelve other files, which is the shape worth
hunting for when you look for something to extract. A clone jscpd found *inside*
a single file raises `clone_pair_count` but adds no partner.

Edge (clone coupling between two files) attributes:

| Attribute                 | Meaning                                                                     |
|-----------------------------|--------------------------------------------------------------------------|
| `clone_coupling`            | Shared cloned lines / line count of the smaller of the two files (0-1)   |
| `shared_clone_lines`        | Unique duplicated lines shared by the two files                          |
| `shared_clone_pair_count`   | Number of jscpd clone pairs connecting the two files                     |

In CodeCharta, map `clone_coverage` or `duplicated_lines` to a color metric
to spot duplication hot spots, and enable edges to see which files are
copy-paste-coupled to each other.

#### Clone edges are undirected - show both directions

A clone pair has no direction: all three attributes are symmetric
(`shared_clone_lines` is the minimum of both sides, `clone_coupling` is
normalised against the *smaller* file), and each pair yields exactly one edge.
Which file ends up as `fromNodeName` is decided by sorting the two paths
lexicographically, so "outgoing" only means "the alphabetically earlier path".

The visualization does not know that. It colours incoming and outgoing edges
differently and lets you show them separately - so a view restricted to one
direction hides part of every file's clone partners, filtered by nothing but
the alphabet. **Enable both directions**, or set both edge colours to the same
value.

This differs from `ccsh gitlogparser`, whose `temporal_coupling` edges *are*
directed: it writes both directions with different values (how often B changed
with A is not how often A changed with B). In a merged map the two edge types
therefore behave differently, which is expected, not a defect.

## Development

```bash
npm test   # plain-Node smoke tests, no framework, no install needed
```

Four suites run: the converter smoke test, the `fix-merged-edges` repair test,
the `strip-edges` test, and a check that `jscpd-to-cc-pipeline.sh` and the
README's pipeline section still list the same steps.

## Background: Why a separate conversion step, not a jscpd plugin

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

## License

MIT, see [LICENSE](LICENSE).
