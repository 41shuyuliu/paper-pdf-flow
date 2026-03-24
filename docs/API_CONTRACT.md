# 接口契约（MVP）

## 1. 版本
- 契约版本：`v0.2`
- 日期：`2026-03-24`
- 适用范围：`paper_pdf_flow_skill` 后端 MVP

## 2. 目标
- 固定最小稳定协议，覆盖：
  - 上传单篇 PDF 论文解读任务
  - 查询任务状态
  - 下载生成结果
  - 服务健康检查
- 插件与后端共用同一套“论文解读”输出契约。

## 3. 通用规则
- 协议：`HTTP + JSON`
- 编码：`UTF-8`
- 基础地址示例：`http://127.0.0.1:8787`
- 任务状态枚举（严格）：
  - `queued`
  - `running`
  - `succeeded`
  - `failed`

## 4. 接口：`GET /health`

### 4.1 成功响应（`200`）
```json
{
  "ok": true,
  "service": "paper-pdf-flow-backend",
  "version": "0.2.0",
  "time": "2026-03-24T08:00:00Z"
}
```

### 4.2 说明
- 供服务探活使用。
- 必须轻量、无副作用。

## 5. 接口：`POST /tasks`

### 5.1 用途
- 从单个上传 PDF 创建一个“论文解读”生成任务。

### 5.2 请求
- Content-Type：`multipart/form-data`
- 字段：
  - `pdf`（必填）：PDF 二进制文件
  - `lang`（可选）：`zh` 或 `en`，默认 `zh`
  - `mode`（可选）：当前仅支持 `final`，默认 `final`
  - `output_name`（可选）：输出 markdown 文件名，例如 `note.md`
  - `api_base_url`（可选）：模型服务地址；若省略则回退到环境变量 `PAPER_PDF_FLOW_API_BASE_URL`
  - `api_key`（可选）：模型 API 密钥；若省略则回退到环境变量 `PAPER_PDF_FLOW_API_KEY`
  - `model`（可选）：模型名字；若省略则回退到环境变量 `PAPER_PDF_FLOW_MODEL`

### 5.3 成功响应（`202`）
```json
{
  "task_id": "task_20260324_0001",
  "status": "queued",
  "created_at": "2026-03-24T08:00:00Z",
  "poll_url": "/tasks/task_20260324_0001",
  "download_url": "/tasks/task_20260324_0001/download"
}
```

### 5.4 错误响应
- `400`：参数非法、缺少模型配置、或 `mode` 不为 `final`
- `413`：文件过大
- `415`：上传文件不是 PDF
- `422`：上传内容不可解析
- `500`：服务内部错误

## 6. 接口：`GET /tasks/{task_id}`

### 6.1 用途
- 轮询任务执行状态与元信息。

### 6.2 成功响应（`200`）- 运行中示例
```json
{
  "task_id": "task_20260324_0001",
  "status": "running",
  "progress": 0.72,
  "message": "Requesting model interpretation",
  "created_at": "2026-03-24T08:00:00Z",
  "updated_at": "2026-03-24T08:00:03Z"
}
```

### 6.3 成功响应（`200`）- 成功示例
```json
{
  "task_id": "task_20260324_0001",
  "status": "succeeded",
  "progress": 1.0,
  "message": "Completed",
  "result": {
    "filename": "note.md",
    "size_bytes": 12480
  },
  "created_at": "2026-03-24T08:00:00Z",
  "updated_at": "2026-03-24T08:00:06Z"
}
```

### 6.4 成功响应（`200`）- 失败示例
```json
{
  "task_id": "task_20260324_0001",
  "status": "failed",
  "progress": 1.0,
  "message": "Failed to generate paper interpretation",
  "error": {
    "code": "MODEL_REQUEST_ERROR",
    "detail": "模型请求失败（HTTP 401）：..."
  },
  "created_at": "2026-03-24T08:00:00Z",
  "updated_at": "2026-03-24T08:00:05Z"
}
```

### 6.5 错误响应
- `404`：任务不存在

## 7. 接口：`GET /tasks/{task_id}/download`

### 7.1 用途
- 在任务完成后下载生成的 markdown。

### 7.2 成功响应（`200`）
- Content-Type：`text/markdown; charset=utf-8`
- 建议响应头：`Content-Disposition: attachment; filename="note.md"`
- 响应体：生成后的 markdown 文本

### 7.3 错误响应
- `404`：任务不存在
- `409`：任务尚未完成（`queued` 或 `running`）
- `410`：任务失败且无可下载结果

## 8. 任务状态机（严格）
- 允许的状态迁移：
  - `queued -> running`
  - `queued -> failed`
  - `running -> succeeded`
  - `running -> failed`
- 终止状态：
  - `succeeded`
  - `failed`
- 禁止状态回退。

## 9. 单文件输出约束
- 一个任务只生成一个 markdown 产物。
- 后端禁止创建镜像/备份副本。
- 输出契约固定为“论文解读”结构，不再允许旧的“按图流程笔记”格式。

## 10. 安全与校验约束
- `output_name` 必须拦截路径穿越（例如 `../`）。
- 接口响应中不得暴露服务端绝对路径。
- 错误信息应可读且长度受控。
- API 配置可来自表单或环境变量，但不应在响应里回显敏感值。

## 11. v0.2 非目标
- 批量 PDF 处理
- 任务取消/重试接口
- 鉴权与多租户访问控制
- 流式输出部分 markdown
