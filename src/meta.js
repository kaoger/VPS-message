const GRAPH_URL = "https://graph.facebook.com/v23.0/me/messages";

async function sendMessage(recipientId, message) {
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
        messaging_type: "RESPONSE",
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
export async function sendText(recipientId, text) {
  await sendMessage(recipientId, { text });
}

/**
 * Text + quick replies.
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
