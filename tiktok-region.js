// TikTok 地区解锁 for Stash
// 把请求里的地区 / 运营商参数从 CN 改成目标地区
// argument 填地区代码：JP / US / TW / KR / SG / GB，默认 JP
const MCC = { JP: "44010", US: "310260", TW: "46692", KR: "45005", SG: "52501", GB: "23410" };
const target = String(typeof $argument !== "undefined" && $argument ? $argument : "JP").trim().toUpperCase();
const mcc = MCC[target] || MCC.JP;
let url = $request.url;
const regionKeys = ["carrier_region", "carrier_region_v2", "sys_region", "region", "op_region", "residence", "current_region", "account_region", "store_region"];
for (const k of regionKeys) {
  url = url.replace(new RegExp("([?&]" + k + "=)[A-Za-z]{2}(?=&|$)", "g"), "$1" + target);
}
url = url.replace(/([?&]mcc_mnc=)\d+(?=&|$)/g, "$1" + mcc);
if (url !== $request.url) {
  $done({ url });
} else {
  $done({});
}
