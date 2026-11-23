import asyncio
import hmac
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.sessions import SessionMiddleware

from . import config
from .bot import bot
from .sheets import store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("app")
STATIC = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not config.ADMIN_PASSWORD:
        log.warning("ADMIN_PASSWORD is empty: set it, otherwise nobody can sign in to the panel")
    await asyncio.to_thread(store.connect)
    try:
        await bot.start()
    except Exception:  # noqa: BLE001
        log.exception("Telegram bot failed to start (check TELEGRAM_BOT_TOKEN)")
    yield
    await bot.stop()


app = FastAPI(title="Xərc", lifespan=lifespan, docs_url=None, redoc_url=None)

PUBLIC_PREFIXES = ("/login", "/api/login", "/api/health", "/static/")


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if path.startswith(PUBLIC_PREFIXES) or request.session.get("user"):
        return await call_next(request)
    if path.startswith("/api/"):
        return JSONResponse({"detail": "Not signed in"}, status_code=401)
    return RedirectResponse("/login", status_code=303)


# Added after the auth middleware so it wraps it (session is available inside).
app.add_middleware(SessionMiddleware, secret_key=config.SECRET_KEY, session_cookie="xerc_session",
                   max_age=60 * 60 * 24 * 30, same_site="lax", https_only=config.SECURE_COOKIES)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.exception_handler(ValueError)
async def value_error(_, exc: ValueError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(KeyError)
async def key_error(_, exc: KeyError):
    return JSONResponse({"detail": str(exc.args[0]) if exc.args else "Not found"}, status_code=404)


@app.exception_handler(RuntimeError)
async def runtime_error(_, exc: RuntimeError):
    return JSONResponse({"detail": str(exc)}, status_code=503)


# ---------- pages ----------
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/login", include_in_schema=False)
def login_page(request: Request):
    if request.session.get("user"):
        return RedirectResponse("/", status_code=303)
    return FileResponse(STATIC / "login.html", headers={"Cache-Control": "no-cache"})


# ---------- auth ----------
class LoginIn(BaseModel):
    username: str
    password: str


@app.post("/api/login")
async def login(body: LoginIn, request: Request):
    ok = bool(config.ADMIN_PASSWORD) and hmac.compare_digest(body.username, config.ADMIN_USERNAME) \
        and hmac.compare_digest(body.password, config.ADMIN_PASSWORD)
    if not ok:
        await asyncio.sleep(1.0)  # slow down guessing
        return JSONResponse({"detail": "Wrong username or password"}, status_code=401)
    request.session["user"] = body.username
    return {"ok": True}


@app.post("/api/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True, "storage": store.ready, "bot": bot.running}


# ---------- data ----------
@app.get("/api/meta")
def meta():
    data = {
        "base": config.DEFAULT_CURRENCY,
        "error": store.error,
        "sheet": store.title,
        "bot": {"running": bot.running, "username": bot.username},
        "categories": [],
        "rates": [{"currency": config.DEFAULT_CURRENCY, "rate": 1.0}],
    }
    if store.ready:
        data["categories"] = store.list_categories()
        data["rates"] = store.list_rates()
    return data


@app.post("/api/refresh")
async def refresh():
    """Reload data from the sheet; also retries the connection if it failed at startup."""
    if not store.ready:
        await asyncio.to_thread(store.connect)
        if store.ready and not bot.running:
            try:
                await bot.start()
            except Exception:  # noqa: BLE001
                log.exception("Telegram bot failed to start")
    store.refresh()
    return {"ok": store.ready, "error": store.error}


class TxIn(BaseModel):
    date: str
    type: Literal["expense", "income"]
    category: str = Field(min_length=1, max_length=60)
    amount: float = Field(gt=0)
    currency: str = Field(default=config.DEFAULT_CURRENCY, min_length=2, max_length=5)
    note: str = Field(default="", max_length=500)


@app.get("/api/transactions")
def list_transactions():
    return store.list_transactions()


@app.post("/api/transactions")
def add_transaction(body: TxIn):
    return store.add_transaction(body.model_dump(), source="web")


@app.put("/api/transactions/{tx_id}")
def update_transaction(tx_id: str, body: TxIn):
    return store.update_transaction(tx_id, body.model_dump())


@app.delete("/api/transactions/{tx_id}")
def delete_transaction(tx_id: str):
    return store.delete_transaction(tx_id)


class CatIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    command: str = ""
    type: Literal["expense", "income", "both"] = "expense"
    color: str = ""
    icon: str = ""


class CatUpdate(CatIn):
    apply_to_transactions: bool = True


@app.post("/api/categories")
def add_category(body: CatIn):
    return store.add_category(body.model_dump())


@app.put("/api/categories/{name}")
def update_category(name: str, body: CatUpdate):
    d = body.model_dump()
    apply = d.pop("apply_to_transactions")
    return store.update_category(name, d, apply_to_transactions=apply)


@app.delete("/api/categories/{name}")
def delete_category(name: str, reassign: str | None = None):
    return store.delete_category(name, reassign or None)


class RateIn(BaseModel):
    currency: str
    rate: float = Field(gt=0)


@app.put("/api/rates")
def set_rates(body: list[RateIn]):
    return store.set_rates([r.model_dump() for r in body])
