/**
 * YouTube Enhance for Stash — 自研脚本（刻杨版 v1.3.0, 2026-11-14）
 *
 * 做什么：
 *  - JSON 响应：删广告字段；给 playabilityStatus 注入 miniPlayer /
 *    backgroundPlayer 的 active 渲染（JSON 通道本来就这么表示）。
 *  - protobuf 响应（iOS App 的 youtubei 接口，需 binary-mode）：
 *      · /youtubei/v1/player —— 删根字段 7(adPlacements)/68(adSlots)；
 *        playabilityStatus(2) 里的 11(后台)/21(画中画) Render 换成 active=true。
 *      · /youtubei/v1/get_watch —— 对每个 Content 的内嵌 player(2) 做同样处理。
 *      · /youtubei/v1/account/get_setting —— 追加「后台播放」设置项
 *        (SettingItem 88478200)，并给 categoryId=10135 的分类集合补一条
 *        clientSettingEnum item=151 的布尔开关。
 *    其余字段逐字节原样透传；任何解析失败都原样放行（fail-open）。
 *
 * 字段号来自公开的逆向接口定义（Maasea/sgmodule 的 protobuf 类型表），
 * 解析器为自研通用 wire-format 代码，不依赖任何第三方脚本。
 */
(function () {
  "use strict";

  function log(msg) {
    try { console.log("[YTE] " + msg); } catch (e) {}
  }

  // 不用 instanceof 接 body：宿主（Stash）传进来的 Uint8Array 可能来自另一个
  // realm，instanceof 会误判为 false 导致 v1.1/v1.2 静默放行。按鸭子类型转字节。
  function toBytes(raw) {
    var i, out;
    if (raw == null) return null;
    if (typeof raw === "string") {
      out = new Uint8Array(raw.length);
      for (i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i) & 0xff;
      return out;
    }
    if (typeof raw === "object") {
      if (typeof raw.length === "number") {
        out = new Uint8Array(raw.length);
        for (i = 0; i < raw.length; i++) out[i] = raw[i] & 0xff;
        return out;
      }
      if (typeof raw.byteLength === "number") {
        try { return new Uint8Array(raw); } catch (e) { return null; }
      }
    }
    return null;
  }

  // ---------- 通用 protobuf wire-format 工具 ----------

  function readVarint(buf, pos) {
    var result = 0, shift = 0, b;
    do {
      if (pos >= buf.length) throw new Error("varint overflow");
      b = buf[pos++];
      result += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if (shift > 63) throw new Error("varint too long");
    } while (b & 0x80);
    return { value: result, next: pos };
  }

  function encodeVarint(v) {
    var out = [];
    v = v >>> 0; // 字段号与小整数都 < 2^31
    do {
      var b = v & 0x7f;
      v >>>= 7;
      out.push(v ? b | 0x80 : b);
    } while (v);
    return new Uint8Array(out);
  }

  function encodeTag(fieldNo, wire) {
    return encodeVarint(fieldNo * 8 + wire);
  }

  function encodeVarintField(fieldNo, value) {
    var tag = encodeTag(fieldNo, 0);
    var val = encodeVarint(value);
    var out = new Uint8Array(tag.length + val.length);
    out.set(tag, 0);
    out.set(val, tag.length);
    return out;
  }

  function encodeLenField(fieldNo, payload) {
    var tag = encodeTag(fieldNo, 2);
    var len = encodeVarint(payload.length);
    var out = new Uint8Array(tag.length + len.length + payload.length);
    out.set(tag, 0);
    out.set(len, tag.length);
    out.set(payload, tag.length + len.length);
    return out;
  }

  function concatBytes(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], off); off += list[i].length; }
    return out;
  }

  // 解析一层字段：返回 [{no, wire, raw(Uint8Array), valStart, valEnd}]
  // raw 是该字段在原缓冲里的完整字节（tag+value），透传时直接拼接。
  function parseFields(buf) {
    var fields = [];
    var pos = 0;
    while (pos < buf.length) {
      var start = pos;
      var tag = readVarint(buf, pos);
      pos = tag.next;
      var no = Math.floor(tag.value / 8);
      var wire = tag.value % 8;
      if (no === 0) throw new Error("field 0");
      var valStart = pos, valEnd;
      if (wire === 0) {
        var v = readVarint(buf, pos);
        pos = v.next;
        valEnd = pos;
      } else if (wire === 2) {
        var lv = readVarint(buf, pos);
        pos = lv.next;
        valStart = pos; // 指向 payload 本体
        pos += lv.value;
        if (pos > buf.length) throw new Error("len overflow");
        valEnd = pos;
      } else if (wire === 1) {
        pos += 8; valEnd = pos;
        if (pos > buf.length) throw new Error("64bit overflow");
      } else if (wire === 5) {
        pos += 4; valEnd = pos;
        if (pos > buf.length) throw new Error("32bit overflow");
      } else {
        throw new Error("unsupported wire " + wire);
      }
      fields.push({
        no: no, wire: wire,
        raw: buf.slice(start, pos),
        valStart: valStart, valEnd: valEnd
      });
    }
    return fields;
  }

  function lenPayload(field, buf) {
    if (field.wire !== 2) return null;
    return buf.slice(field.valStart, field.valEnd);
  }

  // 取 varint 字段的数值（wire 必须为 0）；raw 里重新读一遍
  function varintValue(field, buf) {
    // field.raw = tag + varint
    var t = readVarint(field.raw, 0);
    var v = readVarint(field.raw, t.next);
    return v.value;
  }

  // ---------- Player 改写 ----------

  // BackgroundSupportedRenderer: { 64657230: BackgroundAbility }
  // BackgroundAbility: { 1: active=true }
  function buildBackgroundRender() {
    var ability = encodeVarintField(1, 1);
    var supported = encodeLenField(64657230, ability);
    return supported;
  }

  // PictureInPictureSupportedRenderer: { 151635310: PictureInPictureAbility }
  // PictureInPictureAbility: { 1: active=true, 8: 1 }
  function buildPipRender() {
    var ability = concatBytes([encodeVarintField(1, 1), encodeVarintField(8, 1)]);
    return encodeLenField(151635310, ability);
  }

  function patchPlayability(psBytes) {
    var fields = parseFields(psBytes);
    var out = [];
    var changed = false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.no === 11 && f.wire === 2) {
        out.push(encodeLenField(11, buildBackgroundRender()));
        changed = true;
      } else if (f.no === 21 && f.wire === 2) {
        out.push(encodeLenField(21, buildPipRender()));
        changed = true;
      } else {
        out.push(f.raw);
      }
    }
    if (!changed) {
      // 原响应里没有这两个 Render（极少数情况），补上
      out.push(encodeLenField(11, buildBackgroundRender()));
      out.push(encodeLenField(21, buildPipRender()));
    }
    return concatBytes(out);
  }

  function patchPlayer(bytes) {
    var fields = parseFields(bytes);
    var out = [];
    var sawPlayability = false, changed = false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.no === 7 || f.no === 68) { changed = true; continue; } // adPlacements / adSlots
      if (f.no === 2 && f.wire === 2) {
        var ps = lenPayload(f, bytes);
        if (ps) {
          out.push(encodeLenField(2, patchPlayability(ps)));
          sawPlayability = true;
          changed = true;
          continue;
        }
      }
      out.push(f.raw);
    }
    if (!sawPlayability || !changed) {
      if (!sawPlayability) {
        var nos = [];
        for (var k = 0; k < fields.length && k < 20; k++) nos.push(fields[k].no);
        log("player: no playabilityStatus, root fields=" + nos.join(","));
      }
      return null;
    }
    return concatBytes(out);
  }

  // ---------- get_watch 改写 ----------
  // Watch: { 1: Content[] }；Content: { 2: Player, 3: Next }
  function patchWatch(bytes) {
    var fields = parseFields(bytes);
    var out = [];
    var changed = false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.no === 1 && f.wire === 2) {
        var content = lenPayload(f, bytes);
        if (content) {
          var cFields = parseFields(content);
          var cOut = [];
          var cChanged = false;
          for (var j = 0; j < cFields.length; j++) {
            var cf = cFields[j];
            if (cf.no === 2 && cf.wire === 2) {
              var player = lenPayload(cf, content);
              if (player) {
                var patched = patchPlayer(player);
                if (patched) {
                  cOut.push(encodeLenField(2, patched));
                  cChanged = true;
                  continue;
                }
              }
            }
            cOut.push(cf.raw);
          }
          if (cChanged) {
            out.push(encodeLenField(1, concatBytes(cOut)));
            changed = true;
            continue;
          }
        }
      }
      out.push(f.raw);
    }
    return changed ? concatBytes(out) : null;
  }

  // ---------- get_setting 改写 ----------
  // SettingBooleanRenderer 的开关端点：
  //   ServiceEndpoint { 81212182: SetClientSettingEndpoint }
  //   SetClientSettingEndpoint { 1: SettingData }
  //   SettingData { 1: ClientSettingEnum, 3: boolValue }
  //   ClientSettingEnum { 1: item }；enable 时写 boolValue=true，disable 时按
  //   protobuf 默认值规则省略 boolValue。
  function buildClientSettingEndpoint(item, enabled) {
    var enumMsg = encodeVarintField(1, item);
    var dataParts = [encodeLenField(1, enumMsg)];
    if (enabled) dataParts.push(encodeVarintField(3, 1));
    var settingData = concatBytes(dataParts);
    var setEndpoint = encodeLenField(1, settingData);
    return encodeLenField(81212182, setEndpoint);
  }

  // SubSetting { 61331416: SettingBooleanRenderer }
  // SettingBooleanRenderer { 5: enableEndpoint, 6: disableEndpoint, 15: itemId(0 省略) }
  function buildSubSetting() {
    var renderer = concatBytes([
      encodeLenField(5, buildClientSettingEndpoint(151, true)),
      encodeLenField(6, buildClientSettingEndpoint(151, false))
    ]);
    return encodeLenField(61331416, renderer);
  }

  // SettingItem { 88478200: BackgroundPlayBackSettingRenderer }
  // BackgroundPlayBackSettingRenderer { 2,3,9,10: true, 14: Icon{1: iconType} }
  function buildBackgroundSettingItem() {
    var renderer = concatBytes([
      encodeVarintField(2, 1),
      encodeVarintField(3, 1),
      encodeVarintField(9, 1),
      encodeVarintField(10, 1),
      encodeLenField(14, encodeVarintField(1, 1093))
    ]);
    return encodeLenField(88478200, renderer);
  }

  function patchSetting(bytes) {
    var fields = parseFields(bytes);
    var hasItems = false, i, f;
    for (i = 0; i < fields.length; i++) {
      if (fields[i].no === 6 || fields[i].no === 7) { hasItems = true; break; }
    }
    if (!hasItems) {
      var nos = [];
      for (i = 0; i < fields.length && i < 20; i++) nos.push(fields[i].no);
      log("get_setting: no settingItems, root fields=" + nos.join(","));
      return null; // 不像 Setting 响应，放行
    }

    var out = [];
    for (i = 0; i < fields.length; i++) {
      f = fields[i];
      if (f.no === 6 && f.wire === 2) {
        var item = lenPayload(f, bytes);
        if (item) {
          var patchedItem = patchSettingItem(item);
          if (patchedItem) { out.push(encodeLenField(6, patchedItem)); continue; }
        }
      }
      out.push(f.raw);
    }
    out.push(encodeLenField(6, buildBackgroundSettingItem()));
    return concatBytes(out);
  }

  // 给 categoryId=10135 的分类集合追加一条布尔开关 SubSetting；不匹配原样返回 null
  function patchSettingItem(itemBytes) {
    var fields = parseFields(itemBytes);
    var out = [], changed = false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.no === 66930374 && f.wire === 2) {
        var coll = lenPayload(f, itemBytes);
        if (coll) {
          var cFields = parseFields(coll);
          var isTarget = false, j;
          for (j = 0; j < cFields.length; j++) {
            if (cFields[j].no === 4 && varintValue(cFields[j]) === 10135) { isTarget = true; break; }
          }
          if (isTarget) {
            var cOut = [];
            for (j = 0; j < cFields.length; j++) cOut.push(cFields[j].raw);
            cOut.push(encodeLenField(3, buildSubSetting()));
            out.push(encodeLenField(66930374, concatBytes(cOut)));
            changed = true;
            continue;
          }
        }
      }
      out.push(f.raw);
    }
    return changed ? concatBytes(out) : null;
  }

  // ---------- JSON 改写（Web/JSON 通道兜底） ----------

  function stripJsonAds(node) {
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) stripJsonAds(node[i]);
      return;
    }
    if (node && typeof node === "object") {
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var lk = key.toLowerCase();
        if (
          lk === "adplacements" || lk === "adslots" || lk === "playerads" ||
          lk === "adbreakheartbeatparams" ||
          (node === node && lk.indexOf("pagead") === 0)
        ) {
          delete node[key];
        } else {
          stripJsonAds(node[key]);
        }
      }
    }
  }

  function patchJson(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return null; }
    if (!data || typeof data !== "object") return null;
    stripJsonAds(data);
    var ps = data.playabilityStatus;
    if (ps && typeof ps === "object") {
      ps.miniPlayer = { miniPlayerRenderer: { active: true } };
      ps.backgroundPlayer = { backgroundPlayerRenderer: { active: true } };
      if (data.playerConfig && typeof data.playerConfig === "object") {
        // 某些客户端读 playerConfig 里的开关
        data.playerConfig.backgroundPlaybackConfig = { backgroundPlayback: true };
      }
    }
    return JSON.stringify(data);
  }

  // ---------- 主入口 ----------
  try {
    var raw = typeof $response !== "undefined" ? $response.body : null;
    if (raw == null) return $done({});
    var url = (typeof $request !== "undefined" && $request.url) || "";

    var bytes = toBytes(raw);
    if (!bytes || bytes.length === 0) return $done({});

    if (bytes[0] === 0x7b) {
      var text = new TextDecoder("utf-8").decode(bytes);
      var patchedJson = patchJson(text, url);
      if (patchedJson == null) return $done({});
      return $done({ body: new TextEncoder().encode(patchedJson) });
    }

    var outBytes = null, ep = null;
    try {
      if (/youtubei\/v1\/player/.test(url)) { ep = "player"; outBytes = patchPlayer(bytes); }
      else if (/youtubei\/v1\/get_watch/.test(url)) { ep = "get_watch"; outBytes = patchWatch(bytes); }
      else if (/youtubei\/v1\/account\/get_setting/.test(url)) { ep = "get_setting"; outBytes = patchSetting(bytes); }
      else return $done({});
    } catch (err) {
      log(ep + ": patch error " + (err && err.message));
      return $done({});
    }

    if (!outBytes) { log(ep + ": not patched (" + bytes.length + " bytes)"); return $done({}); }
    log(ep + ": patched " + bytes.length + " -> " + outBytes.length + " bytes");
    return $done({ body: outBytes });
  } catch (e) {
    try { return $done({}); } catch (ignore) {}
  }
})();
