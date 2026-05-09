#!/usr/bin/env bash
# Live call test watcher: capture runtime logs, health, docker stats, and forensics snapshots.
# Usage: ./scripts/live-call-test-watch.sh [--duration 180] [--out /tmp/veralux-live-tests] [--call-id optional]
# Does not copy .env files. URLs in env dump are host-only redacted.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DURATION=180
OUT_BASE="/tmp/veralux-live-tests"
CALL_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration)
      DURATION="${2:?}"
      shift 2
      ;;
    --out)
      OUT_BASE="${2:?}"
      shift 2
      ;;
    --call-id)
      CALL_FILTER="${2:?}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--duration SEC] [--out DIR] [--call-id CALL_CONTROL_ID]"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUTDIR="${OUT_BASE%/}/$TS"
mkdir -p "$OUTDIR"
PIDS_FILE="$OUTDIR/background.pids"
: >"$PIDS_FILE"

RUNNING=1
LATEST_SESSION=""
cleanup() {
  local ec="${1:-$?}"
  if [[ "$RUNNING" -eq 0 ]]; then
    exit "$ec"
  fi
  RUNNING=0
  if [[ -f "$PIDS_FILE" ]]; then
    while read -r p; do
      [[ -n "$p" ]] && kill "$p" 2>/dev/null || true
    done <"$PIDS_FILE"
  fi
  # Do not `wait` on background jobs: docker logs -f would block shutdown forever.
  sleep 0.3

  # Copy latest forensics session from container
  if docker inspect veralux-runtime &>/dev/null; then
    FORENSICS_ROOT="$(docker exec veralux-runtime sh -c 'printf %s "${AUDIO_FORENSICS_DIR:-/data/veralux/voice/forensics}"')"
    LATEST_SESSION="$(docker exec veralux-runtime sh -c "
      d=\"$FORENSICS_ROOT\"
      [ -d \"\$d\" ] || exit 0
      find \"\$d\" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort | tail -1
    ")"
    if [[ -n "${CALL_FILTER:-}" ]]; then
      SAFE_ID="$(echo -n "$CALL_FILTER" | tr -c 'A-Za-z0-9._-' '_')"
      LATEST_SESSION="$(docker exec veralux-runtime sh -c "
        d=\"$FORENSICS_ROOT\"
        find \"\$d\" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | grep -F \"/${SAFE_ID}/\" | sort | tail -1
      ")"
    fi
    if [[ -n "$LATEST_SESSION" ]]; then
      mkdir -p "$OUTDIR/forensics_copy"
      docker cp "veralux-runtime:$LATEST_SESSION" "$OUTDIR/forensics_copy/$(basename "$LATEST_SESSION")" 2>/dev/null || true
      if docker exec veralux-runtime sh -c "test -f \"$LATEST_SESSION/timeline.jsonl\""; then
        docker exec veralux-runtime sh -c "tail -n 2000 \"$LATEST_SESSION/timeline.jsonl\"" >"$OUTDIR/forensics_timeline_tail.jsonl" 2>/dev/null || true
      fi
    fi
  fi

  {
    echo "Live test watcher finished at $(date -Iseconds)"
    echo "Output directory: $OUTDIR"
    echo "Latest session in container (if any): ${LATEST_SESSION:-none}"
    echo "Copied under: $OUTDIR/forensics_copy/"
    echo "Post-call analyzer (pick the session dir that contains timeline.jsonl):"
    echo "  $SCRIPT_DIR/analyze-audio-forensics.sh $OUTDIR/forensics_copy/<timestamp_dir>"
  } >>"$OUTDIR/summary.txt"

  echo ""
  echo "Watcher stopped. Bundle: $OUTDIR"
  echo "Next: $SCRIPT_DIR/analyze-audio-forensics.sh <call-folder-or-id>"
  exit "$ec"
}
trap 'cleanup 130' INT
trap 'cleanup 143' TERM
trap 'cleanup $?' EXIT

redact_url_val() {
  local v="${1:-}"
  if [[ -z "$v" ]]; then
    printf '(unset)\n'
    return
  fi
  if [[ "$v" =~ ^https?://([^/?#]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]} (URL host only)"
    return
  fi
  printf '(set, %s chars)\n' "${#v}"
}

record_metadata() {
  local mf="$OUTDIR/startup_metadata.txt"
  {
    echo "=== VeraLux live call test watcher ==="
    echo "started_utc: $(date -u -Iseconds)"
    echo "out_dir: $OUTDIR"
    echo "duration_sec: $DURATION"
    echo "call_filter: ${CALL_FILTER:-none}"
    echo ""
    echo "=== git ==="
    if git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null; then
      git -C "$REPO_ROOT" rev-parse HEAD
      git -C "$REPO_ROOT" log -1 --oneline 2>/dev/null || true
    else
      echo "(not a git checkout or git missing)"
    fi
    echo ""
    echo "=== docker ps (veralux) ==="
    docker ps -a --filter "name=veralux-" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null || echo "(docker ps failed)"
    echo ""
    echo "=== docker compose ps (project veralux) ==="
    if docker compose -f "$REPO_ROOT/docker-compose.yml" -f "$REPO_ROOT/docker-compose.production.yml" -p veralux ps 2>/dev/null; then
      :
    else
      docker compose -p veralux ps 2>/dev/null || echo "(compose ps failed — set PROD_ROOT or run from repo root)"
    fi
    echo ""
    echo "=== health ==="
    curl -sS -m 3 "http://localhost:4001/health" 2>/dev/null | head -c 4000 || echo "(curl /health failed)"
    echo ""
    curl -sS -m 3 "http://localhost:4001/health/voice" 2>/dev/null | head -c 4000 || echo "(curl /health/voice failed)"
    echo ""
    echo ""
    echo "=== runtime env (safe keys only, inside veralux-runtime) ==="
    if docker inspect veralux-runtime &>/dev/null; then
      while read -r var; do
        [[ -z "$var" ]] && continue
        val="$(docker exec veralux-runtime sh -c "printf '%s' \"\${$var:-}\"" 2>/dev/null || true)"
        case "$var" in
          WHISPER_URL|CHATTERBOX_URL)
            printf '%s=%s\n' "$var" "$(redact_url_val "$val")"
            ;;
          *)
            printf '%s=%s\n' "$var" "$val"
            ;;
        esac
      done <<'ENVS'
AUDIO_FORENSICS_ENABLED
AUDIO_FORENSICS_DIR
AUDIO_FORENSICS_ALLOW_PII
STT_ECHO_SUPPRESSION_MODE
STT_POST_PLAYBACK_GRACE_MS
STT_POST_PLAYBACK_GRACE_MIN_MS
STT_POST_PLAYBACK_GRACE_MAX_MS
STT_PLAYBACK_GRACE_BUFFER_MAX_MS
STT_CAPTURE_DURING_POST_PLAYBACK_GRACE
STT_USE_AUDIO_CLOCK_FOR_MEDIA_GAPS
TTS_MODE
WHISPER_URL
CHATTERBOX_URL
BRAIN_USE_LOCAL
ENVS
    else
      echo "(container veralux-runtime not running)"
    fi
  } | tee "$mf"
}

health_loop() {
  local out="$OUTDIR/health.samples.jsonl"
  while true; do
    python3 -c "
import json, urllib.request, datetime
def get(path):
    try:
        with urllib.request.urlopen('http://localhost:4001'+path, timeout=2) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {'error': str(e)}
row = {
  't': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),
  'health': get('/health'),
  'voice': get('/health/voice'),
}
print(json.dumps(row))
" >>"$out" 2>/dev/null || true
    sleep 2
  done
}

docker_loop() {
  local out="$OUTDIR/docker.samples.jsonl"
  local gpu_txt="$OUTDIR/gpu.samples.txt"
  while true; do
    python3 -c "
import json, subprocess, datetime, shutil
names = ['veralux-runtime','veralux-whisper','veralux-chatterbox','veralux-redis','veralux-postgres','veralux-control']
rows = []
for n in names:
    try:
        r = subprocess.run(['docker','inspect','-f','{{.State.Status}}',n], capture_output=True, text=True, timeout=5)
        rows.append({'name':n,'inspect_status':(r.stdout or '').strip() or None,'rc':r.returncode})
    except Exception as e:
        rows.append({'name':n,'error':str(e)})
stats = ''
try:
    r = subprocess.run(['docker','stats','--no-stream','--format','{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'] + names,
        capture_output=True, text=True, timeout=15)
    stats = (r.stdout or '').strip()
except Exception as e:
    stats = str(e)
row = {'t': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'), 'containers': rows, 'docker_stats_lines': stats}
print(json.dumps(row))
" >>"$out" 2>/dev/null || true
    if command -v nvidia-smi &>/dev/null; then
      {
        echo "--- $(date -u -Iseconds) ---"
        nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader 2>/dev/null || true
      } >>"$gpu_txt"
    fi
    sleep 5
  done
}

forensics_loop() {
  local wlog="$OUTDIR/forensics.watch.jsonl"
  while true; do
    if ! docker inspect veralux-runtime &>/dev/null; then
      sleep 5
      continue
    fi
    FORENSICS_ROOT="$(docker exec veralux-runtime sh -c 'printf %s "${AUDIO_FORENSICS_DIR:-/data/veralux/voice/forensics}"')"
    python3 -c "
import json, subprocess, datetime, os
root = '''$FORENSICS_ROOT'''
call_filter = '''${CALL_FILTER:-}'''
try:
    r = subprocess.run(['docker','exec','veralux-runtime','sh','-c',
        'd=\"%s\"; find \"\$d\" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort' % root],
        capture_output=True, text=True, timeout=20)
    dirs = [x for x in (r.stdout or '').splitlines() if x.strip()]
except Exception as e:
    dirs = []
if call_filter:
    safe = ''.join(c if c.isalnum() or c in '._-' else '_' for c in call_filter)
    dirs = [d for d in dirs if '/%s/' % safe in d]
latest = dirs[-1] if dirs else None
counts = {}
timeline_events = {}
if latest:
    try:
        r2 = subprocess.run(['docker','exec','veralux-runtime','sh','-c',
            'for p in audio transcripts llm tts playback; do echo -n \"\$p \"; find \"%s/\$p\" -type f 2>/dev/null | wc -l; done' % latest],
            capture_output=True, text=True, timeout=30)
        for line in (r2.stdout or '').splitlines():
            parts = line.split()
            if len(parts) >= 2:
                counts[parts[0]] = int(parts[-1])
    except Exception:
        pass
    try:
        r3 = subprocess.run(['docker','exec','veralux-runtime','sh','-c',
            'test -f \"%s/timeline.jsonl\" && tail -n 5000 \"%s/timeline.jsonl\"' % (latest, latest)],
            capture_output=True, text=True, timeout=30)
        for line in (r3.stdout or '').splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
                ev = o.get('event') or ''
                timeline_events[ev] = timeline_events.get(ev, 0) + 1
            except Exception:
                pass
    except Exception:
        pass
row = {
  't': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),
  'forensics_root': root,
  'latest_session_dir': latest,
  'artifact_counts_by_subdir': counts,
  'timeline_event_counts_sampled': timeline_events,
}
print(json.dumps(row))
" >>"$wlog" 2>/dev/null || true
    sleep 5
  done
}

VOICE_PATTERN='call\.initiated|call\.answered|streaming\.started|media_ws_connected|media_ingest|media_payload|stt_|whisper|transcript|assistant_echo|playback|tts|llm|dead_air|audio_state_transition|frame_dropped|post_playback|health|listening_armed|forensics'

start_log_pipeline() {
  : >"$OUTDIR/runtime.full.log"
  : >"$OUTDIR/runtime.voice-events.log"
  # Separate processes so we can kill docker logs and tail independently on exit.
  docker logs -f veralux-runtime >>"$OUTDIR/runtime.full.log" 2>&1 &
  echo $! >>"$PIDS_FILE"
  tail -n 0 -F "$OUTDIR/runtime.full.log" 2>/dev/null | grep --line-buffered -E "$VOICE_PATTERN" >>"$OUTDIR/runtime.voice-events.log" &
  echo $! >>"$PIDS_FILE"
}

record_metadata

if docker inspect veralux-runtime &>/dev/null; then
  start_log_pipeline
else
  echo "Warning: veralux-runtime not running; skipping docker logs." | tee -a "$OUTDIR/runtime.full.log"
fi

health_loop &
echo $! >>"$PIDS_FILE"
docker_loop &
echo $! >>"$PIDS_FILE"
forensics_loop &
echo $! >>"$PIDS_FILE"

echo "Watching (duration ${DURATION}s). Output: $OUTDIR"
echo "Ctrl+C to stop early (bundle will still be finalized)."

sleep "$DURATION"
