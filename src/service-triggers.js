/** Exact Messenger entry messages and postback payloads that start a web form. */
export const SERVICE_TRIGGERS = Object.freeze([
  { title: "我想詢問新成屋裝潢", payload: "SERVICE_NEW_HOME", service: "新成屋裝潢" },
  { title: "我想詢問舊屋翻新", payload: "SERVICE_OLD_HOME", service: "舊屋翻新" },
  { title: "我想詢問局部裝修", payload: "SERVICE_PARTIAL", service: "局部裝修" },
  { title: "我想詢問商業空間", payload: "SERVICE_COMMERCIAL", service: "商業空間" },
]);

const byTitle = new Map(SERVICE_TRIGGERS.map((item) => [item.title, item.service]));
const byPayload = new Map(SERVICE_TRIGGERS.map((item) => [item.payload, item.service]));
const allowedServices = new Set(SERVICE_TRIGGERS.map((item) => item.service));

export function serviceForTrigger({ text = "", payload = "" } = {}) {
  return byPayload.get(payload) || byTitle.get(text.trim()) || null;
}

export function isSupportedService(service) {
  return allowedServices.has(service);
}
