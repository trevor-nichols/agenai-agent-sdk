"""Generate tiny, deterministic, offline package-manager fixtures; no package code executes."""
import base64
import csv
import gzip
import hashlib
import io
import json
import pathlib
import tarfile
import zipfile

ROOT = pathlib.Path(__file__).parent


def npm(name, version, files, dependencies=None, command=None, bin_path="bin/cli.js"):
    manifest = {"name": name, "version": version}
    if dependencies:
        manifest["dependencies"] = dependencies
    if command:
        manifest["bin"] = {command: bin_path}
        manifest["scripts"] = {"postinstall": "node -e \"require('fs').writeFileSync('SCRIPT_RAN', 'unsafe')\""}
    files = {"package.json": json.dumps(manifest, sort_keys=True), **files}
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for path, content in sorted(files.items()):
            data = content.encode()
            entry = tarfile.TarInfo("package/" + path)
            entry.mode = 0o644
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    with (ROOT / f"{name}-{version}.tgz").open("wb") as destination:
        with gzip.GzipFile(fileobj=destination, mode="wb", mtime=0, filename="") as compressed:
            compressed.write(raw.getvalue())


def wheel(name, version, module, code, requires=None, command=None, extra_files=None):
    stem = name.replace("-", "_")
    info = f"{stem}-{version}.dist-info"
    metadata = f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n"
    for requirement in requires or []:
        metadata += f"Requires-Dist: {requirement}\n"
    files = {module + ".py": code, info + "/METADATA": metadata,
             info + "/WHEEL": "Wheel-Version: 1.0\nGenerator: acp-offline-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
             **(extra_files or {})}
    if command:
        files[info + "/entry_points.txt"] = f"[console_scripts]\n{command} = {module}:main\n"
    records = io.StringIO()
    writer = csv.writer(records, lineterminator="\n")
    for path, text in sorted(files.items()):
        data = text.encode()
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
        writer.writerow([path, "sha256=" + digest, len(data)])
    writer.writerow([info + "/RECORD", "", ""])
    files[info + "/RECORD"] = records.getvalue()
    with zipfile.ZipFile(ROOT / f"{stem}-{version}-py3-none-any.whl", "w", zipfile.ZIP_STORED) as archive:
        for path, text in sorted(files.items()):
            entry = zipfile.ZipInfo(path, (2026, 10, 9, 0, 0, 0))
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, text)


npm("fixture-dependency", "4.5.6", {"index.js": "exports.value = 'dependency-ok';\n"})
npm_code = "const dependency = require('fixture-dependency'); console.log(JSON.stringify({dependency:dependency.value,args:process.argv.slice(2),launch:process.env.ACP_FIXTURE_LAUNCH}));\n"
npm("fixture-agent", "1.2.3", {"bin/cli.js": npm_code}, {"fixture-dependency": "^4.0.0"}, "native-fixture")
npm("fixture-conflict", "1.2.3", {"bin/cli.js": npm_code}, {"fixture-dependency": "9.0.0"}, "native-fixture")
npm("fixture-extensionless", "1.2.3", {"bin/native-fixture": "#!/usr/bin/env node\n" + npm_code}, {"fixture-dependency": "^4.0.0"}, "native-fixture", "bin/native-fixture")
npm("fixture-wrong-interpreter", "1.2.3", {"bin/native-fixture": "#!/usr/bin/env python3\n" + npm_code}, {"fixture-dependency": "^4.0.0"}, "native-fixture", "bin/native-fixture")
npm("fixture-extra", "1.0.0", {"index.js": "exports.value = 'unused';\n"})

wheel("fixture-dependency", "4.5.6", "fixture_dependency", "value = 'dependency-ok'\n")
python_code = "import json, os, sys\nimport fixture_dependency\ndef main():\n    print(json.dumps({'dependency':fixture_dependency.value,'args':sys.argv[1:],'command':sys.argv[0],'launch':os.environ.get('ACP_FIXTURE_LAUNCH')}))\n"
wheel("fixture-agent", "1.2.3", "fixture_agent", python_code, ["fixture-dependency (>=4,<5)"], "native-fixture")
wheel("fixture-conflict", "1.2.3", "fixture_conflict", python_code, ["fixture-dependency (==9.0.0)"], "native-fixture")
wheel("fixture-extra", "1.0.0", "fixture_extra", "value = 'unused'\n")
wheel("fixture-path-hook", "1.2.3", "fixture_path_hook", python_code, ["fixture-dependency (>=4,<5)"], "native-fixture", {"unsafe.pth": "import os; raise RuntimeError('must never execute')\n"})
