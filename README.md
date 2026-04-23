# teamfeed

轻量级项目进展小组协作工具。基于 Cloudflare Workers + D1 + 静态前端。

## 特性（Phase 1 MVP）

- 📱 手机优先的轻量网页
- 🐯 名字 hash 匹配头像 emoji（无需注册）
- 📋 项目 tab 切换 + 时间轴展示（按日分组）
- ✍️ flomo 风格底部输入框（支持 iPhone 语音键盘）
- 🎨 关键人物自动染色 + 数字/日期/金额自动高亮
- 🗑️ 只能删自己发的（微信/Telegram 惯例）
- ⚙️ 设置页：身份 / 项目 / 人物字典

## 本地开发

### 1. 安装依赖

```bash
cd ~/teamfeed
npm install
```

### 2. 创建本地 D1 数据库

```bash
npx wrangler d1 create teamfeed-db
# 复制输出里的 database_id，粘贴到 wrangler.toml 的对应字段

npm run db:migrate:local    # 建表
npm run db:seed:local       # 种子数据：BCI + 控股平台
```

### 3. 本地运行

```bash
npm run dev
# 默认 http://localhost:8787
```

### 4. 手机测试（同局域网）

找到电脑 IP（`ifconfig | grep inet`），手机浏览器访问 `http://<电脑IP>:8787`。

或用 `wrangler dev --ip 0.0.0.0` 显式监听。

## 部署到 Cloudflare

### 前置：确保 Cloudflare 账号已登录

```bash
npx wrangler login
```

### 部署

```bash
npm run db:migrate:remote   # 远程数据库建表
npm run db:seed:remote      # 远程数据库种子
npm run deploy              # 部署 Worker
```

部署后访问 `https://teamfeed.<your-subdomain>.workers.dev`（或自定义域名）。

## Phase 2（暂不做）

- 📊 一键整理（LLM 集成，用户自带 Key）
- 📤 导出 JSON
- ♾️ 无限滚动分页

等真实使用一周后再决定要不要做。

## 架构

```
Cloudflare Pages (静态前端)
       ↓ fetch
Cloudflare Workers (API, src/worker.js)
       ↓
Cloudflare D1 (notes/projects/people 三张表)
```

全部在 CF 免费额度内，成本 $0。

## 设计文档

完整设计方案存于 Obsidian：
`~/Obsidian/kevinob/brainstorm/2026-04-23-项目进展小组网页-teamfeed.md`

关联方法论：
`~/Obsidian/kevinob/🦾 Openclaw/skills/52-研究工作流方法论-四工具认知架构.md`
