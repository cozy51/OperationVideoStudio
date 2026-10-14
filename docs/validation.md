# 検証記録 — 2026-10-14

冒頭の表は初期 Phase 1 の履歴です。最新の結果は末尾の「Phase 2 / 3 とアイコン変更」を参照してください。

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

## 未公開・ローカル修正：SOLIDWORKSのウィンドウ検索失敗

ユーザー提供ログの `Can't find window 'SOLIDWORKS Premium 2023 SP5.0'` は、gdigrabのタイトル検索失敗を示す。タイトルが変化したかどうか自体はこのログだけでは確定できない。

FFmpeg公式ソース（master と n7.1）で `hwnd=<integer>` 入力対応を確認し、タイトルではなく選択時のHWNDを渡すように変更した。対象IDには所有プロセスIDも含め、開始・再開時にIsWindow、所有プロセス、IsIconic、表示領域を確認する。同名タイトルの拒否処理は削除した。

対象識別の新規Rustテスト3件成功。既存2件のunit testと6件の動画integration testは今回の対象フィルターで除外し、再実行していない。Windows GNU targetの型チェック成功。Windows実機でのSOLIDWORKS録画・映像確認は未実施。

ユーザーの「指示がなければGitHubを更新しない」に従い、変更は作業ツリーのみに保存。commit・push・Actions起動はしていない。

## 未公開・ローカル修正：録画整理とクリップ操作

録画フォルダーをRec_01、Rec_02形式、完成MP4を同じ番号の名前に変更。既存番号の最大値より後を使い、create_dirで衝突を防ぐ。録画保存先をapp local dataのrecording-folder.jsonにatomic保存し、次回起動時に再読み込みする。

並べ替えは左右ボタンと、クリップのつかみ部分からのpointer操作に対応。OSファイルドロップ機能を保ったまま、WindowsでHTML5 drag/dropとの競合を避ける。クリップの任意表示名はoptional nameとしてJSONへ保存し、旧プロジェクトにも対応。元動画のパス・ファイル名は変更しない。

フロントエンド13テスト、Rust unit 7 + integration 7テスト、TypeScript/Vite build、Windows向け型チェックが成功。録画の連番・既存データ保持・保存先の読み直し、クリップ名のJSON往復・旧形式読込、UIの名称変更・保存・Undo、左右移動・pointerによる移動を確認。UIのネイティブコマンドはモックであり、Windowsの録画・ダイアログ・ポインタ操作は実機未検証。

commit、push、GitHub Actions起動はしていない。インストール済みアプリへは未反映。

## 未公開・ローカル修正：最小化対象の除外と確認枠

Windows列挙コールバックでIsIconicを確認し、最小化対象を除外。別の透明・最前面・非フォーカス・クリック透過ウィンドウで対象の赤枠を表示する。ウィンドウ指定ではGetClientRectとClientToScreenにより録画されるクライアント領域を確認する。フレーム準備後に表示し、位置を定期更新。録画開始前に破棄し、キャプチャ除外も設定。選択後に最小化された場合には対象一覧を更新して選択を解除する。

フロントエンド15テスト、TypeScript/Vite build、Windows向け型チェック成功。追加テストは選択対象の確認枠要求・設定を閉じた際の枠削除、最小化エラー時の選択解除・開始禁止をモックしたTauriで検証する。Rustの動画処理ロジックは今回変更せず、そのテストは前回結果のまま。実際の枠の描画・DPI・操作透過・録画除外はWindows未検証。

既存の未公開修正を保持。GitHub更新、commit、pushはしていない。

## 未公開・ローカル修正：素材確認と追加の操作分離

左側一覧のクリックを先頭からの素材プレビュー再生、ダブルクリックを末尾への追加に変更。素材確認の再生時計を編集タイムラインから分離し、「編集結果へ戻る」を追加。クリックではクリップを増やさず、確認中の再生位置を変更してもタイムライン・保存JSONは変更しない。

フロントエンド17テスト、TypeScript/Vite build成功。追加テストでクリックの再生要求・編集非変更、ダブルクリックで1本だけ追加、素材を8秒まで進めた後に元のカット範囲・編集位置へ戻ることを検証。動画の再生メソッドはjsdomでモックし、WebView2の実際のデコード・再生試験はしていない。GitHub更新・commit・pushはしていない。

## Phase 2 / 3 とアイコン変更（未公開・ローカル）

時間付き注釈の編集・Canvasプレビュー・PNG焼き込み、番号/ハイライト/マスク、黒画面、クリップ音量、別音声トラック、WASAPI録音、クリック強調、プレビュー用コピー、二世代復旧を実装。録画時の音声と映像の時刻合わせはWindows実機未検証。

- `npm test`: 24件成功。注釈追加/編集/複製/保存、黒画面、別音声追加を含む。Tauriをモックしたjsdom試験。
- `npm run build`: TypeScript/Viteビルド成功。
- Rust: unit 8件、実際のFFmpegを使うintegration 13件成功。時間付きPNG/クリック、モザイク/黒画面、消音、別音声の配置と進捗、プレビューコピー、元動画保持、キャンセルを確認。
- Windows GNU targetの`cargo check --locked`成功。ネイティブAPIの型チェックであり、Windows実行試験ではない。
- Tauri icon CLIで紫/コーラルの新ロゴからWindows ICOを生成。16/24/32/48/64/256px収録。ヘッダーも同じロゴへ変更。64px画像を目視確認。Windowsタスクバーの実表示は未検証。

日本語フォントの実描画、注釈のドラッグ操作、音声同期精度、長時間録画、実際のWindowsプレーヤー再生、exe/msi生成とインストールは未実施。ぼかしはCSSプレビューとFFmpeg出力で完全一致しない。これらを含む全9項目の受入条件は未達確認。

GitHubへのcommit/push、Actions起動はしていない。配布済みインストーラーには未反映。

## Windows CI の注釈書き出し互換性修正

Windows CIの動画処理13件中、通常処理11件が成功し、注釈/クリックとモザイクの2件が失敗したログ画像を受領。共通経路で使っていた`-filter_complex_script`はFFmpeg現行上流から削除されているため、推奨のファイル読み込み構文`-/filter_complex`へ変更。FFmpeg 7.1.5で動画処理13件すべて成功、Windows向け型チェック成功。Windows CIでの再試験結果は未取得。

Actionsのcheckout/setup-nodeをv5へ更新してNode.js 20警告に対応し、今後の原因確認用にFFmpeg/FFprobeバージョン出力を追加。
