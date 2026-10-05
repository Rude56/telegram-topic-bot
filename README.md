# 🤖 Telegram 私聊机器人

> 🎯 把用户私聊消息集中到管理群的独立话题里：验证、过滤、撤回、话题管理，一站式搞定
> ☁️ 基于 Cloudflare Workers + D1，无需服务器，复制代码即可上线

![版本](https://img.shields.io/badge/%E7%89%88%E6%9C%AC-v1.01-brightgreen)
![许可证](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-GPL--3.0-blue)
![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)

---

## 🌟 核心特点

- 🛡️ **人机验证** —— Turnstile / reCAPTCHA / 自定义问题三种方式，拦截机器人，答错 5 次锁定 10 分钟
- 🚫 **消息过滤** —— 屏蔽词管理 + 消息类型开关 
- 💬 **自动回复** —— 命中关键字自动回复预设内容
- 🗂️ **话题管理** —— 每位用户独立话题与资料卡，支持禁言、重置验证、新建资料卡、删除话题
- ✂️ **撤回同步** —— 引用消息发送 `/del`，私聊与话题两侧同步删除
- 📝 **编辑同步** —— 用户或管理员修改消息，另一侧自动同步更新
- 👍 **表态同步** —— 表情表态在话题与私聊之间双向同步，送达自动回执
- 🌙 **就寝时间** —— 设定时间段内自动提示，表态切换为 😴

## 🔄 工作流程

```
👤 用户私聊 ➜ 🤖 机器人（验证 / 过滤 / 限速）➜ 🗂️ 管理群独立话题 ➜ 🛠️ 管理员处理 ➜ 📨 转发回用户
```

## 👥 角色与权限

| 角色         | 权限                                           |
| ------------ | ---------------------------------------------- |
| 普通用户     | 验证后消息转发                                 |
| 群组普通成员 | 可回复用户                                     |
| 群组管理员   | `/del`、`/reset`、`/new_card`、`/delete_topic` |
| 所有者       | `/start` 打开控制面板、`/help` 查看帮助        |

## 🚀 部署步骤

### 🧰 准备工作

1. [Cloudflare 账号](https://dash.cloudflare.com/)
2. Telegram 账号
3. 🧠 聪明的大脑

### 1️⃣ 创建机器人与管理群组

1. 在 [@BotFather](https://t.me/BotFather) 创建机器人，记下 `BOT_TOKEN`
2. 建一个开启“话题（Topics）”的超级群组，把机器人拉进去并设为管理员（勾选管理话题、删除消息权限），记下群组 ID（形如 `-100xxxxxxxxxx`）
3. 获取自己的ID（通过 [@raw_data_bot](https://t.me/raw_data_bot) 获取）

### 2️⃣ 创建 D1 数据库

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 导航至 **存储和数据库 → D1 数据库**
3. 点击**创建**，名字随意

### 3️⃣ 创建 Worker

1. 进入 **Workers 和 Pages → 创建应用程序**
2. 选择**从 Hello World 开始**
3. 命名 Worker（例如 `tg-bot`）→ 点击**部署**
4. 点击**编辑代码**，**全量覆盖**：删除默认代码，把本仓库 [`bot.js`](bot.js) 的完整代码粘贴进去
5. 点击**部署**
6. 打开 Worker 根网址，看到「✅ 机器人运行正常（Bot v1.01）」

### 4️⃣ 绑定 D1 数据库

1. 打开刚创建的 Worker → **设置 → 绑定**
2. 点击**添加绑定**，选择 **D1 数据库**
3. 变量名必须填 `TG_BOT_DB`（一字不差），再选择刚创建的数据库
4. 保存后重新部署

### 5️⃣ 配置环境变量

在 Worker → **设置 → 变量和密钥**

| 变量名称                                      | 示例值                     | 说明                                                         |
| --------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| `BOT_TOKEN`                                   | `12345:AAH...`             | 你的 Bot Token                                               |
| `ADMIN_IDS`                                   | `123456,789012`            | 所有者 ID（可私聊打开控制面板的账号；多人用英文逗号分隔、**无空格**） |
| `ADMIN_GROUP_ID`                              | `-100123456789`            | 开启话题的超级群组 ID                                        |
| `WORKER_URL`                                  | `https://xxx.workers.dev/` | Worker 完整访问链接                                          |
| `TELEGRAM_WEBHOOK_SECRET`                     | `随机一串字符`             | 校验 Telegram 请求，自定义随机字符                         |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | `0x4AAAA...`               | 可选，在 Cloudflare 侧边栏选择 Turnstile → 添加站点，站点名称：任意，域：填写 Worker 域名（`workers.dev`），模式：选择 **托管**，创建后复制 **站点密钥 (Site Key)** 和 **密钥 (Secret Key)** |
| `RECAPTCHA_SITE_KEY` / `RECAPTCHA_SECRET_KEY` | `6LAAAA...`                | 可选，需自行在 [Google reCAPTCHA Admin Console](https://www.google.com/recaptcha/admin) 创建（选择 **v2 Checkbox** 类型） |

### 6️⃣ 设置 Webhook

在浏览器地址栏输入以下 URL 并回车（替换三个占位符）：`<BOT_TOKEN>``<WORKER_URL>``<TELEGRAM_WEBHOOK_SECRET>`

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>/&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

✅ **成功响应**：

```
{"ok":true,"result":true,"description":"Webhook is already set"}
```

## 🔡 使用教程

1. 创建者私信发送`/start`初始化，并召唤面板进行各项配置
2. 发送`/help`获取帮助
3. 撤回消息用`/del`命令，直接删除是单向撤回
4. 锁定话题即可对用户禁言
5. 有任何问题或建议，欢迎提`Issues`

## 📝 更新日志

<details>
<summary>🎉 v1.0 — 首个公开版本（点击展开）</summary>


- 💬 私聊转话题、话题资料卡与置顶
- 🛡️ 三种人机验证（Turnstile / reCAPTCHA / 问题验证）
- 👋 欢迎语自定义、🚫 消息过滤、✂️ 撤回同步、📝 编辑同步、👍 表态同步、🗂️ 话题管理
- 💡 自动回复、🌙 就寝时间
- 🔐 Webhook 校验、请求限流、幂等去重与数据自动清理

</details>

## 📜 许可证

本项目采用 **GNU General Public License v3.0（GPL-3.0）** 开源，完整条款见 [LICENSE](LICENSE)。

- ✅ 可以免费使用、修改、分发本项目（包括商用）
- 🔁 基于本项目修改或衍生的作品，必须同样以 GPL-3.0 开源，并保留版权声明
- ⚠️ 本程序不提供任何担保

---

## ⭐ Star 增长曲线

[![Star History Chart](https://api.star-history.com/svg?repos=Rude56/telegram-topic-bot&type=Date)](https://www.star-history.com/#Rude56/telegram-topic-bot&Date)

⭐ **如果这个项目帮到了你，欢迎点个 Star！**

