#!/bin/bash
# Sube al momento lo que Claude apunta: launchd vigila comida/nuevos/ y, cuando aparece un archivo,
# ejecuta comida/subir_nuevos.py (comidas, agua y alimentos nuevos). Solo con el Mac encendido.
# Uso:  bash ~/Projects/Garmin/comida/instalar_apuntar.sh      (para quitarlo: --uninstall)
set -e
LABEL="com.magdalena.comida-subir"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$1" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; echo "✓ Subida al momento de comidas quitada"; exit 0
fi

UV="$(command -v uv || true)"
for p in /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.local/bin/uv"; do [ -z "$UV" ] && [ -x "$p" ] && UV="$p"; done
[ -z "$UV" ] && { echo "No encuentro uv. Ejecuta: brew install uv"; exit 1; }
[ -f "$DIR/mobile/.secrets" ] || { echo "Falta mobile/.secrets (se crea al desplegar)"; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data" "$DIR/comida/nuevos"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$UV</string><string>run</string><string>$DIR/comida/subir_nuevos.py</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$UV"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WatchPaths</key><array><string>$DIR/comida/nuevos</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/comida_subir.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/comida_subir.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ Lo que Claude apunte en comida/nuevos/ se subirá a la app al momento."
echo "  Registro: $DIR/data/comida_subir.log"
