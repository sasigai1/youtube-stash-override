/*
 * YouTube Enhance for Stash — 自研脚本（刻杨版 v1.3.0, 2026-11-14）
 *
 * 字段号均按公开逆向定义（与 Maasea 开源包中 protobuf-ts 生成的字段表一致，
 * 解析/改写为自研通用 wire-format 实现）。三条链：
 *
 * 1) player 响应（protobuf）：
 *    Player: 2=playabilityStatus, 7=adPlacements, 68=adSlots
 *    PlayabilityStatus: 11=backgroundPlayerRender, 21=pictureInPictureRender
 *    BackgroundSupportedRenderer: 64657230=backgroundAbility → 1=active
 *    PictureInPictureSupportedRenderer: 151635310=pictureInPictureAbility → 1=active, 8=f8=1
 *    → 删广告字段，把后台/画中画 Render 换成 active=true。
 *
 * 2) get_watch 响应（protobuf）：Watch: 1=contents；Content: 2=player（内嵌 Player）
 *    → 对内嵌 player 做与 1) 相同的改写（v1.1 漏了这条，真机点播常走这里）。
 *
 * 3) account/get_setting 响应（protobuf）：
 *    Setting: 6=settingItems；SettingItem: 88478200=backgroundPlayBackSettingRenderer,
 *    66930374=settingCategoryCollectionRenderer{3=subSettings, 4=categoryId}
 *    → 追加一个 backgroundPlayback/download/画中画相关开关全开的设置项，
 *      并给 categoryId=10135 的分类补一条 clientSettingEnum item=151 的布尔开关
 *      （v1.1 漏了这条：App 里没有这个设置项时，后台播放光有 playability 也不启用）。
 *
 * JSON 响应走 JSON 处理。其余响应、任何解析失败：一律 fail-open 原样放行，绝不挡播放。
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

  function lenPayload(field) {
    if (field.wire !== 2) return null;
    var tv = readVarint(field.raw, 0);
    var lv = readVarint(field.raw, tv[1]);
    return field.raw.slice(lv[1], lv[1] + lv[0]);
  }

  function varintValue(field) {
    if (field.wire !== 0) return null;
    var tv = readVarint(field.raw, 0);
    return readVarint(field.raw, tv[1])[0];
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

  // ---------- 1) player 改写 ----------
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
      if (fields[i].no === 11 || fields[i].no === 21) continue;
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
      if (f.no === 7 || f.no === 68) { changed = true; continue; }
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

  // ---------- 2) get_watch 改写：内嵌 player ----------
  function patchWatch(bytes) {
    var fields = parseFields(bytes);
    var out = [], changed = false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.no === 1 && f.wire === 2) {
        var content = lenPayload(f);
        if (content) {
          var cFields = parseFields(content);
          var cOut = [], cChanged = false;
          for (var j = 0; j < cFields.length; j++) {
            var cf = cFields[j];
            if (cf.no === 2 && cf.wire === 2) {
              var playerBytes = lenPayload(cf);
              var patched = playerBytes && patchPlayer(playerBytes);
              if (patched) { cOut.push(encodeLenField(2, patched)); cChanged = true; continue; }
            }
            cOut.push(cf.raw);
          }
          if (cChanged) { out.push(encodeLenField(1, concatBytes(cOut))); changed = true; continue; }
        }
      }
      out.push(f.raw);
    }
    return changed ? concatBytes(out) : null;
  }

  // ---------- 3) get_setting 改写：补后台播放设置项 ----------
  function buildSettingData(boolVal) {
    // SettingData{ 1: ClientSettingEnum{1: item=151}, 3: boolValue }
    // boolValue=false 时按 protobuf 默认值规则不写出（与参考实现一致）
    var enumMsg = encodeVarintField(1, 151);
    var parts = [encodeLenField(1, enumMsg)];
    if (boolVal) parts.push(encodeVarintField(3, 1));
    return concatBytes(parts);
  }

  function buildServiceEndpoint(boolVal) {
    // ServiceEndpoint{ 81212182: SetClientSettingEndpoint{ 1: SettingData } }
    var setEp = encodeLenField(1, buildSettingData(boolVal));
    return encodeLenField(81212182, setEp);
  }

  function buildSubSetting() {
    // SubSetting{ 61331416: SettingBooleanRenderer{ 5: enableEp(true), 6: disableEp(false) } }（itemId=0 省略）
    var renderer = concatBytes([
      encodeLenField(5, buildServiceEndpoint(true)),
      encodeLenField(6, buildServiceEndpoint(false))
    ]);
    return encodeLenField(61331416, renderer);
  }

  function buildBackgroundSettingItem() {
    // SettingItem{ 88478200: BackgroundPlayBackSettingRenderer{
    //   2: backgroundPlayback=1, 3: download=1, 9: downloadQualitySelection=1,
    //   10: smartDownload=1, 14: Icon{1: iconType=1093} } }
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
        var item = lenPayload(f);
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
        var coll = lenPayload(f);
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

  // ---------- JSON 处理 ----------
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
