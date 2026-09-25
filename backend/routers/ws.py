import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from auth import get_user_from_token
from database import SessionLocal
from realtime import build_snapshot, manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["realtime"])


@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: str | None = Query(default=None),
):
    await websocket.accept()
    if not token:
        await websocket.close(code=4401, reason="Missing token")
        return

    db = SessionLocal()
    try:
        user = get_user_from_token(token, db)
        if user is None:
            await websocket.close(code=4401, reason="Invalid token")
            return
        snapshot = build_snapshot(db, user)
        db.expunge(user)
    finally:
        db.close()

    await manager.connect(websocket, user)
    await websocket.send_json(snapshot)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        logger.debug("WebSocket disconnected for user %s", user.id)
    finally:
        manager.disconnect(websocket)
