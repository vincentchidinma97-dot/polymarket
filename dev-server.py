#!/usr/bin/env python3
"""Local dev server that mimics the Vercel layout: /api/proxy, /api/news, /api/state, /api/cron/trade."""
import json
import subprocess
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8788
ROOT = Path(__file__).parent / "public"
STATE_FILE = Path(__file__).parent / "dev-state.json"
DATA_API = "https://data-api.polymarket.com"
ALLOWED = {"leaderboard": "/v1/leaderboard", "trades": "/trades", "positions": "/positions", "activity": "/activity"}

STARTING_BALANCE = 10000


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {
        "portfolio": {
            "balance": STARTING_BALANCE, "open": [], "closed": [],
            "autoTrade": True, "mirrorWatchlist": True, "autoClose": True,
            "minConsensus": 6, "created": 0,
        },
        "watchlist": {},
        "lastRun": None,
        "runLog": [],
    }


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/proxy":
            self.proxy(parsed.query)
        elif parsed.path == "/api/news":
            self.news(parsed.query)
        elif parsed.path == "/api/state":
            self.get_state()
        elif parsed.path == "/api/cron/trade":
            self.cron_trade()
        elif parsed.path in ("/", "/index.html"):
            self.serve_file("index.html", "text/html; charset=utf-8")
        else:
            self.send_error(404)

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/state":
            self.put_state()
        else:
            self.send_error(404)

    def get_state(self):
        state = load_state()
        result = json.dumps({
            "portfolio": state["portfolio"],
            "watchlist": state.get("watchlist", {}),
            "lastRun": state.get("lastRun"),
            "runLog": state.get("runLog", [])[:10],
        })
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(result.encode())

    def put_state(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        state = load_state()
        t = body.get("type")
        data = body.get("data", {})

        if t == "settings":
            for k in ("autoTrade", "mirrorWatchlist", "autoClose", "cryptoTrade", "minConsensus"):
                if k in data:
                    state["portfolio"][k] = data[k]
        elif t == "watchlist":
            state["watchlist"] = data
        elif t == "watchlist_toggle":
            wl = state.get("watchlist", {})
            wallet = data.get("wallet")
            if wallet in wl:
                del wl[wallet]
            else:
                wl[wallet] = {"name": data.get("name", ""), "addedAt": 0, "lastPositionCount": None}
            state["watchlist"] = wl
        elif t == "manual_trade":
            p = state["portfolio"]
            entry = float(data.get("price") or 0)
            amt = float(data.get("size") or 0)
            key = f"{data.get('title')}|||{data.get('outcome')}"
            if 0.01 < entry < 0.99 and 5 <= amt <= p["balance"] and not any(o.get("key") == key for o in p["open"]):
                p["open"].append({
                    "key": key, "title": data.get("title"), "outcome": data.get("outcome"),
                    "slug": data.get("slug"), "entry": entry, "shares": amt / entry, "cost": amt,
                    "strength": "manual", "traders": data.get("traders") or 0, "source": "manual",
                    "openedAt": int(time.time() * 1000), "highWaterMark": entry,
                })
                p["balance"] -= amt
        elif t == "close_position":
            p = state["portfolio"]
            idx = data.get("index", -1)
            if data.get("key"):
                idx = next((i for i, pos in enumerate(p["open"]) if pos.get("key") == data["key"]), -1)
            if 0 <= idx < len(p["open"]):
                pos = p["open"].pop(idx)
                cur = pos.get("currentPrice", pos.get("entry", 0))
                val = pos.get("shares", 0) * cur
                pnl = val - pos.get("cost", 0)
                p["balance"] += val
                pos["closedAt"] = int(time.time() * 1000)
                pos["exitPrice"] = cur
                pos["pnl"] = pnl
                pos["value"] = val
                pos["closeReason"] = "manual"
                p["closed"].append(pos)
        elif t == "reset":
            state["portfolio"] = {
                "balance": STARTING_BALANCE, "open": [], "closed": [],
                "autoTrade": True, "mirrorWatchlist": True, "autoClose": True,
                "minConsensus": 6, "created": 0,
            }
            state["runLog"] = []
            state["lastRun"] = None
        elif t == "migrate":
            if data.get("portfolio"):
                state["portfolio"] = data["portfolio"]
            if data.get("watchlist"):
                state["watchlist"] = data["watchlist"]

        save_state(state)
        result = json.dumps({"ok": True})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(result.encode())

    def cron_trade(self):
        result = json.dumps({"skipped": True, "reason": "cron not available in dev mode — use the deployed version"})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(result.encode())

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
