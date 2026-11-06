"""Exercise the compiled extension against a disposable split Auth deployment."""
import asyncio
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import threading

import pytest

from tests.auth.test_auth_service import register
from tests.auth.test_rdh_sso import mcp_token
from tests.fixtures.auth import (running_auth, split_authority, authority, core_database,
                                empty_database, migrate_binary, migrate, database)

pytest_plugins = ["tests.conftest"]
BRIDGE = Path(__file__).parents[1] / "helpers/refreshBridge.cjs"
LOGIN_BRIDGE = Path(__file__).parents[1] / "helpers/splitLoginBridge.cjs"


@pytest.fixture
async def split_service(split_authority, migrate_binary, tmp_path, monkeypatch):
    state = {}

    class Gate(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path != "/.well-known/oauth-protected-resource/mcp":
                self.reply(404, {})
                return
            self.reply(200, {"resource": state["resource"],
                             "authorization_servers": [state["issuer"]],
                             "scopes_supported": ["devices:control"]})

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path != "/mcp" or not self.headers.get("Authorization", "").startswith("Bearer "):
                self.reply(401, {})
                return
            self.reply(200, {"jsonrpc": "2.0", "id": "rdh-auth-check", "result": {}})

    gate = ThreadingHTTPServer(("127.0.0.1", 0), Gate)
    thread = threading.Thread(target=gate.serve_forever, daemon=True)
    thread.start()
    state["resource"] = f"http://127.0.0.1:{gate.server_port}/mcp"
    try:
        async with running_auth(split_authority, migrate_binary, tmp_path, monkeypatch,
                                resource=state["resource"]) as service:
            state["issuer"] = service.url + "/"
            yield service, state["resource"].removesuffix("/mcp")
    finally:
        gate.shutdown()
        gate.server_close()
        thread.join()


@pytest.mark.parametrize("lost_response", [False, True])
async def test_split_auth_refresh_and_revocation(split_service, lost_response):
    service, gate_url = split_service
    await register(service)
    client_id, token = await mcp_token(service, with_client=True)
    recovery_key = secrets.token_urlsafe(32)
    value = {"server": gate_url, "authServer": service.url, "realDiscovery": True,
             "token": {**token, "client_id": client_id, "_got_at": 0},
             "recoveryKey": recovery_key, "loseResponse": lost_response, "signOut": True}
    process = await asyncio.create_subprocess_exec(
        "node", str(BRIDGE), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        output, error = await asyncio.wait_for(process.communicate(json.dumps(value).encode()), 30)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert process.returncode == 0, error.decode()
    result = json.loads(output)
    assert result["signedOut"] and result["recoveryKeyRemoved"]
    assert result["refreshRequests"] == 1 and result["revocationRequests"] == 1
    assert result["revocationConfirmed"] and not result["browserOpens"]

    message = b"rdh-refresh-recovery-v1\0" + client_id.encode() + b"\0" + token["refresh_token"].encode()
    proof = base64.urlsafe_b64encode(hmac.new(recovery_key.encode(), message, hashlib.sha256).digest()).decode().rstrip("=")
    response = await service.client.post("/token/refresh", data={
        "client_id": client_id, "grant_type": "refresh_token", "resource": gate_url + "/mcp",
        "refresh_token": token["refresh_token"], "rdh_refresh_id": proof,
    })
    assert response.status_code == 400 and response.json()["error"] == "invalid_grant"


async def test_split_auth_first_sign_in_and_revocation(split_service):
    service, gate_url = split_service
    await register(service)
    cookies = [[cookie.name, cookie.value] for cookie in service.client.cookies.jar]
    process = await asyncio.create_subprocess_exec(
        "node", str(LOGIN_BRIDGE), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        output, error = await asyncio.wait_for(process.communicate(json.dumps({
            "server": gate_url, "authServer": service.url, "cookies": cookies,
        }).encode()), 30)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert process.returncode == 0, error.decode()
    result = json.loads(output)
    assert result == {"ready": True, "issuerMatched": True, "signedOut": True,
                      "revoked": True, "metadataReads": 2}
