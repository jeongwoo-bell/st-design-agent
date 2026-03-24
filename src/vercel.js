const { CONFIG } = require("./config");

const VERCEL_API = "https://api.vercel.com";

/**
 * git push 후 Vercel 배포가 완료될 때까지 폴링하고 프리뷰 URL을 반환한다.
 * @param {string} branchName - 배포된 브랜치명
 * @param {number} maxWait - 최대 대기 시간(ms), 기본 5분
 * @returns {Promise<string|null>} 프리뷰 URL 또는 null
 */
async function waitForVercelDeployment(branchName, maxWait = 300000) {
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

  console.log(`[VERCEL] ${branchName} 배포 대기 중...`);

  while (Date.now() - startTime < maxWait) {
    try {
      const url = `${VERCEL_API}/v6/deployments?projectId=${CONFIG.vercel.projectId}&meta-gitBranch=${encodeURIComponent(branchName)}&limit=1&sort=created${teamParam}`;
      const res = await fetch(url, { headers });

      if (!res.ok) {
        console.log(`[VERCEL] API 응답 에러: ${res.status}`);
        break;
      }

      const data = await res.json();
      const deployment = data.deployments?.[0];

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
