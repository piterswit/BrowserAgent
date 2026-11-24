"""Read-only secret-pattern inventory; reports locations, never matched values.

Scans project files and ZIP/TAR members without extracting them. Virtual environments,
Git objects and this audit's generated reports are excluded. Findings require review;
this is not a guarantee that arbitrary encodings or frozen binaries contain no secrets.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import tarfile
import zipfile

PATTERNS = {
    "private-key": rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----",
    "github-token": rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{40,255})\b",
    "aws-access-key": rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    "slack-token": rb"\bxox[baprs]-[A-Za-z0-9-]{20,200}\b",
    "api-token": rb"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,255}|AIza[A-Za-z0-9_-]{30,60})\b",
    "credential-url": rb"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|https?)://[^\s/:\"'<>]{1,80}:[^\s/@\"'<>]{4,200}@",
    "webhook": rb"https://(?:hooks\.slack\.com/services/|(?:discord(?:app)?\.com)/api/webhooks/)[A-Za-z0-9/_-]{12,255}",
    "assigned-credential": rb"(?im)\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[\"'][^\"'\r\n]{8,200}[\"']",
}
EXCLUDE = {".git", ".venv311", ".venv", ".audit-venv", "__pycache__", "node_modules", "security-audit"}
MAX_MEMBER = 64 * 1024 * 1024
MAX_ARCHIVE = 512 * 1024 * 1024


def scan(root):
    hits, errors, skipped = [], [], []
    counts = Counter()

    def check(name, data):
        counts["files_or_members"] += 1
        counts["bytes"] += len(data)
        for kind, pattern in PATTERNS.items():
            for match in re.finditer(pattern, data):
                hits.append({"path": name, "line": data.count(b"\n", 0, match.start()) + 1, "kind": kind})

    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if any(part in EXCLUDE for part in relative.parts) or relative.parts[:2] == ("build", "audit-tools-venv"):
            continue
        if path.is_symlink():
            skipped.append({"path": str(relative), "reason": "symlink; not followed"})
            continue
        if not path.is_file():
            continue
        name = relative.as_posix()
        try:
            if path.suffix.lower() == ".zip":
                total = 0
                with zipfile.ZipFile(path) as archive:
                    for member in archive.infolist():
                        if member.is_dir():
                            continue
                        total += member.file_size
                        if member.file_size > MAX_MEMBER or total > MAX_ARCHIVE:
                            skipped.append({"path": name + "!" + member.filename, "reason": "size limit"})
                            continue
                        check(name + "!" + member.filename, archive.read(member))
            elif name.endswith((".tar.gz", ".tgz")):
                total = 0
                with tarfile.open(path, "r:gz") as archive:
                    for member in archive:
                        if not member.isfile():
                            continue
                        total += member.size
                        if member.size > MAX_MEMBER or total > MAX_ARCHIVE:
                            skipped.append({"path": name + "!" + member.name, "reason": "size limit"})
                            continue
                        with archive.extractfile(member) as handle:
                            check(name + "!" + member.name, handle.read(MAX_MEMBER + 1))
            elif path.stat().st_size <= MAX_MEMBER:
                check(name, path.read_bytes())
            else:
                skipped.append({"path": name, "reason": "size limit; binary/container needs separate review"})
        except (OSError, ValueError, zipfile.BadZipFile, tarfile.TarError) as error:
            errors.append({"path": name, "error": type(error).__name__})
    return {"counts": dict(counts), "findings": hits, "errors": errors, "skipped": skipped,
            "limitations": "Pattern matching only; no decompilation, encrypted archives, DMG mounting or Git-history credential scan."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = scan(args.root.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"counts": result["counts"], "findings": len(result["findings"]),
                      "errors": len(result["errors"]), "skipped": len(result["skipped"])}))


if __name__ == "__main__":
    main()
