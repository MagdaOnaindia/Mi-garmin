#!/bin/bash
# Pasa la sincronización con Garmin del Mac al servidor de Fly (una sola vez, 2026-10).
# Antes: uv run mobile/garmin_token_servidor.py --stage   (lo ejecuta Magdalena: pide su contraseña de Garmin)
# Uso:   bash ~/Projects/Garmin/mobile/pasar_a_servidor.sh
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(cd .. && pwd)"
APP="$(sed -n 's/^app = "\(.*\)"/\1/p' fly.toml)"
FLY="$(command -v fly || command -v flyctl || echo "$HOME/.fly/bin/flyctl")"
UV="$(command -v uv || echo /opt/homebrew/bin/uv)"
BK="$DIR/mobile/backups/2026-10-09-nube"
mkdir -p "$BK"

"$FLY" secrets list --app "$APP" | grep -q GARMIN_TOKENS || { echo "Falta el secreto GARMIN_TOKENS: ejecuta antes garmin_token_servidor.py"; exit 1; }

echo "1/6 Copias de seguridad"
VOL="$("$FLY" volumes list --app "$APP" --json | python3 -c 'import json,sys; print(next(v["id"] for v in json.load(sys.stdin) if v["name"]=="garmin_data"))')"
"$FLY" volumes snapshots create "$VOL" --app "$APP"
sqlite3 "$DIR/data/garmin.db" ".backup '$BK/garmin.db'"
cp "$DIR/data/animo.csv" "$DIR/data/app_log.csv" "$DIR/data/app_config.json" "$BK/" 2>/dev/null || true

echo "2/6 Paro las tareas antiguas del Mac"
for l in com.magdalena.garmin-sync com.magdalena.garmin-push com.magdalena.garmin-syncpoll; do
  launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
done

echo "3/6 Despliego la app con la sincronización en el servidor"
"$FLY" secrets set --app "$APP" --stage CLOUD_SYNC=1
if ! bash ./deploy.sh; then
  echo "El despliegue falló: vuelvo a activar las tareas del Mac"
  "$FLY" secrets unset --app "$APP" --stage CLOUD_SYNC || true
  for l in com.magdalena.garmin-sync com.magdalena.garmin-push com.magdalena.garmin-syncpoll; do
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$l.plist" 2>/dev/null || true
  done
  exit 1
fi

echo "4/6 Subo la base del Mac al servidor"
"$UV" run ./copia_mac.py --subir-inicial

echo "5/6 Primera sincronización en el servidor"
set -a; . ./.secrets; set +a
printf 'Authorization: Bearer %s\n' "$UPLOAD_TOKEN" | curl -sS --fail-with-body -H @- -X POST "$FLY_URL/api/cloud/run?full=1"; echo
for i in $(seq 1 40); do
  sleep 15
  ST="$(printf 'Authorization: Bearer %s\n' "$UPLOAD_TOKEN" | curl -sS -H @- "$FLY_URL/api/cloud/status")"
  echo "$ST" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if not d["running"] and (d.get("last") or {}).get("last_end") else 1)' && break
done
echo "$ST" | python3 -c 'import json,sys; d=json.load(sys.stdin); l=d.get("last") or {}; print("Resultado:", "bien" if l.get("ok") else "con errores: %s" % l.get("error")); print(d.get("log","")[-1500:])'

echo "6/6 Copia automática en el Mac"
bash ./install_copia.sh
echo "✓ Hecho. El servidor sincroniza cada 30 min; el Mac solo guarda una copia."
