# 検証記録 — 2026-10-14

実行環境: Debian 13 (Linux x86_64)、Node.js 24.19.0、Rust 1.99.0、FFmpeg/FFprobe 7.1.5。

| 検証 | 結果 |
|---|---|
| `npm ci` による再導入 | 成功 |
| `npm run build` | TypeScript と Vite production build 成功 |
| `npm test` | 編集ロジック 6 テスト成功 |
| `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked` | 動画処理 integration 4 テスト成功。unit/doc test は0件 |
| `cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu --locked` | Windows 向け Rust / Tauri 型チェック成功 |
| Vite起動・ローカルHTTP | HTMLと変換済みReactソースを取得。ブラウザでの視覚・操作試験は未実施 |
| Windowsデスクトップ起動・30秒録画 | 未実施。この環境はLinux |
| exe / msi生成・インストール | 設定とWindows CIを追加。実際の生成・インストールは未実施 |
| コメント・赤枠の表示と焼き込み | Phase 2 未実装 |

動画処理試験では **録画した動画ではなく生成した素材** を使用。30秒の24fps・音声付き動画から10秒〜15秒を除き、別の解像度・15fps・音声なし素材を2秒追加した。27秒・720p・30fps・H.264/AACの出力をFFprobeで検証し、映像の色で素材順を確認、FFmpegで全編デコードした。元動画のバイト列不変、同名出力拒否、キャンセル時の一時ファイル削除、動画を装うプレイリスト拒否も確認した。

クラウドの `install_script` と `start_skill` を設定ドラフトに保存済み。インストールスクリプトは実際に再実行して検証した。保存は公開操作とは別であり、新規タスクへのスナップショット復元試験は未実施。

実機で確認する項目は [Windows試験票](windows.md) に記載。

## v0.1.1 録画開始の修正

ユーザー提供画像の「FFmpegがPATHにあるか確認してください: program not found」から、FFmpeg未検出による開始失敗を確認した。Windows版UIが起動している画像は提供されたが、こちらでWindows実機試験を実施したわけではない。

- FFmpeg/FFprobe・gdigrab・libx264/AACをカウントダウン前に検査。
- ネイティブダイアログで選んだFFmpegフォルダーをローカル設定に保存。PATH依存を回避。
- モーダル内でエラーを表示し、開始失敗時にカウントダウンを解除。
- 状態mutexを保持したままUIウィンドウ操作を呼ぶ処理を削除。状態読み取りはworkerに移し、UIイベント側はtry_lock。開始/停止の同時要求はatomic gateで拒否。
- ツールバーの状態ポーリングを直列化し、遅延時に要求を積み上げない。

検証: フロントエンド9テスト（編集6・録画準備UI3）、Rust 8テスト（transition 2・FFmpeg integration 6）、TypeScript/Vite build、Windows GNU targetの型チェックに成功。UIテストはモックしたTauriコマンドを使うjsdom試験であり、Windowsの録画結果を証明するものではない。Windows実機での録画・停止・MP4再生は引き続き必要。

## v0.1.2 領域選択フリーズの修正

領域選択が白いウィンドウのまま「応答なし」になる画像をユーザーから受領。同期Tauriコマンド内でWebView2ウィンドウを作成していたことを確認した。Tauri `WebviewWindowBuilder` のAPI説明が警告するWindowsのデッドロック条件（https://github.com/tauri-apps/wry/issues/583）に該当する。

`select_region` を async コマンド + `spawn_blocking` に変更し、UIスレッドからウィンドウ作成を切り離した。作成中は非表示とし、位置・サイズ・録画除外の設定後に表示/フォーカスする。設定失敗時には残ったウィンドウを破棄する。画面側では作成中の再クリックを禁止し、失敗時にはモーダル内にエラーを表示して再試行可能にした。

TypeScript/Vite build、フロントエンド10テスト（編集6・録画UI4）、Windows GNU targetの型チェックに成功。追加UIテストは、領域選択要求の処理中に二重実行しないことと、エラー後の復帰を検証する。Windowsで領域選択の描画・ドラッグ・Esc・再選択を実行する実機試験は未実施。
