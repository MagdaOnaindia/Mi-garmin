"""Instantánea de salud (Health Snapshot, el test de 2 minutos en reposo del reloj).

Garmin no da un JSON para esto: el resultado llega dentro del ZIP de bienestar del día
(data/wellness/AAAA-MM-DD.zip) como un ACTIVITY.fit con el perfil "Health Snapshot".
De su sesión se leen FC media, VFC (RMSSD), respiración, SpO2 y estrés medios.

Necesita garmin-fit-sdk (lo instala uv por la cabecera de garmin_sync.py).
"""
from __future__ import annotations

import zipfile
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WELLNESS = ROOT / "data" / "wellness"
FIT_EPOCH = datetime(1989, 12, 31)

SCHEMA = """
CREATE TABLE IF NOT EXISTS health_snapshot (
  ts TEXT PRIMARY KEY, date TEXT, time TEXT, hr REAL, hrv REAL, sdrr REAL,
  resp REAL, spo2 REAL, stress REAL, source TEXT
);
"""


def _num(v):
    return round(float(v), 1) if isinstance(v, (int, float)) else None


def parse_fit(blob: bytes):
    from garmin_fit_sdk import Decoder, Stream
    msgs, _ = Decoder(Stream.from_byte_array(bytearray(blob))).read()
    out = []
    for s in msgs.get("session_mesgs", []):
        if "snapshot" not in str(s.get("sport_profile_name", "")).lower():
            continue
        act = (msgs.get("activity_mesgs") or [{}])[0]
        start = s.get("start_time") or s.get("timestamp")
        if act.get("local_timestamp") and act.get("timestamp"):
            local = FIT_EPOCH + timedelta(seconds=act["local_timestamp"]) - (act["timestamp"] - start)
        else:
            local = start.astimezone().replace(tzinfo=None)  # zona del Mac
        out.append({
            "ts": local.strftime("%Y-%m-%dT%H:%M:%S"), "date": local.strftime("%Y-%m-%d"), "time": local.strftime("%H:%M"),
            "hr": _num(s.get("avg_heart_rate")), "hrv": _num(s.get("rmssd_hrv")), "sdrr": _num(s.get("sdrr_hrv")),
            "resp": _num(s.get("enhanced_avg_respiration_rate") or s.get("avg_respiration_rate")),
            "spo2": _num(s.get("avg_spo2")), "stress": _num(s.get("avg_stress")),
        })
    return out


def parse_zip(path: Path):
    res = []
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if name.upper().endswith("ACTIVITY.FIT"):
                try:
                    res += parse_fit(z.read(name))
                except Exception:
                    continue  # un FIT raro no debe tumbar la sincronización
    return res


def import_snapshots(con, folder: Path = WELLNESS) -> int:
    con.executescript(SCHEMA)
    n = 0
    for z in sorted(folder.glob("*.zip")):
        try:
            rows = parse_zip(z)
        except (zipfile.BadZipFile, OSError):
            continue
        for r in rows:
            con.execute("INSERT OR REPLACE INTO health_snapshot VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (r["ts"], r["date"], r["time"], r["hr"], r["hrv"], r["sdrr"], r["resp"], r["spo2"], r["stress"], z.name))
            n += 1
    con.commit()
    return n
