const { WebClient } = require("@slack/web-api");
const { CONFIG } = require("./config");

const slackClient = new WebClient(CONFIG.slack.botToken);

const STATUS = {
  PENDING: "[⏳]",
  RUNNING: "[🔄]",
  DONE: "[✅]",
  FAILED: "[❌]",
};

class ProgressTracker {
  constructor(channel, threadTs) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.messageTs = null;
    this.title = "🔧 작업 중...";
    this.steps = [];
  }

  /**
   * 단계 추가. 반환값은 인덱스 (이후 start/done/fail에 사용)
   */
  addStep(label) {
    this.steps.push({ label, status: STATUS.PENDING });
    return this.steps.length - 1;
  }

  /**
   * 최초 메시지 전송
   */
  async post() {
    try {
      const result = await slackClient.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text: this._render(),
      });
      this.messageTs = result.ts;
    } catch (err) {
      console.warn("[PROGRESS] 메시지 전송 실패:", err.message);
    }
  }

  async start(index, label) {
    this.steps[index].status = STATUS.RUNNING;
    if (label) this.steps[index].label = label;
    await this._sync();
  }

  async done(index, label) {
    this.steps[index].status = STATUS.DONE;
    if (label) this.steps[index].label = label;
    await this._sync();
  }

  async fail(index, label) {
    this.steps[index].status = STATUS.FAILED;
    if (label) this.steps[index].label = label;
    await this._sync();
  }

  async finish(title) {
    this.title = title;
    await this._sync();
  }

  async _sync() {
    if (!this.messageTs) return;
    try {
      await slackClient.chat.update({
        channel: this.channel,
        ts: this.messageTs,
        text: this._render(),
      });
    } catch (err) {
      console.warn("[PROGRESS] 메시지 업데이트 실패:", err.message);
    }
  }

  _render() {
    const stepLines = this.steps
      .map((step) => `${step.status}  ${step.label}`)
      .join("\n");
    return `${this.title}\n\n\`\`\`\n${stepLines}\n\`\`\``;
  }
}

module.exports = { ProgressTracker, STATUS };
