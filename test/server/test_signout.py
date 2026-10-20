"""Run explicitly with the Hub's pytest environment and source/tests on PYTHONPATH.

These tests use the compiled extension, disposable users, and a real local Hub.
No deployed credentials or devices are used.
"""
import asyncio
import base64
import hashlib
import hmac
import json
from pathlib import Path
import secrets
import time

import pytest

from remote_device_hub.store import digest
from test_mcp_sessions import token_for

pytest_plugins = ["test_integration"]
BRIDGE = Path(__file__).parents[1] / "helpers/refreshBridge.cjs"


async def run_signout(value):
    process = await asyncio.create_subprocess_exec(
        "node", str(BRIDGE), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        output, error = await asyncio.wait_for(
            process.communicate(json.dumps({**value, "signOut": True}).encode()), timeout=15,
        )
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert process.returncode == 0, error.decode()
    return json.loads(output)


@pytest.mark.parametrize("scenario", ["current", "rotated", "lost_refresh_response", "lost_revocation_response"])
async def test_compiled_extension_signout_revokes_the_entire_grant(live, scenario):
    client, app, _, url = live
    app.state.oauth.config.oauth_resource_aliases = {
        "https://mcp.xdistribute.site/mcp": "https://mcp.xdistribute.site/",
    }
    identity, original = await token_for(client, url)
    _, other = await token_for(client, url)
    record = await app.state.store.aget("refresh", digest(original["refresh_token"]))
    family = record["family"]
    recovery_key = secrets.token_urlsafe(32)
    rotates = scenario in {"rotated", "lost_refresh_response"}
    result = await run_signout({
        "server": url,
        "token": {**original, "client_id": identity["client_id"], "_got_at": 0 if rotates else time.time()},
        "recoveryKey": recovery_key,
        "loseResponse": scenario == "lost_refresh_response",
        "loseRevocationResponse": scenario == "lost_revocation_response",
    })
    assert result["signedOut"] and result["recoveryKeyRemoved"]
    assert result["browserOpens"] == 0
    assert result["revocationRequests"] == 1
    assert result["refreshRequests"] == int(rotates)
    assert result["revocationConfirmed"] == (scenario != "lost_revocation_response")
    assert result["warningShown"] == (scenario == "lost_revocation_response")
    assert await app.state.store.aget("grant", family) is None
    assert await app.state.oauth.load_access_token(original["access_token"]) is None
    assert await app.state.oauth.load_refresh_token(
        await app.state.oauth.get_client(identity["client_id"]), original["refresh_token"],
    ) is None
    assert await app.state.oauth.load_access_token(other["access_token"]) is not None
    if rotates:
        assert await app.state.store.aaccess_record(result["issuedHashes"]["access"]) is None
        next_refresh = await app.state.store.aget("refresh", result["issuedHashes"]["refresh"])
        assert next_refresh and not await app.state.store.avalid_grant(next_refresh)
        # Even the correct recovery proof must not resurrect the revoked grant.
        message = b"rdh-refresh-recovery-v1\0" + identity["client_id"].encode() + b"\0" + original["refresh_token"].encode()
        proof = base64.urlsafe_b64encode(hmac.new(recovery_key.encode(), message, hashlib.sha256).digest()).decode().rstrip("=")
        retry = await client.post("/token/refresh", data={
            "client_id": identity["client_id"], "grant_type": "refresh_token",
            "resource": url + "/mcp", "refresh_token": original["refresh_token"], "rdh_refresh_id": proof,
        })
        assert retry.status_code == 400
        assert retry.json()["error"] == "invalid_grant"
