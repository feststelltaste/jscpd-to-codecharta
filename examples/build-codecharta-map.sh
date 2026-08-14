#!/usr/bin/env bash
# Example end-to-end pipeline: jscpd clone detection -> CodeCharta conversion
# -> merge with a source-metrics map -> validate.
#
# Adjust SOURCE_PATHS/OUTPUT_DIR/JSCPD_CONFIG for your project. Run this from
# your project's repository root - unifiedparser, gitlogparser and this
# converter must all resolve relative paths against the same root, or the
# resulting maps won't merge (see "Merging maps" in the README).
set -euo pipefail

JSCPD_CONFIG="${JSCPD_CONFIG:-.jscpd.json}"
OUTPUT_DIR="${OUTPUT_DIR:-reports/jscpd}"
SOURCE_PATHS=("${@:-src}")

mkdir -p "$OUTPUT_DIR"

echo "Detecting clones..."
npx jscpd --config "$JSCPD_CONFIG" --reporters json --output "$OUTPUT_DIR" "${SOURCE_PATHS[@]}"

echo "Converting to CodeCharta..."
node "$(dirname "$0")/../jscpd-to-codecharta.js" \
  "$OUTPUT_DIR/jscpd-report.json" \
  --output "$OUTPUT_DIR/codecharta-clones.cc.json" \
  --project-root .

echo "Extracting source metrics..."
npx ccsh unifiedparser --not-compressed --output-file="$OUTPUT_DIR/source.cc.json" .

echo "Merging maps..."
npx ccsh merge --not-compressed \
  --output-file="$OUTPUT_DIR/complete.cc.json" \
  "$OUTPUT_DIR/source.cc.json" \
  "$OUTPUT_DIR/codecharta-clones.cc.json"

npx ccsh check "$OUTPUT_DIR/complete.cc.json"
echo "Created $OUTPUT_DIR/complete.cc.json"
