/*
 * YouTube Enhance for Stash — 自研脚本（刻杨版 v1.1.0, 2026-11-14）
 *
 * v1.1 新增：protobuf 二进制改写（v1.0 只能处理 JSON，这就是后台播放没生效的原因）。
 * YouTube App 的 player 响应是 protobuf，字段号按公开逆向定义（与 Maasea 开源包中
 * protobuf-ts 生成的字段表一致，此处为自研的通用 wire-format 解析实现）：
 *   Player(根)            : 2=playabilityStatus, 7=adPlacements, 68=adSlots
 *   PlayabilityStatus     : 11=backgroundPlayerRender, 21=pictureInPictureRender
 *   BackgroundSupportedRenderer : 64657230=backgroundAbility → 1=active(bool)
 *   PictureInPictureSupportedRenderer : 151635310=pictureInPictureAbility
 *   PictureInPictureAbility : 1=active(bool), 8=f8(=1)
 *
 * 做法：通用 protobuf 解析 → player 响应删广告字段(7/68)，并把 playabilityStatus 里的
 * 后台(11)/画中画(21) 两个 Render 整体换成 active=true 的版本；其余字段逐字节原样保留。
 * JSON 响应走 v1.0 的 JSON 处理。任何解析失败一律 fail-open 原样放行，绝不挡播放。
 */

(function () {
  "use strict";

  // ---------- 通用 protobuf wire-format 工具 ----------
  function readVarint(buf, pos) {
    var result = 0, shift = 1, i = pos, b;
    do {
      if (i >= buf.length) throw new Error("varint eof");
      b = buf[i++];
      result += (b & 0x7f) * shift;
      shift *= 128;
    } while (b & 0x80);
    return [result, i];
  }

  function writeVarint(value) {
    var out = [];
    var v = value;
    while (v >= 128) {
      out.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return out;
  }

  // 把一段 protobuf 消息解析成字段列表 [{no, wire, raw}]，raw 为含 tag 的完整字节切片。
  // 遇到 group 等不支持的 wire type 直接抛错（外层 fail-open）。
  function parseFields(buf) {
    var fields = [];
    var pos = 0;
    while (pos < buf.length) {
      var start = pos;
      var tv = readVarint(buf, pos);
      var tag = tv[0];
      pos = tv[1];
      var no = Math.floor(tag / 8), wire = tag % 8;
      if (no <= 0) throw new Error("bad field no");
      if (wire === 0) {
        pos = readVarint(buf, pos)[1];
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 5) {
        pos += 4;
      } else if (wire === 2) {
        var lv = readVarint(buf, pos);
        pos = lv[1] + lv[0];
      } else {
        throw new Error("unsupported wire " + wire);
      }
      if (pos > buf.length) throw new Error("field overflow");
      fields.push({ no: no, wire: wire, raw: buf.slice(start, pos) });
    }
    return fields;
  }

  // 取 LEN 字段的内部字节；不是 LEN 返回 null
  function lenPayload(field) {
    if (field.wire !== 2) return null;
    var tv = readVarint(field.raw, 0);
    var lv = readVarint(field.raw, tv[1]);
    return field.raw.slice(lv[1], lv[1] + lv[0]);
  }

  function encodeLenField(no, payload) {
    var tag = writeVarint(no * 8 + 2);
    var len = writeVarint(payload.length);
    var out = new Uint8Array(tag.length + len.length + payload.length);
    out.set(tag, 0);
    out.set(len, tag.length);
    out.set(payload, tag.length + len.length);
    return out;
  }

  function encodeVarintField(no, value) {
    var tag = writeVarint(no * 8 + 0);
    var val = writeVarint(value);
    var out = new Uint8Array(tag.length + val.length);
    out.set(tag, 0);
    out.set(val, tag.length);
    return out;
  }

  function concatBytes(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total), pos = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], pos); pos += list[i].length; }
    return out;
  }

  // ---------- protobuf: playabilityStatus 改写 ----------
  function buildBackgroundRender() {
    var ability = encodeVarintField(1, 1);                        // BackgroundAbility{active:true}
    return encodeLenField(64657230, ability);                     // BackgroundSupportedRenderer
  }

  function buildPipRender() {
    var ability = concatBytes([                                   // PictureInPictureAbility{active:true, f8:1}
      encodeVarintField(1, 1),
      encodeVarintField(8, 1)
    ]);
    return encodeLenField(151635310, ability);                    // PictureInPictureSupportedRenderer
  }

  function patchPlayability(inner) {
    var fields = parseFields(inner);
    var kept = [];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].no === 11 || fields[i].no === 21) continue;   // 旧的后台/画中画设置丢弃，下面换新的
      kept.push(fields[i].raw);
    }
    kept.push(encodeLenField(11, buildBackgroundRender()));
    kept.push(encodeLenField(21, buildPipRender()));
    return concatBytes(kept);
  }

  function patchPlayer(bytes) {
    var fields = parseFields(bytes);
    var out = [], changed = false, sawPlayability = false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.no === 7 || f.no === 68) { changed = true; continue; }  // 删 adPlacements / adSlots
      if (f.no === 2 && f.wire === 2) {
        var inner = lenPayload(f);
        if (inner) {
          out.push(encodeLenField(2, patchPlayability(inner)));
          sawPlayability = true;
          changed = true;
          continue;
        }
      }
      out.push(f.raw);
    }
    if (!sawPlayability || !changed) return null;
    return concatBytes(out);
  }

  // ---------- JSON 处理（沿用 v1.0 逻辑） ----------
  var AD_KEYS = {
    adPlacements: true, adSlots: true, playerAds: true, adBreakParams: true,
    adParams: true, instreamAdPlayerOverlayRenderer: true, instreamAdNativeComponentRenderer: true
  };

  function stripAds(node, depth) {
    if (!node || typeof node !== "object" || depth > 12) return false;
    var changed = false, i, keys, k;
    if (Array.isArray(node)) {
      for (i = 0; i < node.length; i++) if (stripAds(node[i], depth + 1)) changed = true;
      return changed;
    }
    keys = Object.keys(node);
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      if (AD_KEYS[k]) { delete node[k]; changed = true; continue; }
      if (stripAds(node[k], depth + 1)) changed = true;
    }
    return changed;
  }

  function patchJson(text, url) {
    var obj = JSON.parse(text);
    var changed = stripAds(obj, 0);
    var pt = obj && obj.playbackTracking;
    if (pt && typeof pt === "object") {
      var keys = Object.keys(pt);
      for (var i = 0; i < keys.length; i++) {
        if (/pagead|ptracking|adcontext/i.test(keys[i])) { delete pt[keys[i]]; changed = true; }
      }
    }
    if (/youtubei\/v1\/player/.test(url)) {
      var ps = obj && obj.playabilityStatus;
      if (ps && typeof ps === "object") {
        ps.miniPlayer = { miniPlayerRender: { active: true } };
        ps.backgroundPlayer = { backgroundPlayerRender: { active: true } };
        changed = true;
      }
    }
    return changed ? JSON.stringify(obj) : null;
  }

  // ---------- 主入口 ----------
  try {
    var raw = typeof $response !== "undefined" ? $response.body : null;
    if (raw == null) return $done({});
    var url = (typeof $request !== "undefined" && $request.url) || "";
    var isPlayer = /youtubei\/v1\/player/.test(url);

    var bytes = null;
    if (typeof Uint8Array !== "undefined" && raw instanceof Uint8Array) bytes = raw;
    else if (typeof ArrayBuffer !== "undefined" && raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
    else if (typeof raw === "string") {
      bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
    }
    if (!bytes || bytes.length === 0) return $done({});

    // JSON 响应
    if (bytes[0] === 0x7b) {
      var text = new TextDecoder("utf-8").decode(bytes);
      var patched = patchJson(text, url);
      if (patched == null) return $done({});
      return $done({ body: new TextEncoder().encode(patched) });
    }

    // protobuf 只处理 player 响应，其余原样放行
    if (!isPlayer) return $done({});
    var outBytes = patchPlayer(bytes);
    if (!outBytes) return $done({});
    return $done({ body: outBytes });
  } catch (e) {
    try { return $done({}); } catch (ignore) {}
  }
})();
