#!/bin/bash
# Programa la sincronización automática en tu Mac: cada día a las 09:00 y a las 22:00.
# Uso:  bash ~/Projects/Garmin/sync/install_daily.sh      (para quitarla: --uninstall)
set -e
LABEL="com.magdalena.garmin-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$1" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; echo "✓ Sincronización automática quitada"; exit 0
fi

UV="$(command -v uv || true)"
for p in /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.local/bin/uv"; do [ -z "$UV" ] && [ -x "$p" ] && UV="$p"; done
[ -z "$UV" ] && { echo "No encuentro uv. Ejecuta: brew install uv"; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$UV</string><string>run</string><string>$DIR/sync/garmin_sync.py</string>
  </array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>22</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/sync.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/sync.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ Sincronización programada a las 09:00 y 22:00 (y ahora mismo)."
echo "  Registro: $DIR/data/sync.log"
