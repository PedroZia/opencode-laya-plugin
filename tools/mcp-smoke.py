"""Smoke test do servidor MCP oficial da Laya (laya-mcp-server).

Faz o handshake MCP via stdio, lista as tools, roda `laya_status` e uma
decisão real com `laya_predict` (estado em PT -> checkpoint multilingual).

Uso:
  .venv\\Scripts\\python.exe tools\\mcp-smoke.py
  .venv\\Scripts\\python.exe tools\\mcp-smoke.py --server <caminho-do-exe>
"""

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

DEFAULT_SERVER = (
    Path(os.environ["USERPROFILE"])
    / ".config"
    / "opencode"
    / "laya"
    / ".venv"
    / "Scripts"
    / "laya-mcp-server.exe"
)


def _reader(stream, q):
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            q.put(json.loads(line))
        except ValueError:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Smoke test do servidor MCP da Laya")
    ap.add_argument("--server", default=str(DEFAULT_SERVER))
    ap.add_argument(
        "--timeout", type=float, default=300.0, help="timeout por request (s)"
    )
    args = ap.parse_args()

    if not Path(args.server).exists():
        print(f"laya-mcp-server nao encontrado em: {args.server}")
        print("Rode o install.ps1 do repo opencode-laya-plugin primeiro.")
        return 1

    env = dict(os.environ)
    # smoke nao precisa preload (lazy carrega no primeiro predict)
    env.setdefault("LAYA_PRELOAD", "0")

    print(f"subindo: {args.server}")
    proc = subprocess.Popen(
        [args.server],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        env=env,
    )
    q: queue.Queue = queue.Queue()
    threading.Thread(target=_reader, args=(proc.stdout, q), daemon=True).start()

    state = {"_next_id": 1}

    def request(method: str, params=None, timeout: float | None = None) -> dict:
        rid = state["_next_id"]
        state["_next_id"] += 1
        msg = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()
        deadline = time.time() + (timeout or args.timeout)
        while time.time() < deadline:
            try:
                resp = q.get(timeout=max(0.1, deadline - time.time()))
            except queue.Empty:
                break
            if resp.get("id") == rid:
                return resp
        raise TimeoutError(f"sem resposta para {method}")

    def notify(method: str, params=None) -> None:
        msg = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()

    def call_tool(name: str, arguments: dict, timeout: float | None = None) -> str:
        resp = request("tools/call", {"name": name, "arguments": arguments}, timeout)
        if "error" in resp:
            raise RuntimeError(f"{name} falhou: {resp['error']}")
        result = resp.get("result", {})
        return "".join(c.get("text", "") for c in result.get("content", []))

    try:
        init = request(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "mcp-smoke", "version": "0.1"},
            },
        )
        result = init.get("result", {})
        info = result.get("serverInfo", {})
        print(
            f"OK  conectado: {info.get('name')} {info.get('version')} "
            f"(protocolo {result.get('protocolVersion')})"
        )
        notify("notifications/initialized")

        tools = request("tools/list").get("result", {}).get("tools", [])
        print(f"OK  {len(tools)} tools: {', '.join(t['name'] for t in tools)}")

        status = call_tool("laya_status", {}, timeout=60)
        print("--- laya_status ---")
        print(status[:700])

        t0 = time.time()
        answer = call_tool(
            "laya_predict",
            {
                "state": {
                    "body": "Fomos cobrados duas vezes na fatura de maio. Quero reembolso."
                },
                "questions": {
                    "billing": {
                        "type": "noul",
                        "instructions": "Is this a billing issue?",
                    },
                },
            },
        )
        dt = time.time() - t0
        print(f"--- laya_predict ({dt:.1f}s) ---")
        print(answer[:700])

        print("OK  MCP smoke test concluido")
        return 0
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
