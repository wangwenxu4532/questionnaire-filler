# 问卷星自动填写平台

## 📖 项目简介

一个完整的问卷星自动填写平台，输入问卷链接即可批量刷问卷。包含：

- 🎨 **精美的前端界面** — 可视化配置每道题的答案
- 🔧 **Node.js 后端代理** — 解决跨域问题，支持批量提交
- 📊 **实时进度面板** — SSE 流式推送提交进度
- 💾 **配置导入/导出** — 保存答题策略，下次直接加载
- 🐳 **一键 Docker 部署** — 部署到自己的服务器

---

## 🚀 部署方式

### 方式一：本地运行（最简单）

```bash
# 1. 安装 Node.js (https://nodejs.org，选 LTS 版本)

# 2. 打开终端，进入项目目录
cd questionnaire-filler

# 3. 安装依赖
npm install

# 4. 启动服务
npm start

# 5. 打开浏览器访问
# http://localhost:3000
```

### 方式二：部署到 Vercel（免费、最简单）

Vercel 只适合部署纯前端，后端代理不可用。如果只是想看前端代码，可以部署。完整功能需要下面「方式三」或「方式四」。

### 方式三：部署到 Railway / Render（免费、支持后端）

**Railway (推荐):**

1. 注册 [Railway.app](https://railway.app) (用 GitHub 登录)
2. 把项目推送到 GitHub:
   ```bash
   # 在项目目录下
   git init
   git add .
   git commit -m "init"
   # 在 GitHub 上创建新仓库后:
   git remote add origin https://github.com/你的用户名/questionnaire-filler.git
   git branch -M main
   git push -u origin main
   ```
3. 在 Railway 点击 `New Project` → `Deploy from GitHub repo`
4. 选择你的仓库，Railway 会自动检测 Node.js 项目并部署
5. 部署完成后会给你一个 `xxx.railway.app` 的域名

**Render:**

1. 注册 [Render.com](https://render.com)
2. 创建 `Web Service`，连接你的 GitHub 仓库
3. Build Command: `npm install`
4. Start Command: `npm start`
5. 部署完成后获得 `xxx.onrender.com` 域名

### 方式四：部署到自己的服务器（Docker）

```bash
# 1. 在服务器上安装 Docker 和 Docker Compose

# 2. 把项目文件传到服务器
scp -r questionnaire-filler user@你的服务器IP:/opt/

# 3. SSH 到服务器
ssh user@你的服务器IP

# 4. 进入目录并启动
cd /opt/questionnaire-filler
docker compose up -d

# 5. 访问 http://你的服务器IP:3000

# 6. 推荐配置 Nginx 反向代理 + HTTPS（见下方）
```

### Nginx 反向代理配置（可选，用于绑定域名+HTTPS）

```nginx
server {
    listen 80;
    server_name 你的域名.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        # SSE 流式传输需要关闭缓冲
        proxy_buffering off;
    }
}
```

然后用 `certbot` 配置免费 SSL 证书：
```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d 你的域名.com
```

---

## 📁 项目结构

```
questionnaire-filler/
├── public/
│   └── index.html      # 前端页面（单文件完整应用）
├── server.js           # 后端服务（Express + 问卷解析）
├── package.json        # 依赖配置
├── docker-compose.yml  # Docker 编排文件
├── Dockerfile          # Docker 镜像
├── .dockerignore       # Docker 忽略文件
└── README.md           # 本文件
```

---

## ⚠️ 免责声明

本项目仅供学习 Web 前后端开发技术之用。请勿用于：
- 刷票、刷数据
- 干扰问卷统计结果
- 任何违反网站服务条款的行为

使用者需自行承担由此产生的一切法律责任。

---

## 📝 技术栈

- **前端**: 纯 HTML/CSS/JS（无框架），SSE 流式接收进度
- **后端**: Node.js + Express + JSDOM（HTML 解析）+ Axios
- **部署**: Docker / Railway / Render / 传统服务器
