# Mi Garmin: salud y entrenamiento

Ecosistema para analizar los datos del Garmin vívoactive 6 (desde el 7-10-2026).

## Estructura
| Carpeta | Qué contiene |
|---|---|
| `sync/garmin_sync.py` | Descarga de Garmin Connect el sueño, la VFC, la FC en reposo, el Body Battery, el estrés, la preparación, el estado de entrenamiento, el ciclo y las actividades, y los guarda en `data/garmin.db` (SQLite). Al terminar, regenera el dashboard. |
| `sync/export_dashboard.py` | Calcula medias móviles, líneas base, la carga (sRPE y ratio 7/28), las fases del ciclo y el semáforo diario. |
| `sync/install_daily.sh` | Programa la sincronización automática (09:00 y 22:00). |
| `sync/make_demo.py` | Genera datos de ejemplo inventados para ver el dashboard lleno. |
| `dashboard/index.html` | El panel. Ábrelo con doble clic. |
| `research/` | Fichas con los estudios en los que se basa cada métrica y cada umbral. Empieza por `00-metodologia.md`. |
| `data/wellness/` | ZIP diario de bienestar de Garmin, que incluye la Instantánea de salud. |
| `setup/` | Configuración del MCP de Garmin para Claude Desktop. |

## Uso
```bash
# Primera sincronización (desde el 6-10-2026)
uv run ~/Projects/Garmin/sync/garmin_sync.py

# Dejarla automática
bash ~/Projects/Garmin/sync/install_daily.sh

# Ver el panel
open ~/Projects/Garmin/dashboard/index.html
```
Usa el token de `~/.garminconnect`, que dura unos 6 meses. Si caduca, repite `garmin-mcp-auth`. No repitas el inicio de sesión muchas veces seguidas, porque Garmin bloquea temporalmente (error 429).

## Hábitos que mejoran el análisis
- Llevar el reloj también de noche.
- Elegir el perfil correcto en cada sesión: HIIT (martes y jueves), Fuerza, Bici interior y Cinta.
- Grabar la sesión especial de psoas, cadera y lumbar como Fuerza con el nombre "Movilidad".
- Registrar el ánimo: diario en Garmin Connect (Salud femenina) y puntual con el atajo del iPhone, que escribe en iCloud Drive › Garmin › animo.csv (también vale `data/animo.csv`).
- Registro de estilo de vida en Garmin Connect con 4 o 5 hábitos.
- Responder al esfuerzo percibido (1–10) al terminar cada sesión.
- Registrar la regla y los síntomas en Salud femenina.
