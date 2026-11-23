"""Start Xərc:  python run.py   (reads settings from .env)"""
import uvicorn

from app import config

if __name__ == "__main__":
    # One worker only: the Telegram bot must run exactly once.
    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT, workers=1,
                proxy_headers=True, forwarded_allow_ips="*")
