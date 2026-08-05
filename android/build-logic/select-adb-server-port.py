#!/usr/bin/env python3
"""Select one private localhost port for a run-scoped ADB server."""

from __future__ import annotations

import random
import socket
import sys
from collections.abc import Callable
from typing import NamedTuple


# Keep proof-only ADB servers away from the default server (5037), the supported
# emulator console/ADB pairs (5554..5585), and the proof API range
# (49152..61000). The bounded range is deliberately large enough for a busy
# multi-agent Android host while remaining cheap to exhaust deterministically.
ADB_SERVER_PORTS = tuple(range(42000, 42128))


class AdbServerPortSelection(NamedTuple):
    port: int
    attempts: int


class AdbServerPortUnavailable(Exception):
    def __init__(self, attempts: int) -> None:
        super().__init__("adb_server_port_unavailable")
        self.attempts = attempts


def localhost_port_is_available(
    port: int,
    *,
    socket_factory: Callable[..., socket.socket] = socket.socket,
) -> bool:
    candidate = socket_factory(socket.AF_INET, socket.SOCK_STREAM)
    try:
        candidate.bind(("127.0.0.1", port))
    except OSError:
        return False
    finally:
        candidate.close()
    return True


def select_adb_server_port(
    *,
    port_is_available: Callable[[int], bool] = localhost_port_is_available,
    shuffle: Callable[[list[int]], None] | None = None,
) -> AdbServerPortSelection:
    candidates = list(ADB_SERVER_PORTS)
    (shuffle or random.SystemRandom().shuffle)(candidates)
    for attempts, port in enumerate(candidates, start=1):
        if port_is_available(port):
            return AdbServerPortSelection(port, attempts)
    raise AdbServerPortUnavailable(len(candidates))


def main() -> int:
    try:
        selection = select_adb_server_port()
    except AdbServerPortUnavailable as error:
        print(
            f"adb_server_port_unavailable attempts={error.attempts}",
            file=sys.stderr,
        )
        return 1
    print(selection.port, selection.attempts)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
