# Q-router

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md)

Q-router 是一个面向 OpenClaw 的本地 OpenAI 兼容网关。它位于 OpenClaw 与上游模型提供方之间，显式控制模型路由，并阻止“空响应但状态成功”的异常结果被当成正常完成返回。

## 它能做什么
- 转发 `chat/completions` 与面向 provider 的 `responses` 请求
- 在提交失败前做瞬态重试
- 拒绝空成功响应，避免返回空白 assistant 输出
- 将请求轨迹保存到 JSONL 与 SQLite，便于事故回溯
- 通过 `/health` 与 `/debug/routes` 暴露实际生效的路由信息

## 仓库结构
- `src/`：服务端、入口、路由、上游客户端、trace、测试
- `config/router.example.json`：公开提交的模板配置
- `config/router.local.example.json`：本机私有覆盖的最小示例
- `config/model-mappings.json`：显式别名、路由与 thinking 映射
- `docs/`：架构、配置、运维与路由审计文档
- `examples/openclaw.qingfu-router.json5`：OpenClaw 集成示例补丁

## 快速开始
1. 安装依赖：
   ```bash
   npm install
   ```
2. 设置上游 provider 的环境变量：
   ```bash
   export Q_OPENROUTER_API_KEY=replace-me
   export Q_CODEX_API_KEY=replace-me
   export Q_MODELSCOPE_API_KEY=replace-me
   ```
3. 复制一个本地私有配置：
   ```bash
   cp config/router.example.json config/router.local.json
   ```
4. 启动路由器：
   ```bash
   npm run dev
   ```
5. 检查生效配置：
   ```bash
   curl http://127.0.0.1:4318/health
   curl http://127.0.0.1:4318/debug/routes
   ```

公开仓库只跟踪 `config/router.example.json`。本地运行前，请复制到 `config/router.local.json`（或你自己的 `config/router.json`）。如果存在 `config/router.local.json`，它会覆盖基础配置，并且该文件默认不入 Git。

## 配置机制
Q-router 将模型配置拆成两层：

1. `provider` 层：通常放在本地 `config/router.local.json`（可从 `config/router.example.json` 复制）或本地 `config/router.json`
   - 定义上游 API 类型、base URL、认证方式、API key 环境变量、以及真实模型列表
2. `route` 层：放在 `config/model-mappings.json`
   - 定义调用侧别名如何映射到 provider/model
   - 也可定义 fallback 链与池化策略

配置查找顺序：
1. `Q_ROUTER_CONFIG_PATH`
2. `config/router.local.json`
3. `config/router.json`

## 添加一个模型
完整说明保留在英文 README 与 `docs/config.md` 中。最短路径是：
1. 在本地 `config/router.local.json` 中新增 provider 与模型
2. 在 `config/model-mappings.json` 中新增 route alias
3. 导出对应 API key 环境变量
4. 重启 Q-router
5. 用 `/debug/routes` 验证生效路由

## 常用命令
- `npm run dev`：开发模式启动
- `npm run build`：编译到 `dist/`
- `npm start`：运行构建产物
- `npm test`：运行测试
- `npm run preview:openclaw`：预览 OpenClaw 集成补丁

## 文档
- `docs/architecture.md`
- `docs/config.md`
- `docs/operations.md`
- `docs/model-routing-audit.md`

如果你希望先看完整英文原版，再对照中文，建议从 `README.md` 开始。
