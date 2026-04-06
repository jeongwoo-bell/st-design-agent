const CONFIG = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
  },
  repo: {
    url: process.env.REPO_URL,
    branch: process.env.REPO_BRANCH || "develop",
    path: process.env.REPO_PATH || "/tmp/design-bot-repo",
  },
  github: {
    token: process.env.GITHUB_TOKEN,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  figma: {
    apiKey: process.env.FIGMA_API_KEY || null,
  },
  docs: {
    url: process.env.DOCS_REPO_URL || null,
    path: process.env.DOCS_REPO_PATH || "/tmp/design-bot-docs",
    branch: process.env.DOCS_REPO_BRANCH || "main",
  },
  vercel: {
    token: process.env.VERCEL_TOKEN || null,
    projectId: process.env.VERCEL_PROJECT_ID || null,
    teamId: process.env.VERCEL_TEAM_ID || null,
  },
  jira: {
    host: process.env.JIRA_HOST || null,
    email: process.env.JIRA_EMAIL || null,
    apiToken: process.env.JIRA_API_TOKEN || null,
    projectKeys: process.env.JIRA_PROJECT_KEY
      ? process.env.JIRA_PROJECT_KEY.split(",").map((k) => k.trim())
      : [],
  },
  allowedChannel: process.env.ALLOWED_CHANNEL_ID || null,
  slackMaxLength: 3000,
};

function validateEnv() {
  // 웹 모드에서는 슬랙 토큰 불필요
  const required = ["ANTHROPIC_API_KEY", "REPO_URL"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`필수 환경변수가 없어요: ${missing.join(", ")}`);
    process.exit(1);
  }
}

module.exports = { CONFIG, validateEnv };
