# Lokálny dev server: statické súbory + /clax/ proxy na results.championchip.cz (ako Caddy na serveri)
import http.server, urllib.request, sys
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
KEY = open('.apikey').read().strip()
API = 'http://127.0.0.1:8080'
class H(http.server.SimpleHTTPRequestHandler):
    def api(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else None
        hdr = {k: v for k, v in self.headers.items() if k.lower() in ('content-type', 'x-admin-token')}
        hdr['X-Forwarded-For'] = self.headers.get('X-Fake-IP', '127.0.0.1')
        req = urllib.request.Request(API + self.path, data=body, method=self.command, headers=hdr)
        try:
            with urllib.request.urlopen(req) as r: code, out = r.status, r.read()
        except urllib.error.HTTPError as e: code, out = e.code, e.read()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(out))); self.end_headers(); self.wfile.write(out)
    def do_POST(self): return self.api()
    def do_PUT(self): return self.api()
    def do_DELETE(self): return self.api()
    def do_GET(self):
        if self.path.startswith('/api/'): return self.api()
        if self.path.startswith('/clax/'):
            try:
                with urllib.request.urlopen('https://results.championchip.cz/' + self.path[6:]) as r:
                    body = r.read(); self.send_response(200)
            except urllib.error.HTTPError as e:
                body = b''; self.send_response(e.code)
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if self.path.split('?')[0] in ('/', '/index.html'):
            body = open('index.html').read().replace('__API_KEY__', KEY).encode()
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        return super().do_GET()
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
