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

## 接口自检
```powershell
curl http://127.0.0.1:8787/health
```

上传一个 PDF 任务：
```powershell
curl -X POST "http://127.0.0.1:8787/tasks" `
  -F "pdf=@D:\path\to\paper.pdf" `
  -F "lang=zh" `
  -F "mode=final" `
  -F "output_name=note.md"
```

轮询任务状态：
```powershell
curl http://127.0.0.1:8787/tasks/<task_id>
```

下载结果：
```powershell
curl -OJ http://127.0.0.1:8787/tasks/<task_id>/download
```
