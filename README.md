# jscpd-codecharta-reporter

A [jscpd](https://jscpd.dev/) reporter that writes detected code clones
directly as a [CodeCharta](https://codecharta.com/) 1.3 `cc.json` file - as
part of the normal `jscpd` run, no separate conversion step, no intermediate
`jscpd-report.json` round-trip.

Each duplicated file becomes a CodeCharta leaf annotated with clone metrics;
each pair of files that share a clone becomes one aggregated, symmetric edge
("clone coupling") between them. Merge the result with a source-metrics map
(e.g. `ccsh unifiedparser`) or a git-history map (`ccsh gitlogparser`) to see
duplication next to size, complexity, and churn in the same 3D city.

Zero runtime dependencies - only Node.js built-ins (`fs`, `path`, `crypto`).

## Requirements

- Node.js >= 16
- `jscpd` v3 or later (the current `@jscpd/*` reporter architecture; the
  `reportersOptions` config key used below has been present since early v3)

## Install

This package is **not published to npm**. Install it straight from GitHub:

```bash
npm install --save-dev github:<your-github-user>/jscpd-codecharta-reporter
```

(Replace `<your-github-user>/jscpd-codecharta-reporter` with wherever you
push this repo.) npm names the installed folder after the `name` field in
`package.json`, so it lands in `node_modules/jscpd-codecharta-reporter`
regardless of the GitHub path - which matters, see "How discovery works"
below.

## Configure

Add `"codecharta"` to `.jscpd.json`'s `reporters`, and (optionally) tune it
via `reportersOptions.codecharta`:

```json
{
  "reporters": ["console", "codecharta"],
  "reportersOptions": {
    "codecharta": {
      "projectRoot": ".",
      "projectName": "myproject clones",
      "output": "reports/jscpd/codecharta-clones.cc.json"
    }
  },
  "output": "reports/jscpd",
  "absolute": true
}
```

All three `codecharta` options are optional:

| Option        | Default                                          | Purpose                                                                 |
|---------------|---------------------------------------------------|--------------------------------------------------------------------------|
| `projectRoot` | `process.cwd()`                                    | Root used to turn file paths into CodeCharta's `/root/...` node paths   |
| `projectName` | `"<basename of projectRoot> clones"`               | CodeCharta project name                                                 |
| `output`      | `"<jscpd `output` dir>/codecharta-clones.cc.json"` | Where the `cc.json` file is written                                     |

`"absolute": true` (jscpd's own top-level option) is recommended so clone
locations carry absolute file paths - this reporter also resolves relative
ones against `projectRoot`, but absolute paths avoid any ambiguity about
which directory jscpd was run from.

## Run

```bash
npx jscpd --config .jscpd.json src/
```

jscpd prints its usual console/other reports, and this reporter additionally
logs e.g.:

```
[jscpd-codecharta-reporter] wrote 42 clone-annotated files and 17 clone-coupling edges to reports/jscpd/codecharta-clones.cc.json
```

See `examples/.jscpd.json` for a complete example config (Java/JS/JSP/XML,
weak clone detection mode, `equals`/`hashCode` boilerplate excluded via
`ignorePattern` - adjust to your stack).

## jscpd usage hints

- `mode: "weak"` ignores identifier/literal differences (recommended for
  spotting copy-paste-and-rename duplication); `"strict"` requires an exact
  token match.
- `minTokens`/`minLines` are your noise floor - too low and you drown in
  trivial matches (getters/setters, imports); too high and small-but-real
  duplication hides.
- `ignorePattern` (regex, matched against file content) is the escape hatch
  for structurally-required boilerplate that isn't really "duplication"
  (e.g. generated `equals`/`hashCode`, license headers).
- Run jscpd from the same directory (or use `absolute: true` +
  `reportersOptions.codecharta.projectRoot`) every time, so `cc.json`s from
  different runs stay mergeable (stable `/root/...` node paths).

## CodeCharta usage hints

Once you have a `.cc.json`:

- **Visualize directly**: upload it at the [CodeCharta web
  visualization](https://codecharta.com/) - no install needed.
- **Local viewer**: `npm install -g codecharta-analysis`, then
  `ccsh gui reports/jscpd/codecharta-clones.cc.json`.
- **Merge with other maps** (source metrics, git history, ...):
  ```bash
  ccsh merge --not-compressed --output-file=complete.cc.json \
    reports/jscpd/codecharta-clones.cc.json \
    reports/other-map.cc.json
  ```
- **Validate** a map: `ccsh check reports/jscpd/codecharta-clones.cc.json`.

### Metrics this reporter emits

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

## How discovery works (why the package name matters)

jscpd resolves a reporter name that isn't one of its built-ins
(`console`, `json`, `xml`, ...) like this (from jscpd's
`apps/jscpd/src/init/reporters.ts`):

```js
try {
  require(`@jscpd/${reporter}-reporter`).default
} catch {
  require(`jscpd-${reporter}-reporter`).default
}
```

So `"reporters": ["codecharta"]` only resolves automatically if a package
literally named `jscpd-codecharta-reporter` is installed (the `@jscpd/*`
npm scope belongs to jscpd's maintainer, not to third-party reporters).
jscpd then does `new (required).default(options)` and calls
`.report(clones, statistic)` on it - implemented here in `index.js`.

`clones` is an array of jscpd's internal `IClone` objects
(`duplicationA`/`duplicationB`, each with `sourceId` and `start`/`end` as
`{ line, column?, position? }`), which is a different shape than the
`firstFile`/`secondFile`/plain-number-`start`/`end` shape you get from
jscpd's own JSON report file - that shape is produced by jscpd's built-in
`JsonReporter`, not by jscpd itself. This reporter adapts directly from
`IClone` (see `toClonePair` in `index.js`).

## Development

```bash
npm test   # plain-Node smoke test, no framework, no install needed
```

## License

MIT, see [LICENSE](LICENSE).
