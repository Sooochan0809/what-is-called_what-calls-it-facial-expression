#!/usr/bin/env python3
"""Serve the project and expose ZIP jobs found in analysis-webm/uploads."""

from __future__ import annotations

import argparse
import hashlib
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
UPLOADS_DIR = PROJECT_ROOT / "analysis-webm" / "uploads"
STATE_FILE = UPLOADS_DIR / ".processed-zips.json"
STABLE_SECONDS = 0.9
EMOTIONS = {
    1: "neutral",
    2: "happy",
    3: "surprised",
    4: "angry",
    5: "sad",
    6: "fearful",
    7: "disgusted",
}
VIDEO_NAME_PATTERN = re.compile(
    r"^p(?P<prefix>[1-7])[_\s-]*(?P<emotion>neutral|happy|surprised|angry|sad|fearful|disgusted)[_\s-]*(?P<number>\d+).*\.webm$",
    re.IGNORECASE,
)


class UploadJobStore:
    def __init__(
        self,
        uploads_dir: Path = UPLOADS_DIR,
        state_file: Path | None = None,
        project_root: Path = PROJECT_ROOT,
    ):
        self.uploads_dir = uploads_dir
        self.state_file = state_file or uploads_dir / STATE_FILE.name
        self.project_root = project_root
        self.lock = threading.Lock()
        self.observations: dict[str, tuple[int, int, float]] = {}
        self.completed = self._load_completed()

    def _load_completed(self) -> set[str]:
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
            return set(data.get("completed", []))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return set()

    @staticmethod
    def _signature(zip_path: Path) -> str:
        stat = zip_path.stat()
        return f"{zip_path.name}:{stat.st_size}:{stat.st_mtime_ns}"

    def _is_stable(self, zip_path: Path, now: float) -> bool:
        stat = zip_path.stat()
        previous = self.observations.get(zip_path.name)
        current = (stat.st_size, stat.st_mtime_ns)
        if previous is None or previous[:2] != current:
            self.observations[zip_path.name] = (*current, now)
            return False
        return now - previous[2] >= STABLE_SECONDS

    @staticmethod
    def _video_metadata(filename: str) -> tuple[str, int] | None:
        match = VIDEO_NAME_PATTERN.match(filename)
        if not match:
            return None
        prefix = int(match.group("prefix"))
        emotion = match.group("emotion").lower()
        if EMOTIONS[prefix] != emotion:
            return None
        return emotion, int(match.group("number"))

    def _archive_videos(self, zip_path: Path) -> list[tuple[zipfile.ZipInfo, str, int]]:
        videos = []
        with zipfile.ZipFile(zip_path) as archive:
            for info in archive.infolist():
                if info.is_dir() or "__MACOSX" in Path(info.filename).parts:
                    continue
                filename = Path(info.filename).name
                if filename.startswith("._"):
                    continue
                metadata = self._video_metadata(filename)
                if metadata:
                    videos.append((info, *metadata))
        videos.sort(key=lambda item: (list(EMOTIONS.values()).index(item[1]), item[2], item[0].filename))
        return videos

    def _existing_directory_matches(self, directory: Path, filenames: set[str]) -> bool:
        if not directory.is_dir():
            return False
        existing = {path.name for path in directory.iterdir() if path.is_file() and path.suffix.lower() == ".webm"}
        return existing == filenames

    def _extract(self, zip_path: Path, signature: str) -> tuple[Path, list[tuple[str, str, int]]]:
        archive_videos = self._archive_videos(zip_path)
        if not archive_videos:
            raise ValueError("認識できるWebM動画がZIP内にありません")

        filenames = {Path(info.filename).name for info, _, _ in archive_videos}
        target_dir = self.uploads_dir / zip_path.stem
        if not self._existing_directory_matches(target_dir, filenames):
            if target_dir.exists():
                digest = hashlib.sha256(signature.encode("utf-8")).hexdigest()[:8]
                target_dir = self.uploads_dir / f"{zip_path.stem}-{digest}"
            if not self._existing_directory_matches(target_dir, filenames):
                if target_dir.exists():
                    raise ValueError(f"展開先が既に存在します: {target_dir.name}")
                temp_dir = Path(tempfile.mkdtemp(prefix=f".{zip_path.stem}-", dir=self.uploads_dir))
                try:
                    with zipfile.ZipFile(zip_path) as archive:
                        for info, _, _ in archive_videos:
                            filename = Path(info.filename).name
                            with archive.open(info) as source, (temp_dir / filename).open("wb") as destination:
                                shutil.copyfileobj(source, destination)
                    os.replace(temp_dir, target_dir)
                except Exception:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                    raise

        metadata_by_name = {
            Path(info.filename).name: (emotion, number)
            for info, emotion, number in archive_videos
        }
        extracted = [
            (path.name, *metadata_by_name[path.name])
            for path in target_dir.iterdir()
            if path.name in metadata_by_name
        ]
        extracted.sort(key=lambda item: (list(EMOTIONS.values()).index(item[1]), item[2], item[0]))
        return target_dir, extracted

    def jobs(self) -> tuple[list[dict], list[dict]]:
        now = time.monotonic()
        jobs = []
        errors = []
        with self.lock:
            self.uploads_dir.mkdir(parents=True, exist_ok=True)
            for zip_path in sorted(self.uploads_dir.glob("*.zip")):
                try:
                    signature = self._signature(zip_path)
                    if signature in self.completed or not self._is_stable(zip_path, now):
                        continue
                    target_dir, extracted = self._extract(zip_path, signature)
                    relative_dir = target_dir.relative_to(self.project_root)
                    files = []
                    used_slots: set[tuple[str, int]] = set()
                    for filename, emotion, number in extracted:
                        if number < 1 or number > 3:
                            continue
                        slot_number = number
                        key = (emotion, slot_number)
                        if key in used_slots:
                            continue
                        used_slots.add(key)
                        relative_path = relative_dir / filename
                        url = "/" + "/".join(urllib.parse.quote(part) for part in relative_path.parts)
                        files.append({
                            "name": filename,
                            "url": url,
                            "emotion": emotion,
                            "slotNumber": slot_number,
                        })
                    jobs.append({"id": signature, "zipName": zip_path.name, "files": files})
                except (OSError, ValueError, zipfile.BadZipFile) as error:
                    errors.append({"zipName": zip_path.name, "message": str(error)})
        return jobs, errors

    def complete(self, signature: str) -> None:
        with self.lock:
            self.completed.add(signature)
            self.uploads_dir.mkdir(parents=True, exist_ok=True)
            temp_state = self.state_file.with_suffix(".tmp")
            temp_state.write_text(
                json.dumps({"completed": sorted(self.completed)}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            os.replace(temp_state, self.state_file)


class AnalysisRequestHandler(SimpleHTTPRequestHandler):
    store = UploadJobStore()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def copyfile(self, source, outputfile) -> None:
        try:
            super().copyfile(source, outputfile)
        except (BrokenPipeError, ConnectionResetError):
            # 動画解析中に画面を閉じた場合の接続終了は正常終了として扱う。
            pass

    def _send_json(self, data: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if urllib.parse.urlsplit(self.path).path == "/api/uploads/jobs":
            jobs, errors = self.store.jobs()
            self._send_json({"jobs": jobs, "errors": errors})
            return
        super().do_GET()

    def do_POST(self) -> None:
        if urllib.parse.urlsplit(self.path).path != "/api/uploads/complete":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            signature = data.get("id")
            if not isinstance(signature, str) or not signature:
                raise ValueError("id is required")
            self.store.complete(signature)
            self._send_json({"ok": True})
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, OSError) as error:
            self._send_json({"ok": False, "message": str(error)}, HTTPStatus.BAD_REQUEST)


def main() -> None:
    parser = argparse.ArgumentParser(description="Facial-expression analyzer development server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), AnalysisRequestHandler)
    print(f"Open http://{args.host}:{args.port}/analysis-webm/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
