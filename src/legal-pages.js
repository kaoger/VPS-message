// Public policy pages required by Meta App Review (privacy policy + data deletion instructions).
export const BUSINESS_NAME = "三禾室內設計裝潢工程";
export const POLICY_EFFECTIVE_DATE = "2026 年 9 月 26 日";

function layout(title, body) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}｜${BUSINESS_NAME}</title>
  <style>
    :root { --bg: #f4f6f8; --card: #fff; --text: #1a1a1a; --muted: #5b6270; --brand: #1877f2; --line: #e6e8eb; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #15171a; --card: #1f2226; --text: #eceef1; --muted: #a3aab5; --brand: #6aa5ff; --line: #2e3238; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); line-height: 1.7;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif; }
    main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
    article { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px 20px; }
    h1 { font-size: 1.5rem; margin: 0 0 4px; }
    h2 { font-size: 1.1rem; margin: 28px 0 8px; }
    p, li { color: var(--text); }
    .meta { color: var(--muted); font-size: .9rem; margin: 0 0 16px; }
    a { color: var(--brand); }
    nav { margin-top: 20px; font-size: .9rem; color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <article>
${body}
    </article>
    <nav><a href="/privacy">隱私權政策</a> ・ <a href="/terms">服務條款</a> ・ <a href="/data-deletion">資料刪除說明</a></nav>
  </main>
</body>
</html>`;
}

export function renderPrivacyPage() {
  return layout("隱私權政策", `
      <h1>隱私權政策</h1>
      <p class="meta">${BUSINESS_NAME}　生效日期：${POLICY_EFFECTIVE_DATE}</p>
      <p>本政策說明${BUSINESS_NAME}（以下稱「我們」）透過 Facebook 粉絲專頁 Messenger 對話及線上需求表單，如何蒐集、使用、保存及保護您的個人資料。</p>

      <h2>一、我們蒐集的資料</h2>
      <ul>
        <li><strong>Messenger 資料：</strong>您傳送給粉絲專頁的訊息，以及 Meta 提供的粉絲專頁專屬使用者編號（用於將表單摘要回傳到同一個對話）。</li>
        <li><strong>需求表單資料：</strong>服務類型、服務地區、預計坪數、預計開始時間、預算範圍、姓名、聯絡電話、方便聯絡的時段。</li>
      </ul>
      <p>我們不會透過本服務取得您的 Facebook 密碼、好友名單或其他個人檔案內容。</p>

      <h2>二、使用目的</h2>
      <ul>
        <li>了解您的裝潢需求，並由專人與您聯繫、提供諮詢與報價、安排丈量或見面洽談。</li>
        <li>將您填寫的需求摘要回傳至 Messenger，方便您確認及修改。</li>
      </ul>
      <p>我們不會出售、出租或交換您的個人資料。</p>

      <h2>三、資料的處理與保存</h2>
      <ul>
        <li>訊息透過 Meta Platforms（Messenger）傳遞。</li>
        <li>需求表單資料儲存在我們使用的雲端資料庫服務（Supabase），網站主機位於我們租用的虛擬主機。上述服務僅為我們處理資料，不會自行使用您的資料。</li>
        <li>資料僅在提供服務及後續聯繫所需期間保存；您可隨時依第五點要求刪除。</li>
        <li>連線全程使用 HTTPS 加密，資料庫存取僅限我們的伺服器及授權人員。</li>
      </ul>

      <h2>四、LINE 官方帳號</h2>
      <p>表單送出後，我們可能邀請您加入 LINE 官方帳號以便後續溝通。是否加入由您自行決定；加入後的資料處理依 LINE 的服務條款與隱私權政策辦理。</p>

      <h2>五、您的權利</h2>
      <p>依中華民國《個人資料保護法》，您可以查詢、閱覽、補充或更正、停止蒐集處理利用，或要求刪除您的個人資料。刪除方式請見<a href="/data-deletion">資料刪除說明</a>。</p>

      <h2>六、聯絡我們</h2>
      <p>如對本政策有任何疑問，請透過 Facebook 粉絲專頁「${BUSINESS_NAME}」的 Messenger 與我們聯繫。</p>

      <h2>七、政策更新</h2>
      <p>本政策如有修改，將公告於本頁並更新生效日期。</p>`);
}

export function renderTermsPage() {
  return layout("服務條款", `
      <h1>服務條款</h1>
      <p class="meta">${BUSINESS_NAME}　生效日期：${POLICY_EFFECTIVE_DATE}</p>
      <p>本條款適用於${BUSINESS_NAME}（以下稱「我們」）透過 Facebook 粉絲專頁 Messenger 自動回覆及線上需求表單所提供的服務（以下稱「本服務」）。使用本服務即表示您同意本條款。</p>

      <h2>一、服務內容</h2>
      <p>本服務協助您快速提供裝潢需求（例如服務類型、地區、坪數、預算與聯絡方式），並將需求摘要回傳至 Messenger，以便我們安排專人聯繫。本服務免費提供，填寫需求不代表任何契約成立。</p>

      <h2>二、報價與服務條件</h2>
      <p>自動回覆及表單中的說明僅供參考。實際服務範圍、報價、丈量費用與施工條件，以專人聯繫後雙方確認的內容或書面契約為準。</p>

      <h2>三、使用者責任</h2>
      <ul>
        <li>請提供正確的聯絡資料，以便我們與您聯繫。</li>
        <li>請勿以他人名義填寫，或利用本服務傳送不實、騷擾或違法內容。</li>
      </ul>

      <h2>四、個人資料</h2>
      <p>我們如何蒐集與使用您的資料，請見<a href="/privacy">隱私權政策</a>；刪除資料的方式請見<a href="/data-deletion">資料刪除說明</a>。</p>

      <h2>五、服務變更與中斷</h2>
      <p>我們可能因維護、系統更新或不可抗力因素調整、暫停或終止本服務。若自動回覆無法使用，您仍可直接透過 Messenger 與我們聯繫。</p>

      <h2>六、第三方平台</h2>
      <p>本服務透過 Meta（Facebook Messenger）提供，使用時亦須遵守 Meta 的使用條款。若您選擇加入我們的 LINE 官方帳號，亦適用 LINE 的相關條款。</p>

      <h2>七、條款修改與準據法</h2>
      <p>本條款如有修改，將公告於本頁並更新生效日期。本條款以中華民國法律為準據法。</p>

      <h2>八、聯絡我們</h2>
      <p>如有任何問題，請透過 Facebook 粉絲專頁「${BUSINESS_NAME}」的 Messenger 與我們聯繫。</p>`);
}

export function renderDataDeletionPage() {
  return layout("資料刪除說明", `
      <h1>資料刪除說明</h1>
      <p class="meta">${BUSINESS_NAME}　生效日期：${POLICY_EFFECTIVE_DATE}</p>
      <p>您可以隨時要求我們刪除透過 Messenger 及線上需求表單提供的個人資料。</p>

      <h2>如何申請</h2>
      <p>在 Facebook 粉絲專頁「${BUSINESS_NAME}」的 Messenger 對話中傳送「<strong>刪除我的資料</strong>」。若您使用其他 Facebook 帳號申請，請一併提供填寫表單時使用的姓名與聯絡電話，以便我們核對。</p>

      <h2>處理方式</h2>
      <ul>
        <li>我們會在收到申請並核對身分後 <strong>30 天內</strong>，刪除資料庫中與您相關的需求紀錄（姓名、電話、需求內容及 Messenger 使用者編號）。</li>
        <li>處理完成後，我們會透過原聯絡管道通知您。</li>
        <li>Messenger 對話紀錄由 Meta 保存，您可以在 Messenger 中自行刪除對話。</li>
      </ul>

      <h2>移除應用程式權限</h2>
      <p>本服務不需要您登入或授權任何 Facebook 應用程式。如果您曾授權，可在 Facebook「設定與隱私 → 設定 → 應用程式和網站」中移除。</p>`);
}
