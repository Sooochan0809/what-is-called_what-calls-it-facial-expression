# What Is Called / What Calls It “Facial Expression”

## WebMの自動解析

プロジェクトのルートで次を実行します。

```sh
python3 analysis-webm/server.py
```

ブラウザで <http://127.0.0.1:8765/analysis-webm/> を開いてください。画面は
`analysis-webm/uploads`を1秒ごとに確認し、新しいZIPを検出すると展開して自動解析します。

ZIP内の動画名は`p1_neutral_01.webm`の形式にします。`p1`から`p7`は順に
`neutral`、`happy`、`surprised`、`angry`、`sad`、`fearful`、`disgusted`へ対応し、
末尾の番号`01`から`03`が各感情のスロット番号になります。
