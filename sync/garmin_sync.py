# /// script
# requires-python = ">=3.10"
# dependencies = ["garminconnect>=0.3", "garmin-fit-sdk"]
# ///
"""Sincroniza Garmin Connect -> data/garmin.db (SQLite) y regenera el dashboard.

Uso (desde la Terminal del Mac):
    uv run ~/Projects/Garmin/sync/garmin_sync.py              # incremental (últimos 3 días)
    uv run ~/Projects/Garmin/sync/garmin_sync.py --since 2026-10-06
    uv run ~/Projects/Garmin/sync/garmin_sync.py --export-only   # solo regenera dashboard/data.js

Usa el token guardado por garmin-mcp-auth en ~/.garminconnect (no pide contraseña).
En el servidor (Fly) lo lanza sync/cloud_sync.py, con el token en GARMINTOKENS.
"""
from __future__ import annotations

import argparse
import csv
import fcntl
import os
import subprocess
import json
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "garmin.db"
TOKENS = Path(os.environ.get("GARMINTOKENS") or Path.home() / ".garminconnect")  # en Fly: /data/garmin/.garminconnect
FIRST_DAY = "2026-10-06"  # el reloj llegó el 7-10-2026
WATCH_SINCE = "2026-10-07"  # día que llegó el vívoactive 6: antes no hay ZIP de bienestar
LOCK = ROOT / "data" / "syncpoll.lock"  # el mismo candado que mobile/sync_poll.py
PAUSE = 0.6  # segundos entre llamadas, para no provocar el límite (429) de Garmin

SCHEMA = """
CREATE TABLE IF NOT EXISTS daily (
  date TEXT PRIMARY KEY,
  steps INTEGER, step_goal INTEGER, rhr INTEGER, stress_avg INTEGER,
  bb_high INTEGER, bb_low INTEGER, bb_wake INTEGER, bb_charged INTEGER, bb_drained INTEGER,
  im_moderate INTEGER, im_vigorous INTEGER, kcal_active REAL, kcal_total REAL,
  sleep_s INTEGER, deep_s INTEGER, light_s INTEGER, rem_s INTEGER, awake_s INTEGER,
  sleep_score INTEGER, sleep_start TEXT, sleep_end TEXT, resp_sleep REAL, spo2_avg REAL,
  hrv_night REAL, hrv_weekly REAL, hrv_status TEXT, hrv_base_low REAL, hrv_base_high REAL,
  readiness INTEGER, readiness_level TEXT, vo2max REAL, training_status TEXT,
  acute_load REAL, chronic_load REAL, acwr_garmin REAL,
  cycle_day INTEGER, cycle_len INTEGER, period_len INTEGER, cycle_phase_garmin INTEGER,
  flow TEXT, symptoms TEXT, moods TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY, date TEXT, start_local TEXT, name TEXT, type_key TEXT, category TEXT,
  duration_s REAL, distance_m REAL, avg_hr REAL, max_hr REAL, kcal REAL,
  aerobic_te REAL, anaerobic_te REAL, load REAL, rpe REAL, feel REAL,
  z1_s REAL, z2_s REAL, z3_s REAL, z4_s REAL, z5_s REAL, im_moderate INTEGER, im_vigorous INTEGER,
  raw TEXT
);
CREATE TABLE IF NOT EXISTS lifestyle (
  date TEXT, behavior TEXT, value TEXT, PRIMARY KEY (date, behavior)
);
CREATE TABLE IF NOT EXISTS mood_log (
  ts TEXT, date TEXT, mood REAL, energy REAL, note TEXT, source TEXT
);
CREATE TABLE IF NOT EXISTS app_log (
  date TEXT, kind TEXT, key TEXT, value REAL, ts TEXT, PRIMARY KEY (date, kind, key)
);
CREATE TABLE IF NOT EXISTS raw (
  date TEXT, endpoint TEXT, json TEXT, fetched_at TEXT, PRIMARY KEY (date, endpoint)
);
"""


def dig(d, *path, default=None):
    for p in path:
        if isinstance(d, dict):
            d = d.get(p)
        elif isinstance(d, list) and isinstance(p, int) and len(d) > p:
            d = d[p]
        else:
            return default
        if d is None:
            return default
    return d


def category(type_key: str, name: str) -> str:
    t, n = (type_key or "").lower(), (name or "").lower()
    # Sesión especial de fuerza y movilidad (psoas, cadera, lumbar)
    if any(k in n for k in ("movilidad", "psoas", "cadera", "lumbar")):
        return "Movilidad"
    if "hiit" in t or "tabata" in n or "funcional" in n:
        return "HIIT"
    if "strength" in t or "fuerza" in n:
        return "Fuerza"
    if "treadmill" in t or "cinta" in n:
        return "Cinta"
    if "cycling" in t or "bike" in t or "bici" in n:
        return "Bici"
    if "walk" in t or "hiking" in t:
        return "Caminar"
    if "yoga" in t or "pilates" in t or "mobility" in t or "breathwork" in t:
        return "Movilidad"
    return "Otro"


def ms_to_local(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M") if ms else None


class Syncer:
    def __init__(self, con):
        from garminconnect import Garmin

        self.con = con
        self.g = Garmin()
        self.g.login(str(TOKENS))

    def call(self, day, endpoint, fn, *args):
        try:
            res = fn(*args)
        except Exception as e:  # una métrica que falla no debe parar todo
            print(f"  · {endpoint} {day}: {type(e).__name__}: {str(e)[:120]}")
            res = None
        time.sleep(PAUSE)
        if res is not None:
            self.con.execute(
                "INSERT OR REPLACE INTO raw VALUES (?,?,?,?)",
                (day, endpoint, json.dumps(res), datetime.now().isoformat(timespec="seconds")),
            )
        return res

    def day(self, d: str):
        g = self.g
        us = self.call(d, "user_summary", g.get_user_summary, d) or {}
        sl = self.call(d, "sleep", g.get_sleep_data, d) or {}
        hrv = self.call(d, "hrv", g.get_hrv_data, d) or {}
        tr = self.call(d, "training_readiness", g.get_training_readiness, d) or []
        ts = self.call(d, "training_status", g.get_training_status, d) or {}
        mn = self.call(d, "menstrual", g.get_menstrual_data_for_date, d) or {}
        ll = self.call(d, "lifestyle", g.get_lifestyle_logging_data, d) or {}
        mm = self.call(d, "max_metrics", g.get_max_metrics, d) or []  # VO2max (training_status no siempre lo trae)
        mm0 = mm[0] if isinstance(mm, list) and mm else (mm if isinstance(mm, dict) else {})
        self.lifestyle(d, ll)
        self.snapshot(d)

        dto = sl.get("dailySleepDTO") or {}
        hs = hrv.get("hrvSummary") or {}
        tr0 = tr[0] if isinstance(tr, list) and tr else (tr if isinstance(tr, dict) else {})
        tsd = dig(ts, "mostRecentTrainingStatus", "latestTrainingStatusData") or {}
        tsd = next(iter(tsd.values()), {}) if isinstance(tsd, dict) else {}
        atl = tsd.get("acuteTrainingLoadDTO") or {}
        ds, log = mn.get("daySummary") or {}, mn.get("dayLog") or {}

        row = dict(
            date=d,
            steps=us.get("totalSteps"), step_goal=us.get("dailyStepGoal"),
            rhr=us.get("restingHeartRate") or sl.get("restingHeartRate"),
            stress_avg=us.get("averageStressLevel"),
            bb_high=us.get("bodyBatteryHighestValue"), bb_low=us.get("bodyBatteryLowestValue"),
            bb_wake=us.get("bodyBatteryAtWakeTime"), bb_charged=us.get("bodyBatteryChargedValue"),
            bb_drained=us.get("bodyBatteryDrainedValue"),
            im_moderate=us.get("moderateIntensityMinutes"), im_vigorous=us.get("vigorousIntensityMinutes"),
            kcal_active=us.get("activeKilocalories"), kcal_total=us.get("totalKilocalories"),
            sleep_s=dto.get("sleepTimeSeconds"), deep_s=dto.get("deepSleepSeconds"),
            light_s=dto.get("lightSleepSeconds"), rem_s=dto.get("remSleepSeconds"),
            awake_s=dto.get("awakeSleepSeconds"),
            sleep_score=dig(dto, "sleepScores", "overall", "value"),
            sleep_start=ms_to_local(dto.get("sleepStartTimestampLocal")),
            sleep_end=ms_to_local(dto.get("sleepEndTimestampLocal")),
            resp_sleep=dto.get("averageRespirationValue"), spo2_avg=dto.get("averageSpO2Value"),
            hrv_night=hs.get("lastNightAvg") or sl.get("avgOvernightHrv"),
            hrv_weekly=hs.get("weeklyAvg"), hrv_status=hs.get("status") or sl.get("hrvStatus"),
            hrv_base_low=dig(hs, "baseline", "balancedLow"), hrv_base_high=dig(hs, "baseline", "balancedUpper"),
            readiness=tr0.get("score"), readiness_level=tr0.get("level"),
            vo2max=dig(ts, "mostRecentVO2Max", "generic", "vo2MaxPreciseValue")
            or dig(ts, "mostRecentVO2Max", "generic", "vo2MaxValue")
            or dig(mm0, "generic", "vo2MaxPreciseValue") or dig(mm0, "generic", "vo2MaxValue"),
            training_status=tsd.get("trainingStatusFeedbackPhrase") or tsd.get("trainingStatus"),
            acute_load=atl.get("dailyTrainingLoadAcute"), chronic_load=atl.get("dailyTrainingLoadChronic"),
            acwr_garmin=atl.get("dailyAcuteChronicWorkloadRatio"),
            cycle_day=ds.get("dayInCycle"), cycle_len=ds.get("predictedCycleLength") or ds.get("cycleLength"),
            period_len=ds.get("periodLength"), cycle_phase_garmin=ds.get("currentPhase"),
            flow=log.get("flow"), symptoms=",".join(log.get("symptoms") or []) or None,
            moods=",".join(log.get("moods") or []) or None,
            updated_at=datetime.now().isoformat(timespec="seconds"),
        )
        cols = ",".join(row)
        self.con.execute(
            f"INSERT OR REPLACE INTO daily ({cols}) VALUES ({','.join('?' * len(row))})",
            list(row.values()),
        )

    def lifestyle(self, d, data):
        """Hábitos del Registro de estilo de vida. El formato de Garmin no está documentado:
        se lee de forma tolerante y el JSON completo queda en la tabla raw."""
        rep = data.get("dailyLogsReport")
        items = rep if isinstance(rep, list) else (rep or {}).get("logs") or (rep or {}).get("dailyLogs") or []
        for it in items if isinstance(items, list) else []:
            if not isinstance(it, dict):
                continue
            name = next((it[k] for k in ("behaviorName", "name", "logName", "displayName", "behaviorKey") if it.get(k)), None)
            if not name:
                name = next((v for k, v in it.items() if "name" in k.lower() and isinstance(v, str)), None)
            val = next((it[k] for k in ("logValue", "value", "amount", "logStatus", "status", "isLogged", "logged") if k in it), None)
            if name:
                self.con.execute("INSERT OR REPLACE INTO lifestyle VALUES (?,?,?)", (d, str(name), json.dumps(val)))

    def snapshot(self, d):
        """Guarda el ZIP de bienestar del día (incluye la Instantánea de salud si la hiciste)."""
        if d < WATCH_SINCE:
            return
        out = ROOT / "data" / "wellness" / f"{d}.zip"
        # Solo se salta si se bajó cuando el día ya había terminado (si no, faltaría lo de la noche)
        if out.exists() and date.fromtimestamp(out.stat().st_mtime).isoformat() > d:
            return
        # El del día en curso, como mucho cada 2 h (el servidor sincroniza cada 30 min), salvo si lo pides desde el móvil
        if out.exists() and time.time() - out.stat().st_mtime < 2 * 3600 and not os.environ.get("SYNC_FORCE"):
            return
        try:
            blob = self.g.download_health_snapshot(d)
            if blob:
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(blob)
        except Exception as e:
            print(f"  · wellness {d}: {type(e).__name__}")
        time.sleep(PAUSE)

    def activities(self, start: str, end: str):
        acts = self.call(f"{start}..{end}", "activities", self.g.get_activities_by_date, start, end) or []
        for a in acts:
            tk = dig(a, "activityType", "typeKey", default="")
            rpe = a.get("directWorkoutRpe")
            feel = a.get("directWorkoutFeel")
            z = [a.get(f"hrTimeInZone_{i}") for i in range(1, 6)]
            self.con.execute(
                "INSERT OR REPLACE INTO activities VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    a.get("activityId"), (a.get("startTimeLocal") or "")[:10], a.get("startTimeLocal"),
                    a.get("activityName"), tk, category(tk, a.get("activityName")),
                    a.get("duration"), a.get("distance"), a.get("averageHR"), a.get("maxHR"),
                    a.get("calories"), a.get("aerobicTrainingEffect"), a.get("anaerobicTrainingEffect"),
                    a.get("activityTrainingLoad"),
                    rpe / 10 if rpe else None, feel,
                    *z, a.get("moderateIntensityMinutes"), a.get("vigorousIntensityMinutes"),
                    json.dumps(a),
                ),
            )
        print(f"  {len(acts)} actividades")
        self.exercise_sets(acts)

    def exercise_sets(self, acts):
        """Series que grabó el reloj (fuerza, HIIT, movilidad) y el nombre del entrenamiento de Connect.
        Van a la tabla raw ('exercise_sets:<id>', 'workout:<id>'); se piden una vez, y de nuevo si la actividad es de los 2 últimos días."""
        recent = (date.today() - timedelta(days=2)).isoformat()
        have = {r[0] for r in self.con.execute("SELECT endpoint FROM raw WHERE endpoint LIKE 'exercise_sets:%' OR endpoint LIKE 'workout:%'")}
        for a in acts:
            tk = dig(a, "activityType", "typeKey", default="")
            if category(tk, a.get("activityName")) not in ("Fuerza", "HIIT", "Movilidad"):
                continue
            aid, d = a.get("activityId"), (a.get("startTimeLocal") or "")[:10]
            if f"exercise_sets:{aid}" not in have or d >= recent:
                self.call(d, f"exercise_sets:{aid}", self.g.get_activity_exercise_sets, aid)
            wid = a.get("workoutId")
            if wid and f"workout:{wid}" not in have:
                self.call(d, f"workout:{wid}", self.g.get_workout_by_id, wid)
                have.add(f"workout:{wid}")


MOOD_FILES = [
    ROOT / "data" / "animo.csv",
    # Atajo del iPhone: carpeta Garmin de iCloud Drive, o la carpeta por defecto de Atajos
    Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Garmin/animo.csv",
    Path.home() / "Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/animo.csv",
    Path.home() / "Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Garmin/animo.csv",
]


def import_app_log(con):
    """Hábitos (1/0) y medidas que registras en la app del móvil (data/app_log.csv, lo deja mobile/push.py)."""
    f = ROOT / "data" / "app_log.csv"
    con.execute("DELETE FROM app_log")
    try:
        rows = list(csv.DictReader(f.open(encoding="utf-8")))
    except (FileNotFoundError, PermissionError, OSError):
        return
    n = 0
    for r in rows:
        try:
            value = float(str(r.get("value", "")).replace(",", "."))
        except ValueError:
            continue
        if not r.get("date") or not r.get("key"):
            continue
        con.execute("INSERT OR REPLACE INTO app_log VALUES (?,?,?,?,?)",
                    (r["date"][:10], r.get("kind") or "metric", r["key"], value, r.get("ts")))
        n += 1
    print(f"  {n} registros de la app")


def import_moods(con):
    """Lee las líneas del atajo de ánimo: fecha-hora ISO, ánimo 1-5, energía 1-5, nota."""
    con.execute("DELETE FROM mood_log WHERE source='csv'")
    n = 0
    for f in MOOD_FILES:
        try:
            lines = f.read_text(encoding="utf-8").splitlines()
        except (FileNotFoundError, PermissionError, OSError):
            continue
        for line in lines:
            parts = [p.strip() for p in line.split(",", 3)]
            if len(parts) < 2 or not parts[0][:4].isdigit():
                continue
            num = lambda x: float(x.replace(",", ".")) if x and x.replace(",", ".").replace(".", "", 1).isdigit() else None
            mood = num(parts[1])
            energy = num(parts[2]) if len(parts) > 2 else None
            note = parts[3] if len(parts) > 3 else None
            con.execute("INSERT INTO mood_log VALUES (?,?,?,?,?,'csv')", (parts[0], parts[0][:10], mood, energy, note))
            n += 1
    if n:
        print(f"  {n} registros de ánimo")


def daterange(a: date, b: date):
    while a <= b:
        yield a
        a += timedelta(days=1)


def launched_by_sync_poll():
    """True si un proceso padre es mobile/sync_poll.py, que ya tiene el candado tomado para nosotros."""
    pid = os.getppid()
    for _ in range(8):
        if pid <= 1:
            return False
        r = subprocess.run(["ps", "-o", "ppid=,command=", "-p", str(pid)], capture_output=True, text=True)
        parts = r.stdout.strip().split(None, 1)
        if len(parts) < 2:
            return False
        argv = parts[1].split()
        if Path(argv[0]).name not in ("sh", "bash", "zsh") and any(t.endswith("sync_poll.py") for t in argv[:4]):
            return True
        pid = int(parts[0])
    return False


def take_lock():
    """Evita que la sync de las 09:00/22:00 se solape con la que pide el móvil. Devuelve el fichero abierto."""
    LOCK.parent.mkdir(exist_ok=True)
    fh = open(LOCK, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        if launched_by_sync_poll():
            fh.close()
            return None
        sys.exit("Ya hay una sincronización en marcha (data/syncpoll.lock); esta se salta.")
    return fh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="YYYY-MM-DD; por defecto, 3 días antes de lo último guardado")
    ap.add_argument("--lookback", type=int, default=3, help="días hacia atrás desde lo último guardado (por defecto 3)")
    ap.add_argument("--export-only", action="store_true")
    args = ap.parse_args()

    DB.parent.mkdir(exist_ok=True)
    lock = take_lock()  # noqa: F841 (se suelta al terminar el proceso)
    con = sqlite3.connect(DB)
    con.executescript(SCHEMA)

    if not args.export_only:
        last = con.execute("SELECT max(date) FROM daily").fetchone()[0]
        if args.since:
            start = date.fromisoformat(args.since)
        elif last:
            start = date.fromisoformat(last) - timedelta(days=args.lookback)  # Garmin completa datos con retraso
        else:
            start = date.fromisoformat(FIRST_DAY)
        today = date.today()
        print(f"Sincronizando {start} → {today}")
        try:
            s = Syncer(con)
        except Exception as e:
            sys.exit(
                f"No pude entrar en Garmin con el token de {TOKENS}: {e}\n"
                + ("En el servidor: renueva el token desde el Mac con uv run mobile/garmin_token_servidor.py"
                   if os.environ.get("GARMINTOKENS") else
                   "Si han pasado ~6 meses, repite: uvx --python 3.12 --from "
                   "git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth")
            )
        for d in daterange(start, today):
            print(f"· {d}")
            s.day(d.isoformat())
            con.commit()
        s.activities(start.isoformat(), today.isoformat())
        s.call(today.isoformat(), "hr_zones", s.g.get_heart_rate_zones)  # zonas de pulso del perfil (raw); las usa la app
        con.commit()
    import_moods(con)
    import_app_log(con)
    try:  # Instantánea de salud: va dentro de los ZIP de bienestar
        from health_snapshot import import_snapshots
        import_snapshots(con)
    except Exception as e:
        print(f"  ! Instantáneas de salud no se leyeron: {e}", file=sys.stderr)
    con.commit()

    # Cronometer y creatina (nutrition/). Si algo falla, el resto del dashboard se actualiza igual.
    try:
        sys.path.insert(0, str(ROOT / "nutrition"))
        from cronometer_import import import_cronometer
        done = import_cronometer(con)
        if done:
            print("✓ Cronometer: " + ", ".join(f"{k} ({n} días)" for k, n in done.items()))
    except Exception as e:
        print(f"  ! Cronometer no se importó: {e}", file=sys.stderr)
    # Pestaña Comida de la app del móvil (los días con Cronometer mandan)
    try:
        from app_food import download, import_app_food
        try:
            download()
        except Exception as e:
            print(f"  ! No pude bajar la comida de la app, uso la última copia: {e}", file=sys.stderr)
        n = import_app_food(con)
        if n:
            print(f"✓ Comida de la app: {n} días")
    except Exception as e:
        print(f"  ! Comida de la app no se importó: {e}", file=sys.stderr)
    try:
        from creatina import analyse
        (ROOT / "data" / "creatina.json").write_text(json.dumps(analyse(con), ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception as e:
        print(f"  ! Nutrición/creatina no se actualizó: {e}", file=sys.stderr)

    sys.path.insert(0, str(Path(__file__).parent))
    from export_dashboard import export

    out = export(con)
    print(f"✓ Dashboard actualizado: {out}")


if __name__ == "__main__":
    main()
