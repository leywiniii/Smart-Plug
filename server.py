from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import socket
import time
import threading

# ======================================
# SETTINGS
# ======================================

PORT = 8080                          # must match your Cloudflare service (http://localhost:8080)
API_KEY = "psu-smartplug-2026"       # must match API_KEY in the ESP32 code
STALE_AFTER_SECONDS = 10             # mark data "offline" if ESP32 stops sending

# Website folder = the folder where this file is saved
WEB_DIR = os.path.dirname(os.path.abspath(__file__))

# Files that must never be downloadable from the website
BLOCKED_EXTENSIONS = (".py", ".pyc", ".ino", ".env", ".bat", ".ps1", ".log")

latest = None          # last readings received from ESP32
last_update = 0.0      # time of last upload
lock = threading.Lock()


class MySmartPlugServer(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    # ---------- helpers ----------

    def _send_json(self, code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _clean_path(self):
        return self.path.split("?")[0]

    def _is_api_path(self):
        return self._clean_path() == "/api/readings"

    def _is_blocked_file(self):
        path = self._clean_path().lower()
        parts = [p for p in path.split("/") if p]
        if any(p.startswith(".") for p in parts):
            return True
        return path.endswith(BLOCKED_EXTENSIONS)

    # ---------- methods ----------

    def do_OPTIONS(self):
        self._send_json(204, {})

    # ESP32 -> server
    def do_POST(self):
        global latest, last_update

        if not self._is_api_path():
            self._send_json(404, {"error": "Not found"})
            return

        if self.headers.get("X-API-Key") != API_KEY:
            self._send_json(401, {"error": "Invalid API key"})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {"error": "Invalid JSON"})
            return

        with lock:
            latest = data
            last_update = time.time()

        print(f"[ESP32] {data}")
        self._send_json(200, {"status": "ok"})

    # Website API + website files
    def do_GET(self):
        if self._is_api_path():
            with lock:
                if latest is None:
                    self._send_json(503, {
                        "error": "No data received from ESP32 yet",
                        "online": False
                    })
                    return

                age = time.time() - last_update
                result = dict(latest)
                result["online"] = age <= STALE_AFTER_SECONDS
                result["age_seconds"] = round(age, 1)

            self._send_json(200, result)
            return

        if self._is_blocked_file():
            self._send_json(404, {"error": "Not found"})
            return

        super().do_GET()   # serve index.html, css, js, images...

    def list_directory(self, path):
        self._send_json(404, {"error": "Not found"})
        return None

    def log_message(self, format, *args):
        pass  # quiet console


# Listen on IPv4 AND IPv6 (Cloudflare tunnel may connect through ::1)
class DualStackServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


try:
    server = DualStackServer(("::", PORT), MySmartPlugServer)
except OSError as error:
    print(f"Could not start on port {PORT}: {error}")
    print("Another program is already using this port.")
    print("Stop 'python -m http.server 8080' (Ctrl+C in that terminal) and try again.")
    raise SystemExit(1)

print("===================================")
print("       MY SMART PLUG SERVER")
print("===================================")
print(f"Website folder   : {WEB_DIR}")
print(f"Website          : http://localhost:{PORT}/")
print(f"ESP32 uploads to : POST /api/readings")
print(f"Website reads    : GET  /api/readings")
print("===================================")

try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\nServer stopped.")
    server.server_close()
