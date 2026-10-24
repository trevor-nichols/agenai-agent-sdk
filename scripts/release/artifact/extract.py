# ------------------------------------------------------------------------------------------------
#                extract.py - Strict original release ZIP decoding into a private owned directory
# ------------------------------------------------------------------------------------------------

import json
import pathlib
import shutil
import stat
import sys
import zipfile

archive_path, destination, encoded_members = sys.argv[1:]
expected = set(json.loads(encoded_members))
root = pathlib.Path(destination)

with zipfile.ZipFile(archive_path) as archive:
    members = archive.infolist()
    names = [member.filename for member in members]
    if len(names) != len(set(names)) or set(names) != expected:
        raise ValueError("Original artifact ZIP has duplicate, missing or foreign members.")
    if sum(member.file_size for member in members) > 512 * 1024 * 1024:
        raise ValueError("Original artifact exceeds the 512 MiB expanded restoration budget.")
    for member in members:
        mode = member.external_attr >> 16
        if member.is_dir() or stat.S_IFMT(mode) not in (0, stat.S_IFREG):
            raise ValueError("Original artifact ZIP members must be regular files, never links.")
        if member.flag_bits & 1:
            raise ValueError("Encrypted release artifact members are unsupported.")
    (root / "release").mkdir(mode=0o700)
    for member in members:
        # Every name belongs to the exact caller-supplied canonical inventory above.
        with archive.open(member) as source, (root / member.filename).open("xb") as target:
            shutil.copyfileobj(source, target, length=64 * 1024)
