const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = 3100;

let selectedFolder = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function chooseFolder() {
  return new Promise((resolve, reject) => {
    const script = 'POSIX path of (choose folder with prompt "送信するフォルダを選択してください")';
    execFile('osascript', ['-e', script], (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout.trim().replace(/\/$/, ''));
    });
  });
}

function getFilesRecursive(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...getFilesRecursive(fullPath));
    } else if (!entry.name.startsWith('.')) {
      result.push(fullPath);
    }
  }
  return result;
}

app.post('/choose-folder', async (_req, res) => {
  try {
    selectedFolder = await chooseFolder();
    res.json({
      ok: true,
      folder: selectedFolder,
      name: path.basename(selectedFolder)
    });
  } catch (_error) {
    res.status(400).json({ error: 'フォルダ選択をキャンセルしました。' });
  }
});

app.post('/send-folder', async (req, res) => {
  try {
    if (!selectedFolder || !fs.existsSync(selectedFolder)) {
      return res.status(400).json({ error: '先にフォルダを選択してください。' });
    }

    const receiver = String(req.body.receiver || '').replace(/\/$/, '');
    if (!receiver) {
      return res.status(400).json({ error: '受信先URLを入力してください。' });
    }

    const rootName = path.basename(selectedFolder);
    const files = getFilesRecursive(selectedFolder);
    const form = new FormData();

    for (const fullPath of files) {
      const relative = path.relative(selectedFolder, fullPath);
      const relativePath = path.join(rootName, relative).split(path.sep).join('/');
      form.append('paths', relativePath);
      form.append('files', fs.createReadStream(fullPath), {
        filename: path.basename(fullPath)
      });
    }

    const response = await axios.post(`${receiver}/upload-folder`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    res.json({
      ok: true,
      count: response.data.count,
      folder: rootName
    });
  } catch (error) {
    const message = error.response?.data?.error || error.message;
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Sender UI: http://localhost:${PORT}`);
});
