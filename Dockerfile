FROM node:20-slim

# 시스템 패키지 설치 (git, gh CLI 의존성)
RUN apt-get update && apt-get install -y \
    git \
    curl \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI 설치
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# pnpm 설치
RUN npm install -g pnpm

# Claude Code CLI 설치
RUN npm install -g @anthropic-ai/claude-code

# 봇 유저 생성 (root로 실행하지 않기 위해)
RUN useradd -m -s /bin/bash botuser \
    && mkdir -p /home/botuser/.claude \
    && chown -R botuser:botuser /home/botuser

# 작업 디렉토리
WORKDIR /app

# 봇 코드 복사
COPY package.json ./
RUN npm install --production

COPY bot.js wizkey-prompt.js ./
COPY src/ ./src/

# botuser로 전환
RUN chown -R botuser:botuser /app
USER botuser

# git 설정 (커밋용)
RUN git config --global user.email "jeongwoo.lee@belltherapeutics.com" \
    && git config --global user.name "이정우"

CMD ["node", "bot.js"]
