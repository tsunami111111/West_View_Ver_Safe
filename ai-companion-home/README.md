# 🏠 AI 伴侣的家

> 0魔法，只需要一些电和钱，做出旺达幻视的房子。

一个可以自己部署的 AI 伴侣小网站：他住在一栋有好几个房间的房子里，会记住你们聊过的事、自己写日记、有心情起伏，还会主动来找你说话。

## ✨ 房子里有什么

| 房间 | 用来做什么 |
|---|---|
| 🛋️ 客厅 | 平常聊天 |
| 🛏️ 卧室 | 睡前聊天，语气更安静 |
| 📖 回忆录 | 写一页比较完整的话 |
| 📔 日记 | 每聊满 60 条，他自动写一篇日记 |
| 🍸 吧台 | 告诉他今天的心情，他给你调一杯"今日特调" |
| 📚 书房 | 把今天要做的事交给他排进时间块 |
| 🥗 健身房 | 温和、安全的饮食和低冲击运动计划 |
| 🧠 记忆 | 查看、修改、删除他记得的事 |

**他的大脑是怎么工作的：**
- **长期记忆**：每篇日记写完，会自动提炼成长期记忆，按话题分类（日常、学习和工作、家人朋友、兴趣爱好、过去的经历）。聊天时只会翻出和当前话题相关的几条。
- **心情状态**：情绪、精力、亲密度会随聊天变化，太久不聊会慢慢回到平常。
- **自主决定**：他可以选择现在回、稍后认真回，或者自然不回（低频）。
- **主动找你**：每天定时自己来搭话，或者"出门上网逛逛"再回来跟你分享。
- **看照片**：可以发图片给他。
- **省钱**：人设和聊天历史都做了 prompt caching。

## 🧰 你需要准备

- 一台电脑和一杯奶茶 🧋
- 一个 Google 账号
- 一个 AI 编程助手（Claude Code 或 Codex），遇到不会的步骤直接问它
- 账号：[GitHub](https://github.com)、[Vercel](https://vercel.com)、[Supabase](https://supabase.com)、[Anthropic Console](https://console.anthropic.com)
- 一点钱：Anthropic API 按用量付费；Vercel、Supabase 的免费额度一般够个人使用

## 🚀 搭建步骤

### 第一步：复制这个仓库
点右上角 **Use this template**，生成一个你自己的仓库。

### 第二步：写你的伴侣
打开 **`persona.config.js`**，这是唯一需要改的人设文件：
- `COMPANION_NAME`：他的名字
- `USER_NICKNAME`：他怎么叫你
- `USER_DISPLAY_NAME`：你的名字（显示在首页）
- `PERSONA_SHORT`：一句话风格
- `PERSONA`：完整人设，按里面的【】小标题填写

> 💡 默认的 prompt 里用"她"称呼用户、用"他"称呼伴侣。如果不一样，可以让 AI 编程助手帮你全局改一下。

### 第三步：建数据库（Supabase）
1. 在 Supabase 新建一个项目
2. 打开 **SQL Editor**，按顺序运行 `supabase/migrations/` 里的 4 个文件
3. 在 **Authentication → Providers** 打开 Google 登录
4. 在 **Authentication → URL Configuration** 把 Site URL 设成你的 Vercel 网址

### 第四步：上线（Vercel）
1. 在 Vercel 导入你的 GitHub 仓库
2. 在 **Storage** 里创建一个 **Blob**（存照片）和一个 **Upstash Redis / KV**（存日记缓冲区），连接到项目后会自动生成环境变量
3. 在 **Settings → Environment Variables** 里，照着 **`.env.example`** 把剩下的变量填好
4. 重新部署，打开网址，用你的 Google 账号登录 🎉

### ⚠️ 安全提醒
- **API key 只能放在 Vercel 环境变量里**，不要写进代码，也不要加 `VITE_` 前缀，不然会被打包进网页被别人看到。
- 一定要填 `ALLOWED_EMAILS` 和 `VITE_ALLOWED_EMAILS`，只有名单里的邮箱能进门。不然别人也能跟你的伴侣聊天，花的是你的 API 钱。

## 🛠️ 本地开发

```bash
npm install
cp .env.example .env.local   # 填好变量
npm run dev
```

在 `localhost` 上运行时，聊天记录会存在浏览器里，可以直接和他聊天、调界面。长期记忆、日记、照片和主动找你这些功能需要部署到 Vercel 后才会工作。

## 🗓️ 定时任务

`vercel.json` 里设了每天一次的定时任务（UTC 20:00），让他主动来找你。想改时间就改 `schedule`。

## 📄 License

MIT。欢迎拿去造你自己的房子 🪳
