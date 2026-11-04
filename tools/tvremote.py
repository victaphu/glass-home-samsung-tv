#!/usr/bin/env python3
"""Drive a Samsung Tizen TV over its local remote-control API.

Standard library only. The TV listens on port 8002 (WebSocket over TLS with a
self-signed certificate). The first connection from this Mac shows an "Allow"
prompt on the TV; the token the TV returns is stored in state/token so later
runs connect without a prompt. Every command is appended to
state/remote-log.jsonl, so there is a record of every button press sent.

Usage:
  tvremote.py info                        device info (no prompt on the TV)
  tvremote.py pair                        connect, waiting for the Allow prompt
  tvremote.py key HOME LEFT RIGHT*3       press keys in order; NAME*N repeats
  tvremote.py hold ENTER 1.5              press and hold a key for N seconds
  tvremote.py text "hello"                type into the on-screen keyboard
  tvremote.py apps                        list installed apps
  tvremote.py launch <appId>              open an app
  tvremote.py status <appId>              is the app running / visible

Add --note "why" to any command to label it in the log.
Set TV_IP to the TV's address first, e.g.  TV_IP=192.168.1.50 ./tvremote.py info
"""
import argparse
import base64
import datetime
import json
import os
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.request

TV_IP = os.environ.get("TV_IP", "")
CLIENT_NAME = "Mac remote"
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "state")
TOKEN_FILE = os.path.join(STATE, "token")
LOG_FILE = os.path.join(STATE, "remote-log.jsonl")


def log(entry):
    os.makedirs(STATE, exist_ok=True)
    entry = {"at": datetime.datetime.now().isoformat(timespec="seconds"), **entry}
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


class WebSocket:
    """Just enough of RFC 6455 for the TV: text frames, ping/pong, close."""

    def __init__(self, path, timeout=10):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # the TV presents a self-signed certificate
        raw = socket.create_connection((TV_IP, 8002), timeout=timeout)
        self.sock = ctx.wrap_socket(raw, server_hostname=TV_IP)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((
            f"GET {path} HTTP/1.1\r\nHost: {TV_IP}:8002\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("TV closed the connection during the handshake")
            head += chunk
        head, self.buf = head.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0].decode(errors="replace")
        if " 101 " not in status:
            raise ConnectionError(f"TV refused the WebSocket handshake: {status}")

    def settimeout(self, seconds):
        self.sock.settimeout(seconds)

    def _frame(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 1 << 16:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def send_json(self, obj):
        self._frame(0x1, json.dumps(obj).encode())

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("TV closed the connection")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv_json(self, deadline):
        # The TV pings regularly, so a per-read socket timeout alone never fires
        # while it waits for an answer that does not come. Enforce a hard deadline.
        message = b""
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise socket.timeout("deadline passed")
            self.sock.settimeout(remaining)
            b1, b2 = self._read(2)
            fin, opcode, n = b1 & 0x80, b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if b2 & 0x80 else None
            payload = self._read(n)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x9:  # ping
                self._frame(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x8:
                raise ConnectionError("TV closed the connection")
            message += payload
            if fin:
                return json.loads(message.decode("utf-8", errors="replace"))

    def close(self):
        try:
            self._frame(0x8, b"")
            self.sock.close()
        except OSError:
            pass


def connect(wait_for_allow=45):
    name = base64.b64encode(CLIENT_NAME.encode()).decode()
    path = f"/api/v2/channels/samsung.remote.control?name={name}"
    token = None
    if os.path.exists(TOKEN_FILE):
        token = open(TOKEN_FILE).read().strip() or None
    if token:
        path += f"&token={token}"
    ws = WebSocket(path)
    deadline = time.time() + wait_for_allow
    while True:
        try:
            msg = ws.recv_json(deadline)
        except socket.timeout:
            ws.close()
            sys.exit("No answer from the TV. Accept the Allow prompt on the TV, then retry.")
        event = msg.get("event")
        if event == "ms.channel.connect":
            new_token = (msg.get("data") or {}).get("token")
            if new_token and new_token != token:
                os.makedirs(STATE, exist_ok=True)
                with open(TOKEN_FILE, "w") as f:
                    f.write(new_token)
                os.chmod(TOKEN_FILE, 0o600)
            ws.settimeout(10)
            return ws
        if event in ("ms.channel.unauthorized", "ms.channel.timeOut"):
            ws.close()
            sys.exit(f"TV refused the connection ({event}). Choose Allow on the TV, then retry.")


def expand_keys(keys):
    for spec in keys:
        name, _, times = spec.partition("*")
        name = name.upper()
        if not name.startswith("KEY_"):
            name = "KEY_" + name
        for _ in range(int(times or 1)):
            yield name


def send_key(ws, key, cmd="Click"):
    ws.send_json({"method": "ms.remote.control", "params": {
        "Cmd": cmd, "DataOfCmd": key, "Option": "false", "TypeOfRemote": "SendRemoteKey"}})


def installed_apps(ws):
    ws.send_json({"method": "ms.channel.emit",
                  "params": {"event": "ed.installedApp.get", "to": "host"}})
    deadline = time.time() + 10
    while True:
        try:
            msg = ws.recv_json(deadline)
        except socket.timeout:
            break
        if msg.get("event") == "ed.installedApp.get":
            return msg.get("data", {}).get("data", [])
    sys.exit("The TV did not return an app list.")


def rest(method, path):
    req = urllib.request.Request(f"http://{TV_IP}:8001{path}", method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode(errors="replace")
            return resp.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def main():
    # A Windows console can't print every character in Samsung's app names
    # (some use a fullwidth ＆): print a replacement instead of crashing.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--note", default="", help="label this command in the log")
    parser.add_argument("--delay", type=float, default=0.6,
                        help="seconds between key presses (default 0.6)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info")
    sub.add_parser("pair")
    p = sub.add_parser("key")
    p.add_argument("keys", nargs="+")
    p = sub.add_parser("hold")
    p.add_argument("key")
    p.add_argument("seconds", type=float)
    p = sub.add_parser("text")
    p.add_argument("value")
    sub.add_parser("apps")
    p = sub.add_parser("launch")
    p.add_argument("app_id")
    p = sub.add_parser("status")
    p.add_argument("app_id")
    args = parser.parse_args()
    if not TV_IP:
        sys.exit("Set TV_IP to your TV's address, e.g.  TV_IP=192.168.1.50 ./tvremote.py info")

    if args.cmd == "info":
        status, body = rest("GET", "/api/v2/")
        device = json.loads(body).get("device", {})
        for k in ("name", "modelName", "PowerState", "developerMode", "networkType", "ip", "wifiMac"):
            print(f"{k:14} {device.get(k)}")
        return

    if args.cmd == "status":
        status, body = rest("GET", f"/api/v2/applications/{args.app_id}")
        print(status, body)
        return

    ws = connect()
    try:
        if args.cmd == "pair":
            print("Connected. Token saved to", TOKEN_FILE)
            log({"cmd": "pair", "note": args.note})
        elif args.cmd == "key":
            keys = list(expand_keys(args.keys))
            for i, key in enumerate(keys):
                send_key(ws, key)
                if i < len(keys) - 1:
                    time.sleep(args.delay)
            log({"cmd": "key", "keys": keys, "note": args.note})
            print("sent:", " ".join(keys))
        elif args.cmd == "hold":
            key = next(expand_keys([args.key]))
            send_key(ws, key, "Press")
            time.sleep(args.seconds)
            send_key(ws, key, "Release")
            log({"cmd": "hold", "key": key, "seconds": args.seconds, "note": args.note})
            print(f"held {key} for {args.seconds}s")
        elif args.cmd == "text":
            ws.send_json({"method": "ms.remote.control", "params": {
                "Cmd": base64.b64encode(args.value.encode()).decode(),
                "DataOfCmd": "base64", "TypeOfRemote": "SendInputString"}})
            time.sleep(0.5)
            ws.send_json({"method": "ms.remote.control", "params": {"TypeOfRemote": "SendInputEnd"}})
            log({"cmd": "text", "value": args.value, "note": args.note})
            print("typed:", args.value)
        elif args.cmd == "apps":
            apps = installed_apps(ws)
            for app in sorted(apps, key=lambda a: a.get("name", "").lower()):
                print(f"{app.get('appId', ''):<28} type={app.get('app_type')}  {app.get('name')}")
            log({"cmd": "apps", "count": len(apps), "note": args.note})
        elif args.cmd == "launch":
            # This firmware does not answer ed.installedApp.get, so the app type
            # is unknown: try DEEP_LINK, then NATIVE_LAUNCH, and confirm through
            # the REST status that the app is in front.
            result = "not confirmed"
            for action in ("DEEP_LINK", "NATIVE_LAUNCH"):
                ws.send_json({"method": "ms.channel.emit", "params": {
                    "event": "ed.apps.launch", "to": "host",
                    "data": {"appId": args.app_id, "action_type": action}}})
                for _ in range(16):
                    time.sleep(0.5)
                    status, body = rest("GET", f"/api/v2/applications/{args.app_id}")
                    if status == 200 and json.loads(body).get("visible"):
                        result = f"visible via {action}"
                        break
                if result != "not confirmed":
                    break
            log({"cmd": "launch", "app_id": args.app_id, "result": result, "note": args.note})
            print(f"launch {args.app_id}: {result}")
    finally:
        ws.close()


if __name__ == "__main__":
    main()
