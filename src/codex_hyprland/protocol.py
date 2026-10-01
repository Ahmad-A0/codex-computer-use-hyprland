"""The Sky Linux line protocol, NOT an alternative MCP or CUA API."""
import argparse
import json
import sys

from .backend import Backend

PARAMETERS = {
    "list_apps": set(), "list_windows": set(), "get_screenshot": set(),
    "get_window_state": {"window", "include_screenshot", "query"},
    "click": {"window", "element_id", "x", "y", "mouse_button", "click_count", "key", "duration"},
    "scroll": {"window", "element_id", "x", "y", "direction", "pixels", "pages", "key"},
    "drag": {"window", "path", "key"}, "type_text": {"window", "element_id", "text"},
    "press_key": {"window", "key", "duration"},
    "key_down": {"window", "key"}, "key_up": {"window", "key"},
    "clipboard_read": {"window"}, "clipboard_write": {"window", "handle"}, "clipboard_release": {"handle"},
    "drag_handle": {"window", "action", "x", "y"},
    "select_text": {"window", "element_id", "text", "prefix", "suffix", "selection_type"},
    "set_value": {"window", "element_id", "value"},
    "paste": {"window", "text", "format"},
    "perform_secondary_action": {"window", "element_id", "action"},
    "resolve_app": {"app"}, "app_policy": {"window", "app"}, "launch_app": {"app"}, "activate_window": {"window"},
    "move": {"window", "x", "y", "key"}, "move_relative": {"dx", "dy", "key"},
}
# start_audio_recording/stop_audio_recording (SKY_ENABLE_AUDIO=1 only) are not implemented.
MAX_LINE = 2 * 1024 * 1024
INPUT_COMMANDS = {
    'click', 'scroll', 'drag', 'type_text', 'press_key', 'select_text',
    'set_value', 'paste', 'perform_secondary_action', 'activate_window',
    'move', 'move_relative', 'key_down', 'key_up', 'clipboard_read', 'clipboard_write', 'drag_handle',
}


def dispatch(backend, request):
    if not isinstance(request, dict):
        raise ValueError("Request must be an object")
    ident = request.get("id")
    if type(ident) is not int or not 0 <= ident <= 2**53 - 1:
        raise ValueError("Request id must be a nonnegative JavaScript-safe integer")
    method, params = request.get("command"), request.get("input", {})
    if not isinstance(method, str) or method not in PARAMETERS:
        raise ValueError(f"Unsupported Sky Linux command: {method}")
    if not isinstance(params, dict) or params.keys() - PARAMETERS[method]:
        raise ValueError(f"Unsupported parameters for {method}")
    try:
        if method in INPUT_COMMANDS:
            backend.check_holds(method)
        return getattr(backend, method)(params)
    finally:
        # Even a failed action may have delivered partial input. Settle the next
        # observation, never replay the action or delay every inventory request.
        if method in INPUT_COMMANDS:
            backend.defer_observation(params)


def serve(backend, source, sink):
    while line := source.readline(MAX_LINE + 1):
        if len(line) > MAX_LINE:
            raise ValueError("Sky request exceeds the 2 MiB limit")
        request = None
        try:
            request = json.loads(line, parse_constant=lambda v: (_ for _ in ()).throw(ValueError(f"Invalid number: {v}")))
            output = dispatch(backend, request)
            result = {"id": request["id"], "ok": True, "output": output}
        except Exception as exc:
            ident = request.get("id") if isinstance(request, dict) else None
            result = {"id": ident, "ok": False, "error": str(exc)}
        sink.write(json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
        sink.flush()


def main():
    parser = argparse.ArgumentParser(description="Hyprland replacement for the Sky Linux executable")
    parser.add_argument("--mouse-size-px", type=int, help="Accepted for Sky protocol compatibility")
    parser.add_argument("command", choices=["server", "doctor"])
    args = parser.parse_args()
    backend = Backend()
    try:
        if args.command == "doctor":
            print(json.dumps({"backend": "hyprland", "windows": len(backend.list_windows({})),
                              "apps": len(backend.list_apps({})), "at_spi": True}))
        else:
            from .lifecycle import ensure_loaded
            from .accessibility import enable_session_accessibility
            ensure_loaded()
            enable_session_accessibility()
            serve(backend, sys.stdin, sys.stdout)
    finally:
        backend.close()


if __name__ == "__main__":
    main()
