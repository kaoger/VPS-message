const sessions = new Map();
const TTL_MS = 30 * 60 * 1000;

export function getSession(userId) {
  const item = sessions.get(userId);
  if (!item) return null;

  if (Date.now() - item.updatedAt > TTL_MS) {
    sessions.delete(userId);
    return null;
  }

  return item;
}

export function saveSession(userId, data) {
  sessions.set(userId, {
    ...data,
    updatedAt: Date.now(),
  });
}

export function deleteSession(userId) {
  sessions.delete(userId);
}

export function createSession() {
  return {
    step: 0,
    answers: {},
    // When true, next text message is free-form area name after AREA_OTHER
    waitingAreaOther: false,
    // After Q8: showing summary, waiting for 確認送出 / 重新填寫
    awaitingConfirm: false,
    completed: false,
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, item] of sessions.entries()) {
    if (now - item.updatedAt > TTL_MS) {
      sessions.delete(userId);
    }
  }
}, 5 * 60 * 1000).unref();
