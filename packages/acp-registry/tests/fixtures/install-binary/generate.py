"""Rebuild deterministic, synthetic archives; never fetch a native agent."""

import bz2
import gzip
import io
from pathlib import Path
import stat
import tarfile
import zipfile

ROOT = Path(__file__).parent
PROGRAM = b"#!/bin/sh\nprintf 'fixture\\n'\n"


def tar_bytes() -> bytes:
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, content, mode in [("bin/agent", PROGRAM, 0o755), ("share/info", b"retained data\n", 0o644)]:
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            entry.mode = mode
            archive.addfile(entry, io.BytesIO(content))
    return result.getvalue()


def make_zip(name: str, entries: list[tuple[str, bytes, int]]) -> None:
    with zipfile.ZipFile(ROOT / name, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path, content, mode in entries:
            entry = zipfile.ZipInfo(path, date_time=(2026, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = mode << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, content)


tar = tar_bytes()
(ROOT / "valid.tar").write_bytes(tar)
(ROOT / "valid.tar.gz").write_bytes(gzip.compress(tar, mtime=0))
(ROOT / "valid.tar.bz2").write_bytes(bz2.compress(tar))
(ROOT / "valid.bin").write_bytes(PROGRAM)
files = [("bin/agent", PROGRAM, stat.S_IFREG | 0o755), ("share/info", b"retained data\n", stat.S_IFREG | 0o644)]
make_zip("valid.zip", files)
make_zip("links.zip", [*files, ("agent", b"bin/agent", stat.S_IFLNK | 0o777)])
make_zip("escape.zip", [*files, ("agent", b"../../outside", stat.S_IFLNK | 0o777)])
make_zip("traversal.zip", [("../outside", b"forbidden", stat.S_IFREG | 0o644)])
make_zip("device.zip", [("device", b"", stat.S_IFCHR | 0o600)])
make_zip("duplicate.zip", [files[0], files[0]])
make_zip("backslash.zip", [("bin\\agent", PROGRAM, stat.S_IFREG | 0o755)])
data = bytearray((ROOT / "valid.zip").read_bytes())
central = data.index(b"PK\x01\x02")
data[central + 16] ^= 1
(ROOT / "wrong-crc.zip").write_bytes(data)
(ROOT / "incomplete.zip").write_bytes((ROOT / "valid.zip").read_bytes()[:-16])
