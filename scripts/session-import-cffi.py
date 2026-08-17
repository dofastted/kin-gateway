#!/usr/bin/env python3
"""KIN sessionKey → OAuth via Chrome TLS (curl_cffi).

Import-only. Same CookieAuth as sub2api (orgs → authorize → token),
but we impersonate Chrome to pass claude.ai Cloudflare. Runtime renewal
is grant_type=refresh_token in Node against api.anthropic.com (no CF).

Stdout: one JSON object. Logs go to stderr. Never prints raw tokens.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import sys
import time
from urllib.parse import parse_qs, urlparse

CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
CLAUDE_WEB = "https://claude.ai"
TOKEN_URLS = (
    "https://platform.claude.com/v1/oauth/token",
    "https://api.anthropic.com/v1/oauth/token",
)
SCOPE_API = (
    "user:profile user:inference user:sessions:claude_code "
    "user:mcp_servers user:file_upload"
)
SCOPE_INFERENCE = "user:inference"
IMPERSONATES = ("chrome131", "chrome124", "chrome120")


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def redact(s: str, keep: int = 8) -> str:
    if not s:
        return ""
    if len(s) <= keep * 2:
        return s[:4] + "…"
    return s[:keep] + "…" + s[-6:]


def load_session() -> object:
    try:
        from curl_cffi import requests as cffi_requests
    except ImportError as e:
        raise SystemExit("curl_cffi not installed") from e
    last = None
    for name in IMPERSONATES:
        try:
            return cffi_requests.Session(impersonate=name)
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"[cffi] impersonate {name} failed: {e}", file=sys.stderr)
    raise SystemExit(f"no chrome impersonate available: {last}")


def main() -> int:
    sk = (os.environ.get("SESSION_KEY") or (sys.argv[1] if len(sys.argv) > 1 else "")).strip()
    proxy = (os.environ.get("PROXY_URL") or "").strip()
    scope_name = (os.environ.get("SCOPE") or "full").strip() or "full"
    if not sk.startswith("sk-ant-sid"):
        print("expected sk-ant-sid* sessionKey", file=sys.stderr)
        return 2

    scope = SCOPE_INFERENCE if scope_name == "inference" else SCOPE_API
    sess = load_session()
    proxies = {"http": proxy, "https": proxy} if proxy else None
    cookies = {"sessionKey": sk}
    headers = {
        "Origin": "https://claude.ai",
        "Referer": "https://claude.ai/new",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
    }

    print("[1/3] GET /api/organizations", file=sys.stderr)
    r = sess.get(
        f"{CLAUDE_WEB}/api/organizations",
        cookies=cookies,
        headers=headers,
        proxies=proxies,
        timeout=60,
    )
    if r.status_code != 200:
        snippet = (r.text or "")[:240].replace("\n", " ")
        print(f"orgs failed: {r.status_code} {snippet}", file=sys.stderr)
        return 2
    orgs = r.json()
    if not isinstance(orgs, list) or not orgs:
        print("no organizations", file=sys.stderr)
        return 2
    team = next((o for o in orgs if o.get("raven_type") == "team"), None)
    org = team or orgs[0]
    org_uuid = org.get("uuid")
    print(f"[1/3] org={org_uuid} raven={org.get('raven_type')}", file=sys.stderr)

    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    state = b64url(secrets.token_bytes(32))
    body = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "organization_uuid": org_uuid,
        "redirect_uri": REDIRECT_URI,
        "scope": scope,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    print("[2/3] POST /v1/oauth/{org}/authorize", file=sys.stderr)
    r = sess.post(
        f"{CLAUDE_WEB}/v1/oauth/{org_uuid}/authorize",
        cookies=cookies,
        headers={**headers, "Content-Type": "application/json", "Cache-Control": "no-cache"},
        json=body,
        proxies=proxies,
        timeout=60,
    )
    if r.status_code != 200:
        snippet = (r.text or "")[:240].replace("\n", " ")
        print(f"authorize failed: {r.status_code} {snippet}", file=sys.stderr)
        return 2
    redirect = (r.json() or {}).get("redirect_uri") or ""
    parsed = urlparse(redirect)
    qs = parse_qs(parsed.query)
    auth_code = (qs.get("code") or [None])[0]
    resp_state = (qs.get("state") or [None])[0]
    if not auth_code:
        print("no code in redirect_uri", file=sys.stderr)
        return 2
    print(f"[2/3] code={redact(auth_code)}", file=sys.stderr)

    token_body = {
        "code": auth_code,
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": verifier,
    }
    if resp_state:
        token_body["state"] = resp_state

    token = None
    last = None
    for url in TOKEN_URLS:
        print(f"[3/3] POST {url}", file=sys.stderr)
        try:
            tr = sess.post(
                url,
                headers={
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json",
                    "User-Agent": "axios/1.13.6",
                },
                json=token_body,
                proxies=None,  # token endpoints are not CF-gated; skip SOCKS
                timeout=60,
            )
            if tr.status_code != 200:
                last = f"{tr.status_code} {(tr.text or '')[:200]}"
                print(f"[3/3] {last}", file=sys.stderr)
                continue
            token = tr.json()
            if not token.get("access_token"):
                last = "no access_token"
                continue
            break
        except Exception as e:  # noqa: BLE001
            last = str(e)
            print(f"[3/3] error {last}", file=sys.stderr)
    if not token or not token.get("access_token"):
        print(f"token exchange failed: {last}", file=sys.stderr)
        return 2

    expires_in = int(token.get("expires_in") or 0)
    now = int(time.time())
    out = {
        "type": "setup-token" if scope_name == "inference" else "oauth",
        "platform": "anthropic",
        "access_token": token.get("access_token"),
        "refresh_token": token.get("refresh_token") or "",
        "token_type": token.get("token_type") or "Bearer",
        "expires_in": expires_in,
        "expires_at": now + (expires_in or 28800),
        "scope": token.get("scope") or scope,
        "org_uuid": (token.get("organization") or {}).get("uuid") or org_uuid,
        "account_uuid": (token.get("account") or {}).get("uuid") or "",
        "email_address": (token.get("account") or {}).get("email_address") or "",
        "email": (token.get("account") or {}).get("email_address") or "",
        "source": "sessionKey-cookie-auth+curl_cffi",
        "converted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    print(
        f"[ok] email={out.get('email_address') or '-'} "
        f"expires_in={expires_in} at={redact(out['access_token'])} "
        f"rt={redact(out['refresh_token'])}",
        file=sys.stderr,
    )
    sys.stdout.write(json.dumps(out, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
