"""`lithophane` command: serves the web app on localhost and opens it in the browser."""

from __future__ import annotations

import argparse
import functools
import http.server
import socket
import sys
import threading
import webbrowser
from pathlib import Path

from . import __version__

DEFAULT_PORT = 8770


def web_root() -> Path:
    # installed wheel: files are copied into lithophane_studio/web
    packaged = Path(__file__).with_name("web")
    if (packaged / "index.html").is_file():
        return packaged
    # running from a git checkout: the app lives at the repo root
    repo = Path(__file__).resolve().parent.parent
    if (repo / "index.html").is_file():
        return repo
    sys.exit("Error: app files not found. Reinstall with `uv tool install --force lithophane-studio`.")


class Handler(http.server.SimpleHTTPRequestHandler):
    # explicit types: on Windows the registry can map .js to text/plain, which breaks ES modules
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".svg": "image/svg+xml",
        ".json": "application/json",
    }

    def log_message(self, *args) -> None:  # keep the terminal quiet
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        # browser closed the connection early (reload, cancelled download): not an error
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


def free_port(host: str, start: int) -> int:
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    sys.exit(f"Error: no free port between {start} and {start + 49}.")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="lithophane",
        description="Open Lithophane Studio in your browser (runs locally, nothing is uploaded).",
    )
    p.add_argument("command", nargs="?", default="ui", choices=["ui"], help="ui (default): open the app")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port (default {DEFAULT_PORT})")
    p.add_argument("--host", default="127.0.0.1", help="address (default 127.0.0.1)")
    p.add_argument("--no-browser", action="store_true", help="do not open the browser")
    p.add_argument("--version", action="version", version=f"lithophane-studio {__version__}")
    args = p.parse_args(argv)

    # Windows consoles may be cp1252: never crash on an accented character
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    root = web_root()
    port = free_port(args.host, args.port)
    server = Server((args.host, port), functools.partial(Handler, directory=str(root)))
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '') else args.host}:{port}/"

    print(f"Lithophane Studio {__version__}: {url}", flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        threading.Timer(0.4, webbrowser.open, (url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0
