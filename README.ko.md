# AI Canvas Tauri

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · **한국어**

<p align="center">
  <img src="public/icons.svg" alt="AI Canvas Tauri Icon" width="140" height="140" />
</p>

> **Tauri 2 + React 19 + React Flow 12** 기반의 로컬 우선 AI 멀티모달 캔버스 및 대화형 에이전트 데스크톱 애플리케이션.

AI Canvas Tauri는 텍스트, 이미지, 비디오, 오디오, 프레임 단위 애니메이션, Markdown, 샷 리스트, 360° 파노라마, 손글씨 노트를 연결 가능한 캔버스 노드로 구성합니다. 하나의 프로젝트 안에서 생성 파이프라인을 구성하고, 캐릭터 라이브러리와 로컬 에셋을 관리하고, ComfyUI 워크플로를 실행하고, 대화형 어시스턴트로 캔버스를 조회·수정하고, 미디어를 생성하고, 읽기 전용 하위 에이전트를 파견하고, 허가된 파일을 읽고, 프로젝트 메모리를 축적할 수 있습니다. 프로젝트는 시리즈와 에피소드로 나눌 수 있으며, 숏폼 드라마의 각 회차는 하나의 캔버스를 갖고 캐릭터 라이브러리와 에셋은 시리즈 전체에서 공유합니다.

![Version](https://img.shields.io/badge/version-0.10.23-6366f1)
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
| 멀티모달 캔버스 | 텍스트, 이미지, 비디오, 오디오, 애니메이션, Markdown, 샷 리스트, 파노라마, 디렉터와 캔버스 노트를 노드로 연결합니다. |
| 프레임 애니메이션 편집 및 내보내기 | Sprite Sheet를 가져오거나 생성하고 프레임과 재생 효과를 편집한 뒤 GIF, PNG 시퀀스 또는 아틀라스로 내보냅니다. |
| AI 및 워크플로 | 클라우드·사용자 지정 모델, CCC, LibAPI의 텍스트·이미지·비디오·오디오 모델, 여러 ComfyUI 서버, RunningHub, 범용 워크플로 API, Dreamina와 로컬 ONNX 모델을 연결합니다. |
| 워크플로 매개변수 | 로컬 ComfyUI와 RunningHub가 같은 설정 팝오버를 사용하며 실제 정의에 따라 비율·해상도·스텝·스케줄러를 편집합니다. `C#` 노드 ID와 판별된 프롬프트 용도를 표시하고 기본 본문과 참조 소재는 노드 입력창을 사용합니다. |
| 프리셋 실행 및 공유 | 원본 입력 또는 이전 단계 결과를 참조하고, 고급 단계를 순차적으로 또는 의존성에 따라 병렬 실행합니다. JSON 복사·내보내기·가져오기로 독립된 프리셋을 공유할 수 있습니다. |
| 비디오 매개변수 유지 | 비디오 모델을 바꿔도 선택한 비율과 호환되는 해상도·프레임 속도·길이·오디오 설정을 유지합니다. 생성 전에 선택 모델의 제한을 확인하세요. |
| 사용자 플러그인 | 로컬 파일, 마켓 또는 GitHub Release에서 플러그인을 설치해 도구·노드·화면을 확장합니다. JavaScript는 제한된 환경에서, 신뢰하는 Python 플러그인은 현재 사용자 권한으로 실행합니다. |
| 대본 및 샷 제작 | 원작을 탐색하고 회차 대본을 작성하며 샷을 생성·수정합니다. 음성·비디오 소재를 준비해 편집 타임라인으로 보낼 수 있습니다. |
| 내장 비디오 편집 | 독립 편집기에서 여러 트랙, 클립, 전환, 자막, 스티커와 볼륨을 편집합니다. 비디오 내보내기와 MCP 제어를 지원합니다. |
| 대화형 에이전트 | 대화로 캔버스를 조회·편집하고 미디어를 생성하며 작업을 관리합니다. 다중 대화, Plan/B/C 모드, 프로젝트 메모리, 독립 창과 읽기 전용 하위 에이전트를 지원합니다. |
| AI 앱 노드 | Agent 또는 MCP로 대화형 앱을 생성합니다. 연결된 캔버스 에셋만 사용해 읽기 전용 작업을 실행하고 결과를 저장할 수 있습니다. |
| 프로젝트 에셋 클라우드 동기화 | S3 호환 저장소의 공유 프로젝트에 연결해 미디어, 인물, 장면, 소품과 관련 정보를 미리 보고 수동 동기화합니다. 클라우드만 비우거나 삭제해도 로컬 에셋은 유지되며 글로벌 에셋과 자동 동기화는 포함되지 않습니다. |
| 만상 API 그룹 | 그룹별 독립 연결과 API 키를 관리하고 지원되는 텍스트·이미지·비디오 모델을 선택합니다. |
| 캐릭터 및 창작 에셋 | 프로젝트와 글로벌의 캐릭터·장면·소품·무기를 관리합니다. 캐릭터에 음성·동작과 같은 라이브러리의 여러 무기를 연결하고, 에셋 패키지·복사·프로젝트 클라우드 동기화에서도 연결을 유지합니다. 여러 참조 이미지와 이미지별 정확한 참조를 지원합니다. |
| MCP 외부 제어 | 외부 AI 도구가 로컬 stdio 또는 Streamable HTTP로 캔버스, 미디어와 편집 프로젝트를 제어할 수 있습니다. 기본적으로 꺼져 있으며 원격 연결은 확인 후 활성화합니다. |
| 로컬 저장 | 프로젝트와 미디어를 로컬에 저장하고 API 키는 별도의 자격 증명 저장소에서 관리합니다. 저장소 진단은 파일 사용량과 앱 데이터 할당량을 구분하고, 정리 전 확인과 참조 재검사, 참조되지 않은 파일의 저장 위치 열기를 지원합니다. |
| 이미지 무손실 압축 | 이미지 노드에서 PNG / JPEG를 무손실 압축합니다. 용량이 줄어들 때만 별도 사본을 만들고 원본 이미지는 유지합니다. |
| 시리즈 및 회차 | 각 회차는 독립 캔버스를 사용하고 캐릭터, 프로젝트 메모리와 에셋은 시리즈 전체에서 공유합니다. AI로 회차 캐릭터·소품 목록을 추출한 뒤 확인하여 라이브러리에 추가하거나 연결할 수 있습니다. |
| 에셋 라이브러리 및 편집 | 소재·프롬프트·태그·텍스트·Markdown의 미리보기와 편집, 이미지 프롬프트 일괄 추출을 지원합니다. 창작 에셋 다중 선택, 프로젝트와 글로벌 간 복사, 에셋 패키지 가져오기·내보내기, 사용 위치 조회, 누락된 파일 재연결과 누락 기록 정리를 제공합니다. 기록 정리는 되돌릴 수 없지만 디스크 파일은 삭제하지 않습니다. |
| 다국어 인터페이스 | 중국어 간체·영어·일본어·한국어를 지원하며, 표시 언어를 바꿔도 사용자 콘텐츠와 편집 중인 초안을 유지합니다. |
| 3D 디렉터 | 경량 디렉터, Blender 편집과 AI 샷 프리비즈로 장면을 구성하고 샷을 미리 보며 비디오를 출력합니다. |
| 외관 사용자 지정 | 외관 프리셋으로 페이지, 캔버스, 노드와 연결선을 통일합니다. 사용자 테마 생성과 프리셋 가져오기·내보내기를 지원합니다. |
| 비디오 배치 및 사용량 | 비디오 생성 작업을 일괄 관리하고 Volcengine Ark 이미지·비디오 노드의 로컬 사용량 보고서를 내보냅니다. 사용량 추정치는 공식 청구서가 아닙니다. |

사용 가능한 기능은 데스크톱 앱 버전에 따라 다릅니다. 조작 방법은 [사용 설명서](site/manual.html), 개발·통합 자료는 [모듈 안내](doc/文档导航.md) (모두 중국어)를 참고하세요.

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

## 문서

- [사용 설명서 (중국어)](site/manual.html)
- [모듈 문서 안내 (중국어)](doc/文档导航.md)
- [개발 가이드](doc/开发指南.md): 환경, 명령어, 디렉터리, 개발 규약, 디버깅, FAQ (중국어)
- [아키텍처 설명](doc/架构说明.md): 핵심 모듈, 데이터 흐름, 보안 경계, 성능 설계 (중국어)
- [플러그인 개발 규약 (중국어)](doc/插件开发规范.md): Manifest, JavaScript/Python, 노드, UI, 권한 및 릴리스
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
  <a href="https://github.com/Lazzz-y" title="Lazzz-y"><img src="https://images.weserv.nl/?url=github.com/Lazzz-y.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="Lazzz-y" /></a>
  <a href="https://github.com/xiaozangao" title="xiaozangao"><img src="https://images.weserv.nl/?url=github.com/xiaozangao.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="xiaozangao" /></a>
  <a href="https://github.com/orlova851986-debug" title="orlova851986-debug"><img src="https://images.weserv.nl/?url=github.com/orlova851986-debug.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="orlova851986-debug" /></a>
</p>
