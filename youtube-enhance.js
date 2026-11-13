/*
 * YouTube Enhance for Stash — 自研脚本（刻杨版 v1.0.0, 2026-11-14）
 *
 * 作用（仅处理 JSON 格式的 youtubei 响应）：
 *   1. 递归删除广告字段：adPlacements / adSlots / playerAds 等
 *   2. 删除广告追踪字段：playbackTracking 里的 pagead / ptracking 项
 *   3. 在 player 响应里打开画中画（miniPlayer）与后台播放（backgroundPlayer）开关
 *
 * 安全原则：fail-open。解析失败、正文不是 JSON（含 protobuf 二进制响应）时
 * 一律原样放行 $done({})，绝不因为脚本出错挡住正常播放。
 *
 * 配套覆写：YouTube-Crack.stoverride（script-providers 指向本文件托管后的 raw 地址）
 */

(function () {
  var AD_KEYS = {
    adPlacements: true,
    adSlots: true,
    playerAds: true,
    adBreakParams: true,
    adParams: true,
    instreamAdPlayerOverlayRenderer: true,
    instreamAdNativeComponentRenderer: true
  };

  function stripAds(node, depth) {
    if (!node || typeof node !== "object" || depth > 12) return false;
    var changed = false;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        if (stripAds(node[i], depth + 1)) changed = true;
      }
      return changed;
    }
    var keys = Object.keys(node);
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      if (AD_KEYS[k]) {
        delete node[k];
        changed = true;
        continue;
      }
      if (stripAds(node[k], depth + 1)) changed = true;
    }
    return changed;
  }

  function stripTracking(root) {
    var changed = false;
    var pt = root && root.playbackTracking;
    if (pt && typeof pt === "object") {
      var keys = Object.keys(pt);
      for (var i = 0; i < keys.length; i++) {
        if (/pagead|ptracking|adcontext/i.test(keys[i])) {
          delete pt[keys[i]];
          changed = true;
        }
      }
    }
    return changed;
  }

  // 按 Maasea protobuf 定义的字段名（miniPlayerRender / backgroundPlayerRender）
  // 打开开关；结构已存在时只改 active，不存在时按同样结构新建。
  function enablePremiumPlayback(root) {
    var ps = root && root.playabilityStatus;
    if (!ps || typeof ps !== "object") return false;
    var changed = false;

    if (!ps.miniPlayer || typeof ps.miniPlayer !== "object") {
      ps.miniPlayer = { miniPlayerRender: { active: true } };
      changed = true;
    } else {
      var mp = ps.miniPlayer.miniPlayerRender || ps.miniPlayer.miniPlayerRenderer;
      if (mp && typeof mp === "object" && mp.active !== true) {
        mp.active = true;
        changed = true;
      }
    }

    if (!ps.backgroundPlayer || typeof ps.backgroundPlayer !== "object") {
      ps.backgroundPlayer = { backgroundPlayerRender: { active: true } };
      changed = true;
    } else {
      var bp = ps.backgroundPlayer.backgroundPlayerRender || ps.backgroundPlayer.backgroundPlayerRenderer;
      if (bp && typeof bp === "object" && bp.active !== true) {
        bp.active = true;
        changed = true;
      }
    }
    return changed;
  }

  try {
    var body = typeof $response !== "undefined" ? $response.body : null;
    // binary-mode 关闭时 body 应为字符串；不是字符串或不是 JSON 开头 → 放行
    if (typeof body !== "string" || body.length === 0) return $done({});
    var head = body.replace(/^\s+/, "").charAt(0);
    if (head !== "{") return $done({}); // protobuf 二进制响应不处理，避免破坏播放

    var obj = JSON.parse(body);
    var changed = false;
    if (stripAds(obj, 0)) changed = true;
    if (stripTracking(obj)) changed = true;

    var url = (typeof $request !== "undefined" && $request.url) || "";
    if (/youtubei\/v1\/player/.test(url)) {
      if (enablePremiumPlayback(obj)) changed = true;
    }

    if (!changed) return $done({});
    return $done({ body: JSON.stringify(obj) });
  } catch (e) {
    // 任何异常都放行原始响应
    try { return $done({}); } catch (ignore) {}
  }
})();
