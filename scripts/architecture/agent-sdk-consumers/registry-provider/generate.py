"""Build approved synthetic artifacts with only the Python standard library."""
import base64
import csv
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import zipfile

source, output, node = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
output.mkdir()
peer = source.joinpath("peer.mjs").read_bytes()


def tar_bytes(files):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, data, mode in files:
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode = len(data), mode
            archive.addfile(entry, io.BytesIO(data))
    return result.getvalue()


output.joinpath("peer.tar").write_bytes(tar_bytes([("peer.mjs", ("#!" + node + "\n").encode() + peer, 0o755)]))
manifest = {"name": "packed-acp-fixture", "version": "1.2.3", "type": "module",
            "bin": {"packed-acp-fixture": "peer.mjs"},
            "scripts": {"postinstall": "node -e \"require('fs').writeFileSync('SCRIPT_RAN', 'unsafe')\""}}
with output.joinpath("packed-acp-fixture-1.2.3.tgz").open("wb") as destination:
    with gzip.GzipFile(fileobj=destination, mode="wb", mtime=0, filename="") as compressed:
        compressed.write(tar_bytes([("package/package.json", json.dumps(manifest).encode(), 0o644),
                                    ("package/peer.mjs", peer, 0o644)]))

info = "packed_acp_fixture-1.2.3.dist-info"
files = {"packed_acp_fixture.py": source.joinpath("peer.py").read_bytes(),
         info + "/METADATA": b"Metadata-Version: 2.1\nName: packed-acp-fixture\nVersion: 1.2.3\n",
         info + "/WHEEL": b"Wheel-Version: 1.0\nGenerator: packed-acp-proof\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
         info + "/entry_points.txt": b"[console_scripts]\npacked-acp-fixture = packed_acp_fixture:main\n"}
records = io.StringIO()
writer = csv.writer(records, lineterminator="\n")
for name, data in sorted(files.items()):
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
    writer.writerow([name, "sha256=" + digest, len(data)])
writer.writerow([info + "/RECORD", "", ""])
files[info + "/RECORD"] = records.getvalue().encode()
with zipfile.ZipFile(output / "packed_acp_fixture-1.2.3-py3-none-any.whl", "w", zipfile.ZIP_STORED) as archive:
    for name, data in sorted(files.items()):
        entry = zipfile.ZipInfo(name, (2026, 10, 9, 0, 0, 0))
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, data)
