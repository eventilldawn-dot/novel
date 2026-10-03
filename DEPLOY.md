# 部署到网上（GitHub Pages）

这个项目是**纯前端**的：`public/` 目录本身就是一个完整的网站，不需要服务器、不需要构建。
模型调用走**浏览器直连**（DeepSeek 的接口支持跨域），API Key 只存在访问者自己的浏览器里。

仓库里的 `.github/workflows/pages.yml` 已经配好：只要推送到 `main`，GitHub 会自动把 `public/` 发布到 Pages。

## 一次性设置

1. 推送代码到 GitHub 仓库（默认分支 `main`）。
2. 打开仓库 **Settings → Pages**，把 **Source** 改成 **GitHub Actions**。
   （或者用命令行：`gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow`）
3. 等 Actions 跑完，访问 `https://OWNER.github.io/REPO/`。

## 访问者要做什么

打开网址 → 右上角 `⚙` → 填自己的 API Key（默认已按 DeepSeek 配好地址和模型）→ 保存 → 开始写剧情。
Key 存在浏览器 localStorage，只用于直接请求模型服务，不经过任何第三方服务器。

## 关于剧情记录的同步

**线上版没有后端**，剧情只能存在访问者自己浏览器的 localStorage 里 —— 同一个人换台设备就看不到，这是静态托管的固有限制。

如果只有你自己用、并且希望"手机写的电脑能接着看"，正确姿势是**不用线上版**，而是：

1. 在一台常开的电脑上跑 `node server.js`；
2. 手机 / 平板 / 其他电脑都打开终端打印的局域网地址（如 `http://192.168.3.37:8787`）；
3. 所有剧情统一存在那台电脑的 `data/sessions.json`，天然同步。

想在外网也能用，就用内网穿透给本机服务一个 https 地址（Cloudflare Tunnel、frp、Tailscale 都行），
然后线上版设置里填「本机服务地址 + 同步口令」即可连回来 —— 注意必须是 **https**，
否则浏览器会以混合内容为由拦截。

仓库里已经带了一键脚本：双击 `tunnel.bat` 就会启动服务 + Cloudflare 免费隧道，
并打印形如 `https://xxx.trycloudflare.com/?token=...` 的公网地址。手机直接开这个地址即可，
不需要碰线上版（省去跨域和缓存两件事）。详见 README「跨设备同步 ③」。

## 其他静态托管

`public/` 目录可以直接丢到任何静态托管上：

- **Netlify**：把 `public/` 拖到 app.netlify.com/drop
- **Vercel**：`vercel deploy public --prod`（Framework 选 Other）
- **Cloudflare Pages**：构建命令留空，输出目录填 `public`

## 自己的服务器（可选）

如果想让 Key 留在服务器上、多设备共用一个配置，就跑 `node server.js`：

- 局域网使用：手机 / 平板访问 `http://<你的内网IP>:8787`
- 公网使用：用任意反向代理（Nginx / Caddy / Cloudflare Tunnel）指向 `localhost:8787`

此时前端会优先用服务器代理，Key 不出本机。
