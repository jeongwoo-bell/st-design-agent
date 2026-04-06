# st-design-agent

SleepThera 랜딩페이지를 위한 **AI 디자인 에이전트**. 사용자가 UI 수정을 요청하면, AI가 스펙 문서를 참조하여 코드를 자동으로 수정하고 빌드 검증 후 Vercel 프리뷰까지 제공한다.

## 실행 모드

| 모드 | 엔트리포인트 | 설명 |
|------|-------------|------|
| 슬랙 봇 | `node --env-file=.env bot.js` | 슬랙 @멘션 기반 (기존) |
| 웹 API | `node --env-file=.env server.js` | REST + WebSocket (신규) |

## 웹 API (server.js)

```
POST /api/request   { message, threadId?, figmaUrl?, userName?, chatHistory? }
GET  /api/health    헬스 체크
WS   ws://host:3001 실시간 진행상황 (subscribe → progress → complete)
```

프론트엔드 레포: `Sleep-agent-front` (별도 레포)

## 동작 방식

1. 메시지 수신 → Haiku로 분류 (code / ask / talk / ticket / unclear)
2. `code` 요청 시:
   - docs 레포에서 관련 스펙 문서 조회 (`docs-reader.js`)
   - 스펙 기반 구현 여부 확인 → 이미 구현됐으면 스킵, 부분/미구현이면 진행
   - Haiku로 관련 파일 특정 (`file-analyzer.js`)
   - Sonnet으로 코드 수정안 생성 (`code-generator.js`, tool use 멀티턴) — docs 스펙 + 피그마 컨텍스트 포함
   - 파일 적용 → `pnpm build` 검증 (실패 시 최대 3회 재시도) (`builder.js`)
   - git commit & push → Vercel 배포 대기 → 응답
3. `ask` 요청 시: 코드 읽고 기술 질문에 답변
4. `talk` 요청 시: 일반 대화
5. 후속 메시지는 같은 브랜치에서 이어서 작업 (threadId 기반)

## 아키텍처

```
bot.js                  # 슬랙 봇 엔트리포인트
server.js               # 웹 API 엔트리포인트 (Express + WebSocket)
wizkey-prompt.js        # Sonnet/Haiku 시스템 프롬프트
src/
├── web-handler.js      # 웹 API용 오케스트레이터 (슬랙/JIRA 의존성 없음)
├── handler.js          # 슬랙 봇용 오케스트레이터
├── classifier.js       # Haiku: 메시지 분류 + 변경 요약 + 검증 + 티켓 매칭
├── file-analyzer.js    # 파일 트리 수집 + Haiku로 관련 파일 특정
├── code-generator.js   # Sonnet: tool use로 코드 수정안 생성 (멀티턴)
├── builder.js          # 파일 적용 + pnpm build 검증 + revert
├── docs-reader.js      # docs 레포 스펙 읽기 + 관련 스펙 매칭 + 구현 여부 판단
├── figma.js            # Figma REST API로 디자인 스펙 추출
├── git.js              # git 명령 실행 (clone, branch, commit, push, docs 레포 관리)
├── claude.js           # Anthropic SDK 래퍼 (callHaiku, callSonnet)
├── vercel.js           # Vercel API 폴링으로 프리뷰 URL 확보
├── parser.js           # 유틸: 텍스트 잘라내기, 브랜치명 생성, 피그마 링크 감지
├── bot-guide.js        # 봇 기능 가이드 (프롬프트에서 공통 참조)
├── config.js           # 환경변수 → CONFIG 객체
├── messages.js         # 응답 메시지 템플릿
├── thread-map.js       # 스레드/대화 ↔ 브랜치 매핑 (파일 persist)
└── queue.js            # 요청 큐 (동시 처리 방지)
```

## 환경변수

| 변수 | 필수 | 용도 |
|---|---|---|
| `ANTHROPIC_API_KEY` | O | Claude API 키 |
| `REPO_URL` | O | 대상 레포 Git URL |
| `REPO_BRANCH` | - | 기본 브랜치 (기본값: develop) |
| `REPO_PATH` | - | 레포 클론 경로 (기본값: /tmp/design-bot-repo) |
| `GITHUB_TOKEN` | - | GitHub API (PR 생성) |
| `FIGMA_API_KEY` | - | Figma REST API |
| `VERCEL_TOKEN` | - | Vercel 배포 폴링 |
| `VERCEL_PROJECT_ID` | - | Vercel 프로젝트 ID |
| `VERCEL_TEAM_ID` | - | Vercel 팀 ID |
| `DOCS_REPO_URL` | - | 스펙 문서 레포 Git URL |
| `DOCS_REPO_PATH` | - | docs 레포 클론 경로 (기본값: /tmp/design-bot-docs) |
| `DOCS_REPO_BRANCH` | - | docs 레포 브랜치 (기본값: main) |
| `PORT` | - | 웹 API 포트 (기본값: 3001) |

## 핵심 흐름 (web-handler.js)

`_processCodeRequest()` 파이프라인:
1. 브랜치 생성/전환
2. 피그마 데이터 (있으면)
3. 파일 트리 → 관련 파일 특정 → 읽기
4. **`buildDocsContext()`** — docs 레포에서 관련 스펙 찾기 → 구현 여부 판단
5. `generateCodeChanges()` — Sonnet tool use (docs + 피그마 컨텍스트 포함)
6. `applyChanges()` + 재시도
7. `verifyChanges()` — 누락 검증
8. `runBuild()` — 실패 시 재시도 (최대 3회)
9. git push → Vercel 프리뷰 대기

진행상황은 `emit()` 콜백으로 WebSocket에 실시간 전송.

## 주의사항

- `web-handler.js`는 슬랙/JIRA 의존성 없이 독립 동작
- `handler.js`(슬랙용)와 `web-handler.js`(웹용)는 같은 핵심 모듈을 공유
- 빌드 재시도 시 새로 생성된 파일도 컨텍스트에 포함해야 함
- `code-generator.js`의 tool use 멀티턴: read_file 요청 시 파일을 읽어 tool_result로 전달
- 커밋 시 `changes` 배열의 파일만 git add — fixBuildError 수정분도 포함해야 함
