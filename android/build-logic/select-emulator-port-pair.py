#!/usr/bin/env python3
"""Select one Android emulator console/ADB pair from the supported range."""

from __future__ import annotations

import random
import socket
import sys
from collections.abc import Callable
from typing import NamedTuple


EMULATOR_CONSOLE_PORTS = tuple(range(5554, 5585, 2))


class EmulatorPortSelection(NamedTuple):
    console_port: int
    adb_port: int
    attempts: int


class EmulatorPortUnavailable(Exception):
    def __init__(self, attempts: int) -> None:
        super().__init__("emulator_port_unavailable")
        self.attempts = attempts


def localhost_port_pair_is_available(
    console_port: int,
    *,
    socket_factory: Callable[..., socket.socket] = socket.socket,
) -> bool:
    sockets: list[socket.socket] = []
    try:
        for port in (console_port, console_port + 1):
            candidate = socket_factory(socket.AF_INET, socket.SOCK_STREAM)
            sockets.append(candidate)
            candidate.bind(("127.0.0.1", port))
    except OSError:
        return False
    finally:
        for candidate in sockets:
            candidate.close()
    return True


def select_emulator_port_pair(
    *,
    pair_is_available: Callable[[int], bool] = localhost_port_pair_is_available,
    shuffle: Callable[[list[int]], None] | None = None,
) -> EmulatorPortSelection:
    candidates = list(EMULATOR_CONSOLE_PORTS)
    (shuffle or random.SystemRandom().shuffle)(candidates)
    for attempts, console_port in enumerate(candidates, start=1):
        if pair_is_available(console_port):
            return EmulatorPortSelection(console_port, console_port + 1, attempts)
    raise EmulatorPortUnavailable(len(candidates))


def main() -> int:
    try:
        selection = select_emulator_port_pair()
    except EmulatorPortUnavailable as error:
        print(
            f"emulator_port_unavailable attempts={error.attempts}",
            file=sys.stderr,
        )
        return 1
    print(selection.console_port, selection.adb_port, selection.attempts)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
