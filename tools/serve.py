"""Serve the playground on http://localhost:8000/ and tell the browser never to keep old copies,
so an updated game shows up on a plain reload."""
import http.server
import os

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
print("Ragdoll Playground: http://localhost:8000/  (close this window to stop it)")
http.server.ThreadingHTTPServer(("", 8000), NoCache).serve_forever()
