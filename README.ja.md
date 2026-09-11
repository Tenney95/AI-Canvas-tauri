# AI Canvas Tauri

[简体中文](README.md) · [English](README.en.md) · **日本語** · [한국어](README.ko.md)

<p align="center">
  <img src="public/icons.svg" alt="AI Canvas Tauri Icon" width="140" height="140" />
</p>

> **Tauri 2 + React 19 + React Flow 12** で構築した、ローカルファーストの AI マルチモーダルキャンバス＆対話エージェントデスクトップアプリ。

AI Canvas Tauri は、テキスト・画像・動画・音声・コマ撮りアニメーション・Markdown・ショットリスト・360° パノラマ・手描きノートを、接続可能なキャンバスノードとして整理します。ひとつのプロジェクト内で生成パイプラインを構成し、キャラクターライブラリとローカル素材を管理し、ComfyUI ワークフローを実行し、対話アシスタントでキャンバスの参照・編集、メディア生成、読み取り専用サブエージェントの派遣、許可済みファイルの読み取り、プロジェクトメモリの蓄積ができます。プロジェクトはシリーズとエピソードに分割でき、短編ドラマの各話ごとにキャンバスを持ち、キャラクターライブラリと素材はシリーズ全体で共有します。

![Version](https://img.shields.io/badge/version-0.9.7-6366f1)
![Tauri](https://img.shields.io/badge/Tauri-2-24c8db)
![React](https://img.shields.io/badge/React-19-61dafb)
![React Flow](https://img.shields.io/badge/React_Flow-12-ff0072)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6)
![License](https://img.shields.io/badge/license-source--available-f59e0b)

**オンライン体験:** <https://tenney95.github.io/AI-Canvas-tauri/>（トップ画面ですぐ試せます。デモキャンバス内蔵）

**ダウンロード:** <https://github.com/tenney95/AI-Canvas-tauri/releases>（デスクトップインストーラー）

[オンライン体験](https://tenney95.github.io/AI-Canvas-tauri/) · [ダウンロード](https://github.com/tenney95/AI-Canvas-tauri/releases) · [主な機能](#主な機能) · [クイックスタート](#クイックスタート) · [ドキュメント](#ドキュメント) · [ライセンス](#ライセンス)

> Web 版はキャンバスと UI の体験に適しています。ファイルシステム、認証情報ストレージ、独立ウィンドウ、3D ディレクターデスク、ローカルモデルなどは Tauri デスクトップ環境に依存します。完全な体験をご希望の場合は、以下の手順でデスクトップアプリを起動してください。

## 画面プレビュー

![AI Canvas Tauri Screenshot](public/screenshot.png)

## 主な機能

| 機能 | 説明 |
| --- | --- |
| マルチモーダルキャンバス | テキスト、画像、動画、音声、アニメーション、Markdown、ショットリスト、パノラマ、ディレクター、素材、ノートを接続。ミニマップの件数表示、遠景の軽量表示、段階的な表示更新に対応し、元の素材とデータを保持します。 |
| AI とワークフロー | クラウドモデル、カスタム実行プロトコル、複数 ComfyUI サーバー、RunningHub ワークフロー／AI アプリ、汎用 Workflow API と AutoDL H3 テンプレート、Dreamina、ローカル ONNX に対応。入力、アップロード、進捗、復旧は各サービスの仕様に従います。 |
| ユーザープラグイン | ローカル、マーケット、GitHub Release から JavaScript／信頼済み Python プラグインを導入し、ツール・ノード・ホスト管理 UI を拡張。JavaScript は QuickJS、Python は現在のユーザー権限で実行。ソースと完全な revision のダイジェストを検証し、無効化・更新後の古い結果は書き戻しません。 |
| 脚本とショット制作 | 原作の章閲覧、各話の執筆、脚本スナップショット、ショット修正と画像補完、音声・動画・ディレクターノードの準備に対応。セリフ字幕と準備済み音声をタイムラインへ送り、キャラクターの動作素材を @ で参照できます。 |
| 内蔵ビデオ編集 | 独立エディターで複数トラック、トリミング、分割、変形、トランジション、文字、ステッカー、音量を編集し、パススルーまたは合成出力。MCP から工程編集、バックグラウンド出力、メディア解析、フレーム抽出も可能です。 |
| 対話エージェント | 複数会話、ストリーミング、Plan/B/C モード、ツール、承認カード、タスク履歴、コンテキスト圧縮、プロジェクトメモリ。 |
| 読み取り専用サブエージェント | 専門役割を設定し、主タスクが必要に応じて並列実行。読み取り専用の結果をサニタイズして返します。 |
| キャラクターと創作素材 | プロジェクト／グローバルのキャラクターカード、参照画像、声、動作素材を管理。人物・シーン・小道具の抽出、説明、画像の紐付けに対応。 |
| MCP 外部制御 | 初期状態は無効。本機 stdio と追加の設定確認を伴う Streamable HTTP に対応し、必要なツールのみ取得する方式が標準です。素材取り込み、画像分割アップロード、システム貼り付け、画面のキャンバス取り込み、編集工程操作が可能。自律モードで実行しますが、選択質問はユーザーが回答します。 |
| ローカル保存と設定保護 | 素材はプロジェクトフォルダー、構造化データは IndexedDB、API キーは Rust 認証情報ストアへ保存。設定は変更項目ごとに競合を検出し、失敗時は下書きを保持して再試行／再読み込みを提供。終了前に保存を待機します。 |
| シリーズと各話 | 各話が独立キャンバスを持ち、キャラクター、メモリ、素材フォルダーはシリーズで共有。脚本から各話を一括作成できます。 |
| 素材ライブラリとプレビュー | Tab で左サイドバーを開閉し、プロジェクトファイル、グローバル素材、創作素材、ノード一覧を切り替え。カードからノードの位置表示と接続、番号順の全画面画像閲覧、動画の浮動再生、出力履歴の固定に対応。復元可能な削除とデスクトップ .aicanvas パッケージも利用できます。 |
| ガイドとヘルプ | 初回ガイド、用途別ヘルプ、オフライン操作マニュアルで @ 参照、ComfyUI 入力、ショートカット、カスタム API を解説。 |
| 2 種類の 3D ディレクター | 軽量版は必要時に実行リソースを導入。Blender 編集は Windows x86_64 と macOS Intel／Apple Silicon、安定版 4.5・5.0・5.1・5.2 系列に対応。保存して戻る際はカメラ PNG と .blend の両方を検証します。 |

本ドキュメントは 0.9.7 と 2026-09-11 までの後続ソース更新を対象とします。配布済みインストーラーには後続機能が含まれない場合があります。操作は[マニュアル](site/manual.html)、実装の担当範囲と検証状況は[モジュール一覧](doc/文档导航.md)（中国語）をご覧ください。

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

バージョンの基準は `package.json` です。`npm run sync-version` が更新するのは中国語 README のバッジと `src-tauri/Cargo.toml` のみです。Tauri 設定、翻訳 README、サイト、マニュアルは別途確認してください。[リリース手順](doc/打包与发版流程.md)を参照。

## ドキュメント

- [操作マニュアル（中国語）](site/manual.html)
- [モジュール一覧（中国語）](doc/文档导航.md)
- [開発指南](doc/开发指南.md): 環境、コマンド、ディレクトリ、開発規約、デバッグ、FAQ（中国語）
- [アーキテクチャ説明](doc/架构说明.md): コアモジュール、データフロー、セキュリティ境界、パフォーマンス設計（中国語）
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
  <a href="https://github.com/xiaozangao" title="xiaozangao"><img src="https://images.weserv.nl/?url=github.com/xiaozangao.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="xiaozangao" /></a>
  <a href="https://github.com/orlova851986-debug" title="orlova851986-debug"><img src="https://images.weserv.nl/?url=github.com/orlova851986-debug.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="orlova851986-debug" /></a>
</p>
