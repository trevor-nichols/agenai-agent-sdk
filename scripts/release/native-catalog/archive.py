"""Read bounded package payload identities without extracting or following links."""

import hashlib
import json
import pathlib
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
if not archive.is_file() or archive.is_symlink() or archive.stat().st_size > 64 * 1024 * 1024:
    raise ValueError("Invalid bounded catalog archive")
records = []
seen = set()
total = 0
manifest = None
with tarfile.open(archive, "r:gz") as stream:
    for member in stream:
        name = member.name.rstrip("/") if member.isdir() else member.name
        parts = name.split("/")
        if (len(seen) >= 10000 or name in seen or not (name.startswith("package/") or (member.isdir() and name == "package"))
                or any(part in ("", ".", "..") for part in parts)
                or "\\" in name or len(name.encode("utf-8")) > 4096
                or any(ord(char) < 32 or ord(char) == 127 for char in name)):
            raise ValueError("Unsafe or duplicate catalog archive member")
        seen.add(name)
        if member.isdir():
            records.append({"path": name.removeprefix("package/") if name != "package" else "",
                            "bytes": 0, "mode": member.mode & 0o7777, "kind": "directory", "sha256": hashlib.sha256(b"").hexdigest()})
            continue
        if not member.isfile() or member.size < 0 or member.size > 64 * 1024 * 1024:
            raise ValueError("Catalog archive members must be bounded regular files")
        if name == "package/package.json" and member.size > 64 * 1024:
            raise ValueError("Catalog package manifest exceeds its budget")
        total += member.size
        if total > 256 * 1024 * 1024:
            raise ValueError("Expanded catalog archive exceeds its budget")
        digest = hashlib.sha256()
        actual = 0
        manifest_bytes = bytearray()
        with stream.extractfile(member) as source:
            while chunk := source.read(64 * 1024):
                actual += len(chunk)
                digest.update(chunk)
                if name == "package/package.json":
                    manifest_bytes.extend(chunk)
        if actual != member.size:
            raise ValueError("Incomplete catalog archive member")
        local = name.removeprefix("package/")
        if local == "package.json":
            manifest = manifest_bytes.decode("utf-8")
        # Only inert top-level documentation may differ in an explicitly paired repack.
        if local not in ("README.md", "LICENSE"):
            records.append({"path": local, "bytes": actual, "mode": member.mode & 0o7777, "kind": "file",
                            "sha256": digest.hexdigest()})
print(json.dumps({"files": sorted(records, key=lambda entry: entry["path"]), "manifest": manifest}, separators=(",", ":")))
