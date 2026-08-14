#!/usr/bin/env bash
#
# Build one CodeCharta map from clone, source and git metrics.
#
# Copy this file into the root of the repository you want to analyse and run
# it there. It runs the full pipeline documented in the README, in the order
# that matters:
#
#   jscpd -> jscpd-to-cc -> unifiedparser -> gitlogparser -> strip-edges
#          -> merge -> fix-merged-edges -> check
#
# Every step runs from the repository root so that all tools resolve relative
# paths against the same root - otherwise the maps merge into parallel trees
# instead of onto each other (see "Merging maps" in the README).
#
# Requirements: node >= 16, jscpd, and ccsh (npm install -g codecharta-analysis).
# jscpd-to-cc, fix-merged-edges and strip-edges are taken from PATH, or from
# the directory in JSCPD_TO_CC_DIR if you did not install this package globally.

set -euo pipefail

OUTPUT_DIR="reports"
PROJECT_NAME="$(basename "$PWD")"
GIT="metrics"

usage() {
    cat <<'EOF'
Usage: jscpd-to-cc-pipeline.sh [options]

Build one CodeCharta map from clone, source and git metrics.

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

Clone coupling is always the edge metric of the resulting map. "metrics" strips
the temporal-coupling edges before merging, because the visualization draws
every edge of a selected building regardless of the selected edge metric - so
two kinds of coupling in one map cannot be told apart. The untouched git map
with its temporal-coupling edges is still written, so a separate analysis can
use it.

Scanning the git log is by far the slowest step on a large repository. Use
"none" when you only care about clones and source metrics.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -o | --output-dir)
            OUTPUT_DIR="${2:?--output-dir requires a value}"
            shift 2
            ;;
        -n | --project-name)
            PROJECT_NAME="${2:?--project-name requires a value}"
            shift 2
            ;;
        -g | --git)
            GIT="${2:?--git requires a value}"
            shift 2
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown argument: $1" >&2
            echo "Run with --help for usage." >&2
            exit 1
            ;;
    esac
done

case "$GIT" in
    metrics | all | none) ;;
    *)
        echo "error: --git must be 'metrics', 'all' or 'none', got '$GIT'" >&2
        exit 1
        ;;
esac

# --- locate the helper scripts ------------------------------------------------

resolve_helper() {
    local name="$1"
    if command -v "$name" > /dev/null 2>&1; then
        echo "$name"
    elif [ -n "${JSCPD_TO_CC_DIR:-}" ] && [ -f "$JSCPD_TO_CC_DIR/$name.js" ]; then
        echo "node $JSCPD_TO_CC_DIR/$name.js"
    elif [ -f "$(dirname "$0")/$name.js" ]; then
        echo "node $(dirname "$0")/$name.js"
    else
        echo "error: $name not found. Install this package globally, or set" >&2
        echo "       JSCPD_TO_CC_DIR to the directory holding $name.js." >&2
        exit 1
    fi
}

require_command() {
    if ! command -v "$1" > /dev/null 2>&1; then
        echo "error: $1 not found in PATH. $2" >&2
        exit 1
    fi
}

require_command jscpd "Install it with: npm install -g jscpd"
require_command ccsh "Install it with: npm install -g codecharta-analysis"

JSCPD_TO_CC="$(resolve_helper jscpd-to-cc)"
FIX_MERGED_EDGES="$(resolve_helper fix-merged-edges)"
STRIP_EDGES="$(resolve_helper strip-edges)"

mkdir -p "$OUTPUT_DIR"

# --- 1. detect clones ---------------------------------------------------------

echo "==> Detecting clones with jscpd"
if [ -f .jscpd.json ]; then
    jscpd --config .jscpd.json --reporters json,html --output "$OUTPUT_DIR"
else
    echo "    (no .jscpd.json found - running jscpd with its defaults)"
    jscpd --reporters json,html --output "$OUTPUT_DIR" .
fi

# --- 2. convert the clone report ---------------------------------------------

echo "==> Converting the jscpd report to CodeCharta"
$JSCPD_TO_CC "$OUTPUT_DIR/jscpd-report.json" \
    --output "$OUTPUT_DIR/codecharta-clones.cc.json" \
    --project-root . \
    --project-name "$PROJECT_NAME clones"

# --- 3. source metrics --------------------------------------------------------

# The output directory and this script live inside the analysed tree once it
# has been copied in, so they are excluded to keep them out of the map.
echo "==> Extracting source metrics"
ccsh unifiedparser --not-compressed --output-file="$OUTPUT_DIR/source.cc.json" \
    --exclude="$OUTPUT_DIR/.*,.*$(basename "$0")" .

# --- 3b. git history metrics (skipped outside a git repository) --------------

MAPS=("$OUTPUT_DIR/source.cc.json")
SOURCES_WITH_EDGES=("$OUTPUT_DIR/codecharta-clones.cc.json")

if [ "$GIT" = "none" ]; then
    echo "==> Skipping git history metrics (--git none)"
elif ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    echo "==> Not a git repository - skipping git history metrics"
else
    echo "==> Extracting git history metrics"
    git log --numstat --raw --topo-order --reverse -m > "$OUTPUT_DIR/git.log"
    git ls-files > "$OUTPUT_DIR/git-files.txt"
    ccsh gitlogparser log-scan \
        --git-log="$OUTPUT_DIR/git.log" \
        --repo-files="$OUTPUT_DIR/git-files.txt" \
        --not-compressed \
        --output-file="$OUTPUT_DIR/git.cc.json"

    if [ "$GIT" = "metrics" ]; then
        # Keep the history metrics, drop the temporal-coupling edges. The
        # original git.cc.json stays untouched for a separate analysis.
        echo "==> Dropping temporal-coupling edges (--git metrics)"
        $STRIP_EDGES "$OUTPUT_DIR/git.cc.json" \
            --output "$OUTPUT_DIR/git-metrics-only.cc.json"
        MAPS+=("$OUTPUT_DIR/git-metrics-only.cc.json")
    else
        MAPS+=("$OUTPUT_DIR/git.cc.json")
        SOURCES_WITH_EDGES=("$OUTPUT_DIR/git.cc.json" "${SOURCES_WITH_EDGES[@]}")
    fi
fi

MAPS+=("$OUTPUT_DIR/codecharta-clones.cc.json")

# --- 4. merge -----------------------------------------------------------------

echo "==> Merging maps"
ccsh merge --not-compressed --output-file="$OUTPUT_DIR/complete.cc.json" "${MAPS[@]}"

# --- 4b. repair the edge attributes ccsh merge drops -------------------------

# Only needed when more than one input carries edges - see "ccsh merge drops
# edge attributes" in the README. With --git metrics or none it never happens.
if [ "${#SOURCES_WITH_EDGES[@]}" -gt 1 ]; then
    echo "==> Restoring edge attributes dropped by ccsh merge"
    $FIX_MERGED_EDGES "$OUTPUT_DIR/complete.cc.json" "${SOURCES_WITH_EDGES[@]}"
fi

# --- 5. validate --------------------------------------------------------------

echo "==> Validating the merged map"
ccsh check "$OUTPUT_DIR/complete.cc.json"

echo
echo "Done: $OUTPUT_DIR/complete.cc.json (git: $GIT)"
echo "Open it at https://codecharta.com/visualization/ (or your local webstudio)."
