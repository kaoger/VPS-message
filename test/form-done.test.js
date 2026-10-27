import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { renderDonePage } from "../src/form-page.js";
import { SANHE_PAGE_ID } from "../src/admin-config.js";

for (const visibilityState of ["visible", "hidden"]) {
  test(`Messenger return falls back after 1500ms only while visible (${visibilityState})`, () => {
    const html = renderDonePage({ summary: "送出摘要", messengerOk: true });
    assert.ok(html.includes(`href="fb-messenger://user-thread/${SANHE_PAGE_ID}"`));
    const fallbackUrl = html.match(/data-fallback-url="([^"]+)"/)[1];
    assert.equal(fallbackUrl, `https://m.me/${SANHE_PAGE_ID}`);

    let click, timeout;
    const link = {
      dataset: { fallbackUrl },
      addEventListener(event, callback) {
        assert.equal(event, "click");
        click = callback;
      },
    };
    const document = {
      visibilityState: "visible",
      getElementById(id) {
        assert.equal(id, "messenger-return-link");
        return link;
      },
    };
    const window = { location: { href: "https://example.test/form/submit" } };
    const originalUrl = window.location.href;
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    runInNewContext(scripts[0][1], {
      document, window,
      setTimeout(callback, delay) {
        assert.equal(delay, 1500);
        timeout = callback;
      },
    });
    assert.equal(timeout, undefined, "No fallback timer before a click");
    click();
    assert.equal(window.location.href, originalUrl, "Keep the default App link navigation");
    document.visibilityState = visibilityState;
    timeout();
    assert.equal(window.location.href, visibilityState === "visible" ? fallbackUrl : originalUrl);
  });
}
