"""Bounded single-member gzip transformation for the pinned native qualification."""

import hashlib
import json
import os
import stat
import sys
import zlib


def transform(spec, source_path, destination_path):
    if ".".join(map(str, sys.version_info[:3])) != spec["pythonVersion"]:
        raise ValueError("decoder_version_mismatch")
    if zlib.ZLIB_VERSION != spec["zlibCompileVersion"] or zlib.ZLIB_RUNTIME_VERSION != spec["zlibRuntimeVersion"]:
        raise ValueError("decoder_zlib_mismatch")
    for key in ("inputChunkBytes", "outputChunkBytes"):
        if not isinstance(spec[key], int) or not 1 <= spec[key] <= 1048576:
            raise ValueError("invalid_chunk_bound")
    if not 1 <= spec["maxInputBytes"] <= 104857600 or not 1 <= spec["maxOutputBytes"] <= 268435456:
        raise ValueError("invalid_stream_bound")
    source_fd = os.open(source_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(source_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > spec["maxInputBytes"]:
            raise ValueError("invalid_compressed_input")
        destination_fd = os.open(destination_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            compressed_hash = hashlib.sha256()
            decoded_hash = hashlib.sha256()
            compressed_bytes = 0
            decoded_bytes = 0
            magic = bytearray()
            decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
            while True:
                chunk = os.read(source_fd, spec["inputChunkBytes"])
                if not chunk:
                    break
                compressed_bytes += len(chunk)
                if compressed_bytes > spec["maxInputBytes"]:
                    raise ValueError("compressed_limit_exceeded")
                compressed_hash.update(chunk)
                if decoder.eof:
                    raise ValueError("gzip_trailing_data")
                pending = chunk
                while pending:
                    output = decoder.decompress(pending, spec["outputChunkBytes"])
                    pending = decoder.unconsumed_tail
                    if decoder.unused_data:
                        raise ValueError("gzip_trailing_data")
                    decoded_bytes += len(output)
                    if decoded_bytes > spec["maxOutputBytes"]:
                        raise ValueError("decoded_limit_exceeded")
                    decoded_hash.update(output)
                    if len(magic) < 4:
                        magic.extend(output[:4 - len(magic)])
                    view = memoryview(output)
                    while view:
                        written = os.write(destination_fd, view)
                        if not written:
                            raise ValueError("decoded_write_failed")
                        view = view[written:]
            if not decoder.eof:
                raise ValueError("gzip_incomplete")
            after = os.fstat(source_fd)
            current = os.stat(source_path, follow_symlinks=False)
            identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            if identity(before) != identity(after) or identity(before) != identity(current):
                raise ValueError("compressed_input_changed")
            compressed = {"bytes": compressed_bytes, "sha256": compressed_hash.hexdigest()}
            decoded = {"bytes": decoded_bytes, "sha256": decoded_hash.hexdigest()}
            if compressed != spec["compressed"] or decoded != spec["decoded"] or magic.hex() != spec["magicHex"]:
                raise ValueError("gzip_identity_mismatch")
            os.fsync(destination_fd)
            return {"compressed": compressed, "decoded": decoded,
                    "pythonVersion": spec["pythonVersion"], "zlibCompileVersion": zlib.ZLIB_VERSION,
                    "zlibRuntimeVersion": zlib.ZLIB_RUNTIME_VERSION}
        finally:
            os.close(destination_fd)
    finally:
        os.close(source_fd)


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192 or len(sys.argv) != 3:
            raise ValueError("invalid_transform_input")
        result = transform(json.loads(raw), sys.argv[1], sys.argv[2])
        print(json.dumps(result, separators=(",", ":")))
    except Exception:
        # No filesystem paths, input contents or Python diagnostics leave this helper.
        print('{"error":"native_gzip_transform_failed"}')
        sys.exit(1)
