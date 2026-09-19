#!/usr/bin/env python3
"""Load or safely replace the locally built module in the selected session."""
import json
from codex_hyprland import session
from codex_hyprland.lifecycle import ensure_loaded
session.ensure_session_env()
print(json.dumps(ensure_loaded()))
