# image-lan-folder-v3

Mac 2台をLANでつなぎ、フォルダ単位で画像を送る最小構成です。

- `sender/`：送信側PC（例: 192.168.10.1）
- `receiver/`：受信側PC（例: 192.168.10.2）

## 特徴

- ブラウザからファイル/フォルダを直接アップロードしません。
- 送信側の「フォルダを選ぶ」ボタンは macOS のフォルダ選択ダイアログをNode.js経由で開きます。
- そのため、Chrome等の「サイトを信用できる場合にのみ送ってください」というフォルダアップロード警告は出ません。
- 選択したフォルダ名とサブフォルダ構造を維持して、受信側の `uploads/` に再現します。
- 同じ相対パスのファイルが既にある場合は上書きします。

## 1. 受信側PC

```bash
cd receiver
npm install
npm start
```

受信側は `0.0.0.0:3000` で待ち受けます。

## 2. 送信側PC

```bash
cd sender
npm install
npm start
```

ブラウザで以下を開きます。

```text
http://localhost:3100
```

画面上の受信先を `http://192.168.10.2:3000` にし、
「フォルダを選ぶ」→「送信」の順に操作します。

## 保存例

送信側で:

```text
session_001/
├── joy.jpg
├── anger.jpg
└── sub/
    └── neutral.jpg
```

を選ぶと、受信側では:

```text
receiver/uploads/
└── session_001/
    ├── joy.jpg
    ├── anger.jpg
    └── sub/
        └── neutral.jpg
```

として保存されます。
