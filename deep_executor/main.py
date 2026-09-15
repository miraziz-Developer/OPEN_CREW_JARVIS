"""Lightweight task intake service; heavy task execution is intentionally not implemented."""

import asyncio
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field


class TaskRequest(BaseModel):
    task_type: str = Field(min_length=1, max_length=128)
    payload: dict[str, Any] = Field(default_factory=dict)


class TaskAccepted(BaseModel):
    task_id: str
    status: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.tasks = asyncio.Queue()
    app.state.records: dict[str, dict[str, Any]] = {}
    app.state.redis_url = os.getenv("REDIS_URL")
    yield


app = FastAPI(title="Jarvis Deep Executor", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "redis_configured": bool(app.state.redis_url)}


@app.post("/tasks", response_model=TaskAccepted, status_code=status.HTTP_202_ACCEPTED)
async def receive_task(request: TaskRequest) -> TaskAccepted:
    task_id = str(uuid4())
    record = {"task_id": task_id, "task_type": request.task_type, "payload": request.payload,
              "status": "queued", "received_at": datetime.now(timezone.utc).isoformat()}
    app.state.records[task_id] = record
    await app.state.tasks.put(record)
    # A Redis worker can consume this queue once REDIS_URL and worker policy are configured.
    return TaskAccepted(task_id=task_id, status="queued")


@app.get("/tasks/{task_id}")
async def task_status(task_id: str) -> dict[str, Any]:
    record = app.state.records.get(task_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return record