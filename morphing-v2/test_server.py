import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

import server


class SamplingUploadTest(unittest.TestCase):
    def test_saves_video_inside_sampling_directory(self):
        with tempfile.TemporaryDirectory(dir=server.PROJECT_ROOT) as temporary:
            original = server.SAMPLING_DIR
            server.SAMPLING_DIR = Path(temporary)
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                connection = http.client.HTTPConnection(*httpd.server_address)
                connection.request(
                    "POST",
                    "/api/morphing/sampling?batch=../batch-1&name=../clip.webm",
                    body=b"video",
                    headers={"Content-Type": "video/webm", "Content-Length": "5"},
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 200, response.read())
                self.assertEqual((Path(temporary) / "batch-1" / "clip.webm").read_bytes(), b"video")
                connection.request(
                    "POST",
                    "/api/morphing/sampling?batch=batch-1&name=clip.webm",
                    body=b"newer",
                    headers={"Content-Type": "video/webm", "Content-Length": "5"},
                )
                response = connection.getresponse()
                self.assertTrue(json.loads(response.read())["existing"])
                self.assertEqual((Path(temporary) / "batch-1" / "clip.webm").read_bytes(), b"video")
            finally:
                httpd.shutdown()
                httpd.server_close()
                thread.join()
                server.SAMPLING_DIR = original


if __name__ == "__main__":
    unittest.main()
