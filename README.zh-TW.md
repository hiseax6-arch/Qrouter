# Q-router

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md)

Q-router 是一個給 OpenClaw 用的本地 OpenAI 相容路由閘道。OpenClaw 本身已經具備基礎路由能力，但 Q-router 提供了一個更靈活、可獨立演進的增強層，適合需要自訂重試、故障切換、回切策略以及上游控制、且不希望被 OpenClaw 更新節奏綁定的場景。

## 核心能力
- 在上游 provider 限流、不穩定、返回不一致時，提高 OpenClaw 的輸出穩定性
- 對瞬時上游失敗自動重試，盡量避免直接把壞結果返回給 OpenClaw
- 當某個模型或 provider 不可靠時，自動切換到備援路由
- 主路恢復後自動切回，避免臨時降級長期固化
- 拒絕「空回應但狀態成功」或格式異常的返回，防止 OpenClaw 產出空白回覆
- 在多個上游模型來源之間保持明確路由，而不是依賴黑盒式 provider 內部切換
- 用 JSONL 和 SQLite 保存本地 trace，方便排查輸出不穩定與事故問題

## 適合誰
如果你符合下面幾類情況，Q-router 很適合：
- 本地執行 OpenClaw 或類似工具
- 需要在多個模型來源之間切換或路由
- 經常依賴免費額度、社群介面、或不穩定的第三方服務商
- 希望自己控制重試、fallback 鏈與路由行為
- 需要本地證據鏈來排查上游失敗問題

## 不太適合誰
如果你屬於下面這些情況，Q-router 可能沒有必要：
- 只使用一個穩定 provider
- 不需要路由控制或 fallback 機制
- 不在意空回應過濾或本地除錯 trace

## 為什麼 OpenClaw 已經有路由，還要用 Q-router？
OpenClaw 已經有內建路由，但當你希望路由策略和穩定性增強層獨立演進時，Q-router 更有價值。它讓你可以更細粒度地控制重試策略、fallback / failback 行為、上游實驗和本機路由規則，而不用等待 OpenClaw 主體版本更新。

## 推薦的免費 / 低成本 API 來源
如果你剛開始用 Q-router，下面兩個上游很適合作為起點：

### OpenRouter
- 模型覆蓋面廣
- 適合快速測試多個 provider
- 適合做免費或低成本模型實驗
- 具體可用性和額度會隨模型變化

### ModelScope（魔塔社區）
- 適合中國大陸可存取場景
- 適合試用多個開放模型或社群介面
- 適合作為 OpenRouter 之外的第二上游來源

Q-router 在這類來源組合下特別有價值，因為免費或社群介面往往更容易出現限流、不穩定、返回品質不一致等問題，而 Q-router 可以用自動重試、failover 和 failback 吸收一部分波動。

## 典型使用場景
- 把多個免費或低成本模型 API 聚合到一個本地入口
- 用重試 + fallback + failback 緩衝不穩定上游
- 讓 OpenClaw 的模型路由保持本地可控、明確透明
- 排查間歇性空回應、格式錯誤、或異常成功返回

## 倉庫結構
- `src/`：服務端、入口、路由、上游客戶端、trace、測試
- `config/router.example.json`：公開提交的模板配置
- `config/router.local.example.json`：本機私有覆蓋示例
- `config/model-mappings.json`：明確別名、路由與 thinking 映射
- `docs/`：架構、配置、運維與路由審計文件
- `examples/openclaw.qingfu-router.json5`：OpenClaw 整合示例補丁

## 快速開始
1. 安裝依賴：
   ```bash
   npm install
   ```
2. 設定 provider 的環境變數：
   ```bash
   export Q_OPENROUTER_API_KEY=replace-me
   export Q_CODEX_API_KEY=replace-me
   export Q_MODELSCOPE_API_KEY=replace-me
   ```
3. 複製一份本地私有配置：
   ```bash
   cp config/router.example.json config/router.local.json
   ```
4. 啟動路由器：
   ```bash
   npm run dev
   ```
5. 檢查生效配置：
   ```bash
   curl http://127.0.0.1:4318/health
   curl http://127.0.0.1:4318/debug/routes
   ```

公開倉庫只追蹤 `config/router.example.json`。本地執行前，請複製到 `config/router.local.json`（或你自己的 `config/router.json`）。如果存在 `config/router.local.json`，它會覆蓋基礎配置，而且該檔案預設不進 Git。

## 配置機制
Q-router 將模型配置拆成兩層：

1. `provider` 層：通常放在本地 `config/router.local.json`（可從 `config/router.example.json` 複製）或本地 `config/router.json`
   - 定義上游 API 類型、base URL、認證方式、API key 環境變數，以及真實模型列表
2. `route` 層：放在 `config/model-mappings.json`
   - 定義呼叫別名如何映射到 provider / model
   - 也可以定義 fallback 鏈與池化策略

配置查找順序：
1. `Q_ROUTER_CONFIG_PATH`
2. `config/router.local.json`
3. `config/router.json`

如果存在 `config/router.local.json`，它會覆蓋基礎配置，是放置本機私有 provider 覆蓋項的建議位置。

## 為什麼不直接連 provider
直接請求 provider 雖然簡單，但你會失去：
- 統一的自動重試編排
- 明確的 fallback / failover / failback 控制
- 空成功回應過濾
- 跨 provider 的統一本地 trace 證據鏈

## 常用命令
- `npm run dev`：開發模式啟動
- `npm run build`：編譯到 `dist/`
- `npm start`：執行建置產物
- `npm test`：執行測試
- `npm run preview:openclaw`：預覽 OpenClaw 整合補丁

## 文件
- `docs/architecture.md`
- `docs/config.md`
- `docs/operations.md`
- `docs/model-routing-audit.md`
