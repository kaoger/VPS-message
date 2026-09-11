const GRAPH_URL = "https://graph.facebook.com/v23.0/me/messages";

async function sendMessage(recipientId, message, messagingType = "RESPONSE") {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) {
    throw new Error("META_PAGE_ACCESS_TOKEN is missing");
  }

  const response = await fetch(
    `${GRAPH_URL}?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messaging_type: messagingType,
        recipient: { id: recipientId },
        message,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Meta send failed ${response.status}: ${body}`);
  }
}

/** Plain text only */
export async function sendText(recipientId, text, messagingType = "RESPONSE") {
  await sendMessage(recipientId, { text }, messagingType);
}

/**
 * Text + quick replies (pills above keyboard).
 * options: Array<[title, payload]>
 */
export async function sendQuickReplies(recipientId, text, options) {
  await sendMessage(recipientId, {
    text,
    quick_replies: options.map(([title, payload]) => ({
      content_type: "text",
      title,
      payload,
    })),
  });
}

/**
 * Button Template — postback buttons on bubble (max 3 each; auto-chunk).
 * options: Array<[title, payload]>
 */
export async function sendButtonTemplate(
  recipientId,
  text,
  options,
  { continuationText = "請繼續選擇：" } = {}
) {
  const chunks = [];
  for (let i = 0; i < options.length; i += 3) {
    chunks.push(options.slice(i, i + 3));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const bodyText = i === 0 ? text : continuationText;
    await sendMessage(recipientId, {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: bodyText.slice(0, 640),
          buttons: chunk.map(([title, payload]) => ({
            type: "postback",
            title: String(title).slice(0, 20),
            payload: String(payload).slice(0, 1000),
          })),
        },
      },
    });
  }
}

/**
 * Button Template with a single web_url (open external form).
 * title max 20 chars.
 */
export async function sendUrlButton(recipientId, text, { title, url }) {
  await sendMessage(recipientId, {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: String(text).slice(0, 640),
        buttons: [
          {
            type: "web_url",
            title: String(title).slice(0, 20),
            url,
            webview_height_ratio: "tall",
          },
        ],
      },
    },
  });
}
