# Q-router

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md)

Q-router 是一个给 OpenClaw 用的本地 OpenAI 兼容路由网关，核心目标是提高 OpenClaw 在多上游模型来源下的输出稳定性，尤其适合第三方服务不稳定、限流、返回不一致、偶发失败的场景。

## 核心能力
- 在上游 provider 限流、不稳定、返回不一致时，提高 OpenClaw 的输出稳定性
- 对瞬时上游失败自动重试，尽量避免直接把坏结果返回给 OpenClaw
- 当某个模型或 provider 不可靠时，自动切换到备用路由
- 主路恢复后自动切回，避免临时降级长期固化
- 拒绝“空响应但状态成功”或格式异常的返回，防止 OpenClaw 产出空白回复
- 在多个上游模型来源之间保持显式路由，而不是依赖黑盒式 provider 内部切换
- 用 JSONL 和 SQLite 保存本地 trace，方便排查输出不稳定和事故问题

## 适合谁
如果你符合下面几类情况，Q-router 很合适：
- 本地运行 OpenClaw 或类似工具
- 需要在多个模型来源之间切换或路由
- 经常依赖免费额度、社区接口、或不稳定的第三方服务商
- 希望自己控制重试、fallback 链和路由行为
- 需要本地证据链来排查上游失败问题

## 不太适合谁
如果你是下面这些情况，Q-router 可能没有必要：
- 只使用一个稳定 provider
- 不需要路由控制或 fallback 机制
- 不在意空响应过滤或本地调试 trace

## 推荐的免费 / 低成本 API 来源
如果你刚开始用 Q-router，下面两个上游很适合作为起点：

### OpenRouter
- 模型覆盖面广
- 适合快速测试多个 provider
- 适合做免费或低成本模型实验
- 具体可用性和额度会随模型变化

### ModelScope（魔塔社区）
- 适合中国大陆可访问场景
- 适合试用多个开放模型或社区接口
- 适合作为 OpenRouter 之外的第二上游来源

Q-router 在这类来源组合下特别有价值，因为免费或社区接口往往更容易出现限流、不稳定、返回质量不一致等问题，而 Q-router 可以用自动重试、failover 和 failback 吸收一部分波动。

## 典型使用场景
- 把多个免费或低成本模型 API 聚合到一个本地入口
- 用重试 + fallback + failback 缓冲不稳定上游
- 让 OpenClaw 的模型路由保持本地可控、显式透明
- 排查间歇性空响应、格式错误、或异常成功返回

## 仓库结构
- `src/`：服务端、入口、路由、上游客户端、trace、测试
- `config/router.example.json`：公开提交的模板配置
- `config/router.local.example.json`：本机私有覆盖示例
- `config/model-mappings.json`：显式别名、路由与 thinking 映射
- `docs/`：架构、配置、运维与路由审计文档
- `examples/openclaw.qingfu-router.json5`：OpenClaw 集成示例补丁

## 快速开始
1. 安装依赖：
   ```bash
   npm install
   ```
2. 设置 provider 的环境变量：
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
   - 定义上游 API 类型、base URL、认证方式、API key 环境变量，以及真实模型列表
2. `route` 层：放在 `config/model-mappings.json`
   - 定义调用别名如何映射到 provider / model
   - 也可以定义 fallback 链和池化策略

配置查找顺序：
1. `Q_ROUTER_CONFIG_PATH`
2. `config/router.local.json`
3. `config/router.json`

如果存在 `config/router.local.json`，它会覆盖基础配置，是放置本机私有 provider 覆盖项的推荐位置。

## 为什么不直接连 provider
直接请求 provider 虽然简单，但你会失去：
- 统一的自动重试编排
- 显式的 fallback / failover / failback 控制
- 空成功响应过滤
- 跨 provider 的统一本地 trace 证据链

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
