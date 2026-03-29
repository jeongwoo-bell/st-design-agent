const { exec } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");
const { CONFIG } = require("./config");

const execAsync = promisify(exec);

async function run(cmd, cwd = CONFIG.repo.path) {
  console.log(`[RUN] ${cmd}`);
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: CONFIG.anthropic.apiKey,
        FIGMA_API_KEY: CONFIG.figma.apiKey || "",
        GITHUB_TOKEN: CONFIG.github.token || "",
      },
    });
    if (stdout) console.log(`[OUT] ${stdout.slice(0, 500)}`);
    if (stderr) console.log(`[ERR] ${stderr.slice(0, 500)}`);
    return stdout.trim();
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    throw error;
  }
}

async function ensureRepo() {
  const repoUrl = CONFIG.github.token
    ? CONFIG.repo.url.replace("https://", `https://${CONFIG.github.token}@`)
    : CONFIG.repo.url;

  if (!fs.existsSync(CONFIG.repo.path)) {
    console.log("[REPO] 레포 클론 중...");
    await run(`git clone ${repoUrl} ${CONFIG.repo.path}`, "/tmp");
  }

  if (!fs.existsSync(path.join(CONFIG.repo.path, ".git"))) {
    console.log("[REPO] 불완전한 레포 감지, 재클론...");
    await run(`rm -rf ${CONFIG.repo.path}`, "/tmp");
    await run(`git clone ${repoUrl} ${CONFIG.repo.path}`, "/tmp");
  }

  await run("git reset --hard HEAD");
  await run("git clean -fd");
  await run(`git checkout ${CONFIG.repo.branch}`);
  await run(`git pull origin ${CONFIG.repo.branch}`);

  // node_modules 없으면 설치
  if (!fs.existsSync(path.join(CONFIG.repo.path, "node_modules"))) {
    console.log("[REPO] 의존성 설치 중...");
    await run("pnpm install");
  }

  console.log("[REPO] 레포 준비 완료");
}

async function switchToBranch(branchName, createNew = false) {
  if (createNew) {
    await run(`git checkout -b ${branchName}`);
  } else {
    try {
      await run(`git fetch origin ${branchName}`);
      await run(`git checkout ${branchName}`);
      await run(`git pull origin ${branchName}`);
    } catch {
      await run(`git checkout ${branchName}`);
    }
  }
}

module.exports = { run, ensureRepo, switchToBranch };
