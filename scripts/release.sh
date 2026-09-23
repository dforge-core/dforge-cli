#!/bin/bash
# Usage: scripts/release.sh 0.2.23 [extra publish.sh flags, e.g. --dry-run or --tag next]
set -eo pipefail
V="${1:?usage: $0 <version> [flags]}"; shift
exec "$(dirname "$0")/publish.sh" --source-tag "cli-v$V" --version "$V" "$@"
