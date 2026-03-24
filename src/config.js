const path = require("path");

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
  vercel: {
    token: process.env.VERCEL_TOKEN || null,
    projectId: process.env.VERCEL_PROJECT_ID || null,
    teamId: process.env.VERCEL_TEAM_ID || null,
  },
  allowedChannel: process.env.ALLOWED_CHANNEL_ID || null,
  claudeTimeout: parseInt(process.env.CLAUDE_TIMEOUT) || 600000,
  slackMaxLength: 3000,
};

function validateEnv() {
  const required = [
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "ANTHROPIC_API_KEY",
    "REPO_URL",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`❌ 필수 환경변수가 없어요: ${missing.join(", ")}`);
    process.exit(1);
  }
}

module.exports = { CONFIG, validateEnv };
