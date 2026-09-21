#!/usr/bin/env python3
"""Small, safe Blender .blend -> GLB conversion helper."""
from __future__ import annotations
import os, shutil, subprocess, tempfile
import sys
from pathlib import Path

BLENDER_DEFAULT = "/Applications/Blender.app/Contents/MacOS/Blender"
MAX_BYTES = 256 * 1024 * 1024

def blender_path() -> str:
    configured = os.environ.get("BLENDER_BIN")
    return (shutil.which(configured) or configured) if configured else (shutil.which("blender") or BLENDER_DEFAULT)

def convert_blend(data: bytes, timeout: int = 120) -> bytes:
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("blend input must be raw bytes")
    if not data:
        raise ValueError("blend input is empty")
    if len(data) > MAX_BYTES:
        raise ValueError("blend input exceeds 256MB limit")
    binary = Path(blender_path())
    if not binary.is_file():
        raise RuntimeError("Blender is unavailable")
    exporter = Path(__file__).with_name("blender_export_model.py")
    with tempfile.TemporaryDirectory(prefix="model-viewer-") as td:
        root = Path(td)
        source, output = root / "input.blend", root / "output.glb"
        source.write_bytes(data)
        try:
            result = subprocess.run(
                [str(binary), "--background", "--factory-startup", "--disable-autoexec", str(source), "--python-exit-code", "1", "--python", str(exporter), "--", str(output)],
                check=False, timeout=timeout, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("Blender conversion exceeded the two-minute limit") from exc
        if result.returncode:
            detail = (result.stdout + result.stderr).decode("utf-8", errors="replace").replace(str(root), "<temporary model>")
            raise RuntimeError(f"Blender could not export this file: {detail[-1200:]}")
        if not output.is_file():
            raise RuntimeError("Blender produced no GLB")
        return output.read_bytes()

if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: model_viewer_blender.py input.blend output.glb")
    Path(sys.argv[2]).write_bytes(convert_blend(Path(sys.argv[1]).read_bytes()))
