const { CONFIG } = require("./config");

const VERCEL_API = "https://api.vercel.com";

/**
 * git push 후 Vercel 배포가 완료될 때까지 폴링하고 프리뷰 URL을 반환한다.
 * @param {string} branchName - 배포된 브랜치명
 * @param {number} maxWait - 최대 대기 시간(ms), 기본 3분
 * @returns {Promise<string|null>} 프리뷰 URL 또는 null
 */
async function waitForVercelDeployment(branchName, maxWait = 180000) {
  if (!CONFIG.vercel.token || !CONFIG.vercel.projectId) {
    console.log("[VERCEL] 토큰 또는 프로젝트 ID 미설정 — 프리뷰 URL 생략");
    return null;
  }

  const headers = {
    Authorization: `Bearer ${CONFIG.vercel.token}`,
  };

  const teamParam = CONFIG.vercel.teamId
    ? `&teamId=${CONFIG.vercel.teamId}`
    : "";

  const startTime = Date.now();
  const pollInterval = 10000; // 10초

  // push 시점 기록 (이전 배포와 구분하기 위해)
  const pushTime = Date.now() - 30000; // 30초 여유

  console.log(`[VERCEL] ${branchName} 배포 대기 중...`);

  while (Date.now() - startTime < maxWait) {
    try {
      // 최신 배포 목록에서 브랜치명으로 필터링 (since 파라미터로 최근 것만)
      const url = `${VERCEL_API}/v6/deployments?projectId=${CONFIG.vercel.projectId}&limit=5&sort=created&since=${pushTime}${teamParam}`;
      const res = await fetch(url, { headers });

      if (!res.ok) {
        console.log(`[VERCEL] API 응답 에러: ${res.status}`);
        break;
      }

      const data = await res.json();

      // 브랜치명이 포함된 배포 찾기 (meta.gitBranch 또는 name에서 매칭)
      const deployment = data.deployments?.find((d) => {
        const gitBranch = d.meta?.githubCommitRef || d.meta?.gitBranch || "";
        return gitBranch === branchName;
      });

      if (deployment) {
        const state = deployment.state || deployment.readyState;
        console.log(`[VERCEL] 배포 상태: ${state}`);

        if (state === "READY") {
          const previewUrl = `https://${deployment.url}`;
          console.log(`[VERCEL] 프리뷰 URL: ${previewUrl}`);
          return previewUrl;
        }

        if (state === "ERROR" || state === "CANCELED") {
          console.log(`[VERCEL] 배포 실패: ${state}`);
          return null;
        }
      } else {
        console.log("[VERCEL] 아직 배포가 생성되지 않음...");
      }
    } catch (err) {
      console.log(`[VERCEL] 폴링 에러: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  console.log("[VERCEL] 타임아웃 — 프리뷰 URL 없이 진행");
  return null;
}

module.exports = { waitForVercelDeployment };
