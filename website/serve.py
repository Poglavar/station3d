#!/usr/bin/env python3
"""Dev static server with caching disabled.

`python -m http.server` sends Last-Modified but no Cache-Control, so browsers
heuristically cache assets — and ES-module import trees (station-3d/index.js
and everything it imports) can't be busted by a query string on the entry, so
a stale buildings.js keeps loading until a hard refresh. Serving with
Cache-Control: no-store forces a re-fetch every time, which is what you want
in local development.

Usage (from the website/ directory):
    python3 serve.py [port]        # default 8091, binds 127.0.0.1
"""

import sys
import threading
import json
import subprocess
import hashlib
from io import BytesIO
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import unquote, urlsplit


VENDOR_PREFIX = "/__station3d_vendor__/"
WEBSITE_ROOT = Path(__file__).resolve().parent
VENDOR_ROOT = Path(__file__).resolve().parent.parent / "node_modules"
sys.path.insert(0, str(WEBSITE_ROOT.parent / "tools"))
from model_viewer_blender import blender_path, convert_blend, MAX_BYTES
from model_viewer_assets import list_local_models, resolve_local_asset
PUBLIC_VENDOR_ROUTES = (
    ("/vendor/three/", VENDOR_ROOT / "three"),
    ("/vendor/leaflet/", VENDOR_ROOT / "leaflet" / "dist"),
    ("/vendor/leaflet-heat/", VENDOR_ROOT / "leaflet.heat" / "dist"),
    ("/vendor/turf/", VENDOR_ROOT / "@turf" / "turf"),
    ("/vendor/html2canvas/", VENDOR_ROOT / "html2canvas" / "dist"),
    ("/vendor/maplibre/", VENDOR_ROOT / "maplibre-gl" / "dist"),
)
BLENDER_CONVERSION_LOCK = threading.Lock()


class NoCacheHandler(SimpleHTTPRequestHandler):
    def _model_viewer_path(self):
        path = unquote(urlsplit(self.path).path)
        return path[len("/prijevoz"):] if path.startswith("/prijevoz/") else path

    def _json(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _model_viewer_allowed(self):
        host = self.headers.get("Host", "").lower()
        try:
            host_name = urlsplit("http://" + host).hostname
        except ValueError:
            return False
        if host_name not in ("127.0.0.1", "localhost", "::1"):
            return False
        origin = self.headers.get("Origin")
        if origin and (urlsplit(origin).scheme != "http" or urlsplit(origin).netloc.lower() != host):
            return False
        return self.headers.get("X-Model-Viewer") == "1"

    def send_head(self):
        path = self._model_viewer_path()
        if path == "/station-3d/workers/render-compiler-worker.js":
            # Compile on each Worker request so native development never uses
            # stale generated code. This changes no files or production assets.
            try:
                result = subprocess.run(
                    ["node", str(WEBSITE_ROOT.parent / "tools/bundle-station3d-worker.mjs")],
                    cwd=WEBSITE_ROOT.parent, capture_output=True, check=True, timeout=30,
                )
            except (OSError, subprocess.SubprocessError) as exc:
                body = json.dumps({"error": "Station3D Worker build failed", "detail": str(exc)}).encode()
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return BytesIO(body)
            body = result.stdout
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Station3D-Worker-SHA256", hashlib.sha256(body).hexdigest())
            self.end_headers()
            return BytesIO(body)
        return super().send_head()

    def do_GET(self):
        path = self._model_viewer_path()
        if path == "/__model_viewer__/blender":
            available = Path(blender_path()).is_file()
            return self._json(200, {"available": available, "detail": "Blender ready" if available else "Blender unavailable"})
        if path == "/__model_viewer__/assets":
            return self._json(200, list_local_models(WEBSITE_ROOT.parent))
        return super().do_GET()

    def do_POST(self):
        if self._model_viewer_path() != "/__model_viewer__/blend":
            return self._json(404, {"error": "Unknown import endpoint"})
        if not self._model_viewer_allowed():
            return self._json(403, {"error": "Blender uploads require the local viewer origin"})
        try: length = int(self.headers.get("Content-Length", "-1"))
        except ValueError: length = -1
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/octet-stream":
            return self._json(415, {"error": "Upload the Blender file as application/octet-stream"})
        if length <= 0 or length > MAX_BYTES:
            return self._json(413, {"error": "Choose a nonempty Blender file smaller than 256 MB"})
        if not BLENDER_CONVERSION_LOCK.acquire(blocking=False):
            return self._json(429, {"error": "Another Blender conversion is running; try again when it finishes"})
        previous_timeout = self.connection.gettimeout()
        try:
            self.connection.settimeout(15)
            data = self.rfile.read(length)
            if len(data) != length:
                return self._json(400, {"error": "The upload was interrupted; choose the file again"})
            self.connection.settimeout(previous_timeout)
            result = convert_blend(data)
            self.send_response(200)
            self.send_header("Content-Type", "model/gltf-binary")
            self.send_header("Content-Length", str(len(result)))
            self.end_headers()
            self.wfile.write(result)
        except Exception as exc:
            self._json(422, {"error": str(exc)[:1200]})
        finally:
            self.connection.settimeout(previous_timeout)
            BLENDER_CONVERSION_LOCK.release()

    def translate_path(self, path):
        request_path = unquote(urlsplit(path).path)
        # Mirror the production sibling app routes and asset mount. A city's
        # path is application state, so every such direct hit serves one shell.
        if request_path == "/sloboda" or request_path.startswith("/sloboda/"):
            return str(WEBSITE_ROOT / "sloboda.html")
        if request_path.startswith("/prijevoz/"):
            request_path = request_path[len("/prijevoz"):]
        if request_path.startswith("/__model_viewer__/asset/"):
            asset = resolve_local_asset(WEBSITE_ROOT.parent, request_path)
            return str(asset or WEBSITE_ROOT / "__missing_model_viewer_asset__")
        if request_path.startswith(VENDOR_PREFIX):
            relative = request_path[len(VENDOR_PREFIX):].lstrip("/")
            resolved = (VENDOR_ROOT / relative).resolve()
            try:
                resolved.relative_to(VENDOR_ROOT.resolve())
            except ValueError:
                return str(VENDOR_ROOT / "__invalid_vendor_path__")
            return str(resolved)
        # Production builds materialize these paths under website/vendor. Keep
        # native-ESM development usable before a build by serving the same
        # allow-listed URLs straight from the pinned packages.
        for prefix, root in PUBLIC_VENDOR_ROUTES:
            if not request_path.startswith(prefix):
                continue
            relative = request_path[len(prefix):].lstrip("/")
            resolved = (root / relative).resolve()
            try:
                resolved.relative_to(root.resolve())
            except ValueError:
                return str(VENDOR_ROOT / "__invalid_vendor_path__")
            return str(resolved)
        return super().translate_path(request_path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
    # Threaded so one browser keep-alive connection can't block every other
    # request (single-threaded HTTPServer stalls the whole page under HTTP/1.1).
    from functools import partial
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(NoCacheHandler, directory=str(WEBSITE_ROOT)))
    print(f"Dev server (no-cache) on http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    main()
