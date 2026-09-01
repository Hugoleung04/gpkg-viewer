#!/usr/bin/env python3
"""Launch the Offline GeoPackage Viewer on a local HTTP server.

GeoPackage WASM cannot reliably load from file:// URLs, so a tiny
local server is required. Nothing is sent off this machine.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser


ROOT = os.path.dirname(os.path.abspath(__file__))


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[viewer] " + (fmt % args) + "\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def find_port(preferred: int) -> int:
    for port in [preferred] + list(range(preferred + 1, preferred + 20)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("0.0.0.0", port))
            except OSError:
                continue
            return port
    raise RuntimeError("No free port found")


def lan_addresses():
    found = []
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        found.append(sock.getsockname()[0])
        sock.close()
    except OSError:
        pass
    try:
        hostname = socket.gethostname()
        found.append(socket.gethostbyname(hostname))
    except OSError:
        pass
    out = []
    for ip in found:
        if ip and not ip.startswith("127.") and ip not in out:
            out.append(ip)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline GeoPackage Viewer")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    os.chdir(ROOT)
    port = find_port(args.port)
    handler = functools.partial(QuietHandler, directory=ROOT)
    httpd = socketserver.ThreadingTCPServer(("0.0.0.0", port), handler)
    httpd.daemon_threads = True

    local = f"http://127.0.0.1:{port}/"
    print("=" * 60)
    print("  Offline GeoPackage Viewer")
    print(f"  This computer: {local}")
    for ip in lan_addresses():
        print(f"  Phone on same Wi-Fi: http://{ip}:{port}/")
    print("  Press Ctrl+C to stop.")
    print("=" * 60)

    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(local)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
