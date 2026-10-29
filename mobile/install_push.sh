#!/bin/bash
# Sube el panel al móvil cada vez que el sync regenera dashboard/data.js (y además a las 09:15 y 22:15).
# Uso:  bash ~/Projects/Garmin/mobile/install_push.sh      (para quitarlo: --uninstall)
set -e
LABEL="com.magdalena.garmin-push"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$1" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; echo "✓ Subida automática al móvil quitada"; exit 0
fi

UV="$(command -v uv || true)"
for p in /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.local/bin/uv"; do [ -z "$UV" ] && [ -x "$p" ] && UV="$p"; done
[ -z "$UV" ] && { echo "No encuentro uv. Ejecuta: brew install uv"; exit 1; }
[ -f "$DIR/mobile/.secrets" ] || { echo "Falta mobile/.secrets (se crea al desplegar)"; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$UV</string><string>run</string><string>$DIR/mobile/push.py</string>
  </array>
  <key>WatchPaths</key><array><string>$DIR/dashboard/data.js</string></array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>15</integer></dict>
    <dict><key>Hour</key><integer>22</integer><key>Minute</key><integer>15</integer></dict>
  </array>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/push.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/push.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ El panel se subirá al móvil tras cada sincronización (y ahora mismo)."
echo "  Registro: $DIR/data/push.log"
