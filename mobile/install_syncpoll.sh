#!/bin/bash
# Permite actualizar desde el móvil: cada minuto mira si pediste "Actualizar desde Garmin" y, si es así,
# sincroniza con Garmin y sube el panel (mobile/sync_poll.py). Solo funciona con el Mac encendido.
# Uso:  bash ~/Projects/Garmin/mobile/install_syncpoll.sh      (para quitarlo: --uninstall)
set -e
LABEL="com.magdalena.garmin-syncpoll"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$1" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; echo "✓ Actualización desde el móvil quitada"; exit 0
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
    <string>$UV</string><string>run</string><string>$DIR/mobile/sync_poll.py</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$UV"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/syncpoll.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/syncpoll.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ El Mac mirará cada minuto si pides actualizar desde el móvil."
echo "  Registro: $DIR/data/syncpoll.log"
