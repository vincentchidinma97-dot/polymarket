#!/usr/bin/env python3
"""Local dev server that mimics the Vercel layout: /api/proxy?endpoint=X and static files."""
import json
import subprocess
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8788
ROOT = Path(__file__).parent / "public"
DATA_API = "https://data-api.polymarket.com"
ALLOWED = {"leaderboard": "/v1/leaderboard", "trades": "/trades", "positions": "/positions", "activity": "/activity"}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/proxy":
            self.proxy(parsed.query)
        elif parsed.path == "/api/news":
            self.news(parsed.query)
        elif parsed.path in ("/", "/index.html"):
            self.serve_file("index.html", "text/html; charset=utf-8")
        else:
            self.send_error(404)

    def proxy(self, query):
        params = urllib.parse.parse_qs(query)
        endpoint = params.get("endpoint", [None])[0]
        upstream = ALLOWED.get(endpoint)
        if not upstream:
            self.send_response(400); self.end_headers(); return

        fwd = {k: v[0] for k, v in params.items() if k != "endpoint"}
        qs = urllib.parse.urlencode(fwd)
        url = f"{DATA_API}{upstream}{'?' + qs if qs else ''}"

        try:
            body = subprocess.run(
                ["curl", "-sf", "--max-time", "20", "-A", "polymarket-tracker/1.0", url],
                capture_output=True, check=True,
            ).stdout
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def news(self, query):
        params = urllib.parse.parse_qs(query)
        q = params.get("q", [None])[0]
        if not q:
            self.send_response(400); self.end_headers(); return

        encoded = urllib.parse.quote(q)
        url = f"https://news.google.com/rss/search?q={encoded}&hl=en-US&gl=US&ceid=US:en"

        try:
            body = subprocess.run(
                ["curl", "-sf", "--max-time", "10", "-A", "polymarket-tracker/1.0", url],
                capture_output=True, check=True,
            ).stdout.decode()

            import re
            items = []
            for m in re.finditer(r"<item>(.*?)</item>", body, re.DOTALL):
                if len(items) >= 8:
                    break
                block = m.group(1)
                title = (re.search(r"<title>(.*?)</title>", block, re.DOTALL) or type("", (), {"group": lambda s, n: ""})()).group(1)
                link = (re.search(r"<link>(.*?)</link>", block, re.DOTALL) or type("", (), {"group": lambda s, n: ""})()).group(1)
                pub = (re.search(r"<pubDate>(.*?)</pubDate>", block, re.DOTALL) or type("", (), {"group": lambda s, n: ""})()).group(1)
                src = (re.search(r"<source[^>]*>(.*?)</source>", block, re.DOTALL) or type("", (), {"group": lambda s, n: ""})()).group(1)

                for old, new in [("<![CDATA[", ""), ("]]>", ""), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")]:
                    title = title.replace(old, new)
                    src = src.replace(old, new)
                    link = link.replace(old, new)

                items.append({"title": title, "link": link, "pubDate": pub, "source": src, "ts": 0})

            result = json.dumps({"query": q, "count": len(items), "items": items})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(result.encode())
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def serve_file(self, name, ctype):
        p = ROOT / name
        if not p.exists(): self.send_error(404); return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(p.read_bytes())

    def log_message(self, fmt, *args): pass


if __name__ == "__main__":
    print(f"Dev server on http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
