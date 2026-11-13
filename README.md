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

- 脚本层处理 protobuf 二进制：player 响应删 adPlacements/adSlots 并把 playabilityStatus 里后台（字段 11）/画中画（字段 21）Render 换成 active=true；get_watch 响应改内嵌 player；account/get_setting 响应追加后台播放设置项（字段 88478200）并给 categoryId=10135 分类补 item=151 布尔开关。其余字段逐字节保留，解析失败自动放行。JSON 响应走 JSON 处理。
- 这不是 YouTube Premium 会员破解：会员专享视频、官方离线下载等服务端验会员的功能无法通过覆写获得。
- 版本记录：v1.0 真机后台未生效（只处理 JSON）；v1.1 改 protobuf player，真机仍未生效；v1.2 补 get_watch + get_setting 两条链（与参考实现的 handler 构成对齐），待真机复测。诊断法：更新后打开 YouTube 设置页，若多出后台播放设置项，说明脚本链已生效。
