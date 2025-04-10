# MCP Client 项目搭建指南
项目是Node开发，面向用openai进行MCP调用的客户端，仅测试过mcp-mongo-server的功能
## 项目初始化

1. 创建项目目录并进入：
   ```bash
   mkdir mcp-client
   cd mcp-client
   ```

2. 初始化 npm 项目：
   ```bash
   npm init -y
   ```

## 安装依赖

安装开发依赖：
```bash
npm install -D typescript @types/node
npm install openai @modelcontextprotocol/sdk dotenv
npm install mcp-mongo-server
```

## 配置 TypeScript

初始化 TypeScript 配置：
```bash
npx tsc --init
```

创建入口文件：
```bash
touch index.ts
```

## 环境变量配置

在项目根目录创建 `.env` 文件，配置如下：
```
LLM_API_KEY=sk-xxxxxxxxxxxxxxxx
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
```

> 注意：请将 `LLM_API_KEY` 替换为您实际的 API 密钥

## 构建与运行

构建项目：
```bash
npm run build
```

运行项目：
```bash
node build/index.js
```

## 服务器配置

您可以在 `server-config.ts` 中添加各种 MCP 服务器配置



