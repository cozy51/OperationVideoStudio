# Windows 開発と実機検証

## 必要な環境

- Windows 10 **2004 以降** または Windows 11（録画ツールバー除外APIの要件）。64bit。
- Node.js 22 以上と npm。
- Visual Studio 2022 Build Tools: 「C++ によるデスクトップ開発」、Windows SDK。
- Rust stable / `x86_64-pc-windows-msvc`。
- Microsoft Edge WebView2 Runtime。
- `ffmpeg.exe` と `ffprobe.exe` を PATH に配置。gdigrab と libx264 / AAC 対応ビルド。

FFmpeg は公式サイトの Windows ビルド案内から入手し、配布元のチェックサム/署名で検証してください。TLS やチェックサム検証を無効にしないでください。本プロジェクトはバイナリを自動ダウンロード・同梱しません。

```powershell
node --version
rustc --version
ffmpeg -hide_banner -devices
ffmpeg -hide_banner -encoders
ffprobe -version
npm ci
npm test
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked
npm run tauri dev
```

起動後、「録画」で対象・カーソル・画質を選び、保存先を指定。3秒後にメイン画面が最小化され、除外設定済みのツールバーから一時停止/再開/停止できます。ウィンドウ録画は対象を最小化しないでください。同名のウィンドウは録画対象を一意に指定できないため拒否します。モニターか範囲を選んでください。

録画映像にツールバーが映り込まないか実機で必ず確認してください。保護コンテンツ・UAC のセキュアデスクトップ・アプリ固有の描画方式は録画できない場合があります。

## 「program not found」で録画できない場合

FFmpeg がアプリから見つからない状態です。インストーラーにはFFmpegを同梱していません。

1. 信頼するWindows用FFmpegビルドを導入し、`ffmpeg.exe` と `ffprobe.exe` を用意してください。wingetを使う場合は次のコマンドで導入できます。

   ```powershell
   winget install --id Gyan.FFmpeg --exact
   ```

2. v0.1.1以降は「録画」→「FFmpegのフォルダーを設定」で、両方のexeがある `bin` フォルダーを選択できます。選択したフォルダーはアプリ設定に保存され、次回起動にも使用します。
3. 「FFmpeg / FFprobe・Windows録画を使用できます」が表示されてから録画を開始してください。
4. PATHに追加して使う場合は、アプリを完全に終了して起動し直してください。古い起動プロセスにはPATH変更が反映されません。

録画前にFFmpeg/FFprobe・gdigrab・libx264/AACを検査します。未導入時は保存先選択やカウントダウンに進みません。フォルダー内のプログラムを実行するため、配布元・チェックサムを確認したものを選択してください。

## インストーラー

```powershell
npm run tauri build
```

`src-tauri/target/release/bundle/nsis/*.exe` と `src-tauri/target/release/bundle/msi/*.msi` に生成されます。Windows CI も同じコマンドを実行します。生成設定を追加した段階で、クラウドから CI を実行・成果物を公開したわけではありません。FFmpeg は利用者が別途導入します。

## 実機試験票（未実施）

| 試験 | 確認内容 |
|---|---|
| 起動 | 開発起動、exeとmsiからのインストール・起動、WebView2 |
| 30秒録画 | デスクトップを30秒録画、30fps、時間表示、停止後の自動読込 |
| 各対象 | モニター選択、ウィンドウ、マウス範囲選択、負の座標、混在DPI |
| 一時停止 | 10秒録画→5秒停止→10秒録画。完成動画に停止中の5秒が含まれない |
| ツールバー | キャプチャ除外を完成動画で確認、閉じるボタンで録画を失わない |
| カーソル・画質 | 表示ON/OFF、高画質、保存先、日本語ファイル名 |
| カット | 30秒動画の10秒〜15秒を削除。元ファイル不変、編集後25秒 |
| 連結 | 別動画を追加、ドラッグ並べ替え、異なるサイズ/fps/音声なし素材 |
| プレビュー | 再生・一時停止・フレーム移動・速度、分割した同一素材の遷移 |
| MP4 | 720p/1080p/元サイズ、H.264/AAC・30fps、一般的プレーヤーで全編再生 |
| 安全性 | 同名出力拒否、途中キャンセル、一時ファイル削除、元動画のハッシュ不変 |
| 復旧 | JSON保存・再読込、アプリ再起動後に復旧、欠けた元動画のエラー |
| 長時間 | 1時間録画、CPU/メモリ/空き容量、録画中の対象終了・ディスク不足 |

「ここをクリック」・赤枠・注釈焼き込みの試験は Phase 2 待ちです。マイク・内部音声・クリック強調も未実装です。実機結果をこの表とは別に日時・OS・FFmpegバージョン付きで記録してください。
