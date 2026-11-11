# AI Canvas Tauri

[简体中文](README.md) · [English](README.en.md) · **日本語** · [한국어](README.ko.md)

<p align="center">
  <img src="public/icons.svg" alt="AI Canvas Tauri Icon" width="140" height="140" />
</p>

> **Tauri 2 + React 19 + React Flow 12** で構築した、ローカルファーストの AI マルチモーダルキャンバス＆対話エージェントデスクトップアプリ。

AI Canvas Tauri は、テキスト・画像・動画・音声・コマ撮りアニメーション・Markdown・ショットリスト・360° パノラマ・手描きノートを、接続可能なキャンバスノードとして整理します。ひとつのプロジェクト内で生成パイプラインを構成し、キャラクターライブラリとローカル素材を管理し、ComfyUI ワークフローを実行し、対話アシスタントでキャンバスの参照・編集、メディア生成、読み取り専用サブエージェントの派遣、許可済みファイルの読み取り、プロジェクトメモリの蓄積ができます。プロジェクトはシリーズとエピソードに分割でき、短編ドラマの各話ごとにキャンバスを持ち、キャラクターライブラリと素材はシリーズ全体で共有します。

**0.11.2 · アシスタントウィンドウと最近使った Skill：** 独立ウィンドウを閉じる・戻す際は、下書きの受け渡しと実際の終了を待ち、失敗時は下書きを保持して編集に戻れます。ノードの `/` メニューに、アップロード済み・有効なエージェントパッケージから最近使った利用可能な Skill を最大 5 件表示し、アシスタントでの選択も同じ履歴に記録します。グループ開閉時の間隔調整、新プロジェクトの未使用原本のスキャン、7 役割のチーム、Seedream 5.0 Flash に対応し、素材プレビューと macOS の一部ファイル処理も修正しました。既存プロジェクトは自動移行せず、v4 と旧 v1〜v3 の互換性を維持します。出力履歴を含む v4 は 0.11.0 または対応クライアントが必要で、初期の v4 クライアントでは拒否される場合があります。配布状況と検証範囲は[リリースノート](.release-notes.md)をご確認ください。

![Version](https://img.shields.io/badge/version-0.11.2-6366f1)
![Tauri](https://img.shields.io/badge/Tauri-2-24c8db)
![React](https://img.shields.io/badge/React-19-61dafb)
![React Flow](https://img.shields.io/badge/React_Flow-12-ff0072)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6)
![License](https://img.shields.io/badge/license-source--available-f59e0b)

**オンライン体験:** <https://tenney95.github.io/AI-Canvas-tauri/>（トップ画面ですぐ試せます。デモキャンバス内蔵）

**ダウンロード:** <https://github.com/tenney95/AI-Canvas-tauri/releases>（デスクトップインストーラー）

[オンライン体験](https://tenney95.github.io/AI-Canvas-tauri/) · [ダウンロード](https://github.com/tenney95/AI-Canvas-tauri/releases) · [スポンサー](#スポンサー) · [主な機能](#主な機能) · [クイックスタート](#クイックスタート) · [ドキュメント](#ドキュメント) · [ライセンス](#ライセンス)

> Web 版はキャンバスと UI の体験に適しています。ファイルシステム、認証情報ストレージ、独立ウィンドウ、3D ディレクターデスク、ローカルモデルなどは Tauri デスクトップ環境に依存します。完全な体験をご希望の場合は、以下の手順でデスクトップアプリを起動してください。

## 画面プレビュー

![AI Canvas Tauri Screenshot](public/screenshot.png)

## スポンサー

<table>
  <tr>
    <td align="center" width="140">
      <a href="https://www.runninghub.ai/call-api?source=github"><img src="doc/images/sponsors/runninghub-logo.png" alt="RunningHub API" width="80" height="80"></a><br>
      <a href="https://www.runninghub.ai/call-api?source=github"><strong>RunningHub API</strong></a>
    </td>
    <td>
      <strong>本プロジェクトをご支援いただいている <a href="https://www.runninghub.ai/call-api?source=github">RunningHub API</a> に感謝します！</strong>
      <ul>
        <li>Seedance、Kling、MiniMax、Nano Banana、Veo など、<strong>400 以上のモデルと 8,000 以上のバージョン</strong>を提供。国際版モデルにもアクセスできます。</li>
        <li><strong>高い同時実行性能と従量課金</strong>に対応。Seedance のオンラインツールは <strong>0.21 元／秒から（人民元）</strong>利用できます。</li>
        <li><strong>脚本から完成動画まで</strong>、無限キャンバス、ComfyUI、AI エージェントなどのオンラインツールで制作できます。</li>
        <li><strong>ひとつのプラットフォーム</strong>で LLM、マルチモーダル、ワークフローの各 API と AI アプリを利用できます。</li>
      </ul>
      <a href="https://www.runninghub.ai/call-api?source=github">モデルと API を見る</a> · 割引や API の無料テストについては <a href="mailto:zhenyuedong@haima.me">zhenyuedong@haima.me</a> までお問い合わせください。<br>
      <sub>モデル、バージョン、料金、特典、利用権限は RunningHub の公式情報とアカウントの契約内容に準じます。</sub>
    </td>
  </tr>
</table>

## 主な機能

| 機能 | 説明 |
| --- | --- |
| マルチモーダルキャンバス | テキスト、画像、動画、音声、アニメーション、Markdown、ショットリスト、パノラマ、ディレクター、手描きノートをノードとして接続します。 |
| グループ開閉時の間隔調整 | ヘッダーをダブルクリックして折りたたみ、フォルダーをダブルクリックして展開します。同じ行の右側の内容が移動し、間隔と手動移動を保持します。 |
| フレームアニメーション編集と出力 | Sprite Sheet を読み込み・生成し、フレームや再生効果を編集。GIF、PNG 連番、アトラスとして出力できます。 |
| AI とワークフロー | クラウド・カスタムモデル、CCC、LibAPI のテキスト・画像・動画・音声モデル、複数の ComfyUI サーバー、RunningHub、汎用ワークフロー API、Dreamina、ローカル ONNX モデルに接続します。 |
| ワークフローパラメーター | ローカル ComfyUI と RunningHub で共通の設定ポップオーバーを使用し、実際の定義に応じて比率・解像度・ステップ・スケジューラーを編集します。`C#` ノード ID と判定できたプロンプトの用途を表示し、既定の本文と参照素材はノードの入力欄を使います。 |
| クラウドワークフローの入力参照 | RunningHub ワークフローや AI アプリを選択し、`@` の ComfyUI タブで種類・名前・元ノード ID から入力先を選べます。RefMod のロール一覧はローカル ComfyUI のみで利用できます。 |
| シードとダウンロード復旧 | 数値シードをランダム・固定から選び、新しい空ノードで直前のワークフローと寸法を再利用できます。出力履歴から元のタスクのダウンロードを再試行でき、Windows の階層化された素材パスと書き出しエラーの位置表示も修正しました。 |
| プリセットの実行と共有 | 元の入力または前ステップの結果を参照し、高度なステップを順番または依存関係に沿って並列実行。JSON のコピー・出力・読み込みで独立したプリセットを共有できます。 |
| 動画パラメーターの保持 | 動画モデルを切り替えても、選択した比率と互換性のある解像度・フレームレート・長さ・音声設定を保持します。生成前に選択モデルの制約を確認してください。 |
| ユーザープラグイン | ローカルファイル、マーケット、GitHub Release からプラグインを導入し、ツール・ノード・画面を拡張します。JavaScript は制限された環境で、信頼済み Python は現在のユーザー権限で実行します。 |
| 脚本と原文の執筆 | メイン画面または独立ワークベンチで構成・各話の脚本・原文を編集し、タブに応じたツールを使えます。原文は通常のテキスト欄で執筆でき、AI の書き出し・続き・推敲は候補を採用して手動保存します。原文と各話の脚本はプロジェクトの `manuscripts` フォルダーに TXT で保存します。 |
| ストーリー関係図 | 人物・出来事・伏線と関係を、原文の根拠とともに図・時系列・一覧で整理します。AI の抽出結果はプレビューしてから図に追加します。 |
| 内蔵ビデオ編集 | 独立エディターで複数トラック、クリップ、トランジション、字幕、ステッカー、音量を編集。動画出力と MCP 制御に対応します。 |
| 対話エージェントと共同制作 | アシスタントと脚本ワークベンチが必要に応じて許可済みエージェントと Skill を選択し、複数モデルのチームと確認可能な成果を利用できます。ワークベンチ上部の Agent 協作で実行方法・メンバー・モデル・権限をまとめて設定し、Plan/B/C・プロジェクトメモリ・読み取り専用サブエージェントの制約を守ります。 |
| アシスタントウィンドウと最近の Skill | 会話の下書きを受け渡し、終了失敗時は編集に戻れます。ノードの `/` に最近使ったアップロード済み・パッケージ内の利用可能な Skill を最大 5 件表示し、メイン・独立アシスタントでの選択も同じ履歴に記録します。選択時は参照を挿入するだけで生成を開始しません。 |
| AI アプリノード | Agent または MCP で対話型アプリを作成。紐付けたキャンバス素材のみを参照し、読み取り専用の処理と結果の保存を行います。 |
| プロジェクト素材のクラウド同期 | S3 互換ストレージで共有プロジェクトに接続し、メディア、人物、シーン、小道具と関連情報を確認して手動同期します。クラウドのみの消去・削除ではローカル素材を保持します。グローバル素材と自動同期は対象外です。 |
| 万象 API のグループ | グループごとに独立した接続と API キーを管理し、対応済みのテキスト・画像・動画モデルを選択できます。 |
| キャラクターと創作素材 | プロジェクトとグローバルの人物・シーン・小道具・武器を管理。キャラクターに声・動作と同じライブラリの複数武器を関連付け、素材パッケージ、コピー、プロジェクトのクラウド同期でも関連を保持します。複数参照画像と画像単位の参照に対応します。 |
| MCP 外部制御 | 外部 AI ツールから本機 stdio または Streamable HTTP を通じてキャンバス、メディア、編集プロジェクトを操作します。初期状態は無効で、リモート接続は確認後に有効化します。 |
| ローカル保存 | プロジェクトと素材をローカル保存し、API キーは専用ストアで管理します。ファイル使用量とアプリデータの容量枠を分け、新旧プロジェクトの未参照の通常原本を確認・再検査してから整理します。新プロジェクトの不変メディア、インポート領域、未完了操作の対象は保護します。 |
| 画像のロスレス圧縮 | 画像ノードから PNG / JPEG をロスレス圧縮。サイズが小さくなる場合だけ別のコピーを作成し、元画像を保持します。 |
| シリーズと各話 | 各エピソードは独立したキャンバスを使い、シリーズ全体でキャラクター、プロジェクトメモリと素材を共有します。AI で本話の人物・小道具をリストに抽出し、確認後にライブラリへ追加または関連付けできます。 |
| 素材ライブラリと編集 | 素材・プロンプト・タグ・テキスト・Markdown のプレビューと編集、画像からのプロンプト一括抽出に対応。創作素材の複数選択、プロジェクトとグローバル間のコピー、素材パッケージの入出力、使用箇所の確認、見つからないファイルの再接続と欠落記録の整理にも対応。記録の整理は取り消せませんが、ディスク上のファイルは削除しません。 |
| 多言語インターフェース | 簡体字中国語・英語・日本語・韓国語に対応し、表示言語を切り替えてもユーザーの内容と編集中の下書きを保持します。 |
| 3D ディレクター | 軽量ディレクター、Blender 編集、AI ショットプレビズで、シーンの構築、ショットのプレビュー、動画出力を行います。 |
| 外観のカスタマイズ | 外観プリセットでページ、キャンバス、ノード、接続線を統一。カスタムテーマの作成とプリセットのインポート・エクスポートに対応します。 |
| 動画バッチと使用量 | 動画生成をバッチ管理し、Volcengine Ark の画像・動画ノードのローカル使用量レポートを出力します。使用量の見積もりは公式請求書ではありません。 |

利用できる機能はデスクトップ版のバージョンによって異なります。操作は[マニュアル](site/manual.html)、開発・連携資料は[モジュール一覧](doc/文档导航.md)（いずれも中国語）をご覧ください。

## 技術スタック

| 技術 | 用途 |
| --- | --- |
| [Tauri 2](https://tauri.app/) + Rust | デスクトップシェル、ウィンドウ、ファイル、アップデート、ローカルモデル、システム機能 |
| [React 19](https://react.dev/) + TypeScript 6 | UI、ドメイン型、厳格な型チェック |
| [React Flow 12](https://reactflow.dev/) | ノードキャンバス、接続、ビュー制御 |
| [Zustand 5](https://zustand.docs.pmnd.rs/) | スライス化されたグローバル状態管理 |
| [Tailwind CSS 3](https://tailwindcss.com/) | コンポーネントスタイルと `canvas-*` デザイントークン |
| [Vitest](https://vitest.dev/) | 自動テスト |
| IndexedDB | ローカル構造化データの永続化 |

## クイックスタート

### 必要環境

- Node.js: Vite 8 の動作要件を満たすもの（現行 LTS 推奨）
- npm
- Rust stable ツールチェーン
- Blender 編集（任意）：Windows x86_64 または macOS Intel／Apple Silicon、安定版 4.5 / 5.0 / 5.1 / 5.2 系列。軽量版は Blender 不要。
- プラットフォーム別の [Tauri システム依存関係](https://v2.tauri.app/start/prerequisites/)

Windows ビルドではさらに Visual Studio Build Tools 2022 と「C++ によるデスクトップ開発」ワークロードが必要です。

### 依存関係のインストール

```bash
npm install
```

### 開発環境の起動

```bash
# Web フロントエンドのみ起動。デフォルトで http://localhost:1420
npm run dev

# 完全な Tauri デスクトップアプリを起動
npm run tauri dev
```

Web モードは UI 開発に適しています。ネイティブダイアログ、ローカルファイルツール、独立ウィンドウ、ローカルモデル、3D ディレクターデスクなどは Tauri デスクトップ環境が必要です。

### チェックとビルド

```bash
# TypeScript 型チェック
npm run typecheck

# ESLint チェック
npm run lint

# ユニットテスト（Vitest）
npm run test

# lint + 型チェック + テスト
npm run check

# フロントエンド本番ビルド
npm run build

# デスクトップアプリのビルド
npm run tauri build
```

## ドキュメント

- [操作マニュアル（中国語）](site/manual.html)
- [モジュール一覧（中国語）](doc/文档导航.md)
- [開発指南](doc/开发指南.md): 環境、コマンド、ディレクトリ、開発規約、デバッグ、FAQ（中国語）
- [アーキテクチャ説明](doc/架构说明.md): コアモジュール、データフロー、セキュリティ境界、パフォーマンス設計（中国語）
- [プラグイン開発規約（中国語）](doc/插件开发规范.md): Manifest、JavaScript／Python、ノード、UI、権限と公開手順
- [ComfyUI ワークフロー統合説明](doc/ComfyUI工作流集成说明.md): インポート、IO ノード検出、コンテンツ・パラメータ注入、結果取得（中国語）
- [対話式キャンバスアシスタント機能方案](doc/对话式画布助手-功能方案.md)
- [対話アシスタント Agent 能力実施方案](doc/对话助手-Agent能力实施方案.md)
- [パッケージングとリリース手順](doc/打包与发版流程.md)

長期的なエンジニアリング境界はリポジトリ内の [AGENTS.md](AGENTS.md) に準拠し、アーキテクチャ決定記録は [`doc/adr/`](doc/adr/) にあります。

## ライセンス

本プロジェクトは **AI Canvas Tauri Source-Available License** に基づいて提供されます。全文は [LICENSE](LICENSE) をご覧ください。

学習、研究、社内利用、改変、統合利用は許可されています。許可のないスキン販売、ホワイトラベル配布、ソースコード転売、商業再配布、および本プロジェクトを同種製品として商業化することは禁止されています。

本プロジェクトは OSI 定義におけるオープンソースではありません。商用ライセンスをご希望の場合は著作権者にお問い合わせください。

### サードパーティ素材

キャンバスノートのツールバーとプロパティパネルのビジュアルデザインは [Excalidraw](https://github.com/excalidraw/excalidraw) を参考にしています。ライセンスは [doc/licenses/excalidraw-MIT.txt](doc/licenses/excalidraw-MIT.txt) をご覧ください。

## 連絡先

開発コミュニケーション QQ グループ: 873354155

## 共同開発者

<p>
  <a href="https://github.com/zhurui0523" title="zhurui0523"><img src="https://images.weserv.nl/?url=github.com/zhurui0523.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="zhurui0523" /></a>
  <a href="https://github.com/stars-one" title="stars-one"><img src="https://images.weserv.nl/?url=github.com/stars-one.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="stars-one" /></a>
  <a href="https://github.com/luckcatlin2000" title="luckcatlin2000"><img src="https://images.weserv.nl/?url=github.com/luckcatlin2000.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="luckcatlin2000" /></a>
  <a href="https://github.com/Lazzz-y" title="Lazzz-y"><img src="https://images.weserv.nl/?url=github.com/Lazzz-y.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="Lazzz-y" /></a>
  <a href="https://github.com/xiaozangao" title="xiaozangao"><img src="https://images.weserv.nl/?url=github.com/xiaozangao.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="xiaozangao" /></a>
  <a href="https://github.com/orlova851986-debug" title="orlova851986-debug"><img src="https://images.weserv.nl/?url=github.com/orlova851986-debug.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="orlova851986-debug" /></a>
</p>
