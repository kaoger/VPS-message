// Official LINE friend link supplied by the project owner.
export const OFFICIAL_LINE_URL = "https://line.me/R/ti/p/@662gzsyl?oat_content=url&ts=09240050";

export function lineThankYouText(editing = false) {
  return `${editing ? "感謝您的更新！" : "感謝您的填寫！"}歡迎加入三禾官方 LINE，方便後續溝通需求、傳送照片與討論細節。加入後請傳送您的姓名，方便我們核對這次填寫的需求。`;
}
