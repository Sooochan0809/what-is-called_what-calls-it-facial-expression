#!/usr/bin/env python3
"""Serve the project and expose recording ZIPs placed in morphing-v2/upload."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import tempfile
import threading
import time
import urllib.parse
import zipfile
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
UPLOAD_DIR = PROJECT_ROOT / "morphing-v2" / "upload"
STATE_FILE = UPLOAD_DIR / ".processed-zips.json"
SAMPLING_DIR = PROJECT_ROOT / "morphing-v2" / "sampling"
STABLE_SECONDS = 0.9
MAX_SAMPLE_BYTES = 512 * 1024 * 1024


def safe_name(value: str, fallback: str, limit: int = 120) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(value).name).strip(".-")
    return (cleaned or fallback)[:limit]


class RecordingStore:
    def __init__(self, upload_dir: Path = UPLOAD_DIR, project_root: Path = PROJECT_ROOT):
        self.upload_dir = upload_dir
        self.project_root = project_root
        self.state_file = upload_dir / STATE_FILE.name
        self.lock = threading.Lock()
        self.observations: dict[str, tuple[int, int, float]] = {}
        try:
            self.completed = set(json.loads(self.state_file.read_text(encoding="utf-8")).get("completed", []))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            self.completed = set()

    @staticmethod
    def signature(path: Path) -> str:
        stat = path.stat()
        return f"{path.name}:{stat.st_size}:{stat.st_mtime_ns}"

    def is_stable(self, path: Path, now: float) -> bool:
        stat = path.stat()
        current = (stat.st_size, stat.st_mtime_ns)
        previous = self.observations.get(path.name)
        if previous is None or previous[:2] != current:
            self.observations[path.name] = (*current, now)
            return False
        return now - previous[2] >= STABLE_SECONDS

    def extract(self, path: Path) -> tuple[Path, dict, str]:
        with zipfile.ZipFile(path) as archive:
            files = [info for info in archive.infolist() if not info.is_dir() and "__MACOSX" not in Path(info.filename).parts]
            json_files = [info for info in files if Path(info.filename).suffix.lower() == ".json"]
            video_files = [info for info in files if Path(info.filename).suffix.lower() in {".webm", ".mp4", ".mov"}]
            if len(json_files) != 1 or len(video_files) != 1:
                raise ValueError("ZIPにはJSONと動画が1ファイルずつ必要です")
            metadata = json.loads(archive.read(json_files[0]).decode("utf-8"))
            part = int(metadata.get("part", 0))
            emotions = metadata.get("targetEmotions")
            if not 1 <= part <= 6 or not isinstance(emotions, list) or not emotions:
                raise ValueError("JSONのpartまたはtargetEmotionsが不正です")
            target = self.upload_dir / ".extracted" / self.signature(path).replace(":", "-")
            target.mkdir(parents=True, exist_ok=True)
            video_name = Path(video_files[0].filename).name
            destination = target / video_name
            if not destination.exists() or destination.stat().st_size != video_files[0].file_size:
                descriptor, temporary_name = tempfile.mkstemp(prefix=".video-", dir=target)
                os.close(descriptor)
                temporary = Path(temporary_name)
                try:
                    with archive.open(video_files[0]) as source, temporary.open("wb") as output:
                        shutil.copyfileobj(source, output)
                    os.replace(temporary, destination)
                finally:
                    temporary.unlink(missing_ok=True)
        relative = destination.relative_to(self.project_root)
        url = "/" + "/".join(urllib.parse.quote(piece) for piece in relative.parts)
        return destination, metadata, url

    def jobs(self) -> tuple[list[dict], list[dict]]:
        now = time.monotonic()
        jobs, errors = [], []
        with self.lock:
            self.upload_dir.mkdir(parents=True, exist_ok=True)
            paths = sorted(self.upload_dir.glob("*.zip"), key=lambda item: item.stat().st_mtime_ns)
            for path in paths:
                try:
                    signature = self.signature(path)
                    if signature in self.completed or not self.is_stable(path, now):
                        continue
                    _, metadata, video_url = self.extract(path)
                    jobs.append({
                        "id": signature,
                        "zipName": path.name,
                        "modifiedAt": path.stat().st_mtime_ns // 1_000_000,
                        "part": int(metadata["part"]),
                        "targetEmotions": metadata["targetEmotions"],
                        "videoUrl": video_url,
                    })
                except (OSError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as error:
                    errors.append({"zipName": path.name, "message": str(error)})
        return jobs, errors

    def complete(self, signatures: list[str]) -> None:
        with self.lock:
            self.completed.update(signatures)
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.state_file.with_suffix(".tmp")
            temporary.write_text(json.dumps({"completed": sorted(self.completed)}, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(temporary, self.state_file)


class Handler(SimpleHTTPRequestHandler):
    store = RecordingStore()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def send_json(self, value: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if urllib.parse.urlsplit(self.path).path == "/api/morphing/uploads/jobs":
            jobs, errors = self.store.jobs()
            self.send_json({"jobs": jobs, "errors": errors})
            return
        super().do_GET()

    def do_POST(self) -> None:
        request = urllib.parse.urlsplit(self.path)
        if request.path == "/api/morphing/sampling":
            self.save_sample(urllib.parse.parse_qs(request.query))
            return
        if request.path != "/api/morphing/uploads/complete":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode("utf-8"))
            signatures = data.get("ids")
            if not isinstance(signatures, list) or not signatures or not all(isinstance(item, str) for item in signatures):
                raise ValueError("ids is required")
            self.store.complete(signatures)
            self.send_json({"ok": True})
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, OSError) as error:
            self.send_json({"ok": False, "message": str(error)}, HTTPStatus.BAD_REQUEST)

    def save_sample(self, query: dict[str, list[str]]) -> None:
        temporary = None
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_SAMPLE_BYTES:
                raise ValueError("動画サイズが不正、または512MBを超えています")
            batch = safe_name(query.get("batch", [""])[0], "batch", 80)
            filename = safe_name(query.get("name", [""])[0], "clip.webm")
            filename = f"{Path(filename).stem}.webm"
            directory = SAMPLING_DIR / batch
            directory.mkdir(parents=True, exist_ok=True)
            target = directory / filename
            if target.exists():
                relative = target.relative_to(PROJECT_ROOT)
                url = "/" + "/".join(urllib.parse.quote(piece) for piece in relative.parts)
                self.send_json({"name": filename, "url": url, "existing": True})
                return
            descriptor, temporary_name = tempfile.mkstemp(prefix=".sample-", dir=directory)
            os.close(descriptor)
            temporary = Path(temporary_name)
            remaining = length
            with temporary.open("wb") as output:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise OSError("動画の受信が途中で終了しました")
                    output.write(chunk)
                    remaining -= len(chunk)
            os.replace(temporary, target)
            relative = target.relative_to(PROJECT_ROOT)
            url = "/" + "/".join(urllib.parse.quote(piece) for piece in relative.parts)
            self.send_json({"name": filename, "url": url})
        except (OSError, ValueError) as error:
            self.send_json({"ok": False, "message": str(error)}, HTTPStatus.BAD_REQUEST)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Morphing automatic processing server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Open http://{args.host}:{args.port}/morphing-v2/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
