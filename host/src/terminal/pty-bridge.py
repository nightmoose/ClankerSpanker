#!/usr/bin/env python3
"""PTY bridge for ClankerSpanker host terminal.

Binary frames on stdin/stdout (see frames.ts):
  u8 type | u32be length | payload

Types: IN=1 OUT=2 RESIZE=3 EXIT=4 ERR=5
RESIZE payload: u16be rows, u16be cols
EXIT payload: i32be status
"""
from __future__ import annotations

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

TYPE_IN = 1
TYPE_OUT = 2
TYPE_RESIZE = 3
TYPE_EXIT = 4
TYPE_ERR = 5
MAX_PAYLOAD = 1_000_000


def write_frame(kind: int, payload: bytes) -> None:
    header = struct.pack("!BI", kind, len(payload))
    sys.stdout.buffer.write(header + payload)
    sys.stdout.buffer.flush()


def read_exact(fd: int, n: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < n:
        chunk = os.read(fd, n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def read_frame(fd: int) -> tuple[int, bytes] | None:
    header = read_exact(fd, 5)
    if header is None:
        return None
    kind, length = struct.unpack("!BI", header)
    if length > MAX_PAYLOAD:
        write_frame(TYPE_ERR, b"frame too large")
        return None
    payload = b"" if length == 0 else read_exact(fd, length)
    if payload is None:
        return None
    return kind, payload


def set_winsize(fd: int, rows: int, cols: int) -> None:
    rows = max(1, min(rows, 512))
    cols = max(1, min(cols, 512))
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)
    except OSError:
        pass


def main() -> int:
    shell = os.environ.get("CLANKER_TERMINAL_SHELL") or os.environ.get("SHELL") or "/bin/bash"
    home = os.environ.get("HOME") or os.path.expanduser("~")
    rows = int(os.environ.get("CLANKER_TERMINAL_ROWS") or "24")
    cols = int(os.environ.get("CLANKER_TERMINAL_COLS") or "80")

    try:
        os.chdir(home)
    except OSError:
        pass

    pid, master = pty.fork()
    if pid == 0:
        os.environ.setdefault("TERM", "xterm-256color")
        os.environ.setdefault("LANG", "en_US.UTF-8")
        name = os.path.basename(shell) or "sh"
        try:
            os.execvpe(shell, [name, "-il"], os.environ)
        except OSError:
            os.execvpe("/bin/sh", ["sh"], os.environ)
        os._exit(127)

    set_winsize(master, rows, cols)
    stdin_fd = sys.stdin.fileno()
    # Non-blocking master reads so we can drain.
    flags = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    def shutdown(status: int) -> None:
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass
        write_frame(TYPE_EXIT, struct.pack("!i", status))
        try:
            os.close(master)
        except OSError:
            pass

    try:
        while True:
            try:
                readable, _, _ = select.select([master, stdin_fd], [], [], 30.0)
            except (InterruptedError, ValueError):
                break
            if master in readable:
                try:
                    data = os.read(master, 32_768)
                except BlockingIOError:
                    data = None
                except OSError:
                    data = b""
                if data:
                    write_frame(TYPE_OUT, data)
                elif data is not None:
                    waited = os.waitpid(pid, os.WNOHANG)
                    code = 0
                    if waited[0] == pid:
                        code = os.waitstatus_to_exitcode(waited[1]) if hasattr(os, "waitstatus_to_exitcode") else 0
                    shutdown(code)
                    return 0
            if stdin_fd in readable:
                frame = read_frame(stdin_fd)
                if frame is None:
                    shutdown(0)
                    return 0
                kind, payload = frame
                if kind == TYPE_IN:
                    if payload:
                        os.write(master, payload)
                elif kind == TYPE_RESIZE and len(payload) >= 4:
                    r, c = struct.unpack("!HH", payload[:4])
                    set_winsize(master, r, c)
                    try:
                        os.kill(pid, signal.SIGWINCH)
                    except OSError:
                        pass
    except Exception as err:  # noqa: BLE001 — last-chance to the client
        write_frame(TYPE_ERR, str(err).encode("utf-8", "replace"))
        shutdown(1)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
