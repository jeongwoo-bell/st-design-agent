const requestQueue = [];
let isProcessing = false;

function enqueueRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;
  const { fn, resolve, reject } = requestQueue.shift();
  try {
    const result = await fn();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    isProcessing = false;
    processQueue();
  }
}

function getQueueLength() {
  return requestQueue.length;
}

module.exports = { enqueueRequest, getQueueLength };
