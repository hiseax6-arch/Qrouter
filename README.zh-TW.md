# Q-router

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md)

Q-router 是一個面向 OpenClaw 的本地 OpenAI 相容閘道。它位於 OpenClaw 與上游模型提供方之間，明確控制模型路由，並阻止「空回應但狀態成功」的異常結果被當成正常完成返回。

## 它能做什麼
- 轉發 `chat/completions` 與面向 provider 的 `responses` 請求
- 在提交失敗前做暫態重試
- 拒絕空成功回應，避免返回空白 assistant 輸出
- 將請求軌跡保存到 JSONL 與 SQLite，方便事故追溯
- 透過 `/health` 與 `/debug/routes` 暴露實際生效的路由資訊

## 倉庫結構
- `src/`：服務端、入口、路由、上游客戶端、trace、測試
- `config/router.example.json`：公開提交的模板配置
- `config/router.local.example.json`：本機私有覆蓋的最小示例
- `config/model-mappings.json`：明確別名、路由與 thinking 映射
- `docs/`：架構、配置、運維與路由審計文件
- `examples/openclaw.qingfu-router.json5`：OpenClaw 整合示例補丁

## 快速開始
1. 安裝依賴：
   ```bash
   npm install
   ```
2. 設定上游 provider 的環境變數：
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
   - 定義呼叫側別名如何映射到 provider/model
   - 也可定義 fallback 鏈與池化策略

配置查找順序：
1. `Q_ROUTER_CONFIG_PATH`
2. `config/router.local.json`
3. `config/router.json`

## 新增一個模型
完整說明保留在英文 README 與 `docs/config.md`。最短路徑是：
1. 在本地 `config/router.local.json` 中新增 provider 與模型
2. 在 `config/model-mappings.json` 中新增 route alias
3. 匯出對應 API key 環境變數
4. 重新啟動 Q-router
5. 用 `/debug/routes` 驗證生效路由

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

如果你想先看完整英文原版，再對照中文，建議從 `README.md` 開始。
