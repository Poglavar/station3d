from __future__ import annotations
import json
from pathlib import Path

MANIFEST = Path("website/station-3d/models/viewer-studies.json")

def _safe(root: Path, relative: str) -> Path | None:
    if not isinstance(relative, str) or Path(relative).is_absolute(): return None
    candidate = (root / relative).resolve()
    try: candidate.relative_to(root.resolve())
    except ValueError: return None
    if candidate.is_symlink() or not candidate.is_file(): return None
    try: candidate.resolve().relative_to(root.resolve())
    except ValueError: return None
    return candidate

def _entries(root: Path):
    try: entries = json.loads((root / MANIFEST).read_text())
    except (OSError, ValueError): return []
    return entries if isinstance(entries, list) else []

def list_local_models(repo_root: Path) -> list[dict]:
    root = Path(repo_root).resolve(); result = []
    for item in _entries(root):
        if not isinstance(item, dict) or not item.get("id"): continue
        model = _safe(root, item.get("model"))
        if not model: continue
        refs = [{"label": r.get("label", "Reference"), "url": f"/__model_viewer__/asset/{item['id']}/reference-{i}"}
                for i, r in enumerate(item.get("referenceImages", [])) if isinstance(r, dict) and _safe(root, r.get("path"))]
        result.append({"id": item["id"], "label": item.get("label", item["id"]), "category": item.get("category", "other"),
                      "description": item.get("description", ""), "url": f"/__model_viewer__/asset/{item['id']}/model",
                      "sourceURL": f"/__model_viewer__/asset/{item['id']}/source" if _safe(root, item.get("source")) else None,
                      "references": refs, "cameraViews": item.get("cameraViews", {}),
                      "format": item.get("format", model.suffix.lstrip('.')),
                      "alphaCutoutMaterials": item.get("alphaCutoutMaterials", [])})
    return result

def resolve_local_asset(repo_root: Path, request_path: str) -> Path | None:
    root = Path(repo_root).resolve(); parts = request_path.strip("/").split("/")
    if len(parts) != 4 or parts[:2] != ["__model_viewer__", "asset"]: return None
    ident, kind = parts[2], parts[3]
    for item in _entries(root):
        if isinstance(item, dict) and item.get("id") == ident:
            if kind == "model": return _safe(root, item.get("model"))
            if kind == "source": return _safe(root, item.get("source"))
            if kind.startswith("reference-") and kind[10:].isdigit():
                refs = item.get("referenceImages", []); i = int(kind[10:])
                return _safe(root, refs[i].get("path")) if i < len(refs) and isinstance(refs[i], dict) else None
    return None
