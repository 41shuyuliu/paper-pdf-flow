from __future__ import annotations

import itertools
import os
import threading
from dataclasses import dataclass
from datetime import datetime
from datetime import timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi import File
from fastapi import Form
from fastapi import HTTPException
from fastapi import UploadFile
from fastapi import status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from core.paper_interpretation import ApiConfig
from core.paper_interpretation import ApiConfigError
from core.paper_interpretation import ModelRequestError
from core.paper_interpretation import PdfExtractionError
from core.paper_interpretation import build_model_prompts
from core.paper_interpretation import parse_pdf
from core.paper_interpretation import request_markdown_from_model

APP_VERSION = "0.2.0"
SERVICE_NAME = "paper-pdf-flow-backend"
ALLOWED_LANGS = {"zh", "en"}
ALLOWED_MODES = {"final"}
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(30 * 1024 * 1024)))

ENV_API_BASE_URL = "PAPER_PDF_FLOW_API_BASE_URL"
ENV_API_KEY = "PAPER_PDF_FLOW_API_KEY"
ENV_MODEL = "PAPER_PDF_FLOW_MODEL"

TASK_BASE_DIR = Path(__file__).resolve().parent / ".runtime_tasks"

_TASK_SEQ = itertools.count(1)
_TASK_LOCK = threading.Lock()


@dataclass
class TaskRecord:
    task_id: str
    status: str
    progress: float
    message: str
    created_at: str
    updated_at: str
    lang: str
    mode: str
    input_filename: str
    output_name: str
    task_dir: Path
    input_pdf: Path
    output_md: Path
    error: dict[str, str] | None = None


TASKS: dict[str, TaskRecord] = {}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def make_task_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    seq = next(_TASK_SEQ)
    return f"task_{stamp}_{seq:04d}"


def sanitize_output_name(output_name: str | None, pdf_filename: str) -> str:
    if output_name is None or not output_name.strip():
        stem = Path(pdf_filename or "note.pdf").stem or "note"
        return f"{stem}.md"

    name = output_name.strip()
    if Path(name).name != name or "/" in name or "\\" in name:
        raise HTTPException(status_code=400, detail="output_name must be a plain filename.")
    if name in {".", ".."}:
        raise HTTPException(status_code=400, detail="output_name is invalid.")
    if not name.lower().endswith(".md"):
        raise HTTPException(status_code=400, detail="output_name must end with .md")
    return name


def is_probable_pdf(payload: bytes, filename: str, content_type: str | None) -> bool:
    if not payload:
        return False
    if payload.startswith(b"%PDF"):
        return True
    if (content_type or "").lower() == "application/pdf":
        return True
    return filename.lower().endswith(".pdf")


def resolve_api_config(
    api_base_url: str | None,
    api_key: str | None,
    model: str | None,
) -> ApiConfig:
    config = ApiConfig(
        base_url=(api_base_url or os.getenv(ENV_API_BASE_URL, "")).strip(),
        api_key=(api_key or os.getenv(ENV_API_KEY, "")).strip(),
        model=(model or os.getenv(ENV_MODEL, "")).strip(),
    )

    missing: list[str] = []
    if not config.base_url:
        missing.append("api_base_url")
    if not config.api_key:
        missing.append("api_key")
    if not config.model:
        missing.append("model")
    if missing:
        raise HTTPException(
            status_code=400,
            detail=(
                "Missing model configuration: "
                + ", ".join(missing)
                + f". Provide them in form fields or env vars {ENV_API_BASE_URL}/{ENV_API_KEY}/{ENV_MODEL}."
            ),
        )
    return config


def get_task_or_404(task_id: str) -> TaskRecord:
    with _TASK_LOCK:
        task = TASKS.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found.")
    return task


def patch_task(task_id: str, **updates: object) -> None:
    with _TASK_LOCK:
        task = TASKS[task_id]
        for key, value in updates.items():
            setattr(task, key, value)
        task.updated_at = utc_now_iso()


def fail_task(task_id: str, code: str, detail: str, *, message: str) -> None:
    patch_task(
        task_id,
        status="failed",
        progress=1.0,
        message=message,
        error={"code": code, "detail": detail[:300]},
    )


def task_to_payload(task: TaskRecord) -> dict[str, object]:
    payload: dict[str, object] = {
        "task_id": task.task_id,
        "status": task.status,
        "progress": round(float(task.progress), 3),
        "message": task.message,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
    }
    if task.status == "succeeded":
        size_bytes = task.output_md.stat().st_size if task.output_md.is_file() else 0
        payload["result"] = {"filename": task.output_name, "size_bytes": size_bytes}
    if task.status == "failed":
        payload["error"] = task.error or {"code": "UNKNOWN", "detail": "Unknown task failure."}
    return payload


def run_task(task_id: str, api_config: ApiConfig) -> None:
    patch_task(task_id, status="running", progress=0.12, message="Extracting PDF structure")
    task = get_task_or_404(task_id)

    try:
        parsed = parse_pdf(task.input_pdf)
    except PdfExtractionError as exc:
        fail_task(
            task_id,
            code="PDF_PARSE_ERROR",
            detail=str(exc),
            message="Failed to extract text from PDF",
        )
        return
    except Exception as exc:
        fail_task(
            task_id,
            code="TASK_EXECUTION_ERROR",
            detail=str(exc),
            message="Unexpected extraction failure",
        )
        return

    patch_task(task_id, progress=0.45, message="Building paper interpretation prompt")
    try:
        prompts = build_model_prompts(task.input_filename, parsed, lang=task.lang)
    except Exception as exc:
        fail_task(
            task_id,
            code="PROMPT_BUILD_ERROR",
            detail=str(exc),
            message="Failed to build paper interpretation prompt",
        )
        return

    patch_task(task_id, progress=0.72, message="Requesting model interpretation")
    try:
        markdown = request_markdown_from_model(api_config, prompts)
    except ApiConfigError as exc:
        fail_task(
            task_id,
            code="MODEL_CONFIG_ERROR",
            detail=str(exc),
            message="Model configuration is invalid",
        )
        return
    except ModelRequestError as exc:
        fail_task(
            task_id,
            code="MODEL_REQUEST_ERROR",
            detail=str(exc),
            message="Failed to generate paper interpretation",
        )
        return
    except Exception as exc:
        fail_task(
            task_id,
            code="TASK_EXECUTION_ERROR",
            detail=str(exc),
            message="Unexpected model execution failure",
        )
        return

    try:
        task.output_md.write_text(markdown, encoding="utf-8")
    except OSError as exc:
        fail_task(
            task_id,
            code="OUTPUT_WRITE_ERROR",
            detail=str(exc),
            message="Failed to write markdown output",
        )
        return

    if not task.output_md.is_file():
        fail_task(
            task_id,
            code="OUTPUT_MISSING",
            detail="Model completed but markdown output is missing.",
            message="Task completed but output is missing",
        )
        return

    patch_task(task_id, status="succeeded", progress=1.0, message="Completed", error=None)


app = FastAPI(title=SERVICE_NAME, version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "service": SERVICE_NAME,
        "version": APP_VERSION,
        "time": utc_now_iso(),
    }


@app.post("/tasks", status_code=202)
async def create_task(
    pdf: UploadFile = File(...),
    lang: str = Form("zh"),
    mode: str = Form("final"),
    output_name: str | None = Form(None),
    api_base_url: str | None = Form(None),
    api_key: str | None = Form(None),
    model: str | None = Form(None),
) -> dict[str, object]:
    lang = (lang or "zh").strip()
    mode = (mode or "final").strip()
    if lang not in ALLOWED_LANGS:
        raise HTTPException(status_code=400, detail="lang must be zh or en.")
    if mode not in ALLOWED_MODES:
        raise HTTPException(status_code=400, detail="mode must be final.")

    resolved_api_config = resolve_api_config(api_base_url, api_key, model)

    payload = await pdf.read()
    if not payload:
        raise HTTPException(status_code=422, detail="Uploaded file is empty.")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Uploaded file is too large.")
    if not is_probable_pdf(payload, pdf.filename or "", pdf.content_type):
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Uploaded file is not a PDF.")

    safe_output_name = sanitize_output_name(output_name, pdf.filename or "note.pdf")
    task_id = make_task_id()
    task_dir = TASK_BASE_DIR / task_id
    input_pdf = task_dir / "input.pdf"
    output_md = task_dir / safe_output_name

    try:
        task_dir.mkdir(parents=True, exist_ok=False)
        input_pdf.write_bytes(payload)
    except FileExistsError:
        raise HTTPException(status_code=500, detail="Task directory collision.")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to store uploaded file: {exc}")

    now = utc_now_iso()
    record = TaskRecord(
        task_id=task_id,
        status="queued",
        progress=0.0,
        message="Task accepted",
        created_at=now,
        updated_at=now,
        lang=lang,
        mode=mode,
        input_filename=pdf.filename or "input.pdf",
        output_name=safe_output_name,
        task_dir=task_dir,
        input_pdf=input_pdf,
        output_md=output_md,
    )
    with _TASK_LOCK:
        TASKS[task_id] = record

    worker = threading.Thread(
        target=run_task,
        args=(task_id, resolved_api_config),
        daemon=True,
        name=f"worker-{task_id}",
    )
    worker.start()

    return {
        "task_id": task_id,
        "status": "queued",
        "created_at": now,
        "poll_url": f"/tasks/{task_id}",
        "download_url": f"/tasks/{task_id}/download",
    }


@app.get("/tasks/{task_id}")
def get_task(task_id: str) -> dict[str, object]:
    task = get_task_or_404(task_id)
    return task_to_payload(task)


@app.get("/tasks/{task_id}/download")
def download_result(task_id: str) -> FileResponse:
    task = get_task_or_404(task_id)
    if task.status in {"queued", "running"}:
        raise HTTPException(status_code=409, detail="Task is not completed yet.")
    if task.status == "failed":
        raise HTTPException(status_code=410, detail="Task failed and has no downloadable output.")
    if not task.output_md.is_file():
        raise HTTPException(status_code=410, detail="Output is missing.")

    return FileResponse(
        path=task.output_md,
        media_type="text/markdown; charset=utf-8",
        filename=task.output_name,
    )
