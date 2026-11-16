# syntax=docker/dockerfile:1
# JitArchives 正式系统镜像（阶段二第五批 · 功能四）
# 多阶段：node:24 构建（tsc + vite）→ node:24 运行（仅产物与生产依赖）。
# 说明：本批所在开发机未安装 Docker，以下配置为静态交付，未在容器内实跑验证（见交付报告边界声明）。

# ---------- 构建阶段 ----------
FROM node:24 AS build
WORKDIR /app

# 先复制工作区清单，利用层缓存安装依赖
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN npm ci

# 复制源码并构建（后端 tsc → apps/api/dist；前端 vite → apps/web/dist）
COPY apps ./apps
RUN npm run build

# 抽出生产依赖（运行阶段只需 node_modules 运行时包）
RUN npm prune --omit=dev

# ---------- 运行阶段 ----------
FROM node:24 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    JIT_HOST=0.0.0.0 \
    JIT_PORT=5006 \
    JIT_DB_FILE=/data/jitarchives.db \
    JIT_FILE_STORE=/data/file-store

# 产物 + 生产依赖 + 备份/恢复工具（零额外依赖）
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/web/package.json ./apps/web/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/api/tools ./apps/api/tools

# 持久化卷：数据库与档案文件存储（密钥不写入镜像，经环境变量注入）
VOLUME ["/data"]
EXPOSE 5006

# 健康检查复用无鉴权 /api/health（degraded 时非 2xx → 探针失败）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.JIT_PORT||5006)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
