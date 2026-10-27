# FFmpeg ライセンスと配布方針

Web 版は、ブラウザ内で動く FFmpeg である ffmpeg.wasm を使います。

| パッケージ | 用途 | ライセンス |
| --- | --- | --- |
| `@ffmpeg/ffmpeg` | ffmpeg.wasm を操作する JavaScript | MIT |
| `@ffmpeg/core` | FFmpeg 本体を WebAssembly にしたもの（libx264 などを含む） | GPL-2.0-or-later |

`@ffmpeg/core` はビルド時に `dist/assets/` に含まれ、このサイトから利用者のブラウザへ配信されます。Web サイトで配信することは、GPL の対象となるプログラムの配布にあたります。

公開前に次を確認してください。

- 配信している `@ffmpeg/core` のバージョンと、対応するソースコードの入手先（ffmpeg.wasm リポジトリ: https://github.com/ffmpegwasm/ffmpeg.wasm 、FFmpeg: https://ffmpeg.org/ ）を、利用者が確認できる場所に示す。
- GPL の全文と著作権表示を利用者が確認できるようにする。
- アプリ本体のコードと `@ffmpeg/core` の関係（別の Worker で動く別プログラムとして扱えるか）を含め、社内配布・社外公開の条件を確認する。社外に公開する場合は、法務部門などへの確認を推奨します。

FFmpeg の公式情報: https://ffmpeg.org/legal.html
