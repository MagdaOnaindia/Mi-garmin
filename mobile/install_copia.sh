#!/bin/bash
# Desde que el servidor de Fly sincroniza con Garmin, el Mac solo guarda una copia (mobile/copia_mac.py):
# cada 30 min, y al encenderlo, baja data/garmin.db y dashboard/data.js del servidor.
# También quita las tareas antiguas del Mac (sincronización 09:00/22:00, push y actualizar desde el móvil);
# sus .plist quedan en mobile/backups/2026-10-09-nube/launchagents por si hubiera que volver atrás.
# Uso:  bash ~/Projects/Garmin/mobile/install_copia.sh      (--uninstall quita la copia; --volver-al-mac lo deja como antes)
set -e
LABEL="com.magdalena.garmin-copia"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OLD="com.magdalena.garmin-sync com.magdalena.garmin-push com.magdalena.garmin-syncpoll"
SAVED="$DIR/mobile/backups/2026-10-09-nube/launchagents"

if [ "$1" = "--uninstall" ] || [ "$1" = "--volver-al-mac" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; echo "✓ Copia automática quitada"
  if [ "$1" = "--volver-al-mac" ]; then
    for l in $OLD; do
      [ -f "$SAVED/$l.plist" ] && cp "$SAVED/$l.plist" "$HOME/Library/LaunchAgents/" && launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$l.plist" && echo "✓ $l reactivada"
    done
  fi
  exit 0
fi

UV="$(command -v uv || true)"
for p in /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.local/bin/uv"; do [ -z "$UV" ] && [ -x "$p" ] && UV="$p"; done
[ -z "$UV" ] && { echo "No encuentro uv. Ejecuta: brew install uv"; exit 1; }
[ -f "$DIR/mobile/.secrets" ] || { echo "Falta mobile/.secrets (se crea al desplegar)"; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data" "$SAVED"
for l in $OLD; do
  launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
  if [ -f "$HOME/Library/LaunchAgents/$l.plist" ]; then
    mv "$HOME/Library/LaunchAgents/$l.plist" "$SAVED/" && echo "✓ Tarea antigua $l quitada"
  fi
done

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$UV</string><string>run</string><string>$DIR/mobile/copia_mac.py</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$UV"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/copia.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/copia.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ El Mac bajará una copia del servidor cada 30 min. Registro: $DIR/data/copia.log"
