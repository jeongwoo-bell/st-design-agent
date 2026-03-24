# 🤖 Design Bot

디자이너가 Slack에서 요청하면 Claude Code가 코드를 수정하고 push하는 봇

## 동작 방식

1. 디자이너가 Slack에서 `@Design Bot 버튼 색상 파란색으로 바꿔줘` 요청
2. 봇이 레포에서 새 브랜치 생성
3. Claude Code가 코드 수정
4. 자동으로 commit & push
5. Vercel 프리뷰 링크가 Slack에 전달됨

## 세팅 방법

### 1. 의존성 설치

```bash
cd design-bot
npm install
```

### 2. 환경변수 설정

`.env.example`을 복사해서 `.env` 파일을 만들어요:

```bash
cp .env.example .env
```

`.env` 파일을 열고 토큰들을 채워주세요:

```
SLACK_BOT_TOKEN=xoxb-...    # Slack Install App에서 받은 Bot Token
SLACK_APP_TOKEN=xapp-...    # Slack Socket Mode에서 받은 App Token
ANTHROPIC_API_KEY=sk-ant-...  # Anthropic API 키
GITHUB_TOKEN=ghp-...        # GitHub Personal Access Token
REPO_URL=https://github.com/your-org/your-repo.git
REPO_BRANCH=develop
```

### 3. Claude Code CLI 설치 확인

```bash
claude --version
```

### 4. 실행

```bash
node --env-file=.env bot.js
```

## 사용법

### @멘션으로 요청 (아무 채널에서)

```
@Design Bot 메인 페이지 헤더 폰트를 24px로 바꿔줘
@Design Bot 로그인 버튼을 파란색 라운드로 만들어줘
@Design Bot GNB에 다크모드 토글 추가해줘
```

### 전용 채널에서 바로 메시지 (ALLOWED_CHANNEL_ID 설정 시)

```
메인 페이지 헤더 폰트를 24px로 바꿔줘
```

## 주의사항

- Claude Code가 `--yes` 모드로 실행돼서 모든 수정을 자동 승인해요
- 반드시 브랜치에서 작업하고, PR 리뷰 후 머지하세요
- `CLAUDE.md` 파일에 프로젝트 규칙을 잘 적어두면 결과물 품질이 올라가요
