"""Merge the generated provider entry into Codex config, or remove it, preserving other settings."""
import argparse
from datetime import datetime
import os
from pathlib import Path
import sys
import tempfile
import tomlkit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--project', action='store_true', help='Register for this checkout instead of globally.')
parser.add_argument('--remove', action='store_true', help="Remove this installation's cua_repl entry.")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
config_home = root / '.codex' if args.project else Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
path = config_home / 'config.toml'
original = path.read_text() if path.exists() else ''
document = tomlkit.parse(original)
if args.remove:
    servers = document.get('mcp_servers')
    provider = servers.get('cua_repl') if servers is not None else None
    if provider is None:
        print(f'Provider not registered in {path}')
        raise SystemExit(0)
    launcher = str(root / 'scripts/launch.mjs')
    if launcher not in list(provider.get('args', [])):
        print(f'{path}: cua_repl runs {list(provider.get("args", []))}, not this installation '
              f'({launcher}); left unchanged.', file=sys.stderr)
        raise SystemExit(1)
    del servers['cua_repl']
    if not servers:
        del document['mcp_servers']
else:
    entry = tomlkit.parse(sys.stdin.read())['mcp_servers']['cua_repl']
    servers = document.setdefault('mcp_servers', tomlkit.table())
    provider = servers.setdefault('cua_repl', tomlkit.table())
    for key, value in entry.items():
        if key == 'env':
            provider.setdefault('env', tomlkit.table()).update(value)
        else:
            provider[key] = value
updated = tomlkit.dumps(document)
if updated == original:
    print(f'Provider already registered in {path}')
    raise SystemExit(0)
config_home.mkdir(parents=True, exist_ok=True)
descriptor, temporary = tempfile.mkstemp(prefix='.codex-config-', dir=config_home)
try:
    with os.fdopen(descriptor, 'w') as stream:
        os.fchmod(stream.fileno(), path.stat().st_mode & 0o777 if path.exists() else 0o600)
        stream.write(updated)
        stream.flush()
        os.fsync(stream.fileno())
    if path.exists():
        if path.read_text() != original:
            raise RuntimeError('Codex config changed meanwhile; run the command again.')
        backup = path.with_name(path.name + '.before-hyprland-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
        with backup.open('x') as stream:
            os.chmod(backup, 0o600)
            stream.write(original)
        print(f'Backed up {path} to {backup}')
    os.replace(temporary, path)
finally:
    Path(temporary).unlink(missing_ok=True)
print(f'{"Removed provider from" if args.remove else "Registered provider in"} {path}')
