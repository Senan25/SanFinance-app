"""All settings come from the .env file in the project folder (or real environment variables)."""
import os
import re
import secrets
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")  # existing environment variables (e.g. from Docker) take priority


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _bool(name: str, default: str) -> bool:
    return _env(name, default).lower() in ("1", "true", "yes", "on")


HOST = _env("HOST", "0.0.0.0")
PORT = int(_env("PORT", "7319"))

# Web panel
ADMIN_USERNAME = _env("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = _env("ADMIN_PASSWORD")
SECRET_KEY = _env("SECRET_KEY") or secrets.token_hex(32)
SECURE_COOKIES = _bool("SECURE_COOKIES", "false")

# Money
DEFAULT_CURRENCY = _env("DEFAULT_CURRENCY", "AZN").upper()
TIMEZONE = ZoneInfo(_env("TIMEZONE", "Asia/Baku"))

# Google Sheet via Apps Script web app
APPS_SCRIPT_URL = _env("APPS_SCRIPT_URL")
APPS_SCRIPT_SECRET = _env("APPS_SCRIPT_SECRET")
CACHE_TTL_SECONDS = int(_env("CACHE_TTL_SECONDS", "60"))

# Telegram
TELEGRAM_BOT_TOKEN = _env("TELEGRAM_BOT_TOKEN")
ALLOWED_TELEGRAM_IDS = {
    int(x) for x in re.split(r"[,\s]+", _env("ALLOWED_TELEGRAM_IDS")) if x.lstrip("-").isdigit()
}
AUTO_CREATE_CATEGORIES = _bool("AUTO_CREATE_CATEGORIES", "true")
