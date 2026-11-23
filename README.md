# Xərc: cost monitor with Telegram bot + Google Sheets

- **Web panel** on port **7319**: Monitoring dashboard (main page) and Edit data panel.
- **Telegram bot** for costs during the day: `/benzin 20` → category *Benzin*, 20 AZN.
- **Google Sheet** as the database, connected through a small **Apps Script** (no Google Cloud, no key files).
- **All settings in one `.env` file.** Runs with Docker or directly with Python.

```
xerc/
├── apps_script/Code.gs   paste into your Google Sheet (step 1)
├── app/                  the application (web panel, API, bot, storage)
├── run.py                starts everything: python run.py
├── start.sh / start.bat  one-click start without Docker (Linux/macOS / Windows)
├── Dockerfile, docker-compose.yml
├── requirements.txt
└── .env.example          copy to .env and fill in
```

---

## Step 1. Connect the Google Sheet (about 3 minutes, done once)

1. Create a new empty Google Sheet (sheets.google.com → Blank). Name it e.g. *Xərc*.
2. In the sheet menu: **Extensions → Apps Script**. A code editor opens.
3. Delete everything in `Code.gs` and paste the whole content of **`apps_script/Code.gs`**.
4. On the line `const SECRET = 'CHANGE-ME';` replace `CHANGE-ME` with your own long random text,
   e.g. `const SECRET = 'k8Fq2-baku-7Zx91-mL0p';`. Remember it, it goes into `.env` too.
5. Click 💾 **Save**.
6. Click **Deploy → New deployment**. Click the ⚙️ next to *Select type* → **Web app**.
   - Description: `Xərc`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**.
7. Google asks for permission: **Authorize access** → choose your account →
   if you see *“Google hasn't verified this app”* click **Advanced → Go to Xərc (unsafe)** → **Allow**.
   This is normal: it's your own script, asking to edit your own sheet.
8. Copy the **Web app URL** (looks like `https://script.google.com/macros/s/AKfy.../exec`).

“Anyone” only means the URL can be called; without your SECRET the script refuses every request.
Nothing needs to stay open: the script runs on Google's servers 24/7.

> If you change the script later: **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**.
> The URL stays the same.

## Step 2. Create the Telegram bot (2 minutes)

1. In Telegram open **@BotFather** → send `/newbot` → choose a name and a username ending with `bot`.
2. Copy the token (looks like `7012345678:AAH...`).

## Step 3. Fill in `.env`

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

Open `.env` and set at least:

```ini
ADMIN_PASSWORD=your-panel-password
SECRET_KEY=any-long-random-text
APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfy.../exec
APPS_SCRIPT_SECRET=k8Fq2-baku-7Zx91-mL0p          # exactly the same as SECRET in Code.gs
TELEGRAM_BOT_TOKEN=7012345678:AAH...
```

## Step 4. Start the app (choose A or B)

### A) Without Docker

Needs **Python 3.10 or newer** (`python3 --version`).

**Linux / macOS**
```bash
./start.sh
```
**Windows**: double-click `start.bat`.

Both create a virtual environment, install the requirements and run `python run.py`.
Manual way:
```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

**Keep it running on a Linux server (systemd)**: create `/etc/systemd/system/xerc.service`:
```ini
[Unit]
Description=Xerc cost monitor
After=network-online.target

[Service]
WorkingDirectory=/opt/xerc
ExecStart=/opt/xerc/.venv/bin/python run.py
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```
Then (after running `./start.sh` once in `/opt/xerc` so `.venv` exists):
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xerc
sudo journalctl -u xerc -f          # logs
```

### B) With Docker

```bash
docker compose up -d --build
docker compose logs -f
```
or without compose:
```bash
docker build -t xerc .
docker run -d --name xerc --restart unless-stopped --env-file .env -p 7319:7319 xerc
```

In the logs you should see:
```
Connected to Google Sheet 'Xərc' (created tabs: Transactions, Categories, Rates)
Telegram bot @your_bot started
Uvicorn running on http://0.0.0.0:7319
```

## Step 5. First use

1. Open `http://YOUR_SERVER_IP:7319` (on your own PC: `http://localhost:7319`) and sign in.
2. Send `/start` to your bot. It replies with **your Telegram ID**.
3. Put it in `.env` → `ALLOWED_TELEGRAM_IDS=123456789` and restart the app. Now only you can add costs.
4. Send `/benzin 20`. Reload the panel: the cost appears on Monitoring, and as a row in your sheet.

---

## Bot usage

| Message | Result |
|---|---|
| `/benzin 20` | Benzin, 20 AZN, today |
| `/benzin 20 usd` | 20 USD (converted to AZN in charts) |
| `/market 35.4 bread, milk` | with a note |
| `/telefon 10$` | symbols ₼ $ € £ also work |
| `Səhiyyə 15` | without slash: any category name, including Azerbaijani letters |
| `/kitab 12` | unknown category → created automatically (`AUTO_CREATE_CATEGORIES`) |
| `/today` `/week` `/month` `/last` | summaries |
| `/undo` or the **Undo** button | removes your last entry |
| `/cats` `/rates` | categories and currencies |

The bot records **costs only**; add income in the web panel. The `/` menu in Telegram shows your cost
categories and updates when you change categories in the panel.

## Web panel

**Monitoring**: period switch, “where the money went” band, totals with change vs previous period,
cash flow, category doughnut (costs or income), spending pace, day-of-week averages, categories over time,
top categories, latest entries. Click a category to see its transactions.

**Edit data**: transactions (search, filter, sort, edit/delete amount, type, category, currency, date, note,
add income or costs, CSV export), categories (name, icon, color, type, Telegram command; rename or move
existing entries), currencies (rates to AZN; starter rates are approximate).

## Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `7319` | Where the panel listens |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / – | Panel login (password required) |
| `SECRET_KEY` | random | Keeps you signed in across restarts |
| `SECURE_COOKIES` | `false` | `true` behind HTTPS |
| `DEFAULT_CURRENCY` | `AZN` | Main currency |
| `TIMEZONE` | `Asia/Baku` | What “today” means for bot entries |
| `APPS_SCRIPT_URL` | – | Web app URL ending with `/exec` |
| `APPS_SCRIPT_SECRET` | – | Same text as `SECRET` in Code.gs |
| `CACHE_TTL_SECONDS` | `60` | Memory cache; hand edits in the sheet show up after this (or press ↻ in the panel) |
| `TELEGRAM_BOT_TOKEN` | – | From @BotFather |
| `ALLOWED_TELEGRAM_IDS` | – | Who may add costs (comma-separated) |
| `AUTO_CREATE_CATEGORIES` | `true` | Create unknown categories from the bot |

Change the port: set `PORT` in `.env`; with Docker also change both numbers in `docker-compose.yml` (`"7400:7400"`).

## Troubleshooting

| Problem | Fix |
|---|---|
| Red banner *“Wrong secret”* | `APPS_SCRIPT_SECRET` in `.env` ≠ `SECRET` in Code.gs. If you changed Code.gs, deploy a **new version**. |
| *“Apps Script did not answer with data”* | URL must end with `/exec`; deployment must be *Execute as: Me*, *Who has access: Anyone*. |
| *“Set SECRET in the Apps Script code”* | You left `CHANGE-ME` in Code.gs. Change it, save, deploy a new version. |
| Fixed the problem but banner stays | Press ↻ in the panel (it reconnects) or restart the app. |
| Bot doesn't answer | Check the token; run only **one** copy of the app (two copies fight over the bot). |
| *“You are not allowed”* | Add the ID the bot shows to `ALLOWED_TELEGRAM_IDS`, restart. |
| Saving takes 1–2 seconds | Normal for Apps Script. Reading is cached. |

Health check: `curl http://localhost:7319/api/health`
