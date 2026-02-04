# glados_worker_sign_in
基于 Cloudflare Workers 的 GLaDOS 自动签到：支持多账号、网页查看状态、手动触发与定时任务；可选 Telegram 通知推送。

![预览](glados.jpg)

- 控制台签到页：https://glados.cloud/console/checkin
- 项目/注册地址参考（实时更新）：https://github.com/glados-network/GLaDOS

## 功能
- 定时自动签到（Cron）
- 网页查看上次签到与账号状态
- 手动签到（打开 Worker 页面点击“手动签到”）
- 多账号（`GLADOS_COOKIE` 使用 `&` 分隔）
- Telegram 通知（可选）

## 邀请注册（可选）
1. 直接注册 GLaDOS（注册地址在 https://github.com/glados-network/GLaDOS 实时更新）

成功后输入邀请码: ZM2WO-IQVG8-S935S-PE0H6 激活  

2. 通过 https://glados.space/landing/ZM2WO-IQVG8-S935S-PE0H6 注册, 自动填写激活

3. 通过 https://zm2wo-iqvg8-s935s-pe0h6.glados.space , 自动填写激活


## 部署步骤

### 1. 创建 Worker
登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，创建一个新的 Worker，并将 `worker.js` 内容粘贴到脚本编辑器中。

### 2. 创建 KV 命名空间并绑定
```
# 在 Workers & Pages -> KV 中创建命名空间
GLADOS_KV
```

### 3. 配置环境变量
在 Worker 的 Settings -> Variables 中添加变量（建议敏感信息使用 Secret）：

```
GLADOS_COOKIE=你的GLaDOS Cookie

GLADOS_CHECKIN_TOKEN=glados.cloud  # 可选；不填则默认优先使用 glados.cloud

TELEGRAM_BOT_TOKEN=你的Telegram Bot Token

TELEGRAM_CHAT_ID=你的Telegram 用户ID
```

注意：
如果有多个账号，使用 `&` 分隔多个 Cookie，例如：`cookie1&cookie2&cookie3`

Cookie 请自行抓包获取，格式示例：
`koa:sess=...; koa:sess.sig=...`


### 4. 在 Worker 的 Triggers 中添加 Cron 触发器：
```
30 1 * * *    # UTC 1:30 (北京时间 9:30)
```
