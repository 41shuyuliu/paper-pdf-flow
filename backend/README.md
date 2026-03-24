# 后端 MVP 快速开始

## 安装依赖
```powershell
D:\Python\Environments\pytorch\Scripts\python.exe -m pip install -r .\backend\requirements.txt
```

## 启动服务
```powershell
D:\Python\Environments\pytorch\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8787 --reload
```

请在项目根目录 `paper_pdf_flow_skill` 下执行上述命令。

## 模型配置
后端现在直接走“论文解读”链路，不再调用旧脚本生成最终稿。

你可以二选一提供模型配置：

### 方案 1：环境变量
```powershell
$env:PAPER_PDF_FLOW_API_BASE_URL = "https://your-endpoint"
$env:PAPER_PDF_FLOW_API_KEY = "sk-..."
$env:PAPER_PDF_FLOW_MODEL = "gpt-5.3-codex"
```

### 方案 2：请求表单字段
- `api_base_url`
- `api_key`
- `model`

## 接口自检
```powershell
curl http://127.0.0.1:8787/health
```

上传一个 PDF 论文解读任务：
```powershell
curl -X POST "http://127.0.0.1:8787/tasks" `
  -F "pdf=@D:\path\to\paper.pdf" `
  -F "lang=zh" `
  -F "mode=final" `
  -F "output_name=note.md" `
  -F "api_base_url=https://your-endpoint" `
  -F "api_key=sk-..." `
  -F "model=gpt-5.3-codex"
```

轮询任务状态：
```powershell
curl http://127.0.0.1:8787/tasks/<task_id>
```

下载结果：
```powershell
curl -OJ http://127.0.0.1:8787/tasks/<task_id>/download
```
