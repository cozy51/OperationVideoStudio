# Operation Video Studio

Windows 10 / 11 向けの操作録画・非破壊動画編集アプリ。動画はローカルで処理し、外部 API は使用しません。

## 現在の実装範囲

Phase 1 のコードを実装しています。Windows 実機での受入試験は未実施です。

- デスクトップ全体・モニター・ウィンドウ・マウス選択領域のネイティブ録画
- 保存先選択 → 3 秒カウントダウン → 録画、一時停止・再開・停止、録画後の自動取り込み
- カーソル表示の切替、標準/高画質、30fps、録画から除外するツールバー
- 複数動画の選択・OS ドラッグ＆ドロップ、元音声付きプレビュー、再生速度・フレーム移動
- 分割、クリップ削除、指定区間の削除、ドラッグ並べ替え、Undo / Redo、タイムライン倍率
- JSON プロジェクトの保存・再読込、ローカル自動保存・起動時の復旧提案
- MP4 H.264/AAC、720p/1080p/先頭動画の解像度、30fps への正規化、進捗・キャンセル、保存先を開く

Windows GDI API を利用する FFmpeg `gdigrab` 入力で録画します。`getDisplayMedia` は使いません。マイク・PC 内部音声の録音、クリック強調、注釈・モザイク、無音/黒画面クリップの挿入は未実装です。録画自体は映像のみです。書き出し時に音声なし素材へ無音 AAC を補います。

## Windows 開発・インストーラー

[Windows セットアップと実機試験](docs/windows.md) を参照してください。

```powershell
npm ci
npm test
npm run tauri dev
# exe / msi
npm run tauri build
```

Node.js 22 以上、Rust stable (MSVC)、Visual Studio C++ Build Tools、WebView2、FFmpeg / FFprobe が必要です。FFmpeg は PATH から起動し、アプリには同梱していません。インストーラー利用者の PC にも FFmpeg と WebView2 が必要です。CI は Windows でテスト・ビルドし exe/msi をアーティファクトに保存します。未署名の開発用インストーラーです。

## Linux クラウドで検証できる範囲

```bash
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked
npm run dev
```

Rust の動画処理テストには `ffmpeg` と `ffprobe` が PATH に必要です。Linux でネイティブ録画・Windows アプリの起動はできません。ブラウザ表示でデスクトップ機能は無効になります。Windows クロス型チェックは `x86_64-pc-windows-gnu` target と MinGW のリソースコンパイラを用いて実行できますが、Windows 起動試験の代わりにはなりません。

## 構成

- `src/editor.ts`: 元動画の参照と source in/out を持つ非破壊タイムライン
- `src/main.tsx`, `src/style.css`: React / TypeScript / Tailwind の日本語編集画面
- `src-tauri/src/media.rs`: FFprobe、正規化・連結・キャンセル・上書き禁止
- `src-tauri/src/desktop.rs`: Windows キャプチャ対象列挙、録画、ネイティブダイアログ、Tauri コマンド
- `src-tauri/tests/video_pipeline.rs`: 実際の FFmpeg で異なる解像度/fps/音声の素材を編集するテスト
- `tests/editor.test.ts`: 編集データの境界・削除・分割テスト
- `docs/plan.md`: 段階的実装計画

## 安全性と制約

元動画は読み取りのみ。出力・手動プロジェクト保存は同名ファイルを置き換えません。保存し直す場合は新しい名前を指定してください。書き出し用一時ファイルは出力先に作り、成功時だけ新しい MP4 を確定します。十分なディスク空き容量が必要です。録画は停止処理で MP4 ヘッダーを確定するため、プロセス強制終了や電源断時は最後のセグメントが復旧不能になる場合があります。完了したセグメントは録画フォルダーに残ります。

JavaScript に汎用シェル・ファイルシステム・HTTP プラグイン権限を与えず、Rust がネイティブ選択・OS ドロップ・ユーザー選択プロジェクトで許可した動画のみをアクセス対象にします。プロジェクトを開くと記載されたローカル動画への読み取りを許可します。信頼するプロジェクトを開いてください。

プレビューは WebView2 の対応コーデックに制限されます。FFmpeg で読み込める形式でもプレビュー不可になる場合は H.264/AAC MP4 に変換してください。独立した動画クリップを `<video>` で切り替えるため、プレビューのつなぎ目に短い読み込みが入る可能性があります。書き出しでは正規化して連結します。

FFmpeg の利用・再配布条件については [ライセンス方針](docs/ffmpeg-license.md) を参照してください。
