# Design Bot v5

디자이너가 슬랙에서 말로 랜딩페이지를 수정하는 봇

## 동작 방식

```
디자이너 → 슬랙 → 봇(오케스트레이터)

1. Haiku가 관련 파일 특정 (2초)
2. 봇이 파일 읽기 (즉시)
3. Sonnet이 코드 수정안 생성 (20~30초)
4. 봇이 파일 적용 → 빌드 검증 → 커밋 → 푸시
5. Vercel 프리뷰 링크가 슬랙에 전달
```

## 세팅 방법

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경변수 설정

`.env` 파일을 만들고 아래 값들을 채워주세요:

```
# 필수
SLACK_BOT_TOKEN=xoxb-...         # Slack Bot Token
SLACK_APP_TOKEN=xapp-...         # Slack Socket Mode App Token
ANTHROPIC_API_KEY=sk-ant-...     # Anthropic API 키
REPO_URL=https://github.com/org/repo.git

# 선택
GITHUB_TOKEN=ghp-...             # GitHub PAT (PR 생성용)
REPO_BRANCH=develop              # 기본 브랜치 (기본값: develop)
FIGMA_API_KEY=figd_...           # 피그마 API 키 (피그마 링크 지원)
VERCEL_TOKEN=...                 # Vercel 프리뷰 URL용
VERCEL_PROJECT_ID=...            # Vercel 프로젝트 ID
VERCEL_TEAM_ID=...               # Vercel 팀 ID (선택)
ALLOWED_CHANNEL_ID=C...          # 특정 채널만 허용 (선택)
```

### 3. 실행

```bash
node --env-file=.env bot.js
```

### Docker로 실행

```bash
docker compose up --build
```

## 사용법

### 코드 수정 요청

슬랙에서 `@봇이름`으로 멘션하거나, 봇이 관리하는 스레드에서 바로 메시지를 보내세요.

```
@클로정우 Section3 타이틀 폰트 크게 해줘
@클로정우 헤더 배경색 바꿔줘
@클로정우 [피그마 링크] 이대로 구현해줘
```

### 후속 수정

같은 스레드에서 계속 메시지를 보내면 같은 브랜치에서 이어서 작업합니다.

```
여백 좀 더 줘
색상 좀 더 진하게
```

### PR 생성

스레드에서 `/pr` 입력하면 Draft PR을 생성합니다.

```
/pr
```

### 질문/대화

코드 수정이 아닌 질문은 자동으로 감지해서 답변합니다.

```
@클로정우 Section3에 뭐 들어있어?
@클로정우 이 프로젝트 구조가 어떻게 돼있어?
```

## 아키텍처 (v5)

```
슬랙 메시지
  ↓
Haiku — 메시지 분류 (code/chat/unclear)
  ↓
[code]                          [chat]
Haiku — 관련 파일 특정           Haiku — 관련 파일 특정
  ↓                               ↓
봇 — fs로 파일 읽기              봇 — fs로 파일 읽기
  ↓                               ↓
Sonnet — 코드 수정안 생성        Haiku — 파일 기반 답변
  ↓
봇 — 파일 적용
  ↓
봇 — pnpm build (실패 시 Sonnet에 수정 요청, 최대 3회)
  ↓
봇 — git commit + push
  ↓
봇 — Vercel 프리뷰 대기
  ↓
슬랙 응답
```

## 주의사항

- 수정은 항상 브랜치에서 작업되며, PR 리뷰 후 머지하세요
- 피그마 링크를 보내면 Figma REST API로 디자인 데이터를 가져와서 구현합니다
- 빌드 실패 시 자동으로 수정 시도하고, 3회 실패하면 변경사항을 되돌립니다
