import "dotenv/config";
import express from "express";
import {
  FLOW,
  buildSummary,
  titleForPayload,
  CONFIRM_OPTIONS,
  SUBMIT_SUCCESS_TEXT,
} from "./flow.js";
import {
  getSession,
  saveSession,
  deleteSession,
  createSession,
} from "./session-store.js";
import * as meta from "./meta.js";

const app = express();
app.use(express.json());

const port = Number(process.env.PORT || 3000);

const liveSend = {
  text: (id, t) => meta.sendText(id, t),
  quick: (id, t, opts) => meta.sendQuickReplies(id, t, opts),
};

app.get("/health", (_req, res) => {
  res.json({ ok: true, flowSteps: FLOW.length });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token &&
    token === process.env.META_VERIFY_TOKEN &&
    challenge
  ) {
    return res.status(200).send(String(challenge));
  }

  return res.sendStatus(403);
});

// ACK Meta immediately, process async
app.post("/webhook", (req, res) => {
  res.status(200).json({ received: true });

  void processWebhook(req.body, liveSend).catch((error) => {
    console.error("Webhook processing error:", error);
  });
});

async function processWebhook(body, send) {
  if (body?.object !== "page") return;

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const senderId = event?.sender?.id;
      const message = event?.message;

      if (!senderId || !message || message.is_echo) continue;

      const payload = message.quick_reply?.payload ?? null;
      const text =
        typeof message.text === "string" ? message.text.trim() : null;

      if (text == null && !payload) continue;

      await handleIncoming(senderId, { text, payload }, send);
    }
  }
}

async function askStep(senderId, stepIndex, send) {
  const step = FLOW[stepIndex];
  if (!step) return;

  if (step.type === "quick_reply") {
    await send.quick(senderId, step.text, step.options);
  } else {
    await send.text(senderId, step.text);
  }
}

async function showConfirm(senderId, session, send) {
  session.awaitingConfirm = true;
  session.step = FLOW.length;
  saveSession(senderId, session);
  await send.quick(senderId, buildSummary(session.answers), CONFIRM_OPTIONS);
}

/**
 * Core 8-step flow + confirm.
 * Test build: fixed questions in RAM; confirm does NOT write Supabase yet.
 */
export async function handleIncoming(senderId, { text, payload }, send) {
  let session = getSession(senderId);

  // New / expired / fully done → start at Q1
  if (!session || session.completed) {
    session = createSession();
    saveSession(senderId, session);
    await askStep(senderId, 0, send);
    return;
  }

  // Confirm screen: 確認送出 / 重新填寫
  if (session.awaitingConfirm) {
    const p = payload || null;
    const t = text || null;
    const isSubmit =
      p === "CONFIRM_SUBMIT" || t === "確認送出";
    const isRestart =
      p === "CONFIRM_RESTART" || t === "重新填寫";

    if (isRestart) {
      deleteSession(senderId);
      session = createSession();
      saveSession(senderId, session);
      await askStep(senderId, 0, send);
      return;
    }

    if (isSubmit) {
      // Test version: thank-you only. Later: INSERT customer_leads here.
      session.awaitingConfirm = false;
      session.completed = true;
      saveSession(senderId, session);
      await send.text(senderId, SUBMIT_SUCCESS_TEXT);
      // Drop session so next message starts fresh
      deleteSession(senderId);
      return;
    }

    // Anything else → re-show summary + buttons
    await showConfirm(senderId, session, send);
    return;
  }

  // Free-text region after「其他地區」
  if (session.waitingAreaOther) {
    if (!text) {
      await send.text(senderId, FLOW[1].otherPrompt);
      return;
    }
    session.answers.area = text;
    session.waitingAreaOther = false;
    session.step = 2;
    saveSession(senderId, session);
    await askStep(senderId, 2, send);
    return;
  }

  const stepIndex = session.step;
  const step = FLOW[stepIndex];

  if (!step) {
    session = createSession();
    saveSession(senderId, session);
    await askStep(senderId, 0, send);
    return;
  }

  if (step.type === "quick_reply") {
    const chosenPayload = payload || null;
    let value = chosenPayload ? titleForPayload(step, chosenPayload) : null;
    let resolvedPayload = chosenPayload;

    if (!value && text) {
      const byTitle = step.options.find(([title]) => title === text);
      if (byTitle) {
        value = byTitle[0];
        resolvedPayload = byTitle[1];
      }
    }

    if (!value) {
      await askStep(senderId, stepIndex, send);
      return;
    }

    if (step.otherPayload && resolvedPayload === step.otherPayload) {
      session.waitingAreaOther = true;
      saveSession(senderId, session);
      await send.text(senderId, step.otherPrompt);
      return;
    }

    session.answers[step.key] = value;
  } else {
    // name / phone
    if (!text) {
      await askStep(senderId, stepIndex, send);
      return;
    }

    if (typeof step.validate === "function" && !step.validate(text)) {
      await send.text(
        senderId,
        step.errorText || "格式不正確，請再試一次。"
      );
      saveSession(senderId, session);
      return;
    }

    session.answers[step.key] = text;
  }

  const next = stepIndex + 1;
  if (next >= FLOW.length) {
    // Q8 done → summary + confirm buttons (not yet submitted)
    await showConfirm(senderId, session, send);
    return;
  }

  session.step = next;
  saveSession(senderId, session);
  await askStep(senderId, next, send);
}

// ---- local test helpers (no Meta token needed) ----
app.post("/test/reset", (req, res) => {
  const senderId = String(req.body?.senderId || "test-user");
  deleteSession(senderId);
  res.json({ ok: true, senderId });
});

app.post("/test/message", async (req, res) => {
  const senderId = String(req.body?.senderId || "test-user");
  const text = req.body?.text != null ? String(req.body.text).trim() : null;
  const payload =
    req.body?.payload != null ? String(req.body.payload) : null;

  const outbox = [];
  const send = {
    text: async (_id, t) => {
      outbox.push({ type: "text", text: t });
    },
    quick: async (_id, t, options) => {
      outbox.push({
        type: "quick_reply",
        text: t,
        options: options.map(([title, p]) => ({ title, payload: p })),
      });
    },
  };

  try {
    await handleIncoming(senderId, { text, payload }, send);
    res.json({
      ok: true,
      senderId,
      outbox,
      session: getSession(senderId),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(
    `sanhe-messenger-bot listening on 127.0.0.1:${port} (fixed ${FLOW.length}-step flow)`
  );
});
