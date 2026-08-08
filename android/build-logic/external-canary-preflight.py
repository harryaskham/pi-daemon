#!/usr/bin/env python3
"""Read-only external Pi Daemon preflight and one-shot Pi Droid import builder."""

from __future__ import annotations

import argparse
import base64
import hashlib
import ipaddress
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from external_canary_token import BearerFormatError, MAX_RAW_TOKEN_BYTES, parse_http_bearer

MAX_CAPABILITIES_BYTES = 1 * 1_024 * 1_024
MAX_DASHBOARD_BYTES = 4 * 1_024 * 1_024
MAX_STAGING_BYTES = 24 * 1_024
OPAQUE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
DISPLAY_NAME = "External Pi Daemon canary"


class PreflightError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        raise PreflightError("redirect_refused")


def canonical_api_url(raw: str, allow_insecure_http: bool) -> tuple[str, str, str, int]:
    if len(raw) > 2_048 or any(ord(character) < 0x20 or character.isspace() for character in raw):
        raise PreflightError("api_url_invalid")
    try:
        parsed = urllib.parse.urlsplit(raw)
        port = parsed.port
    except ValueError as error:
        raise PreflightError("api_url_invalid") from error
    if parsed.scheme not in {"http", "https"} or parsed.hostname is None:
        raise PreflightError("api_url_invalid")
    if parsed.username is not None or parsed.password is not None or parsed.path != "" or parsed.query or parsed.fragment:
        raise PreflightError("api_url_not_canonical")
    if parsed.scheme == "http" and not allow_insecure_http:
        raise PreflightError("insecure_http_requires_confirmation")
    host = parsed.hostname.lower()
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if len(host) > 253 or not re.fullmatch(
            r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*",
            host,
        ):
            raise PreflightError("api_url_host_invalid")
    display_host = f"[{host}]" if ":" in host else host
    effective_port = port if port is not None else (443 if parsed.scheme == "https" else 80)
    authority = display_host if port is None else f"{display_host}:{port}"
    canonical = f"{parsed.scheme}://{authority}"
    if raw != canonical:
        raise PreflightError("api_url_not_canonical")
    return canonical, parsed.scheme, host, effective_port


def read_owner_token(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise PreflightError("token_file_unavailable") from error
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
            raise PreflightError("token_file_not_owner_regular")
        if info.st_mode & 0o077 or not info.st_mode & stat.S_IRUSR:
            raise PreflightError("token_file_not_owner_only")
        if info.st_size < 1 or info.st_size > MAX_RAW_TOKEN_BYTES:
            raise PreflightError("token_file_size_invalid")
        raw_token = os.read(descriptor, MAX_RAW_TOKEN_BYTES + 1)
    except OSError as error:
        raise PreflightError("token_file_unavailable") from error
    finally:
        os.close(descriptor)
    try:
        return parse_http_bearer(raw_token)
    except BearerFormatError as error:
        raise PreflightError("token_file_format_invalid") from error


def read_json_response(
    opener: urllib.request.OpenerDirector,
    origin: str,
    path: str,
    token: bytes,
    limit: int,
    code: str,
) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{origin}{path}",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token.decode('ascii')}",
        },
        method="GET",
    )
    try:
        with opener.open(request, timeout=10) as response:
            if response.status != 200:
                raise PreflightError(f"{code}_http_status")
            content_length = response.headers.get("Content-Length")
            if content_length is not None:
                try:
                    if int(content_length) > limit:
                        raise PreflightError(f"{code}_response_too_large")
                except ValueError as error:
                    raise PreflightError(f"{code}_content_length_invalid") from error
            encoded = response.read(limit + 1)
    except PreflightError:
        raise
    except urllib.error.HTTPError as error:
        raise PreflightError(f"{code}_http_status") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise PreflightError(f"{code}_unavailable") from error
    if len(encoded) > limit:
        raise PreflightError(f"{code}_response_too_large")
    try:
        value = json.loads(encoded)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PreflightError(f"{code}_response_invalid") from error
    if not isinstance(value, dict):
        raise PreflightError(f"{code}_response_invalid")
    return value


def success_data(
    envelope: dict[str, Any],
    code: str,
    expected_host_instance_id: str | None = None,
) -> dict[str, Any]:
    if envelope.get("ok") is not True or not isinstance(envelope.get("data"), dict):
        raise PreflightError(f"{code}_response_invalid")
    if expected_host_instance_id is not None and envelope.get("hostInstanceId") != expected_host_instance_id:
        raise PreflightError(f"{code}_host_changed")
    return envelope["data"]


def opaque(value: Any, code: str, limit: int = 256) -> str:
    if not isinstance(value, str) or not (1 <= len(value) <= limit) or OPAQUE_ID.fullmatch(value) is None:
        raise PreflightError(code)
    return value


def managed_identity(record: dict[str, Any]) -> tuple[str, int] | None:
    managed = record.get("managed")
    if not isinstance(managed, dict):
        return None
    session_id = managed.get("sessionId")
    generation = managed.get("generation")
    if not isinstance(session_id, str) or OPAQUE_ID.fullmatch(session_id) is None:
        return None
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 1:
        return None
    return session_id, generation


def observer_attach_is_safe(inventory: dict[str, Any], info: dict[str, Any]) -> bool:
    inventory_identity = managed_identity(inventory)
    info_identity = managed_identity(info)
    if inventory_identity is None or inventory_identity != info_identity:
        return False
    inventory_managed = inventory["managed"]
    info_managed = info["managed"]
    inventory_presence = inventory.get("presence")
    info_presence = info.get("presence")
    return (
        inventory_managed.get("state") == "idle"
        and info_managed.get("state") == "idle"
        and isinstance(inventory_presence, dict)
        and isinstance(info_presence, dict)
        and inventory_presence.get("runtime") == "resident-idle"
        and info_presence.get("runtime") == "resident-idle"
    )


def write_private(path: Path, encoded: bytes) -> None:
    if len(encoded) > MAX_STAGING_BYTES:
        raise PreflightError("staging_payload_too_large")
    try:
        parent = path.parent.resolve(strict=True)
        parent_info = parent.stat()
    except OSError as error:
        raise PreflightError("output_parent_unavailable") from error
    if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != os.geteuid() or parent_info.st_mode & 0o077:
        raise PreflightError("output_parent_not_owner_private")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
        try:
            view = memoryview(encoded)
            while view:
                written = os.write(descriptor, view)
                if written < 1:
                    raise OSError("short write")
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise PreflightError("output_write_failed") from error


def digest_id(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode()).hexdigest()}"


def run(arguments: argparse.Namespace) -> None:
    origin, scheme, network_host, network_port = canonical_api_url(
        arguments.api_url,
        arguments.allow_insecure_http,
    )
    token_bytes = read_owner_token(Path(arguments.token_file))
    # Do not inherit ambient HTTP(S)_PROXY authority: the service bearer may
    # travel only to the operator-selected canonical origin.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        capabilities_envelope = read_json_response(
            opener,
            origin,
            "/v1/capabilities",
            token_bytes,
            MAX_CAPABILITIES_BYTES,
            "capabilities",
        )
        capabilities = success_data(capabilities_envelope, "capabilities")
        host_instance_id = opaque(capabilities_envelope.get("hostInstanceId"), "host_instance_invalid", 128)
        if capabilities.get("authentication") != "service-bearer":
            raise PreflightError("authentication_contract_invalid")
        subprotocols = capabilities.get("rpcSubprotocols")
        if not isinstance(subprotocols, list) or "pi-daemon-rpc.v1" not in subprotocols:
            raise PreflightError("rpc_contract_invalid")

        inventory_envelope = read_json_response(
            opener,
            origin,
            "/v1/dashboard/inventory?limit=50",
            token_bytes,
            MAX_DASHBOARD_BYTES,
            "inventory",
        )
        inventory_data = success_data(inventory_envelope, "inventory", host_instance_id)
        sessions = inventory_data.get("sessions")
        if not isinstance(sessions, list) or not sessions or not isinstance(sessions[0], dict):
            raise PreflightError("inventory_empty")
        selected = sessions[0]
        inventory_id = opaque(selected.get("inventoryId"), "inventory_identity_invalid")
        encoded_id = urllib.parse.quote(inventory_id, safe="")

        info_envelope = read_json_response(
            opener,
            origin,
            f"/v1/dashboard/inventory/{encoded_id}",
            token_bytes,
            MAX_DASHBOARD_BYTES,
            "information",
        )
        information = success_data(info_envelope, "information", host_instance_id)
        if information.get("inventoryId") != inventory_id:
            raise PreflightError("information_identity_mismatch")

        transcript_envelope = read_json_response(
            opener,
            origin,
            f"/v1/dashboard/inventory/{encoded_id}/transcript?limit=50",
            token_bytes,
            MAX_DASHBOARD_BYTES,
            "transcript",
        )
        transcript = success_data(transcript_envelope, "transcript", host_instance_id)
        if transcript.get("inventoryId") != inventory_id or not isinstance(transcript.get("records"), list):
            raise PreflightError("transcript_identity_mismatch")

        observer_attach_allowed = observer_attach_is_safe(selected, information)
        pairing_payload = {
            "version": 1,
            "apiUrl": origin,
            "displayName": DISPLAY_NAME,
            "bearer": token_bytes.decode("ascii"),
        }
        pairing_encoded = base64.urlsafe_b64encode(
            json.dumps(pairing_payload, separators=(",", ":")).encode()
        ).decode().rstrip("=")
        staging = {
            "schemaVersion": 1,
            "pairingEnvelope": f"pidroid://pair/v1/{pairing_encoded}",
            "expectedHostInstanceId": host_instance_id,
            "expectedInventoryId": inventory_id,
            "observerAttachAllowed": observer_attach_allowed,
        }
        receipt = {
            "schemaVersion": 1,
            "status": "verified",
            "apiUrl": origin,
            "network": {"scheme": scheme, "host": network_host, "port": network_port},
            "hostInstanceIdSha256": digest_id(host_instance_id),
            "selectedInventoryIdSha256": digest_id(inventory_id),
            "inventoryCount": len(sessions),
            "capabilities": True,
            "inventory": True,
            "information": True,
            "transcript": True,
            "observerAttachAllowed": observer_attach_allowed,
            "methods": ["GET"],
        }
        write_private(
            Path(arguments.staging_file),
            (json.dumps(staging, separators=(",", ":")) + "\n").encode(),
        )
        try:
            write_private(
                Path(arguments.receipt_file),
                (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode(),
            )
        except Exception:
            Path(arguments.staging_file).unlink(missing_ok=True)
            raise
    finally:
        mutable_token = bytearray(token_bytes)
        mutable_token[:] = b"\x00" * len(mutable_token)


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--staging-file", required=True)
    parser.add_argument("--receipt-file", required=True)
    parser.add_argument("--allow-insecure-http", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    try:
        run(parse_arguments(argv))
    except (PreflightError, SystemExit) as error:
        code = error.code if isinstance(error, PreflightError) else "usage"
        print(f"external_canary_preflight_failed code={code}", file=sys.stderr)
        return 70
    except Exception:
        print("external_canary_preflight_failed code=unexpected_failure", file=sys.stderr)
        return 70
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
