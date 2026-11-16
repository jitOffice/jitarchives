# JitArchives 官网

本目录是 JitArchives 独立产品官网，使用原生 HTML、CSS3 和 JavaScript，不依赖前端框架或第三方 CDN。

## 本地运行

在 PowerShell 中执行：

    cd D:\e-docs\website
    node .\server.js

默认访问地址：http://127.0.0.1:8080

本地运行时，`/login`、`/register`、`/dashboard`、`/archives`、`/knowledge-graph`、`/api`、`/assets` 等业务系统路径会反向代理到 `http://127.0.0.1:5006`，因此可以直接从官网点击“登录”进入本地业务系统。若业务系统不在默认地址，可指定：

    $env:APP_ORIGIN = "http://127.0.0.1:5006"
    node .\server.js

如需指定端口或允许局域网访问：

    $env:HOST = "0.0.0.0"
    $env:PORT = "8088"
    node .\server.js

## 目录说明

- index.html：官网页面、SEO 元信息和 JSON-LD 结构化数据。
- css/style.css：品牌样式、PC/平板/手机响应式布局。
- js/main.js：移动端导航、锚点状态、FAQ 和返回顶部交互。
- images/：与业务系统共用的正式 PNG Logo、兼容旧路径的 SVG Logo，以及本地 SVG 功能图标。
- favicon.svg、favicon-16.png、favicon-32.png、favicon.ico、apple-touch-icon.png：均由业务系统正式 Logo 生成，保持品牌一致。
- robots.txt：搜索引擎抓取规则。
- sitemap.xml：官网站点地图。
- llms.txt：供生成式搜索与 AI 助手理解产品定位、功能范围和能力边界。

## 发布前需要确认

1. 当前 canonical、Open Graph、JSON-LD、sitemap 和 robots 中使用的官网域名为 https://archive.jitword.com/。正式域名如有变化，需要统一替换。
2. 官网与业务系统共用 `archive.jitword.com` 域名：Nginx 将 `/` 和官网静态资源交给本目录，将 `/api`、`/login`、`/register`、`/dashboard`、`/archives`、`/knowledge-graph`、`/assets` 等业务路径反代到业务系统。不要新增会拦截业务路由的官网静态规则。
3. 正式环境应由 Nginx 或云负载均衡终止 HTTPS，并配置证书、压缩和静态资源缓存。
4. 发布后将 https://archive.jitword.com/sitemap.xml 提交到 Google Search Console、Bing Webmaster Tools 等站长平台；如需站点所有权验证，再补充平台提供的验证代码。
5. AI 助理的功能说明遵循当前系统实现边界：正文问答支持 DOCX、PDF、TXT 可提取文本；OCR、AI 自动审批和 AI 自动归档不作为已开放能力宣传。

## 实现约束

- 官网所有图标和品牌标识均使用本地 SVG。
- 不加载远程字体、远程图片或第三方前端脚本。
- 不在官网展示未确认的价格、联系方式或未实现的产品能力。
- 静态服务只允许读取本目录内的文件，并对路径穿越请求返回错误。


## 新增功能展示（2026-11-02）

- 首页“产品能力”后增加知识图谱与 AI 证据溯源的功能入口。
- “档案流程”后新增 `#graph` 交互式知识图谱演示，演示节点数据为静态示例，点击节点展示说明；此模块不请求任何真实业务数据。
- 原 `#agent` 展示升级为精简问答、来源文件和图谱关系演示，均为示例内容。
- 样式在 `css/style.css`，节点演示交互在 `js/main.js`。
- 已同步调整标题、页面描述、Open Graph、SoftwareApplication 和 FAQ 的 JSON-LD、`llms.txt` 与首页站点地图日期。
- 不要将包含真实档号、受限合同、附件正文或人员信息的截图直接放入公开官网；请先进行脱敏和授权确认。
- 官网示例并不代表系统的实时回答结果；真实来源、图谱关系和 Agent 行为以系统权限、检索证据和实际验收结果为准。
