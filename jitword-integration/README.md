# JitWord 接入验证程序（JitArchives 阶段一 · 仅测试）

零依赖的本地验证服务，用于确认 JitWord 嵌入集成链路在真实服务上可用：
**创建测试文档 → 后端换一次性票据 → 前端 iframe SDK 握手 → 编辑/保存/重开 → DOCX 导入导出 → 只读拦截 → 密钥不泄漏**。

- 不接档案业务、不接正式登录；只用于接入验证。
- 文档正文保存在 JitWord 服务端（演示环境），本地只保存 `docId` 映射。
- 服务只监听 `127.0.0.1`，不存在对外暴露的入口。
- 验证结论与证据见 [`../docs/阶段一接入验证报告.md`](../docs/阶段一接入验证报告.md)。

---

## 1. 环境要求

| 项 | 要求 | 本机实测 |
| --- | --- | --- |
| Node.js | >= 18（使用内置 `fetch`、`node:test` 无关，零依赖，无需 `npm install`） | v24.22.1（`D:\node.exe`，未加入 PATH） |
| 网络 | 可访问 JitWord 服务与 `loader.js` | 可访问 |
| 浏览器 | Chrome / Edge 等现代浏览器，能加载 iframe 第三方脚本 | 已用 Chromium 验证 |

本机 `node` 不在 PATH 时，用绝对路径执行：`D:\node.exe server.mjs`。

## 2. 目录结构

```
jitword-integration/
├── server.mjs                 # 本地验证服务（API + 静态页），监听 127.0.0.1
├── package.json               # scripts: start / check / config:import（零依赖）
├── config/
│   ├── config.example.json    # 配置模板（不含真实密钥，可提交）
│   └── config.local.json      # 本地真实配置（含 clientSecret，已被 .gitignore 忽略，禁止提交）
├── lib/
│   ├── config.mjs             # 配置加载（env > 配置文件，只解析 JSON，绝不 eval）
│   ├── jitword.mjs            # 服务端换票 / 建文档 / manifest / diagnostics / profile
│   └── docx.mjs               # 零依赖 DOCX 读写：样例生成、OOXML 部件与正文抽取
├── public/
│   ├── index.html             # 验证页（编辑/只读身份、按钮、字段、日志）
│   ├── app.js                 # iframe SDK 接入、票据获取、导入导出、“验证只读权限”（专属探测文档）
│   └── styles.css
├── tools/
│   ├── import-config.mjs      # 从 ../../jiword_config.txt 生成本地配置（只打印长度，不回显密钥）
│   ├── selfcheck.mjs          # 可重复执行的自检（J1-J9 / L1-L6）
│   ├── diagnose.mjs           # 取证脚本：隔离边界响应码、票据实际返回、存储后端
│   └── create-test-doc.mjs    # 新建“仅测试”文档并写入 docId（ASCII 文档名）
├── runtime/                   # 运行数据（已忽略）：state.json、exports/*.docx、自检输出
└── _source/                   # 官方示例包与抓取的 loader.js（已忽略，可重新下载）
```

## 3. 配置

两种方式，环境变量优先级更高；两者都**只做结构化读取，不执行任何配置文本中的代码**。

**方式 A：从仓库根目录的 `jiword_config.txt` 生成（推荐首次使用）**

```powershell
D:\node.exe tools\import-config.mjs
```

该脚本用正则逐字段解析，写出 `config/config.local.json`，只在终端打印“字段已设置 / 长度 N”，不会输出 `clientSecret` 的值，也不会 `eval` 配置内容。

**方式 B：环境变量**

```powershell
$env:JITWORD_API            = "https://inner.jitword.com/api/v1"
$env:JITWORD_TENANT_KEY     = "e-doc"
$env:JITWORD_PROVIDER_KEY   = "e-doc"
$env:JITWORD_CLIENT_SECRET  = "<向管理员索取，不要写进任何文件>"
$env:JITWORD_PORT           = "3000"
```

可配置字段：`api`、`tenantKey`、`providerKey`、`clientSecret`、`origin`、`docId`、`port`、`editorUrl`。
`origin` 留空时由请求的 `Host` 头自动推导（只接受回环地址），保证**票据声明的 origin 与浏览器地址栏一致**。

> `clientSecret` 只存在于服务端进程内存：不进入接口响应、不进入静态文件、不进入日志（`server.mjs` 与 `lib/config.mjs` 都有兜底拦截）。
> 若某个响应体意外包含密钥，服务端会改回 `500 {"error":"响应体包含敏感字段，已拦截"}`。

## 4. 启动 / 自检 / 停止

**启动**（必须保持窗口打开）

```powershell
cd D:\e-docs\jitword-integration
D:\node.exe server.mjs
```

启动日志会打印两个入口与当前 `docId`：

- 编辑身份：`http://127.0.0.1:3000/?identity=editor`
- 只读身份：`http://127.0.0.1:3000/?identity=viewer`

端口默认 3000，被占用时自动向上顺延（最多 50 个）。

**自检**（服务需先启动；可重复执行）

```powershell
D:\node.exe tools\selfcheck.mjs
```

- `J*` = JitWord 服务侧：manifest、loader.js 与 SDK 版本、SPA 路由、隔离边界、无密钥换票（应 401）、文档票据、票据不复用、双身份 scopes 差异、生效策略。
- `L*` = 本地验证服务侧：服务可达、浏览器可见配置无密钥、静态文件与接口响应扫描、按身份现签不缓存、只监听回环、导出产物可解析。
- 退出码：全部通过 `0`，有失败 `1`（可直接接入 CI）。
- 已知失败项 **J4b** 是厂商侧差异（`POST /api/v1/user/login` 实测 400 而非文档所称 404），详见验证报告第 8 节。

**停止**：在启动窗口按 `Ctrl+C`。若在后台运行，用 `Get-Process node | Stop-Process` 前先确认无其他 Node 任务。

## 5. 页面上可做的动作

| 按钮 | 调用 | 用途 |
| --- | --- | --- |
| 保存 | `editor.save()` | 验证保存链路，观察 `saveStateChanged` 事件 |
| 导出 DOCX | `editor.exportDocx()` | 触发导出；SDK 只返回元数据，docx 由编辑器在浏览器内直接下载 |
| 导入内置测试 DOCX | `editor.importDocx({ content })` | 用本服务生成的样例 docx 验证导入与正文 |
| 选择本地 DOCX | 同上，来源于 `<input type=file>` | 验证真实业务文件（注意 30MB 上限） |
| 验证只读权限 | 专属探测文档上的 `save()` + `importDocx()` | **仅只读身份可用**（编辑身份下按钮置灰）；用服务端生成的完整测试 DOCX，只有 `PERMISSION_DENIED` 判通过，其余一律判验证失败 |
| 读取正文 | `editor.getContent()` | 读回正文，校验输入标记 / 导入标记是否命中 |
| 重新加载 | `location.reload()` | 重新握手（新票）+ 验证内容持久化 |

页面顶部固定提示：**测试身份切换尚未接入正式业务登录，权限由后端签发票据时决定**。

## 6. 关键实现约束

1. **docId 持久化复用**：`runtime/state.json` 保存 `docId` 与创建主体；重启只复用，不重复建文档。优先级：`config.docId` > `state.json` > 首次创建。
2. **票据每次现签**：`POST /api/ticket` 内部每次调用 `/embed/tickets`，无任何缓存；票据 TTL 120s（服务端上限 300s），响应里带 `cached: false`。
3. **权限只收紧不放大**：只读身份用 `role=viewer + scopes=["document:read"] + ui.readonly`，写操作由服务端返回 `PERMISSION_DENIED`。
4. **同一主体限制**：演示环境未提供 ACL 授权接口，只有文档创建者 `externalSubject` 能换到该文档票据，因此两个测试身份共用一个主体，仅靠 role/scopes 区分（不是正式业务模型）。
5. **origin 一致**：后端从请求 `Host` 推导 origin（或读配置），非回环 Host 直接 403。
6. **只监听本机**：`server.listen(port, '127.0.0.1')`，局域网 IP 实测不可达。
7. **敏感数据边界**：`config/config.local.json`、`runtime/`、`_source/*.zip`、`_source/loader.v1.js` 全部在 `.gitignore` 中。
8. **只读验证与主文档隔离**：`POST /api/ticket` 的 `target=probe` 只为专属探测文档换票；“验证只读权限”在离屏探测实例（`#probe-stage`）里执行，用官方 `destroy()` 回收，全程不改动验证主文档，且仅 `PERMISSION_DENIED` 算拦截通过。

## 7. 已知限制 / 踩过的坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 文档名含中文时 `exportDocx` 返回 500 `Invalid character in header content ["Content-Disposition"]` | 厂商把文档名直接写进响应头 | 测试文档名改为纯 ASCII `ONLY-TEST_...`，用 `tools/create-test-doc.mjs` 重建 |
| `exportDocx()` 返回值只有 `{success, filename, size, mimeType}`，没有字节 | iframe SDK 在浏览器内自行下载文件，不把字节回传宿主 | 页面按“元数据成功”提示；需要落盘核对时把下载到的文件复制到 `runtime/exports/` |
| `importDocx` 报 `INTERNAL_ERROR this.rels is not a function` | 手写样例 docx 缺少 `word/_rels/document.xml.rels` 等关系部件 | `lib/docx.mjs` 补齐 7 个 OOXML 部件后导入正常 |
| 票据响应里 `ui.readonly` 恒为 `false` | 服务端未采纳该字段 | 只读能力以 `scopes` 为准，前端另传 `ui.readonly: true` 收紧 UI |
| 非创建者主体换票 `403 document permission denied` | 演示租户无授权接口 | 统一使用文档创建者主体 |
| 自检 `L6` 需要先有导出文件 | 导出由浏览器下载完成 | 把下载到的 docx 复制到 `runtime/exports/` 后再跑 `selfcheck`，或忽略该条 |
| 旧“写权限探针”在编辑身份下弹出 `Corrupted zip` 导入失败 | 探针用 4 字节伪 DOCX 冒充 DOCX，而编辑身份本就有导入权限；且 catch 把所有异常都当成权限拦截 | 改用 `/api/probe-docx` 的完整 DOCX + 专属探测文档 + 严格错误码判定（见验证报告第 12 节） |
| 手动验收前发现 `/api/probe-docx` 返回 404 | 3000 端口上仍是旧的服务进程 | 先 `Ctrl+C` 停止旧进程再重启；启动日志会打印探测文档 `docId` |

## 8. 手工复验清单（约 3 分钟）

1. 启动服务，打开 `?identity=editor`，确认“握手状态=编辑器就绪”“票据 origin = 页面 origin”。
2. 在正文输入 `JITARCHIVES-STAGE1-TYPING-20261026` → 点“保存” → 点“读取正文”，日志应为“含输入标记：true”。
3. 刷新页面（重新握手）→ 内容仍在。
4. `Ctrl+C` 停服务 → 重新启动 → 日志 `docId` 不变 → 刷新页面内容仍在。
5. 点“导入内置测试 DOCX”，正文出现 `IMPORT-SAMPLE-JITARCHIVES-20261026`。
6. 点“导出 DOCX”，浏览器下载 docx；复制到 `runtime/exports/` 后执行 `node tools/selfcheck.mjs`，`L6` 应通过。
7. 切到 `?identity=viewer`：可读、可“读取正文”，输入无效；点“验证只读权限”应显示“通过：save/importDocx 均被权限拒绝”（`?identity=editor` 下该按钮为灰色不可点击）。
8. 访问 `http://127.0.0.1:3000/api/config` 与 `/api/status`，全文搜索不到 `clientSecret` 的值。

## 9. 安全提醒

- `jiword_config.txt` 已随仓库提交进 Git 历史，其中的 `clientSecret` 属于**已泄漏风险项**：建议接入正式环境前轮换密钥，并改为只走环境变量或密钥管理服务。
- 不要把 `config/config.local.json`、`runtime/`、`_source/` 下的产物提交到版本库。
- 本程序不做账号体系、不做审计留痕、不做多租户隔离，仅为接入链路验证。
