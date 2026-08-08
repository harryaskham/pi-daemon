"""Shared bounded HTTP Bearer token contract for external-canary helpers."""

from __future__ import annotations

import re

MIN_TOKEN_BYTES = 16
MAX_TOKEN_BYTES = 4_096
MAX_RAW_TOKEN_BYTES = MAX_TOKEN_BYTES + 2
HTTP_BEARER_SAFE = re.compile(r"^[A-Za-z0-9\-._~+/]+=*$")


class BearerFormatError(ValueError):
    """The supplied bytes are not one canonical Pi Daemon bearer value."""


def parse_http_bearer(raw: bytes) -> bytes:
    """Strip one optional line ending and validate Pi Daemon's bearer contract."""
    if len(raw) > MAX_RAW_TOKEN_BYTES:
        raise BearerFormatError("token exceeds raw byte limit")
    if raw.endswith(b"\r\n"):
        token = raw[:-2]
    elif raw.endswith(b"\n"):
        token = raw[:-1]
    else:
        token = raw
    if not MIN_TOKEN_BYTES <= len(token) <= MAX_TOKEN_BYTES:
        raise BearerFormatError("token byte length is invalid")
    try:
        decoded = token.decode("utf-8")
    except UnicodeDecodeError as error:
        raise BearerFormatError("token is not UTF-8") from error
    if HTTP_BEARER_SAFE.fullmatch(decoded) is None:
        raise BearerFormatError("token is not safe in an HTTP Bearer header")
    return token
