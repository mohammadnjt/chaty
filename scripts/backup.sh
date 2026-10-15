#!/usr/bin/env bash
# Nightly backup of the files/ folder (messages, uploads, settings, keys) to
# Google Drive with rclone. On the server, cron runs it (/etc/cron.d/chaty-backup):
#
#   30 3 * * * root /root/bas/apps/chaty/scripts/backup.sh >> /var/log/chaty-backup.log 2>&1
#
# files/ is mirrored to <remote>/current. Whatever a night's run replaces or
# removes there moves to <remote>/archive/<date>, kept for KEEP_DAYS, so the
# data file (it changes every day) and any removed upload can be brought back
# from any night of the last month. The data file only grows at its end, so
# copying it while Chaty runs is safe.
#
# The result goes to files/backup.json, which the admin panel shows.
#
#   CHATY_BACKUP_REMOTE    rclone remote and folder (default gdrive:Chaty-backup)
#   CHATY_BACKUP_KEEP_DAYS days the archive keeps (default 30)
#   CHATY_HOME             the Chaty folder holding files/ (default: this script's parent)
set -uo pipefail
cd "${CHATY_HOME:-$(dirname "$0")/..}" || exit 1

REMOTE=${CHATY_BACKUP_REMOTE:-gdrive:Chaty-backup}
KEEP_DAYS=${CHATY_BACKUP_KEEP_DAYS:-30}
today=$(date +%F)
log=$(mktemp)
trap 'rm -f "$log"' EXIT

status() {
  python3 - "$1" "$REMOTE" "$log" <<'PY'
import json, sys, time
ok, remote, log = sys.argv[1] == 'ok', sys.argv[2], sys.argv[3]
error = '' if ok else ' '.join(open(log, errors='replace').read().split()[-60:])
with open('files/backup.json.tmp', 'w') as f:
    json.dump({'at': int(time.time() * 1000), 'ok': ok, 'error': error, 'remote': remote}, f)
PY
  mv files/backup.json.tmp files/backup.json
}

run() {
  rclone sync files "$REMOTE/current" \
    --backup-dir "$REMOTE/archive/$today" \
    --exclude '/backup.json' --exclude '/backup.json.tmp' \
    --retries 5 --low-level-retries 20 || return 1
  # Archives older than KEEP_DAYS go (by their folder's date; the files inside
  # keep their own, older, times).
  local cutoff dir
  cutoff=$(date -d "-$KEEP_DAYS days" +%F)
  for dir in $(rclone lsf --dirs-only "$REMOTE/archive" 2>/dev/null); do
    dir=${dir%/}
    if [[ $dir =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && $dir < $cutoff ]]; then
      rclone purge "$REMOTE/archive/$dir" --drive-use-trash=false || return 1
    fi
  done
}

echo "$(date '+%F %T') backup to $REMOTE"
run 2>"$log"
rc=$?
cat "$log" >&2
if ((rc == 0)); then
  status ok
  echo "$(date '+%F %T') done"
else
  status failed
  echo "$(date '+%F %T') FAILED" >&2
  exit 1
fi
