const https = require("https");
const { CONFIG } = require("./config");

function getAuth() {
  if (!CONFIG.jira.host || !CONFIG.jira.email || !CONFIG.jira.apiToken) {
    return null;
  }
  return Buffer.from(`${CONFIG.jira.email}:${CONFIG.jira.apiToken}`).toString("base64");
}

/**
 * JIRA REST API 호출 (GET/POST/PUT)
 */
function request(method, path, body) {
  const auth = getAuth();
  if (!auth) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: CONFIG.jira.host,
      path,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data ? JSON.parse(data) : {});
        } else {
          reject(new Error(`JIRA ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * 미완료 티켓 목록 조회 (프로젝트 키 기반)
 */
const TICKET_PREFIXES = ["LAND", "TEST", "ISI", "REG"];

async function fetchOpenTickets() {
  const projectKeys = CONFIG.jira.projectKeys;
  if (projectKeys.length === 0 || !getAuth()) return [];

  const projectClause = projectKeys.join(",");
  const jql = encodeURIComponent(
    `project in (${projectClause}) AND statusCategory != Done ORDER BY updated DESC`,
  );
  const fields = "summary,status,assignee,description,labels,priority";

  try {
    const result = await request(
      "GET",
      `/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=${fields}`,
    );
    const all = (result?.issues || []).map(formatIssue);

    // LAND/TEST/ISI/REG 관련 티켓만 필터링
    return all.filter((t) =>
      TICKET_PREFIXES.some(
        (prefix) =>
          t.summary.toUpperCase().includes(prefix) ||
          t.key.toUpperCase().includes(prefix),
      ),
    );
  } catch (err) {
    console.error("[JIRA] 티켓 조회 실패:", err.message);
    return [];
  }
}

/**
 * 특정 티켓 조회
 */
async function fetchTicket(issueKey) {
  try {
    const issue = await request(
      "GET",
      `/rest/api/3/issue/${issueKey}?fields=summary,status,assignee,description,labels,priority`,
    );
    return issue ? formatIssue(issue) : null;
  } catch (err) {
    console.error(`[JIRA] 티켓 조회 실패 (${issueKey}):`, err.message);
    return null;
  }
}

/**
 * 티켓에 댓글 추가
 */
async function addComment(issueKey, commentText) {
  try {
    await request("POST", `/rest/api/3/issue/${issueKey}/comment`, {
      body: {
        version: 1,
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: commentText }],
          },
        ],
      },
    });
    console.log(`[JIRA] 댓글 추가 완료: ${issueKey}`);
  } catch (err) {
    console.error(`[JIRA] 댓글 추가 실패 (${issueKey}):`, err.message);
  }
}

/**
 * 티켓 상태 전환
 */
async function transitionTicket(issueKey, targetStatusName) {
  try {
    const data = await request(
      "GET",
      `/rest/api/3/issue/${issueKey}/transitions`,
    );
    const transitions = data?.transitions || [];

    const target = transitions.find(
      (t) => t.name.toLowerCase() === targetStatusName.toLowerCase(),
    );

    if (!target) {
      const available = transitions.map((t) => t.name).join(", ");
      console.warn(
        `[JIRA] "${targetStatusName}" 전환 불가 (${issueKey}). 가능한 전환: ${available}`,
      );
      return false;
    }

    await request("POST", `/rest/api/3/issue/${issueKey}/transitions`, {
      transition: { id: target.id },
    });

    console.log(`[JIRA] 상태 전환 완료: ${issueKey} → ${targetStatusName}`);
    return true;
  } catch (err) {
    console.error(`[JIRA] 상태 전환 실패 (${issueKey}):`, err.message);
    return false;
  }
}

function formatIssue(issue) {
  return {
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status?.name || "Unknown",
    assignee: issue.fields.assignee?.displayName || "미배정",
    description: extractTextFromAdf(issue.fields.description),
    labels: issue.fields.labels || [],
    priority: issue.fields.priority?.name || "Medium",
  };
}

/**
 * ADF(Atlassian Document Format)에서 텍스트만 추출
 */
function extractTextFromAdf(adf) {
  if (!adf) return "";
  if (typeof adf === "string") return adf;

  const texts = [];
  function walk(node) {
    if (node.text) texts.push(node.text);
    if (node.content) node.content.forEach(walk);
  }
  walk(adf);
  return texts.join("\n").slice(0, 1000);
}

const ACTIVE_STATUSES = ["진행 중", "테스트", "in progress", "in review"];

/**
 * 아직 작업 안 된 티켓만 반환 (코드 작업 매칭용)
 */
async function fetchActionableTickets() {
  const all = await fetchOpenTickets();
  return all.filter(
    (t) => !ACTIVE_STATUSES.some((s) => t.status.toLowerCase().includes(s.toLowerCase())),
  );
}

module.exports = {
  fetchOpenTickets,
  fetchActionableTickets,
  fetchTicket,
  addComment,
  transitionTicket,
};
