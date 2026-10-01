"""Save screenshots of the given test windows for the e2e report.
Usage: snap.py OUT_DIR LABEL ADDRESS...  Prints one JSON object per saved image.
Uses the provider's exact per-window capture, so only those windows are
captured (never the rest of the desktop), even on another workspace."""
import json
import re
import shutil
import sys
from pathlib import Path
from codex_hyprland.backend import Backend

out, label, addresses = Path(sys.argv[1]), sys.argv[2], set(sys.argv[3:])
shots = out / 'shots'
shots.mkdir(parents=True, exist_ok=True)
backend = Backend()
try:
    for client in backend.clients():
        if client['address'] not in addresses:
            continue
        name = re.sub(r'[^A-Za-z0-9._-]+', '-', f"{label}-{client['class']}-{client['address'][-6:]}")[:150]
        try:
            image = backend.screenshot(client)[0]['filepath']
            target = shots / f'{name}.jpg'
            shutil.copyfile(image, target)
            print(json.dumps({'window': client['title'], 'class': client['class'], 'file': f'shots/{target.name}'}))
        except Exception as error:  # Diagnostics must never fail the run.
            print(json.dumps({'window': client['title'], 'class': client['class'], 'error': str(error)}))
finally:
    backend.close()
