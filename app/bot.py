"""Telegram bot: expenses only.

  /benzin 20              -> Benzin, 20 AZN, today
  /benzin 20 usd          -> 20 USD
  /market 35.40 bread, milk  -> note "bread, milk"
  market 12               -> works without the slash too (useful for names like "Səhiyyə")
"""
import asyncio
import datetime as dt
import html
import logging
import re

from telegram import BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ParseMode
from telegram.ext import (Application, CallbackQueryHandler, CommandHandler, ContextTypes,
                          MessageHandler, filters)

from . import config
from .sheets import CMD_RE, store, today_local

log = logging.getLogger("bot")

AMOUNT_RE = re.compile(r"^(\d+(?:[.,]\d+)?)([A-Za-z]{3}|₼|\$|€|£)?$")
SYMBOLS = {"₼": "AZN", "$": "USD", "€": "EUR", "£": "GBP", "MANAT": "AZN", "MAN": "AZN"}


def money(v: float, cur: str | None = None) -> str:
    s = f"{v:,.2f}".replace(",", " ")
    return f"{s} {cur or config.DEFAULT_CURRENCY}"


def parse_entry(text: str, currencies: set[str]):
    """Return (category_key, amount, currency, note) or None."""
    toks = text.strip().split()
    if not toks:
        return None
    if toks[0].startswith("/"):
        toks[0] = toks[0][1:].split("@", 1)[0]
    idx = next((i for i, t in enumerate(toks) if AMOUNT_RE.match(t)), None)
    if idx is None:
        return None
    m = AMOUNT_RE.match(toks[idx])
    amount = float(m.group(1).replace(",", "."))
    cur = (m.group(2) or "").upper()
    cur = SYMBOLS.get(cur, cur)
    if idx == 0:
        if len(toks) < 2:
            return None
        cat, rest = toks[1], toks[2:]
    else:
        cat, rest = " ".join(toks[:idx]), toks[idx + 1:]
    if not cur and rest:
        cand = SYMBOLS.get(rest[0].upper(), rest[0].upper())
        if cand in currencies:
            cur = cand
            rest = rest[1:]
    if not cat.strip() or amount <= 0:
        return None
    return cat.strip(), round(amount, 2), cur or config.DEFAULT_CURRENCY, " ".join(rest)


class ExpenseBot:
    def __init__(self):
        self.app: Application | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.username: str | None = None

    @property
    def running(self) -> bool:
        return self.app is not None

    # ---------- lifecycle ----------
    async def start(self):
        if not config.TELEGRAM_BOT_TOKEN:
            log.warning("TELEGRAM_BOT_TOKEN is empty, bot disabled")
            return
        if not store.ready:
            log.warning("Storage not connected, bot disabled")
            return
        app = Application.builder().token(config.TELEGRAM_BOT_TOKEN).build()
        app.add_handler(CommandHandler(["start", "help"], self.cmd_help))
        app.add_handler(CommandHandler("cats", self.cmd_cats))
        app.add_handler(CommandHandler("today", self.cmd_today))
        app.add_handler(CommandHandler("week", self.cmd_week))
        app.add_handler(CommandHandler("month", self.cmd_month))
        app.add_handler(CommandHandler("last", self.cmd_last))
        app.add_handler(CommandHandler("undo", self.cmd_undo))
        app.add_handler(CommandHandler("rates", self.cmd_rates))
        app.add_handler(CallbackQueryHandler(self.on_undo_button, pattern=r"^undo:"))
        app.add_handler(MessageHandler(filters.TEXT, self.on_text))
        await app.initialize()
        await app.start()
        await app.updater.start_polling(allowed_updates=Update.ALL_TYPES)
        self.app = app
        self.loop = asyncio.get_running_loop()
        self.username = app.bot.username
        store.listeners.append(self._schedule_refresh)
        await self.refresh_commands()
        log.info("Telegram bot @%s started", self.username)

    async def stop(self):
        if not self.app:
            return
        try:
            await self.app.updater.stop()
            await self.app.stop()
            await self.app.shutdown()
        finally:
            self.app = None

    def _schedule_refresh(self):
        if self.loop and self.app:
            asyncio.run_coroutine_threadsafe(self.refresh_commands(), self.loop)

    async def refresh_commands(self):
        """Show expense categories in Telegram's command menu for one-tap entry."""
        try:
            cats = await asyncio.to_thread(store.list_categories)
            cmds = [BotCommand(c["command"], f"{c['icon']} {c['name']}".strip()[:256])
                    for c in cats if c["type"] in ("expense", "both") and CMD_RE.match(c["command"])]
            base = [BotCommand("today", "Today's spending"), BotCommand("week", "Last 7 days"),
                    BotCommand("month", "This month by category"), BotCommand("last", "Last 10 entries"),
                    BotCommand("undo", "Delete my last entry"), BotCommand("cats", "All categories"),
                    BotCommand("help", "How to add costs")]
            await self.app.bot.set_my_commands((cmds + base)[:100])
        except Exception:  # noqa: BLE001
            log.exception("Could not update bot commands")

    # ---------- helpers ----------
    @staticmethod
    def _allowed(update: Update) -> bool:
        if not config.ALLOWED_TELEGRAM_IDS:
            return True
        return bool(update.effective_user and update.effective_user.id in config.ALLOWED_TELEGRAM_IDS)

    @staticmethod
    async def _deny(update: Update):
        uid = update.effective_user.id if update.effective_user else "?"
        await update.effective_message.reply_text(
            f"⛔ You are not allowed to use this bot.\nYour Telegram ID: {uid}\n"
            "Ask the owner to add it to ALLOWED_TELEGRAM_IDS.")

    @staticmethod
    def _source(update: Update) -> str:
        u = update.effective_user
        return f"telegram:{u.username or u.id}" if u else "telegram"

    async def _expenses_between(self, start: str, end: str):
        txs = await asyncio.to_thread(store.list_transactions)
        rates = await asyncio.to_thread(store.rate_map)
        items = [t for t in txs if t["type"] == "expense" and start <= t["date"] <= end]
        total = sum(store.to_base(t["amount"], t["currency"], rates) for t in items)
        return items, total, rates

    async def _reply(self, update: Update, text: str, **kw):
        await update.effective_message.reply_text(text, parse_mode=ParseMode.HTML,
                                                  disable_web_page_preview=True, **kw)

    # ---------- commands ----------
    async def cmd_help(self, update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        uid = update.effective_user.id if update.effective_user else "?"
        if not self._allowed(update):
            return await self._deny(update)
        await self._reply(update, (
            "<b>Add a cost</b>\n"
            "<code>/benzin 20</code>  → Benzin, 20 AZN\n"
            "<code>/benzin 20 usd</code>  → in another currency\n"
            "<code>/market 35.4 bread, milk</code>  → with a note\n"
            "<code>Səhiyyə 15</code>  → without slash, any category name\n\n"
            "Unknown category names are created automatically.\n\n"
            "<b>Look back</b>\n/today  /week  /month  /last\n/undo removes your last entry\n"
            "/cats lists categories  ·  /rates shows currencies\n\n"
            f"Your Telegram ID: <code>{uid}</code>"))

    async def cmd_cats(self, update: Update, ctx):
        if not self._allowed(update):
            return await self._deny(update)
        cats = await asyncio.to_thread(store.list_categories)
        exp = [c for c in cats if c["type"] in ("expense", "both")]
        lines = [f"{c['icon'] or '•'} {html.escape(c['name'])} — /{c['command']}" for c in exp]
        await self._reply(update, "<b>Expense categories</b>\n" + ("\n".join(lines) or "None yet"))

    async def cmd_rates(self, update: Update, ctx):
        if not self._allowed(update):
            return await self._deny(update)
        rates = await asyncio.to_thread(store.list_rates)
        lines = [f"1 {r['currency']} = {r['rate']:g} {config.DEFAULT_CURRENCY}" for r in rates[1:]]
        await self._reply(update, "<b>Currencies</b>\n" + ("\n".join(lines) or "Only " + config.DEFAULT_CURRENCY))

    async def cmd_today(self, update: Update, ctx):
        if not self._allowed(update):
            return await self._deny(update)
        today = today_local()
        items, total, _ = await self._expenses_between(today, today)
        lines = [f"{html.escape(t['category'])}: {money(t['amount'], t['currency'])}"
                 + (f" <i>{html.escape(t['note'])}</i>" if t["note"] else "") for t in items]
        await self._reply(update, f"<b>Today: {money(total)}</b>\n" + ("\n".join(lines) or "No costs yet today."))

    async def _summary(self, update: Update, start: str, end: str, title: str):
        items, total, rates = await self._expenses_between(start, end)
        by_cat: dict[str, float] = {}
        for t in items:
            by_cat[t["category"]] = by_cat.get(t["category"], 0) + store.to_base(t["amount"], t["currency"], rates)
        rows = sorted(by_cat.items(), key=lambda kv: kv[1], reverse=True)
        lines = [f"{html.escape(k)}: {money(v)}  ({v / total * 100:.0f}%)" for k, v in rows] if total else []
        await self._reply(update, f"<b>{title}: {money(total)}</b>\n" + ("\n".join(lines) or "No costs in this period."))

    async def cmd_week(self, update: Update, ctx):
        if not self._allowed(update):
            return await self._deny(update)
        end = dt.date.fromisoformat(today_local())
        await self._summary(update, (end - dt.timedelta(days=6)).isoformat(), end.isoformat(), "Last 7 days")

    async def cmd_month(self, update: Update, ctx):
        if not self._allowed(update):
            return await self._deny(update)
        end = dt.date.fromisoformat(today_local())
        await self._summary(update, end.replace(day=1).isoformat(), end.isoformat(), end.strftime("%B %Y"))

    async def cmd_last(self, update: Update, ctx):
        if not self._allowed(update):
            return await self._deny(update)
        txs = await asyncio.to_thread(store.list_transactions)
        exp = [t for t in txs if t["type"] == "expense"][:10]
        lines = [f"{t['date'][5:]}  {html.escape(t['category'])}: {money(t['amount'], t['currency'])}" for t in exp]
        await self._reply(update, "<b>Last entries</b>\n" + ("\n".join(lines) or "Nothing yet."))

    async def cmd_undo(self, update: Update, ctx):
        if not self._allowed(update):
            return await self._deny(update)
        src = self._source(update)
        txs = await asyncio.to_thread(store.list_transactions)
        mine = sorted((t for t in txs if t["source"] == src), key=lambda t: t["created_at"], reverse=True)
        if not mine:
            return await self._reply(update, "Nothing to undo.")
        t = await asyncio.to_thread(store.delete_transaction, mine[0]["id"])
        await self._reply(update, f"↩️ Removed {html.escape(t['category'])} {money(t['amount'], t['currency'])}")

    async def on_undo_button(self, update: Update, ctx):
        q = update.callback_query
        if not self._allowed(update):
            return await q.answer("Not allowed", show_alert=True)
        tx_id = q.data.split(":", 1)[1]
        try:
            t = await asyncio.to_thread(store.delete_transaction, tx_id)
            await q.answer("Removed")
            await q.edit_message_text(
                f"↩️ <s>{html.escape(t['category'])} {money(t['amount'], t['currency'])}</s> removed",
                parse_mode=ParseMode.HTML)
        except KeyError:
            await q.answer("Already removed")
            await q.edit_message_reply_markup(None)

    # ---------- free text / category commands ----------
    async def on_text(self, update: Update, ctx):
        if not self._allowed(update):
            return await self._deny(update)
        text = update.effective_message.text or ""
        currencies = {r["currency"] for r in await asyncio.to_thread(store.list_rates)}
        parsed = parse_entry(text, currencies)
        if not parsed:
            hint = ("Format: <code>/category amount [currency] [note]</code>\n"
                    "Example: <code>/benzin 20</code>  ·  /help")
            if text.startswith("/") and len(text.split()) == 1:
                hint = f"Add the amount: <code>{html.escape(text.split('@')[0])} 20</code>"
            return await self._reply(update, hint)

        key, amount, cur, note = parsed
        if cur not in currencies:
            return await self._reply(update, f"Unknown currency {html.escape(cur)}. Add it in the web panel or use: "
                                             + ", ".join(sorted(currencies)))
        cat = await asyncio.to_thread(store.find_category, key)
        created = False
        if not cat:
            if not config.AUTO_CREATE_CATEGORIES:
                return await self._reply(update, f"No category “{html.escape(key)}”. See /cats")
            try:
                cat = await asyncio.to_thread(store.add_category, {"name": key, "type": "expense"})
                created = True
            except ValueError as e:
                return await self._reply(update, f"Could not create category: {html.escape(str(e))}")
        if cat["type"] == "income":
            return await self._reply(update, f"“{html.escape(cat['name'])}” is an income category. "
                                             "The bot records costs only; add income in the web panel.")

        tx = await asyncio.to_thread(store.add_transaction, {
            "date": today_local(), "type": "expense", "category": cat["name"],
            "amount": amount, "currency": cur, "note": note}, self._source(update))
        _, total, _ = await self._expenses_between(tx["date"], tx["date"])

        msg = f"✅ {cat['icon'] + ' ' if cat['icon'] else ''}<b>{html.escape(cat['name'])}</b>  {money(amount, cur)}"
        if note:
            msg += f"\n<i>{html.escape(note)}</i>"
        if created:
            msg += f"\n🆕 New category created, next time use /{cat['command']}"
        msg += f"\nToday total: {money(total)}"
        kb = InlineKeyboardMarkup([[InlineKeyboardButton("↩️ Undo", callback_data=f"undo:{tx['id']}")]])
        await self._reply(update, msg, reply_markup=kb)


bot = ExpenseBot()
