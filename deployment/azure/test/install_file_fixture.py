"""Execute installFile's actual Python with only / and fixture ownership mapped."""

import os
import secrets  # Preload before confining filesystem access.
import shlex
import stat
import sys

root, command, foreign = sys.argv[1:]
outer = shlex.split(command)
assert outer[:4] == ["sudo", "-n", "/bin/bash", "-c"]
assert "umask 077\n" in outer[4]
deadline = shlex.split(outer[4])[-7:]
assert deadline[:-1] == [
    "exec", "timeout", "--kill-after=10", "180", "/bin/bash", "-c"
]
args = shlex.split(deadline[-1])
assert args[:2] == ["python3", "-c"] and len(args) == 5
program = compile(args[2], "<installFile>", "exec")

real_open, real_fstat = os.open, os.fstat


def mapped_open(path, flags, mode=0o777, *, dir_fd=None):
    if path == "/" and dir_fd is None:
        path = root
    else:
        assert dir_fd is not None and "/" not in path and path not in (".", "..")
    return real_open(path, flags, mode, dir_fd=dir_fd)


def mapped_fstat(fd):
    values = list(real_fstat(fd))
    path = os.readlink(f"/proc/self/fd/{fd}")
    assert path == root or path.startswith(root + "/"), path
    assert values[4] == os.getuid(), "Unexpected actual fixture owner"
    values[4] = 1 if foreign and path == root + foreign.rstrip("/") else 0
    return os.stat_result(values)


def confined(event, args):
    # Refuse absolute/compound paths before any syscall, including old makedirs.
    if event == "open":
        paths = args[:1]
    elif event in ("os.mkdir", "os.chmod", "os.remove", "os.rmdir"):
        paths = args[:1]
    elif event in ("os.rename", "os.link", "os.symlink"):
        paths = args[:2]
    else:
        return
    for path in paths:
        if event == "open" and path == root:
            continue
        if isinstance(path, str):
            assert "/" not in path and path not in (".", ".."), (event, path)


os.open, os.fstat = mapped_open, mapped_fstat
sys.addaudithook(confined)
sys.argv = ["-c", *args[3:]]
os.umask(0o077)
exec(program)
