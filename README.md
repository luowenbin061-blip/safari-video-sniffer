# 视频嗅探（Safari Web Extension）

在 iPhone 的 Safari 里，**长按视频画面**就能列出这个页面上所有视频的真实地址。
MP4 直链可以直接走系统菜单下载。

自用工具，通用嗅探 —— 不对特定站点做适配。

## 装

用 GitHub Actions 编出来的未签名 IPA：

1. 下载 release 里的 `VideoSniffer-unsigned.ipa`
2. 用 **TrollStore** 直接安装；或者用轻松签 / AltStore 签名后安装
3. 装完**先打开一次 App**（这一步不能跳过，否则扩展不会注册）
4. 设置 → Safari 浏览器 → 扩展 → 打开「视频嗅探」
5. 回 Safari，点地址栏左侧「AA」→ 管理扩展 → 确认勾上

## 用

| 操作 | 结果 |
|---|---|
| **长按视频画面**（约 0.5 秒） | 弹出嗅探面板 |
| 点右下角蓝色圆点 | 也是弹出面板 |
| 点扩展图标 | 小面板：看数量、打开面板、重新扫描 |
| 点面板里的某一行 | 复制该地址 |
| **长按面板里的某一行** | iOS 系统菜单 → 「下载链接文件」 |

## 能下什么

- **MP4 直链**：长按链接 → 下载链接文件，直接存进「文件」App
- **M3U8 / MPD**：只能复制地址。它是播放列表，要下几百个分片再拼，手机上一个扩展做不到 —— 复制到电脑上用 `yt-dlp` 或 `N_m3u8DL-RE`
- **DRM 加密的**（付费影视）：拿不到。这不是难度问题，是密码学挡着
- **`blob:` 开头的**：说明视频是脚本喂给播放器的，DOM 里没有真实地址。需要在打开面板之后**重新加载页面**，钩子才会抓到

## 它是怎么嗅的

Safari 不支持 manifest 的 `world: "MAIN"`，content script 跑在隔离世界，够不到页面自己的 `XMLHttpRequest` / `fetch`。所以做了三层，按可靠度排序：

1. **`performance.getEntriesByType('resource')`** —— 主力。它能**回溯**页面已经发生过的全部资源请求，正好覆盖「视频已经在播」这个最常见时机
2. **DOM 扫描** —— 读 `<video>` / `<source>` 的 `currentSrc` 和 `src`
3. **页面世界注入**（`content/inject.js`）—— 用 `<script src>` 把钩子送进页面世界，抓 `XHR` / `fetch` / `createObjectURL`。严格 CSP 的站点会拦掉，拦了不影响前两层

结果按 `MP4 > M3U8 > MPD > BLOB > TS` 排序；一旦拿到播放列表或直链，碎分片就不显示了。

## 目录

```
app/                      宿主 App（iOS 上扩展必须装在一个 App 里）
extension/                扩展本体
  manifest.json           MV2（为兼容 iOS 15.0+，MV3 要 15.4+）
  content/sniffer.js      嗅探 + 面板 UI
  content/sniffer.css     面板样式
  content/inject.js       注入到页面世界的钩子
  popup/                  点扩展图标时的小面板
extension-ios/            扩展的 native 入口（目前是空的）
project.yml               XcodeGen 工程描述
.github/workflows/build.yml  云端编译 → 出未签名 IPA
```

用 XcodeGen 而不是手写 `.xcodeproj`：`.pbxproj` 那种格式手写必错，用 YAML 描述工程更可靠。

## 本地编译（需要 macOS）

```bash
brew install xcodegen
xcodegen generate
open VideoSniffer.xcodeproj
```

命令行出未签名 IPA：

```bash
xcodebuild -project VideoSniffer.xcodeproj -scheme VideoSniffer \
  -sdk iphoneos -configuration Release -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build

mkdir -p out/Payload && cp -R build/Build/Products/Release-iphoneos/VideoSniffer.app out/Payload/
cd out && zip -qry ../VideoSniffer-unsigned.ipa Payload
```

## 已知的坑

- **iOS 15.0 ~ 15.3 之外没验证过。** MV2 是为了兼容它们才选的
- **严格 CSP 的站点**：页面世界注入会失败，只剩 performance 那条路
- **iframe 里的视频**：`all_frames: true` 所以能嗅到，但面板会显示在那个 iframe 的边界内。iframe 小的时候面板也小
- **长按会接管掉 Safari 原生的视频菜单**（画中画等），因为要 `preventDefault`。不想要的话，把 `sniffer.js` 里 `contextmenu` 那段的 `preventDefault` 去掉
