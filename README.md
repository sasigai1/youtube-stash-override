# YouTube 增强覆写 for Stash（自研）

自研的 Stash 覆写，给 iOS YouTube App 去广告，并尝试打开画中画 / 后台播放。

## 文件

- `YouTube-Crack.stoverride` — 完整版：重写层去广告 + 脚本层（清广告字段、开画中画/后台播放开关）
- `YouTube-Crack-Lite.stoverride` — 轻量版：只有重写层去广告，无脚本
- `youtube-enhance.js` — 完整版配套脚本，fail-open 设计，解析失败自动放行，不挡正常播放

## 在 Stash 里导入（完整版）

覆写 → 添加远程覆写 → 粘贴：

```
https://raw.githubusercontent.com/sasigai1/youtube-stash-override/main/YouTube-Crack.stoverride
```

或一键导入：

```
https://link.stash.ws/install-override/raw.githubusercontent.com/sasigai1/youtube-stash-override/main/YouTube-Crack.stoverride
```

导入后：开启 MitM → 生成并信任 Stash 的 CA 证书 → 彻底杀掉 YouTube App 重开。

## 说明

- v1.1 起脚本层处理 protobuf 二进制 player 响应：删 adPlacements/adSlots 字段，并把 playabilityStatus 里的后台播放（字段 11）/画中画（字段 21）Render 换成 active=true；其余字段逐字节保留，解析失败自动放行。JSON 响应仍走 JSON 处理。
- 这不是 YouTube Premium 会员破解：会员专享视频、官方离线下载等服务端验会员的功能无法通过覆写获得。
- v1.1.0 / 2026-11-14。v1.0 真机反馈：后台播放未生效（当时脚本只处理 JSON）；v1.1 已针对 protobuf 重写，效果待真机复测。
