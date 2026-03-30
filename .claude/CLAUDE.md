# st-design-agent

SleepThera 랜딩페이지를 위한 **슬랙 기반 디자인 봇**. 디자이너가 슬랙에서 @멘션으로 UI 수정을 요청하면, AI가 코드를 자동으로 수정하고 빌드 검증 후 Vercel 프리뷰까지 제공한다.

## 동작 방식

1. 슬랙 메시지 수신 → Haiku로 분류 (code / chat / unclear)
2. `code` 요청 시:
   - Haiku로 관련 파일 특정 (`file-analyzer.js`)
   - Sonnet으로 코드 수정안 생성 (`code-generator.js`, tool use 멀티턴)
   - 파일 적용 → `pnpm build` 검증 (실패 시 최대 3회 재시도) (`builder.js`)
   - git commit & push → Vercel 배포 대기 → 슬랙 응답
3. `chat` 요청 시: Haiku가 기술 질문에 답변
4. 스레드 내 후속 메시지는 같은 브랜치에서 이어서 작업
5. `/pr` 명령으로 Draft PR 생성

## 이 봇이 수정하는 대상 레포

- **SleepThera 랜딩페이지** (Next.js + TypeScript + Tailwind CSS)
- 환경변수 `REPO_URL`로 지정, `REPO_PATH` (기본 `/tmp/design-bot-repo`)에 클론
- 이 레포 자체는 봇 코드이며, 랜딩페이지 코드가 아님

## 아키텍처

```
bot.js                  # 엔트리포인트
wizkey-prompt.js        # Sonnet/Haiku 시스템 프롬프트
src/
├── slack.js            # Slack Bolt 이벤트 핸들러 (멘션, 스레드 메시지)
├── handler.js          # 오케스트레이터 (전체 흐름 제어, 핵심 파일)
├── classifier.js       # Haiku: 메시지 분류, TMI 생성, 변경 요약
├── file-analyzer.js    # 파일 트리 수집 + Haiku로 관련 파일 특정
├── code-generator.js   # Sonnet: tool use로 코드 수정안 생성 (멀티턴)
├── builder.js          # 파일 적용 + pnpm build 검증 + revert
├── figma.js            # Figma REST API로 디자인 스펙 추출
├── git.js              # git 명령 실행 (clone, branch, commit, push)
├── vercel.js           # Vercel API 폴링으로 프리뷰 URL 확보
├── parser.js           # 유틸: 슬랙 텍스트 잘라내기, 브랜치명 생성, 피그마 링크 감지
├── classifier.js       # Haiku: 메시지 분류 + TMI + 변경 요약
├── config.js           # 환경변수 → CONFIG 객체
├── messages.js         # 슬랙 응답 메시지 템플릿
├── thread-map.js       # 스레드 ↔ 브랜치 매핑 (메모리 + 파일 persist)
└── queue.js            # 요청 큐 (동시 처리 방지)
```

## 기술 스택

- **런타임**: Node.js (CommonJS)
- **슬랙**: @slack/bolt (Socket Mode)
- **AI**: @anthropic-ai/sdk — Haiku (분류/분석), Sonnet (코드 수정)
- **빌드 검증**: 대상 레포에서 `pnpm build` 실행
- **배포**: Vercel API로 프리뷰 URL 폴링

## 환경변수

| 변수 | 필수 | 용도 |
|---|---|---|
| `SLACK_BOT_TOKEN` | O | 슬랙 봇 토큰 |
| `SLACK_APP_TOKEN` | O | 슬랙 앱 토큰 (Socket Mode) |
| `ANTHROPIC_API_KEY` | O | Claude API 키 |
| `REPO_URL` | O | 대상 레포 Git URL |
| `REPO_BRANCH` | - | 기본 브랜치 (기본값: develop) |
| `REPO_PATH` | - | 레포 클론 경로 (기본값: /tmp/design-bot-repo) |
| `GITHUB_TOKEN` | - | GitHub API (PR 생성) |
| `FIGMA_API_KEY` | - | Figma REST API |
| `VERCEL_TOKEN` | - | Vercel 배포 폴링 |
| `VERCEL_PROJECT_ID` | - | Vercel 프로젝트 ID |
| `VERCEL_TEAM_ID` | - | Vercel 팀 ID |
| `ALLOWED_CHANNEL_ID` | - | 특정 채널만 허용 |

## 핵심 흐름 (handler.js)

`_processCodeRequest()` 가 전체 파이프라인:
1. 스레드-브랜치 매핑 → 브랜치 생성/전환
2. 피그마 데이터 (있으면)
3. `collectFileTree()` → `identifyRelevantFiles()` → `readFiles()`
4. `generateCodeChanges()` — Sonnet이 tool use로 edit_file/create_file 반환
5. `applyChanges()` — 파일 시스템에 적용
6. `runBuild()` — 실패 시 `fixBuildError()`로 재시도 (최대 3회)
7. git add/commit/push → Vercel 프리뷰 대기 → 슬랙 응답

## 주의사항

- `handler.js`가 가장 복잡하고 중요한 파일. 흐름 변경 시 주의
- 빌드 재시도 시 새로 생성된 파일도 컨텍스트에 포함해야 함 (기존 버그 수정됨)
- `code-generator.js`의 tool use 멀티턴: read_file 요청 시 파일을 읽어 tool_result로 전달
- 커밋 시 `changes` 배열의 파일만 git add — fixBuildError 수정분도 포함해야 함
