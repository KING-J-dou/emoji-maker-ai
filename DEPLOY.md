# Emoji Maker AI - 部署指南

## 前置准备

1. **Replicate API Token**: 从 https://replicate.com/account/api-tokens 获取
2. **Cloudflare API Token**: 从 https://dash.cloudflare.com/profile/api-tokens 获取
3. **wrangler CLI**: 已安装

## 部署步骤

### 1. 创建 KV 命名空间
```bash
cd /root/.openclaw/workspace/project/emoji-maker-ai
wrangler kv:namespace create "QUOTA_KV"
```
复制返回的 `id`，更新 `wrangler.toml` 中的 `id = "placeholder"`

### 2. 设置 Replicate API Token
```bash
wrangler secret put REPLICATE_API_TOKEN
# 输入你的 Replicate API Token
```

### 3. 部署 Worker
```bash
wrangler deploy
```

## 本地测试

```bash
wrangler dev --local
```

访问 `http://localhost:8787`

## 环境变量

- `REPLICATE_API_TOKEN`: Replicate API 密钥（通过 secret 设置）
- `QUOTA_KV`: KV 命名空间绑定（存储 IP 额度）
