const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ storage: multer.memoryStorage() });

app.post('/upload-folder', upload.array('files'), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  let paths = req.body.paths || [];
  if (!Array.isArray(paths)) paths = [paths];

  req.files.forEach((file, index) => {
    const relativePath = String(paths[index] || file.originalname)
      .replace(/\\/g, '/')
      .split('/')
      .filter(part => part && part !== '.' && part !== '..')
      .join('/');

    const destination = path.join(UPLOAD_DIR, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.buffer);
  });

  res.json({ ok: true, count: req.files.length });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Receiver running on http://0.0.0.0:${PORT}`);
  console.log(`LAN example: http://192.168.10.2:${PORT}`);
});
