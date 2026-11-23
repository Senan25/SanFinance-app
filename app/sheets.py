"""Google Sheet storage through a Google Apps Script web app (see apps_script/Code.gs).

Tabs (created automatically on first start):
  Transactions: id | date | type | category | amount | currency | note | source | created_at
  Categories:   name | command | type | color | icon
  Rates:        currency | rate      (1 unit of currency = rate units of the default currency)
"""
import datetime as dt
import logging
import re
import threading
import time
import uuid

import httpx

from . import config

log = logging.getLogger("sheets")

TX, CAT, RATE = "Transactions", "Categories", "Rates"
HEADERS = {
    TX: ["id", "date", "type", "category", "amount", "currency", "note", "source", "created_at"],
    CAT: ["name", "command", "type", "color", "icon"],
    RATE: ["currency", "rate"],
}
TEXT_COLUMNS = {TX: [1, 2, 3, 4, 6, 7, 8, 9], CAT: [1, 2, 3, 4, 5], RATE: [1]}
COL_CATEGORY = 4

DEFAULT_CATEGORIES = [
    ["Benzin", "benzin", "expense", "#E8A317", "⛽"],
    ["Market", "market", "expense", "#2F8F6B", "🛒"],
    ["Restoran", "restoran", "expense", "#B3263E", "🍽️"],
    ["Taksi", "taksi", "expense", "#3A6EA5", "🚕"],
    ["Kommunal", "kommunal", "expense", "#6B5CA5", "💡"],
    ["Telefon və internet", "telefon", "expense", "#1F8A9E", "📱"],
    ["Səhiyyə", "sehiyye", "expense", "#D3543C", "💊"],
    ["Geyim", "geyim", "expense", "#A0527A", "👕"],
    ["Əyləncə", "eylence", "expense", "#C77D1E", "🎬"],
    ["Digər", "diger", "expense", "#6E7F86", "📦"],
    ["Maaş", "maas", "income", "#2F8F6B", "💼"],
    ["Bonus", "bonus", "income", "#4CA383", "🎁"],
    ["Digər gəlir", "diger_gelir", "income", "#7FA37A", "➕"],
]
# Approximate defaults; edit them in the panel (Edit data → Currencies).
DEFAULT_RATES_AZN = [["AZN", 1], ["USD", 1.7], ["EUR", 1.95], ["GBP", 2.25], ["RUB", 0.021], ["TRY", 0.042]]

PALETTE = ["#E8A317", "#2F8F6B", "#B3263E", "#3A6EA5", "#6B5CA5", "#1F8A9E", "#D3543C", "#A0527A", "#C77D1E", "#6E7F86"]
RESERVED_COMMANDS = {"start", "help", "cats", "today", "week", "month", "undo", "last", "rates"}
CMD_RE = re.compile(r"^[a-z0-9_]{1,32}$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
AZ_MAP = str.maketrans("əşçğıöüİƏŞÇĞÖÜ", "escgiouiescgou")


def slugify(text) -> str:
    s = str(text).translate(AZ_MAP).lower()
    s = re.sub(r"[^a-z0-9_]+", "_", s)
    return re.sub(r"_+", "_", s).strip("_")[:32]


def norm(text) -> str:
    return str(text if text is not None else "").strip().casefold()


def to_num(v) -> float:
    if isinstance(v, bool):
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v or "").strip().replace("\u00a0", "").replace(" ", "")
    if not s:
        return 0.0
    s = s.replace(",", ".") if ("," in s and "." not in s) else s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_date(v) -> str:
    if isinstance(v, (int, float)) and v > 20000:  # Sheets serial date
        return (dt.date(1899, 12, 30) + dt.timedelta(days=int(v))).isoformat()
    s = str(v or "").strip()
    if not s:
        return ""
    token = s.split("T")[0].split()[0]
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%Y/%m/%d", "%m/%d/%Y"):
        try:
            return dt.datetime.strptime(token, fmt).date().isoformat()
        except ValueError:
            continue
    return s


def now_local() -> dt.datetime:
    return dt.datetime.now(config.TIMEZONE)


def today_local() -> str:
    return now_local().date().isoformat()


class ScriptError(Exception):
    pass


class ScriptClient:
    """Talks to the Apps Script web app."""

    def __init__(self, url: str, secret: str):
        self.url, self.secret = url, secret
        self.http = httpx.Client(timeout=45, follow_redirects=True)

    def call(self, action: str, **params):
        try:
            r = self.http.post(self.url, json={"secret": self.secret, "action": action, **params})
        except httpx.HTTPError as e:
            raise ScriptError(f"Cannot reach Google Apps Script: {e}") from e
        try:
            data = r.json()
        except ValueError:
            raise ScriptError(
                "Apps Script did not answer with data. Check that APPS_SCRIPT_URL ends with /exec and the "
                "web app is deployed with “Execute as: Me” and “Who has access: Anyone”.") from None
        if not data.get("ok"):
            raise ScriptError(data.get("error") or "Apps Script error")
        return data.get("result")


class Store:
    def __init__(self):
        self.lock = threading.RLock()
        self.client: ScriptClient | None = None
        self.cache: dict = {}
        self.error: str | None = None
        self.title: str | None = None
        self.listeners: list = []  # called (no args) after categories change

    # ---------- connection ----------
    @property
    def ready(self) -> bool:
        return self.client is not None and self.error is None

    def connect(self):
        if not config.APPS_SCRIPT_URL or not config.APPS_SCRIPT_SECRET:
            self.error = "Set APPS_SCRIPT_URL and APPS_SCRIPT_SECRET in the .env file."
            log.error(self.error)
            return
        client = ScriptClient(config.APPS_SCRIPT_URL, config.APPS_SCRIPT_SECRET)
        rates = DEFAULT_RATES_AZN if config.DEFAULT_CURRENCY == "AZN" else [[config.DEFAULT_CURRENCY, 1]]
        defaults = {TX: [], CAT: DEFAULT_CATEGORIES, RATE: rates}
        sheets = {t: {"headers": HEADERS[t], "defaults": defaults[t], "textColumns": TEXT_COLUMNS[t]} for t in HEADERS}
        try:
            res = client.call("setup", sheets=sheets)
            self.client, self.title, self.error = client, res.get("title"), None
            log.info("Connected to Google Sheet '%s'%s", self.title,
                     f" (created tabs: {', '.join(res['created'])})" if res.get("created") else "")
        except ScriptError as e:
            self.client = None
            self.error = f"Google Sheet is not connected: {e}"
            log.error(self.error)

    def _call(self, action, **params):
        if not self.client:
            raise RuntimeError(self.error or "Storage is not connected")
        try:
            return self.client.call(action, **params)
        except ScriptError as e:
            raise RuntimeError(str(e)) from e

    # ---------- low-level ----------
    def _read(self, title, fresh=False):
        with self.lock:
            c = self.cache.get(title)
            if not fresh and c and time.time() - c[0] < config.CACHE_TTL_SECONDS:
                return c[1]
            headers = HEADERS[title]
            values = self._call("read", sheet=title, width=len(headers), fillIds=(title == TX))
            rows = [{h: (r[j] if j < len(r) else "") for j, h in enumerate(headers)} for r in values]
            self.cache[title] = (time.time(), rows)
            return rows

    def _invalidate(self, *titles):
        with self.lock:
            for t in titles:
                self.cache.pop(t, None)

    def _notify(self):
        for cb in self.listeners:
            try:
                cb()
            except Exception:  # noqa: BLE001
                log.exception("listener failed")

    # ---------- transactions ----------
    @staticmethod
    def _tx_from_row(r) -> dict:
        typ = norm(r["type"])
        return {
            "id": str(r["id"]).strip(),
            "date": parse_date(r["date"]),
            "type": typ if typ in ("expense", "income") else "expense",
            "category": str(r["category"]).strip(),
            "amount": round(to_num(r["amount"]), 2),
            "currency": str(r["currency"]).strip().upper() or config.DEFAULT_CURRENCY,
            "note": str(r["note"]),
            "source": str(r["source"]),
            "created_at": str(r["created_at"]),
        }

    def list_transactions(self) -> list[dict]:
        out = [self._tx_from_row(r) for r in self._read(TX)]
        out = [t for t in out if t["id"]]
        out.sort(key=lambda t: (t["date"], t["created_at"]), reverse=True)
        return out

    @staticmethod
    def _clean_tx(d) -> dict:
        date = parse_date(d.get("date") or today_local())
        try:
            dt.date.fromisoformat(date)
        except ValueError:
            raise ValueError("Date must be YYYY-MM-DD")
        typ = norm(d.get("type"))
        if typ not in ("expense", "income"):
            raise ValueError("Type must be expense or income")
        category = str(d.get("category") or "").strip()
        if not category:
            raise ValueError("Category is required")
        amount = round(to_num(d.get("amount")), 2)
        if amount <= 0:
            raise ValueError("Amount must be greater than 0")
        currency = str(d.get("currency") or config.DEFAULT_CURRENCY).strip().upper()
        if not re.fullmatch(r"[A-Z]{2,5}", currency):
            raise ValueError("Currency must be a code like AZN or USD")
        return {"date": date, "type": typ, "category": category, "amount": amount,
                "currency": currency, "note": str(d.get("note") or "").strip()[:500]}

    def add_transaction(self, data: dict, source: str = "web") -> dict:
        t = self._clean_tx(data)
        t.update(id=uuid.uuid4().hex[:10], source=source,
                 created_at=now_local().isoformat(timespec="seconds"))
        row = [t[h] for h in HEADERS[TX]]
        with self.lock:
            self._call("append", sheet=TX, row=row)
            c = self.cache.get(TX)  # keep the cache warm instead of re-reading the whole sheet
            if c:
                c[1].append(dict(zip(HEADERS[TX], row)))
        return t

    def _find_tx(self, tx_id):
        for fresh in (False, True):
            for r in self._read(TX, fresh=fresh):
                if str(r["id"]).strip() == tx_id:
                    return self._tx_from_row(r)
        return None

    def update_transaction(self, tx_id: str, data: dict) -> dict:
        with self.lock:
            cur = self._find_tx(tx_id)
            if not cur:
                raise KeyError("Transaction not found")
            t = self._clean_tx({**cur, **data})
            t.update(id=cur["id"], source=cur["source"], created_at=cur["created_at"])
            old = self._call("updateWhere", sheet=TX, col=1, key=tx_id, row=[t[h] for h in HEADERS[TX]])
            self._invalidate(TX)
            if old is None:
                raise KeyError("Transaction not found")
            return t

    def delete_transaction(self, tx_id: str) -> dict:
        with self.lock:
            old = self._call("deleteWhere", sheet=TX, col=1, key=tx_id)
            self._invalidate(TX)
            if old is None:
                raise KeyError("Transaction not found")
            return self._tx_from_row(dict(zip(HEADERS[TX], old + [""] * 9)))

    # ---------- categories ----------
    def list_categories(self) -> list[dict]:
        out = []
        for i, r in enumerate(self._read(CAT)):
            name = str(r["name"]).strip()
            if not name:
                continue
            typ = norm(r["type"])
            color = str(r["color"]).strip()
            out.append({
                "name": name,
                "command": str(r["command"]).strip().lower() or slugify(name),
                "type": typ if typ in ("expense", "income", "both") else "expense",
                "color": color if HEX_RE.match(color) else PALETTE[i % len(PALETTE)],
                "icon": str(r["icon"]).strip(),
            })
        return out

    def find_category(self, key: str):
        cats = self.list_categories()
        k, s = norm(key), slugify(key)
        for c in cats:
            if norm(c["name"]) == k or c["command"] == k:
                return c
        if s:
            for c in cats:
                if slugify(c["name"]) == s or c["command"] == s:
                    return c
        return None

    def _clean_cat(self, d: dict, exclude: str | None = None) -> dict:
        name = re.sub(r"\s+", " ", str(d.get("name") or "")).strip()
        if not name:
            raise ValueError("Category name is required")
        if len(name) > 40:
            raise ValueError("Category name is too long (max 40)")
        cmd = str(d.get("command") or "").strip().lstrip("/").lower() or slugify(name) or f"cat_{uuid.uuid4().hex[:6]}"
        if not CMD_RE.match(cmd):
            raise ValueError("Telegram command may use only a–z, 0–9 and _ (max 32)")
        if cmd in RESERVED_COMMANDS:
            raise ValueError(f"/{cmd} is reserved by the bot, choose another command")
        cats = self.list_categories()
        for c in cats:
            if exclude is not None and norm(c["name"]) == norm(exclude):
                continue
            if norm(c["name"]) == norm(name):
                raise ValueError(f"Category “{name}” already exists")
            if c["command"] == cmd:
                raise ValueError(f"/{cmd} is already used by “{c['name']}”")
        typ = norm(d.get("type") or "expense")
        if typ not in ("expense", "income", "both"):
            raise ValueError("Type must be expense, income or both")
        color = str(d.get("color") or "").strip()
        if not HEX_RE.match(color):
            color = PALETTE[len(cats) % len(PALETTE)]
        icon = str(d.get("icon") or "").strip()[:8]
        return {"name": name, "command": cmd, "type": typ, "color": color, "icon": icon}

    def add_category(self, data: dict) -> dict:
        with self.lock:
            self._read(CAT, fresh=True)
            c = self._clean_cat(data)
            self._call("append", sheet=CAT, row=[c[h] for h in HEADERS[CAT]])
            self._invalidate(CAT)
        self._notify()
        return c

    def update_category(self, old_name: str, data: dict, apply_to_transactions: bool = True) -> dict:
        with self.lock:
            self._read(CAT, fresh=True)
            c = self._clean_cat(data, exclude=old_name)
            old = self._call("updateWhere", sheet=CAT, col=1, key=old_name, row=[c[h] for h in HEADERS[CAT]])
            self._invalidate(CAT)
            if old is None:
                raise KeyError("Category not found")
            moved = 0
            if apply_to_transactions and old_name.strip() != c["name"]:
                moved = self._call("renameInColumn", sheet=TX, col=COL_CATEGORY, **{"from": old_name, "to": c["name"]})
                self._invalidate(TX)
        self._notify()
        return {**c, "moved": moved}

    def delete_category(self, name: str, reassign: str | None = None) -> dict:
        with self.lock:
            moved = 0
            if reassign:
                target = next((c for c in self.list_categories() if norm(c["name"]) == norm(reassign)), None)
                if not target or norm(reassign) == norm(name):
                    raise ValueError("Choose another existing category to move entries to")
                moved = self._call("renameInColumn", sheet=TX, col=COL_CATEGORY, **{"from": name, "to": target["name"]})
                self._invalidate(TX)
            old = self._call("deleteWhere", sheet=CAT, col=1, key=name)
            self._invalidate(CAT)
            if old is None:
                raise KeyError("Category not found")
        self._notify()
        return {"deleted": name, "moved": moved}

    # ---------- rates ----------
    def list_rates(self) -> list[dict]:
        base = config.DEFAULT_CURRENCY
        out, seen = [{"currency": base, "rate": 1.0}], {base}
        for r in self._read(RATE):
            cur = str(r["currency"]).strip().upper()
            if cur and cur not in seen:
                seen.add(cur)
                out.append({"currency": cur, "rate": to_num(r["rate"]) or 1.0})
        return out

    def rate_map(self) -> dict:
        return {r["currency"]: r["rate"] for r in self.list_rates()}

    def set_rates(self, items: list[dict]) -> list[dict]:
        base = config.DEFAULT_CURRENCY
        rows, seen = [[base, 1]], {base}
        for it in items:
            cur = str(it.get("currency") or "").strip().upper()
            if not cur or cur in seen:
                continue
            if not re.fullmatch(r"[A-Z]{2,5}", cur):
                raise ValueError(f"Invalid currency code: {cur}")
            rate = to_num(it.get("rate"))
            if rate <= 0:
                raise ValueError(f"Rate for {cur} must be greater than 0")
            seen.add(cur)
            rows.append([cur, rate])
        with self.lock:
            self._call("replaceAll", sheet=RATE, rows=[HEADERS[RATE]] + rows)
            self._invalidate(RATE)
        return self.list_rates()

    # ---------- helpers ----------
    def to_base(self, amount: float, currency: str, rates: dict | None = None) -> float:
        rates = rates or self.rate_map()
        return amount * rates.get(currency, 1.0)

    def refresh(self):
        self._invalidate(TX, CAT, RATE)


store = Store()
