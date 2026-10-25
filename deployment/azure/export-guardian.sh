#!/bin/bash
set -eu
umask 077
job=$1
shift
# The app creates this exact private prefix; never accept a request-supplied cleanup target.
[[ "$job" == /tmp/opendots-backup-* && "$job" != *//* && "$job" != */../* ]] || exit 1
trap '/bin/rm -rf -- "$job"' EXIT
cd "$job"
ulimit -c 0
ulimit -v 1048576
# Bash uses 1024-byte units: the kernel rejects even one byte over 32MiB.
ulimit -f 32768
# --foreground keeps the worker in our owned process group. Node starts no descendants.
# This guardian and GNU timeout survive the HTTP parent's death.
/usr/bin/timeout --foreground --signal=KILL 20s "$@" > result.json
# Only publish metadata after the SQLite worker really exited successfully.
[[ -s result.json ]] || exit 1
/bin/cat result.json
# EOF (including parent death), explicit release, or deadline always removes private files.
read -r -t 65 _ || true
