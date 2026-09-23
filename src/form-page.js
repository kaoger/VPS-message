import { FORM_FIELDS } from "./form-schema.js";

/** Mobile-first demo form HTML */
export function renderFormPage({ token, error = "", prefill = {}, editing = false }) {
  const fieldsHtml = FORM_FIELDS.map((f) => {
    if (f.type === "choice") {
      const opts = f.options
        .map((o) => {
          const sel = prefill[f.key] === o ? "selected" : "";
          return `<button type="button" class="chip ${sel}" data-field="${f.key}" data-value="${escapeHtml(o)}">${escapeHtml(o)}</button>`;
        })
        .join("");
      const other =
        f.otherKey
          ? `<div class="other" data-other-for="${f.key}" hidden>
              <label>${escapeHtml(f.otherLabel || "其他")}</label>
              <input name="${f.otherKey}" value="${escapeHtml(prefill[f.otherKey] || "")}" placeholder="請輸入" />
            </div>`
          : "";
      return `<section class="card" data-step>
        <h2>${escapeHtml(f.label)}</h2>
        <div class="chips" data-name="${f.key}" data-other-when="${escapeHtml(f.otherWhen || "")}">${opts}</div>
        <input type="hidden" name="${f.key}" value="${escapeHtml(prefill[f.key] || "")}" required />
        ${other}
      </section>`;
    }
    const inputType = f.type === "tel" ? "tel" : "text";
    return `<section class="card" data-step>
      <h2>${escapeHtml(f.label)}</h2>
      <input name="${f.key}" type="${inputType}" inputmode="${f.type === "tel" ? "numeric" : "text"}"
        placeholder="${escapeHtml(f.placeholder || "")}"
        value="${escapeHtml(prefill[f.key] || "")}"
        ${f.pattern ? `pattern="${f.pattern}"` : ""} required />
    </section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>三禾需求快填</title>
  <style>
    :root {
      --bg: #f4f6f8;
      --card: #fff;
      --text: #1a1a1a;
      --muted: #667;
      --brand: #1877f2;
      --brand-press: #0f5ecf;
      --line: #e6e8eb;
      --ok: #0a7a3e;
      --bad: #c62828;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.45;
    }
    .wrap { max-width: 520px; margin: 0 auto; padding: 20px 16px 48px; }
    .hero {
      background: linear-gradient(160deg, #1b4f9c, #1877f2 55%, #4ea1ff);
      color: #fff; border-radius: 18px; padding: 20px 18px; margin-bottom: 16px;
      box-shadow: 0 10px 28px rgba(24,119,242,.28);
    }
    .hero h1 { margin: 0 0 8px; font-size: 1.25rem; }
    .hero p { margin: 0; opacity: .95; font-size: .95rem; }
    .card {
      background: var(--card); border: 1px solid var(--line); border-radius: 16px;
      padding: 14px 14px 16px; margin-bottom: 12px;
    }
    .card h2 { margin: 0 0 12px; font-size: 1rem; font-weight: 650; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chip {
      border: 1px solid var(--line); background: #fafbfc; color: var(--text);
      border-radius: 999px; padding: 10px 14px; font-size: .92rem; cursor: pointer;
    }
    .chip.selected {
      background: #e8f1ff; border-color: var(--brand); color: #0b4db0; font-weight: 600;
    }
    input[type=text], input[type=tel] {
      width: 100%; border: 1px solid var(--line); border-radius: 12px;
      padding: 12px 14px; font-size: 1rem; background: #fff;
    }
    .other { margin-top: 10px; }
    .other label { display:block; font-size:.85rem; color:var(--muted); margin-bottom:6px; }
    .err {
      background: #fdecea; color: var(--bad); border-radius: 12px; padding: 10px 12px;
      margin-bottom: 12px; font-size: .92rem; ${error ? "" : "display:none;"}
    }
    .actions { position: sticky; bottom: 0; padding: 12px 0 4px; background: linear-gradient(transparent, var(--bg) 30%); }
    button.submit {
      width: 100%; border: 0; border-radius: 14px; padding: 14px 16px;
      background: var(--brand); color: #fff; font-size: 1.05rem; font-weight: 700; cursor: pointer;
    }
    button.submit:active { background: var(--brand-press); }
    .hint { text-align: center; color: var(--muted); font-size: .8rem; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1>${editing ? "修改需求" : "一分鐘需求快填"}</h1>
      <p>${editing ? "已帶入上次的資料，請調整後確認送出，更新同一筆需求。" : "可以利用一分鐘快速填表，讓我們迅速掌握您的需求。"}<br/>送出後，摘要會回到 Messenger 對話。</p>
    </div>
    <div class="err" id="err">${escapeHtml(error)}</div>
    <form id="form" method="post" action="/form/submit">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      ${fieldsHtml}
      <div class="actions">
        <button class="submit" type="submit">${editing ? "確認修改並送出" : "送出需求"}</button>
        <p class="hint">送出後請回到 Messenger 查看摘要</p>
      </div>
    </form>
  </div>
  <script>
    function syncOther(name) {
      const chips = document.querySelector('.chips[data-name=\"' + name + '\"]');
      if (!chips) return;
      const when = chips.getAttribute('data-other-when');
      const hidden = document.querySelector('input[name=\"' + name + '\"]');
      const box = document.querySelector('[data-other-for=\"' + name + '\"]');
      if (!box || !when) return;
      box.hidden = hidden.value !== when;
    }
    document.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field;
        const value = btn.dataset.value;
        const wrap = btn.parentElement;
        wrap.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
        btn.classList.add('selected');
        const hidden = document.querySelector('input[name=\"' + field + '\"]');
        if (hidden) hidden.value = value;
        syncOther(field);
      });
    });
    // init selected from prefill
    document.querySelectorAll('.chips').forEach(wrap => {
      const name = wrap.getAttribute('data-name');
      const hidden = document.querySelector('input[name=\"' + name + '\"]');
      if (!hidden || !hidden.value) return;
      wrap.querySelectorAll('.chip').forEach(c => {
        if (c.dataset.value === hidden.value) c.classList.add('selected');
      });
      syncOther(name);
    });
    document.getElementById('form').addEventListener('submit', (e) => {
      const missing = [...document.querySelectorAll('input[required]')].find(i => !i.value.trim());
      if (missing) {
        e.preventDefault();
        const err = document.getElementById('err');
        err.style.display = 'block';
        err.textContent = '請完成所有題目後再送出';
        missing.closest('[data-step]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  </script>
</body>
</html>`;
}

export function renderDonePage({ summary, messengerOk, heading, editUrl, newFormUrl }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>已送出</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif;background:#f4f6f8;margin:0}
    .wrap{max-width:520px;margin:0 auto;padding:24px 16px}
    .card{background:#fff;border-radius:16px;padding:18px;border:1px solid #e6e8eb}
    h1{font-size:1.2rem;margin:0 0 8px;color:#0a7a3e}
    pre{white-space:pre-wrap;background:#f7f8fa;padding:12px;border-radius:12px;font-size:.92rem}
    .note{color:#667;font-size:.9rem;margin-top:12px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${escapeHtml(heading || (messengerOk ? "已送出，摘要已發到 Messenger" : "請查看下方處理結果"))}</h1>
      <pre>${escapeHtml(summary)}</pre>
      ${editUrl ? `<p><a href="${escapeHtml(editUrl)}">修改需求</a></p><p class="note">修改連結兩小時內有效，請勿轉傳。過期後請在 Messenger 傳「修改需求」。</p>` : ""}
      ${newFormUrl ? `<p><a id="new-form-link" href="${escapeHtml(newFormUrl)}" style="display:inline-block;padding:12px 16px;background:#1877f2;color:#fff;border-radius:12px;text-decoration:none">重新填寫（新增一筆）</a></p><p class="note">會開啟空白表單，填完送出才新增一筆需求，不會覆蓋原資料。</p>` : ""}
      <p class="note">請回到粉專 Messenger 對話查看。可關閉此分頁。</p>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
