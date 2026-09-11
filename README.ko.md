# AI Canvas Tauri

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · **한국어**

<p align="center">
  <img src="public/icons.svg" alt="AI Canvas Tauri Icon" width="140" height="140" />
</p>

> **Tauri 2 + React 19 + React Flow 12** 기반의 로컬 우선 AI 멀티모달 캔버스 및 대화형 에이전트 데스크톱 애플리케이션.

AI Canvas Tauri는 텍스트, 이미지, 비디오, 오디오, 프레임 단위 애니메이션, Markdown, 샷 리스트, 360° 파노라마, 손글씨 노트를 연결 가능한 캔버스 노드로 구성합니다. 하나의 프로젝트 안에서 생성 파이프라인을 구성하고, 캐릭터 라이브러리와 로컬 에셋을 관리하고, ComfyUI 워크플로를 실행하고, 대화형 어시스턴트로 캔버스를 조회·수정하고, 미디어를 생성하고, 읽기 전용 하위 에이전트를 파견하고, 허가된 파일을 읽고, 프로젝트 메모리를 축적할 수 있습니다. 프로젝트는 시리즈와 에피소드로 나눌 수 있으며, 숏폼 드라마의 각 회차는 하나의 캔버스를 갖고 캐릭터 라이브러리와 에셋은 시리즈 전체에서 공유합니다.

![Version](https://img.shields.io/badge/version-0.9.7-6366f1)
![Tauri](https://img.shields.io/badge/Tauri-2-24c8db)
![React](https://img.shields.io/badge/React-19-61dafb)
![React Flow](https://img.shields.io/badge/React_Flow-12-ff0072)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6)
![License](https://img.shields.io/badge/license-source--available-f59e0b)

**온라인 체험:** <https://tenney95.github.io/AI-Canvas-tauri/> (첫 화면에서 바로 사용 가능, 데모 캔버스 내장)

**다운로드:** <https://github.com/tenney95/AI-Canvas-tauri/releases> (데스크톱 설치 패키지)

[온라인 체험](https://tenney95.github.io/AI-Canvas-tauri/) · [다운로드](https://github.com/tenney95/AI-Canvas-tauri/releases) · [주요 기능](#주요-기능) · [빠른 시작](#빠른-시작) · [문서](#문서) · [라이선스](#라이선스)

> 웹 버전은 캔버스와 인터페이스 체험에 적합합니다. 파일 시스템, 자격 증명 저장소, 독립 창, 3D 디렉터 데스크, 로컬 모델 등은 Tauri 데스크톱 환경에 의존합니다. 완전한 체험을 원하시면 아래 단계에 따라 데스크톱 앱을 실행하세요.

## 화면 미리보기

![AI Canvas Tauri Screenshot](public/screenshot.png)

## 주요 기능

| 기능 | 설명 |
| --- | --- |
| 멀티모달 캔버스 | 텍스트, 이미지, 비디오, 오디오, 애니메이션, Markdown, 샷 리스트, 파노라마, 디렉터, 소스 파일 및 노트를 연결합니다. 미니맵 통계, 축소 화면의 경량 노드, 점진적 표시를 지원하며 원본 미디어와 데이터를 유지합니다. |
| AI 및 워크플로 | 클라우드 모델, 사용자 지정 실행 프로토콜, 여러 ComfyUI 서버, RunningHub 워크플로/AI 앱, 범용 Workflow API 및 AutoDL H3 템플릿, Dreamina, 로컬 ONNX를 지원합니다. 입력, 업로드, 진행률, 복구는 플랫폼별로 처리합니다. |
| 사용자 플러그인 | 로컬 폴더, 마켓, GitHub Release에서 JavaScript/신뢰하는 Python 플러그인을 설치해 도구·노드·호스트 관리 UI를 확장합니다. JavaScript는 QuickJS에서, Python은 현재 사용자 권한으로 실행합니다. 소스 및 전체 revision 해시를 확인하고 비활성화되거나 교체된 버전의 결과 쓰기를 차단합니다. |
| 대본 및 샷 제작 | 원작의 장 탐색, 회차 집필, 대본 스냅샷, 샷 수정 및 이미지 보완, 음성/비디오/디렉터 노드 준비를 지원합니다. 대사 자막과 준비된 더빙을 타임라인에 보내고 캐릭터 동작 미디어를 @로 참조할 수 있습니다. |
| 내장 비디오 편집 | 독립 편집기에서 여러 트랙, 자르기, 분할, 변형, 전환, 텍스트, 스티커, 볼륨을 편집하고 패스스루 또는 합성으로 내보냅니다. MCP로 편집 프로젝트 수정, 백그라운드 내보내기, 미디어 분석, 프레임 추출도 가능합니다. |
| 대화형 에이전트 | 다중 대화, 스트리밍, Plan/B/C 모드, 도구, 승인 카드, 작업 타임라인, 컨텍스트 압축 및 프로젝트 메모리. |
| 읽기 전용 하위 에이전트 | 전문 역할을 설정하면 주 작업이 필요에 따라 병렬 실행하고 정제된 읽기 전용 결과를 돌려받습니다. |
| 캐릭터 및 창작 에셋 | 프로젝트/글로벌 캐릭터 카드, 참조 이미지, 음성, 동작 미디어를 관리하며 인물·장면·소품 추출, 설명 및 이미지 연결을 지원합니다. |
| MCP 외부 제어 | 기본적으로 꺼져 있습니다. 로컬 stdio와 추가 설정 확인이 필요한 Streamable HTTP를 지원하며 필요한 도구만 검색하는 방식이 기본입니다. 미디어 가져오기, 이미지 분할 업로드, 시스템 붙여넣기, 화면 캔버스 가져오기, 편집 프로젝트 제어가 가능합니다. 자율 모드로 실행하지만 사용자 선택 질문은 직접 답해야 합니다. |
| 로컬 저장 및 설정 보호 | 미디어는 프로젝트 폴더, 구조화 데이터는 IndexedDB, API 키는 Rust 자격 증명 저장소에 보관합니다. 변경 필드별 저장과 충돌 검사를 수행하며 실패 시 초안을 보존하고 재시도/다시 불러오기를 제공합니다. 종료 전에 저장을 기다립니다. |
| 시리즈 및 회차 | 각 회차는 독립 캔버스를 사용하고 캐릭터, 메모리, 미디어 폴더는 시리즈 전체에서 공유합니다. 대본을 읽어 회차를 일괄 생성할 수 있습니다. |
| 에셋 라이브러리 및 미리보기 | Tab으로 왼쪽 패널을 열고 프로젝트 파일, 글로벌 에셋, 창작 에셋, 노드 목록을 탐색합니다. 카드에서 노드 위치 찾기와 연결, 번호순 전체 화면 이미지 보기, 비디오 팝업 재생, 출력 기록 고정을 지원합니다. 복구 가능한 삭제 및 데스크톱 .aicanvas 패키지도 제공합니다. |
| 가이드 및 도움말 | 첫 실행 가이드, 용도별 도움말, 오프라인 설명서에서 @ 참조, ComfyUI 입력, 단축키 및 사용자 지정 API를 안내합니다. |
| 두 가지 3D 디렉터 런타임 | 경량 디렉터는 필요할 때 실행 리소스를 설치합니다. Blender 편집은 Windows x86_64와 macOS Intel/Apple Silicon 및 안정판 4.5·5.0·5.1·5.2 계열을 지원합니다. 저장 후 돌아올 때 카메라 PNG와 .blend 프로젝트를 모두 검증합니다. |

문서는 0.9.7 및 2026-09-11까지의 후속 소스 업데이트를 다룹니다. 배포된 설치 파일에는 이후 기능이 없을 수 있습니다. 조작 방법은 [사용 설명서](site/manual.html), 구현 범위와 검증 상태는 [모듈 안내](doc/文档导航.md) (중국어)를 참고하세요.

## 기술 스택

| 기술 | 용도 |
| --- | --- |
| [Tauri 2](https://tauri.app/) + Rust | 데스크톱 셸, 창, 파일, 업데이트, 로컬 모델 및 시스템 기능 |
| [React 19](https://react.dev/) + TypeScript 6 | UI, 도메인 타입 및 엄격한 타입 검사 |
| [React Flow 12](https://reactflow.dev/) | 노드 캔버스, 연결 및 뷰 제어 |
| [Zustand 5](https://zustand.docs.pmnd.rs/) | 슬라이스 기반 전역 상태 관리 |
| [Tailwind CSS 3](https://tailwindcss.com/) | 컴포넌트 스타일 및 `canvas-*` 디자인 토큰 |
| [Vitest](https://vitest.dev/) | 자동화 테스트 |
| IndexedDB | 로컬 구조화 데이터 영속화 |

## 빠른 시작

### 환경 요구사항

- Node.js: Vite 8 실행 요건 충족, 현재 LTS 권장
- npm
- Rust stable 툴체인
- Blender 편집 (선택): Windows x86_64 또는 macOS Intel/Apple Silicon, 안정판 4.5 / 5.0 / 5.1 / 5.2 계열. 경량 디렉터에는 Blender가 필요하지 않습니다.
- 플랫폼별 [Tauri 시스템 종속성](https://v2.tauri.app/start/prerequisites/)

Windows 빌드에는 Visual Studio Build Tools 2022와 "C++를 사용한 데스크톱 개발" 워크로드가 추가로 필요합니다.

### 의존성 설치

```bash
npm install
```

### 개발 환경 실행

```bash
# 웹 프론트엔드만 실행, 기본적으로 http://localhost:1420 접속
npm run dev

# 전체 Tauri 데스크톱 앱 실행
npm run tauri dev
```

웹 모드는 UI 개발에 적합합니다. 네이티브 대화상자, 로컬 파일 도구, 독립 창, 로컬 모델, 3D 디렉터 데스크 등은 Tauri 데스크톱 환경이 필요합니다.

### 검사 및 빌드

```bash
# TypeScript 타입 검사
npm run typecheck

# ESLint 검사
npm run lint

# 단위 테스트 (Vitest)
npm run test

# lint + 타입 검사 + 테스트
npm run check

# 프론트엔드 프로덕션 빌드
npm run build

# 데스크톱 앱 빌드
npm run tauri build
```

버전 기준은 `package.json`입니다. `npm run sync-version`은 중국어 README 배지와 `src-tauri/Cargo.toml`만 업데이트합니다. Tauri 설정, 번역 README, 사이트 및 설명서는 따로 확인해야 합니다. [릴리스 안내](doc/打包与发版流程.md)를 참고하세요.

## 문서

- [사용 설명서 (중국어)](site/manual.html)
- [모듈 문서 안내 (중국어)](doc/文档导航.md)
- [개발 가이드](doc/开发指南.md): 환경, 명령어, 디렉터리, 개발 규약, 디버깅, FAQ (중국어)
- [아키텍처 설명](doc/架构说明.md): 핵심 모듈, 데이터 흐름, 보안 경계, 성능 설계 (중국어)
- [ComfyUI 워크플로 통합 설명](doc/ComfyUI工作流集成说明.md): 가져오기, IO 노드 감지, 콘텐츠·파라미터 주입, 결과 회수 (중국어)
- [대화형 캔버스 어시스턴트 기능 방안](doc/对话式画布助手-功能方案.md)
- [대화형 어시스턴트 에이전트 역량 구현 방안](doc/对话助手-Agent能力实施方案.md)
- [패키징 및 릴리스 절차](doc/打包与发版流程.md)

장기적인 엔지니어링 경계는 저장소의 [AGENTS.md](AGENTS.md)를 따르며, 아키텍처 결정 기록은 [`doc/adr/`](doc/adr/)에 있습니다.

## 라이선스

본 프로젝트는 **AI Canvas Tauri Source-Available License**에 따라 제공됩니다. 전체 조항은 [LICENSE](LICENSE)를 참고하세요.

학습, 연구, 내부 사용, 수정 및 통합 사용이 허용됩니다. 무단 스킨 판매, 화이트라벨 배포, 소스 코드 재판매, 상업적 재배포 및 본 프로젝트를 동종 제품으로 상업화하는 것은 금지됩니다.

본 프로젝트는 OSI 정의상 오픈소스가 아닙니다. 상업용 라이선스가 필요하시면 저작권자에게 문의하세요.

### 타사 소재

캔버스 노트의 툴바 및 속성 패널 시각 디자인은 [Excalidraw](https://github.com/excalidraw/excalidraw)를 참고했습니다. 라이선스는 [doc/licenses/excalidraw-MIT.txt](doc/licenses/excalidraw-MIT.txt)를 참고하세요.

## 연락처

개발 소통 QQ 그룹: 873354155

## 공동 개발자

<p>
  <a href="https://github.com/zhurui0523" title="zhurui0523"><img src="https://images.weserv.nl/?url=github.com/zhurui0523.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="zhurui0523" /></a>
  <a href="https://github.com/stars-one" title="stars-one"><img src="https://images.weserv.nl/?url=github.com/stars-one.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="stars-one" /></a>
  <a href="https://github.com/luckcatlin2000" title="luckcatlin2000"><img src="https://images.weserv.nl/?url=github.com/luckcatlin2000.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="luckcatlin2000" /></a>
  <a href="https://github.com/xiaozangao" title="xiaozangao"><img src="https://images.weserv.nl/?url=github.com/xiaozangao.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="xiaozangao" /></a>
  <a href="https://github.com/orlova851986-debug" title="orlova851986-debug"><img src="https://images.weserv.nl/?url=github.com/orlova851986-debug.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="orlova851986-debug" /></a>
</p>
