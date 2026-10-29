"""Añade el MCP de Garmin a Claude Desktop sin tocar el resto de la config.
Uso:  uv run --python 3.12 python ~/Projects/Garmin/setup/add_garmin_mcp.py
"""
import json, shutil, os, time
from pathlib import Path

cfg = Path.home() / "Library/Application Support/Claude/claude_desktop_config.json"
cfg.parent.mkdir(parents=True, exist_ok=True)

# Claude Desktop no hereda el PATH de la terminal: usamos la ruta absoluta de uvx
uvx = shutil.which("uvx") or next(
    (p for p in ["/opt/homebrew/bin/uvx", "/usr/local/bin/uvx",
                 str(Path.home() / ".local/bin/uvx"), str(Path.home() / ".cargo/bin/uvx")]
     if os.path.exists(p)), None)
if not uvx:
    raise SystemExit("No encuentro uvx. Ejecuta: brew install uv")

data = {}
if cfg.exists() and cfg.read_text().strip():
    backup = cfg.with_suffix(f".backup-{int(time.time())}.json")
    shutil.copy(cfg, backup)
    print(f"Copia de seguridad: {backup}")
    data = json.loads(cfg.read_text())

data.setdefault("mcpServers", {})["garmin"] = {
    "command": uvx,
    "args": ["--python", "3.12", "--from",
             "git+https://github.com/Taxuspt/garmin_mcp", "garmin-mcp"],
}
cfg.write_text(json.dumps(data, indent=2, ensure_ascii=False))
print(f"✓ MCP 'garmin' añadido en {cfg}")
print(f"  uvx: {uvx}")
print("Ahora cierra Claude Desktop del todo (Cmd+Q) y vuelve a abrirlo.")
