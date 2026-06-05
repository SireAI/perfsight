#!/bin/sh
set -eu

OUTPUT_DIR="${PERFSIGHT_HOOK_TEST_DIR:-./data/hook-tests}"
NOW="$(date '+%Y-%m-%dT%H:%M:%S%z')"
REASONS=""
EVENT=""
PACKAGE_NAME=""
PID_VALUE=""
DUMP_TYPE=""
TIMESTAMP_ISO=""
STATUS=""
MANIFEST_PATH=""
HPROF_PATH=""
RUNTIME_LOG_PATH=""
ERROR_MESSAGE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --event)
      EVENT="${2:-}"
      shift 2
      ;;
    --package)
      PACKAGE_NAME="${2:-}"
      shift 2
      ;;
    --pid)
      PID_VALUE="${2:-}"
      shift 2
      ;;
    --dump-type)
      DUMP_TYPE="${2:-}"
      shift 2
      ;;
    --timestamp)
      TIMESTAMP_ISO="${2:-}"
      shift 2
      ;;
    --status)
      STATUS="${2:-}"
      shift 2
      ;;
    --manifest)
      MANIFEST_PATH="${2:-}"
      shift 2
      ;;
    --hprof)
      HPROF_PATH="${2:-}"
      shift 2
      ;;
    --runtime-log)
      RUNTIME_LOG_PATH="${2:-}"
      shift 2
      ;;
    --reason)
      if [ -n "$REASONS" ]; then
        REASONS="${REASONS},${2:-}"
      else
        REASONS="${2:-}"
      fi
      shift 2
      ;;
    --error)
      ERROR_MESSAGE="${2:-}"
      shift 2
      ;;
    *)
      echo "[test-dump-hook] unknown arg: $1" >&2
      shift 1
      ;;
  esac
done

mkdir -p "$OUTPUT_DIR"

STAMP="$(date '+%Y%m%d_%H%M%S')"
EVENT_FILE="$OUTPUT_DIR/dump-hook-events.jsonl"
DETAIL_FILE="$OUTPUT_DIR/${STAMP}_${EVENT:-unknown}.txt"
LATEST_FILE="$OUTPUT_DIR/latest.txt"

printf '%s\n' \
  "received_at=$NOW" \
  "event=$EVENT" \
  "package=$PACKAGE_NAME" \
  "pid=$PID_VALUE" \
  "dump_type=$DUMP_TYPE" \
  "timestamp=$TIMESTAMP_ISO" \
  "status=$STATUS" \
  "reasons=$REASONS" \
  "manifest=$MANIFEST_PATH" \
  "hprof=$HPROF_PATH" \
  "runtime_log=$RUNTIME_LOG_PATH" \
  "error=$ERROR_MESSAGE" \
  > "$DETAIL_FILE"

printf '%s\n' \
  "received_at=$NOW" \
  "detail_file=$DETAIL_FILE" \
  "event=$EVENT" \
  "package=$PACKAGE_NAME" \
  "pid=$PID_VALUE" \
  "dump_type=$DUMP_TYPE" \
  "status=$STATUS" \
  "manifest=$MANIFEST_PATH" \
  "hprof=$HPROF_PATH" \
  > "$LATEST_FILE"

printf '{"received_at":"%s","event":"%s","package":"%s","pid":"%s","dump_type":"%s","timestamp":"%s","status":"%s","reasons":"%s","manifest":"%s","hprof":"%s","runtime_log":"%s","error":"%s","detail_file":"%s"}\n' \
  "$NOW" \
  "$EVENT" \
  "$PACKAGE_NAME" \
  "$PID_VALUE" \
  "$DUMP_TYPE" \
  "$TIMESTAMP_ISO" \
  "$STATUS" \
  "$REASONS" \
  "$MANIFEST_PATH" \
  "$HPROF_PATH" \
  "$RUNTIME_LOG_PATH" \
  "$ERROR_MESSAGE" \
  "$DETAIL_FILE" \
  >> "$EVENT_FILE"

echo "[test-dump-hook] event=$EVENT status=$STATUS detail=$DETAIL_FILE"
