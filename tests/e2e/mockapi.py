import json, sys
from urllib.parse import unquote
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
LOG = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _send(self, code, body=None):
        self.send_response(code); self.send_header("Content-Type","application/json"); self.send_header("Access-Control-Allow-Origin","*"); self.end_headers()
        if body is not None: self.wfile.write(json.dumps(body).encode())
    def _log(self, body=None):
        with open(LOG,"a") as f: f.write(json.dumps({"m":self.command,"p":self.path,"auth":self.headers.get("Authorization"),"b":body})+"\n")
    def do_GET(self):
        self._log()
        p=self.path
        if p.startswith("/v1/me"): return self._send(200,{"handle":"tester"})
        if p.startswith("/v1/search") and any("؀" <= c <= "ۿ" for c in unquote(p)):
            return self._send(200,{"items":[{"id":"team1","kind":"show","title":"الفريق الأول","original_title":"Ekip 1","year":2012}]})
        if p.startswith("/v1/search"): return self._send(200,{"items":[{"id":"sev-id","kind":"show","title":"Severance","year":2022},{"id":"other","kind":"show","title":"Severance Pay","year":2019}]})
        if p.startswith("/v1/watchlist"): return self._send(200,{"sections":{"watch_next":{"count":1,"items":[{"id":"sev-id","kind":"show","title":"Severance","progress":{"next":{"season":2,"number":7}}}]}}})
        if p.startswith("/v1/titles/sev-id"): return self._send(200,{"id":"sev-id","kind":"show","title":"Severance","year":2022})
        if p.startswith("/v1/library/check"): return self._send(200,{"items":[]})
        return self._send(404,{"error":{"code":"not_found","message":"nope"}})
    def do_POST(self):
        n=int(self.headers.get("Content-Length") or 0); body=json.loads(self.rfile.read(n) or b"null")
        self._log(body)
        if self.path in ("/v1/scrobble/start","/v1/scrobble/pause"): return self._send(202)
        if self.path=="/v1/scrobble/stop": return self._send(200,{"recorded": body.get("progress",0)>=80})
        if self.path=="/v1/library/actions": return self._send(200,{"results":[{"index":0,"status":"ok"}],"dry_run":False})
        return self._send(404,{"error":{"code":"not_found","message":"nope"}})
ThreadingHTTPServer(("127.0.0.1",8768),H).serve_forever()
