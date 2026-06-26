"""
aria-sandbox — Sandbox manager.

Provisions ephemeral Docker containers per CiD (destroy-and-replace model).
Each container is scoped to one conversation — CiD is the namespace.
No persistent state. Container destroyed after execution completes.

Container template: aria-sandbox-template image
  - ssh client
  - curl, wget, jq
  - python3, pip
  - node, npm
  - full Linux toolkit: bash, python3, curl, nmap, openssl, ssh, git, ansible, psql, redis-cli, etc.

Endpoints:
  POST /provision  — spawn container for CiD
  POST /exec       — run command in container
  POST /destroy    — destroy container for CiD
  GET  /status     — list active sandboxes
"""

import os
import json
import logging
import asyncio
import subprocess
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException, Request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("aria-sandbox")

app = FastAPI(title="aria-sandbox", version="1.0.0")

SANDBOX_TEMPLATE_IMAGE = os.getenv("SANDBOX_TEMPLATE_IMAGE", "aria-sandbox-template:latest")
SANDBOX_NETWORK        = os.getenv("SANDBOX_NETWORK",        "aria-internal")
SANDBOX_MEM_LIMIT      = os.getenv("SANDBOX_MEM_LIMIT",      "256m")
SANDBOX_CPU_LIMIT      = os.getenv("SANDBOX_CPU_LIMIT",      "0.5")
EXEC_TIMEOUT           = int(os.getenv("EXEC_TIMEOUT_SECONDS", "60"))

# Active sandboxes: name → container_id
active_sandboxes: dict[str, str] = {}


def _run(cmd: list, timeout: int = 30) -> tuple[int, str, str]:
    """Run a docker command synchronously. Returns (exit_code, stdout, stderr)."""
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", "command timed out"
    except Exception as e:
        return -1, "", str(e)


@app.post("/provision")
async def provision(request: Request):
    """Provision an ephemeral sandbox container scoped to CiD."""
    body = await request.json()
    cid  = body.get("cid", "")
    name = body.get("name", "")

    if not name:
        raise HTTPException(400, "name required")

    # If already exists (e.g. retry), return existing
    if name in active_sandboxes:
        return {"container_id": active_sandboxes[name], "name": name, "status": "existing"}

    log.info("Provisioning sandbox: %s", name)

    # Spawn container from template — no persistent volumes, network isolated
    cmd = [
        "docker", "run", "-d",
        "--name",    name,
        "--network", SANDBOX_NETWORK,
        "--memory",  SANDBOX_MEM_LIMIT,
        "--cpus",    SANDBOX_CPU_LIMIT,
        "--rm",                           # auto-remove on exit
        "--label", f"aria.cid={cid}",
        "--label", "aria.managed=true",
        # Security hardening — keep isolated but allow outbound internet
        "--security-opt", "no-new-privileges",
        "--cap-drop",     "ALL",
        "--cap-add",      "NET_BIND_SERVICE",
        "--cap-add",      "NET_RAW",
        "--tmpfs",        "/tmp:size=100m",
        "--tmpfs",        "/workspace:size=200m",
        SANDBOX_TEMPLATE_IMAGE,
        "sleep", "3600",  # keep alive for session duration
    ]

    exit_code, stdout, stderr = await asyncio.to_thread(_run, cmd, timeout=30)

    if exit_code != 0:
        log.error("Sandbox provision failed: %s", stderr)
        raise HTTPException(500, f"Sandbox provision failed: {stderr}")

    container_id = stdout[:12]
    active_sandboxes[name] = container_id
    log.info("Sandbox ready: %s id=%s", name, container_id)

    return {"container_id": container_id, "name": name, "status": "ready"}


@app.post("/exec")
async def exec_command(request: Request):
    """Execute a command in a sandbox container."""
    body         = await request.json()
    name         = body.get("name", "")
    command_spec = body.get("command_spec", {})

    if not name:
        raise HTTPException(400, "name required")
    if name not in active_sandboxes:
        raise HTTPException(404, f"Sandbox {name} not found")

    cmd_type = command_spec.get("command_type", "shell")
    command  = command_spec.get("command", "")
    target   = command_spec.get("target", "")

    log.info("Exec in %s: type=%s cmd=%s", name, cmd_type, command[:60])

    if cmd_type == "shell":
        # Run shell command directly in container
        docker_cmd = ["docker", "exec", name, "bash", "-c", command]
        exit_code, stdout, stderr = await asyncio.to_thread(
            _run, docker_cmd, timeout=EXEC_TIMEOUT
        )

    elif cmd_type in ("http_get", "http_post"):
        # Run HTTP call via curl inside the sandbox
        method = "GET" if cmd_type == "http_get" else "POST"
        headers = command_spec.get("headers", {})
        body_data = command_spec.get("body", {})

        curl_cmd = ["curl", "-s", "-w", "\\n%{http_code}", "-X", method]
        for k, v in headers.items():
            curl_cmd += ["-H", f"{k}: {v}"]
        if body_data and method == "POST":
            curl_cmd += ["-H", "Content-Type: application/json",
                         "-d", json.dumps(body_data)]
        curl_cmd.append(f"{target}{command}")

        docker_cmd = ["docker", "exec", name] + curl_cmd
        exit_code, stdout, stderr = await asyncio.to_thread(
            _run, docker_cmd, timeout=EXEC_TIMEOUT
        )

    elif cmd_type == "python":
        # Run Python snippet inside sandbox
        python_cmd = f"cd /workspace && python3 -c {json.dumps(command)}"
        docker_cmd = ["docker", "exec", name, "bash", "-c", python_cmd]
        exit_code, stdout, stderr = await asyncio.to_thread(
            _run, docker_cmd, timeout=EXEC_TIMEOUT
        )

    else:
        raise HTTPException(400, f"Unknown command_type: {cmd_type}")

    return {
        "name":      name,
        "command":   command[:200],
        "stdout":    stdout[:4000],
        "stderr":    stderr[:1000],
        "exit_code": exit_code,
    }


@app.post("/destroy")
async def destroy(request: Request):
    """Destroy a sandbox container."""
    body = await request.json()
    name = body.get("name", "")

    if not name:
        raise HTTPException(400, "name required")

    log.info("Destroying sandbox: %s", name)

    cmd = ["docker", "rm", "-f", name]
    exit_code, stdout, stderr = await asyncio.to_thread(_run, cmd, timeout=15)

    active_sandboxes.pop(name, None)

    if exit_code != 0 and "No such container" not in stderr:
        log.warning("Sandbox destroy warning: %s", stderr)

    return {"name": name, "status": "destroyed"}


@app.get("/status")
async def status():
    """List active sandboxes."""
    return {
        "active_count": len(active_sandboxes),
        "sandboxes":    [{"name": k, "id": v} for k, v in active_sandboxes.items()],
    }


@app.get("/health")
async def health():
    return {"status": "ok", "service": "aria-sandbox",
            "active_sandboxes": len(active_sandboxes)}
