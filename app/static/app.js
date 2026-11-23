'use strict';

/* ================= helpers ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s ?? '').trim().toLocaleLowerCase();
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000) + 1;
const todayISO = () => iso(new Date());
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PALETTE = ['#E8A317', '#2F8F6B', '#B3263E', '#3A6EA5', '#6B5CA5', '#1F8A9E', '#D3543C', '#A0527A', '#C77D1E', '#6E7F86'];
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem('xerc.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('xerc.' + k, JSON.stringify(v)); } catch { /* ignore */ } } };

const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmtNum = (v, dec = 2) => (dec ? nf2 : nf0).format(v).replace(/,/g, ' ');
const money = (v, cur = S.base, dec = 2) => `${fmtNum(v, dec)} ${cur}`;
const compact = (v) => Math.abs(v) >= 1000 ? (v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1) + 'k' : fmtNum(v, 0);
const prettyDate = (s, withYear = false) => { if (!s) return ''; const d = parseISO(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ' ' + d.getFullYear() : ''}`; };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const ICON = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>',
};

/* ================= state ================= */
const S = {
  base: 'AZN', categories: [], rates: [], tx: [], rm: {}, meta: {},
  period: store.get('period', 'month'), custom: store.get('custom', { start: '', end: '' }),
  pieType: 'expense', charts: {},
  page: 'monitor', tab: 'tx',
  f: { q: '', type: '', category: '', start: '', end: '' }, sort: { key: 'date', dir: 'desc' }, pg: 1, pageSize: 25,
  loaded: false,
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('Not signed in'); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const d = data?.detail;
    throw new Error(typeof d === 'string' ? d : Array.isArray(d) ? d.map((x) => `${x.loc?.at(-1) ?? ''}: ${x.msg}`).join('; ') : `Request failed (${res.status})`);
  }
  return data;
}

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), err ? 6000 : 3200);
}

const toBase = (t) => t.amount * (S.rm[t.currency] ?? 1);
function catInfo(name) {
  const c = S.categories.find((x) => norm(x.name) === norm(name));
  if (c) return c;
  let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { name, color: PALETTE[h % PALETTE.length], icon: '', command: '', type: 'expense', missing: true };
}

/* ================= data ================= */
async function loadAll(silent = false) {
  try {
    const meta = await api('/api/meta');
    S.meta = meta; S.base = meta.base; S.categories = meta.categories; S.rates = meta.rates;
    S.rm = Object.fromEntries(S.rates.map((r) => [r.currency, r.rate]));
    renderBanner(); renderBotStatus();
    S.tx = meta.error ? [] : await api('/api/transactions');
    S.loaded = true;
    render();
  } catch (e) {
    if (!silent) toast(e.message, true);
  }
}

function renderBanner() {
  const m = S.meta;
  $('#banner').innerHTML = m.error ? `<div class="banner"><b>Data can’t be loaded.</b> ${esc(m.error)}
    <br>Check APPS_SCRIPT_URL and APPS_SCRIPT_SECRET in .env, then restart the app.</div>` : '';
}
function renderBotStatus() {
  const b = S.meta.bot || {};
  $('#bot-dot').classList.toggle('on', !!b.running);
  $('#bot-text').textContent = b.running ? `@${b.username}` : 'Bot offline';
}

/* ================= routing ================= */
function route() {
  const [page, tab] = (location.hash.slice(1) || 'monitor').split('/');
  S.page = page === 'edit' ? 'edit' : 'monitor';
  if (tab && ['tx', 'cats', 'rates'].includes(tab)) S.tab = tab;
  $$('[data-nav]').forEach((a) => { if (a.dataset.nav === S.page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#page-monitor').hidden = S.page !== 'monitor';
  $('#page-edit').hidden = S.page !== 'edit';
  render();
  window.scrollTo(0, 0);
}
function render() {
  if (!S.loaded) return;
  if (S.page === 'monitor') renderMonitor(); else renderEdit();
}

/* ================= periods ================= */
function shiftMonths(d, n) { const x = new Date(d.getFullYear(), d.getMonth() + n, 1); const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate(); x.setDate(Math.min(d.getDate(), last)); return x; }
function periodRange(p = S.period) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  let s, e = t;
  switch (p) {
    case '7d': s = addDays(t, -6); break;
    case 'month': s = new Date(t.getFullYear(), t.getMonth(), 1); break;
    case 'lastmonth': s = new Date(t.getFullYear(), t.getMonth() - 1, 1); e = new Date(t.getFullYear(), t.getMonth(), 0); break;
    case '90d': s = addDays(t, -89); break;
    case 'year': s = new Date(t.getFullYear(), 0, 1); break;
    case 'all': {
      const ds = S.tx.map((x) => x.date).filter(Boolean).sort();
      s = ds.length ? parseISO(ds[0]) : t;
      if (ds.length && ds.at(-1) > iso(t)) e = parseISO(ds.at(-1));
      break;
    }
    default:
      s = S.custom.start ? parseISO(S.custom.start) : new Date(t.getFullYear(), t.getMonth(), 1);
      e = S.custom.end ? parseISO(S.custom.end) : t;
  }
  if (s > e) [s, e] = [e, s];
  return { start: iso(s), end: iso(e) };
}
function prevRange(r, p = S.period) {
  if (p === 'month' || p === 'lastmonth') {
    const s = parseISO(r.start), e = parseISO(r.end);
    const ps = new Date(s.getFullYear(), s.getMonth() - 1, 1);
    const pe = p === 'lastmonth' ? new Date(s.getFullYear(), s.getMonth(), 0) : shiftMonths(e, -1);
    return { start: iso(ps), end: iso(pe) };
  }
  if (p === 'year') {
    const s = parseISO(r.start), e = parseISO(r.end);
    return { start: iso(new Date(s.getFullYear() - 1, 0, 1)), end: iso(new Date(e.getFullYear() - 1, e.getMonth(), e.getDate())) };
  }
  const n = daysBetween(r.start, r.end), e = addDays(parseISO(r.start), -1);
  return { start: iso(addDays(e, -(n - 1))), end: iso(e) };
}
const PERIOD_WORD = { '7d': 'previous 7 days', month: 'same days last month', lastmonth: 'the month before', '90d': 'previous 90 days', year: 'same period last year', all: 'previous period', custom: 'previous period' };

function bucketing(r) {
  const n = daysBetween(r.start, r.end);
  const g = n <= 35 ? 'day' : n <= 150 ? 'week' : 'month';
  const keys = [], labels = [];
  const weekStart = (d) => addDays(d, -((d.getDay() + 6) % 7));
  if (g === 'day') {
    for (let d = parseISO(r.start); iso(d) <= r.end; d = addDays(d, 1)) { keys.push(iso(d)); labels.push(n <= 7 ? `${WEEKDAYS[(d.getDay() + 6) % 7]} ${d.getDate()}` : prettyDate(iso(d))); }
  } else if (g === 'week') {
    for (let d = weekStart(parseISO(r.start)); iso(d) <= r.end; d = addDays(d, 7)) { keys.push(iso(d)); labels.push(prettyDate(iso(d))); }
  } else {
    const s = parseISO(r.start), e = parseISO(r.end);
    for (let d = new Date(s.getFullYear(), s.getMonth(), 1); d <= e; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      keys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); labels.push(`${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`);
    }
  }
  const keyOf = g === 'day' ? (s) => s : g === 'week' ? (s) => iso(weekStart(parseISO(s))) : (s) => s.slice(0, 7);
  return { g, keys, labels, keyOf };
}

/* ================= charts ================= */
function chartTheme() {
  Chart.defaults.font.family = css('--font') || 'system-ui';
  Chart.defaults.font.size = 12.5;
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--line');
  Chart.defaults.plugins.tooltip.backgroundColor = css('--rail');
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
  Chart.defaults.plugins.tooltip.titleFont = { weight: '700' };
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.legend.labels.useBorderRadius = true;
  Chart.defaults.plugins.legend.labels.borderRadius = 3;
  Chart.defaults.animation.duration = 450;
}
function mkChart(id, cfg) {
  S.charts[id]?.destroy();
  const el = document.getElementById(id);
  if (el) S.charts[id] = new Chart(el, cfg);
}
const moneyTip = { callbacks: { label: (c) => ` ${c.dataset.label ? c.dataset.label + ': ' : ''}${money(c.parsed.y ?? c.parsed)}` } };
const yMoney = { beginAtZero: true, ticks: { callback: (v) => compact(v) }, grid: { color: () => css('--line') } };

/* ================= monitoring ================= */
function renderMonitor() {
  $$('#period button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === S.period)));
  $('#custom-range').hidden = S.period !== 'custom';
  const r = periodRange(), pr = prevRange(r);
  if (S.period === 'custom') { $('#c-start').value = r.start; $('#c-end').value = r.end; }
  $('#range-label').textContent = r.start === r.end ? prettyDate(r.start, true) : `${prettyDate(r.start)} – ${prettyDate(r.end, true)}`;

  const inR = S.tx.filter((t) => t.date >= r.start && t.date <= r.end);
  const inP = S.tx.filter((t) => t.date >= pr.start && t.date <= pr.end);
  const body = $('#monitor-body');

  if (!S.tx.length) {
    Object.values(S.charts).forEach((c) => c.destroy()); S.charts = {};
    const cmd = S.categories.find((c) => c.type !== 'income')?.command || 'benzin';
    body.innerHTML = `<div class="panel empty"><h3>No transactions yet</h3>
      <p>Send <code>/${esc(cmd)} 20</code> to ${S.meta.bot?.username ? '@' + esc(S.meta.bot.username) : 'your bot'} to record a cost,<br>or add income in <a href="#edit">Edit data</a>.</p></div>`;
    return;
  }

  const sum = (arr, type) => arr.reduce((a, t) => a + (t.type === type ? toBase(t) : 0), 0);
  const exp = sum(inR, 'expense'), inc = sum(inR, 'income'), pexp = sum(inP, 'expense'), pinc = sum(inP, 'income');
  const net = inc - exp;
  const effEnd = r.end > todayISO() ? todayISO() : r.end;
  const nDays = effEnd < r.start ? 1 : daysBetween(r.start, effEnd);
  const expItems = inR.filter((t) => t.type === 'expense');
  const biggest = expItems.reduce((m, t) => (!m || toBase(t) > toBase(m) ? t : m), null);

  const byCat = (arr, type) => {
    const m = new Map();
    for (const t of arr) if (t.type === type) m.set(t.category, (m.get(t.category) || 0) + toBase(t));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const expCats = byCat(inR, 'expense');
  const prevCats = new Map(byCat(inP, 'expense'));

  body.innerHTML = `
    <div class="flow">
      <div class="flow-head"><span>Where the money went</span><strong class="num">${money(exp)}</strong></div>
      <div class="flow-band" id="flow-band"></div>
    </div>
    <div class="kpis">
      ${kpi('Spent', exp, 'var(--expense)', delta(exp, pexp, true), `${expItems.length} entries`)}
      ${kpi('Earned', inc, 'var(--income)', delta(inc, pinc, false), `${inR.filter((t) => t.type === 'income').length} entries`)}
      ${kpi('Net balance', net, net >= 0 ? 'var(--income)' : 'var(--expense)', '', inc > 0 ? `${Math.round((net / inc) * 100)}% of income saved` : 'No income in period')}
      ${kpi('Average per day', exp / nDays, 'var(--saffron)', '', biggest ? `Largest: ${esc(biggest.category)} ${money(toBase(biggest), S.base, 0)}` : `${nDays} days`)}
    </div>
    <div class="grid">
      <div class="panel span-8">
        <div class="panel-head"><h2 class="panel-title">Cash flow</h2><span class="panel-note" id="cf-note"></span></div>
        <div class="chart-box tall"><canvas id="ch-cashflow" aria-label="Income and costs over time"></canvas></div>
      </div>
      <div class="panel span-4">
        <div class="panel-head">
          <h2 class="panel-title">By category</h2>
          <div class="seg small" role="group" aria-label="Show">
            <button type="button" data-pie="expense" aria-pressed="${S.pieType === 'expense'}">Costs</button>
            <button type="button" data-pie="income" aria-pressed="${S.pieType === 'income'}">Income</button>
          </div>
        </div>
        <div class="donut-wrap">
          <div class="donut-box"><canvas id="ch-donut" aria-label="Share by category"></canvas><div class="donut-center" id="donut-center"></div></div>
          <ul class="legend" id="donut-legend"></ul>
        </div>
      </div>
      <div class="panel span-6">
        <div class="panel-head"><h2 class="panel-title">Spending pace</h2><span class="panel-note">Running total vs ${PERIOD_WORD[S.period]}</span></div>
        <div class="chart-box"><canvas id="ch-pace" aria-label="Cumulative spending"></canvas></div>
      </div>
      <div class="panel span-6">
        <div class="panel-head"><h2 class="panel-title">Day of week</h2><span class="panel-note">Average cost per day</span></div>
        <div class="chart-box"><canvas id="ch-weekday" aria-label="Average spending per weekday"></canvas></div>
      </div>
      <div class="panel span-12">
        <div class="panel-head"><h2 class="panel-title">Categories over time</h2><span class="panel-note">Top 6 categories, rest grouped</span></div>
        <div class="chart-box"><canvas id="ch-stack" aria-label="Category spending over time"></canvas></div>
      </div>
      <div class="panel span-8">
        <div class="panel-head"><h2 class="panel-title">Top categories</h2><span class="panel-note">Change vs ${PERIOD_WORD[S.period]}</span></div>
        <div class="table-wrap" id="top-table"></div>
      </div>
      <div class="panel span-4">
        <div class="panel-head"><h2 class="panel-title">Latest entries</h2><a class="panel-note" href="#edit">See all</a></div>
        <ul class="recent" id="recent"></ul>
      </div>
    </div>`;

  chartTheme();
  renderFlowBand(expCats, exp);
  renderCashflow(r, inR);
  renderDonut(inR, byCat);
  renderPace(r, pr, inR, inP);
  renderWeekday(r, expItems, effEnd);
  renderStack(r, expItems, expCats);
  renderTopTable(expCats, prevCats, exp);
  renderRecent(inR);
}

function kpi(label, value, color, deltaHtml, meta) {
  return `<div class="kpi"><div class="kpi-label"><span class="swatch" style="background:${color}"></span>${label}</div>
    <div class="kpi-value num">${fmtNum(value)}<small>${S.base}</small></div>
    <div class="kpi-meta">${deltaHtml}<span>${meta}</span></div></div>`;
}
function delta(cur, prev, upIsBad) {
  if (!prev && !cur) return '';
  if (!prev) return '<span class="delta flat">new</span>';
  const p = ((cur - prev) / prev) * 100;
  if (Math.abs(p) < 0.5) return '<span class="delta flat">±0%</span>';
  const good = upIsBad ? p < 0 : p > 0;
  return `<span class="delta ${good ? 'good' : 'bad'}" title="vs ${PERIOD_WORD[S.period]}">${p > 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(0)}%</span>`;
}

function renderFlowBand(cats, total) {
  const band = $('#flow-band');
  if (!total) { band.innerHTML = '<div class="flow-empty">No costs in this period</div>'; return; }
  band.innerHTML = cats.map(([name, v]) => {
    const c = catInfo(name), pct = (v / total) * 100;
    const label = pct >= 7 ? `<b>${esc(c.icon ? c.icon + ' ' : '')}${esc(name)}</b><i>${pct.toFixed(0)}%</i>` : '';
    return `<button type="button" class="flow-seg" data-cat="${esc(name)}" style="flex:${v} 1 0;background:${c.color}"
      title="${esc(name)}: ${money(v)} (${pct.toFixed(1)}%)" aria-label="${esc(name)} ${pct.toFixed(0)} percent">${label}</button>`;
  }).join('');
}

function renderCashflow(r, inR) {
  const b = bucketing(r);
  const idx = new Map(b.keys.map((k, i) => [k, i]));
  const e = new Array(b.keys.length).fill(0), inc = new Array(b.keys.length).fill(0);
  for (const t of inR) { const i = idx.get(b.keyOf(t.date)); if (i === undefined) continue; (t.type === 'expense' ? e : inc)[i] += toBase(t); }
  $('#cf-note').textContent = { day: 'Daily', week: 'Weekly', month: 'Monthly' }[b.g];
  mkChart('ch-cashflow', {
    data: {
      labels: b.labels,
      datasets: [
        { type: 'bar', label: 'Income', data: inc, backgroundColor: css('--income'), borderRadius: 5, maxBarThickness: 26, order: 2 },
        { type: 'bar', label: 'Costs', data: e, backgroundColor: css('--expense'), borderRadius: 5, maxBarThickness: 26, order: 2 },
        { type: 'line', label: 'Net', data: inc.map((v, i) => v - e[i]), borderColor: css('--ink'), backgroundColor: css('--ink'),
          borderWidth: 2, pointRadius: b.keys.length > 40 ? 0 : 2.5, tension: .3, order: 1 },
      ],
    },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'end' }, tooltip: moneyTip },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } }, y: { ...yMoney, beginAtZero: true } } },
  });
}

function renderDonut(inR, byCat) {
  const rows = byCat(inR, S.pieType);
  const total = rows.reduce((a, [, v]) => a + v, 0);
  $('#donut-center').innerHTML = `<div><b class="num">${money(total, S.base, 0)}</b><span>${S.pieType === 'expense' ? 'total costs' : 'total income'}</span></div>`;
  $('#donut-legend').innerHTML = rows.length ? rows.map(([n, v]) => {
    const c = catInfo(n);
    return `<li><button type="button" data-cat="${esc(n)}"><span class="sw" style="background:${c.color}"></span>
      <span class="nm">${esc(c.icon ? c.icon + ' ' : '')}${esc(n)}</span><span class="num">${money(v, '', 0).trim()}</span>
      <span class="pc">${((v / total) * 100).toFixed(0)}%</span></button></li>`;
  }).join('') : `<li class="panel-note" style="padding:6px">No ${S.pieType === 'expense' ? 'costs' : 'income'} in this period</li>`;
  mkChart('ch-donut', {
    type: 'doughnut',
    data: { labels: rows.map(([n]) => n), datasets: [{ data: rows.length ? rows.map(([, v]) => v) : [1],
      backgroundColor: rows.length ? rows.map(([n]) => catInfo(n).color) : [css('--surface-2')], borderColor: css('--surface'), borderWidth: 2, hoverOffset: 6 }] },
    options: { maintainAspectRatio: false, cutout: '70%', plugins: { legend: { display: false },
      tooltip: { enabled: !!rows.length, callbacks: { label: (c) => ` ${money(c.parsed)} (${((c.parsed / total) * 100).toFixed(1)}%)` } } },
      onClick: (_, els) => { if (els.length) openCategory(rows[els[0].index][0]); } },
  });
}

function renderPace(r, pr, inR, inP) {
  const n = daysBetween(r.start, r.end), pn = daysBetween(pr.start, pr.end);
  const daily = (arr, start, len) => {
    const a = new Array(len).fill(0);
    for (const t of arr) if (t.type === 'expense') { const i = daysBetween(start, t.date) - 1; if (i >= 0 && i < len) a[i] += toBase(t); }
    let s = 0; return a.map((v) => (s += v));
  };
  const cur = daily(inR, r.start, n), prev = daily(inP, pr.start, pn);
  const todayIdx = daysBetween(r.start, todayISO()) - 1;
  const curShown = cur.map((v, i) => (i > todayIdx ? null : v));
  const len = Math.max(n, 1);
  const labels = Array.from({ length: len }, (_, i) => prettyDate(iso(addDays(parseISO(r.start), i))));
  mkChart('ch-pace', {
    type: 'line',
    data: { labels, datasets: [
      { label: 'This period', data: curShown, borderColor: css('--expense'), backgroundColor: css('--expense-soft'), fill: true, borderWidth: 2.5, pointRadius: 0, tension: .25 },
      { label: 'Previous', data: prev.slice(0, len), borderColor: css('--faint'), borderDash: [5, 4], borderWidth: 1.8, pointRadius: 0, tension: .25, fill: false },
    ] },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'end' }, tooltip: moneyTip },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 18 } }, y: yMoney } },
  });
}

function renderWeekday(r, expItems, effEnd) {
  const tot = new Array(7).fill(0), cnt = new Array(7).fill(0);
  if (effEnd >= r.start) for (let d = parseISO(r.start); iso(d) <= effEnd; d = addDays(d, 1)) cnt[(d.getDay() + 6) % 7]++;
  for (const t of expItems) tot[(parseISO(t.date).getDay() + 6) % 7] += toBase(t);
  const avg = tot.map((v, i) => (cnt[i] ? v / cnt[i] : 0));
  const max = Math.max(...avg);
  mkChart('ch-weekday', {
    type: 'bar',
    data: { labels: WEEKDAYS, datasets: [{ label: 'Average', data: avg, borderRadius: 6, maxBarThickness: 38,
      backgroundColor: avg.map((v) => (v === max && max > 0 ? css('--saffron') : css('--line-strong'))) }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: moneyTip },
      scales: { x: { grid: { display: false } }, y: yMoney } },
  });
}

function renderStack(r, expItems, expCats) {
  const b = bucketing(r);
  const idx = new Map(b.keys.map((k, i) => [k, i]));
  const top = expCats.slice(0, 6).map(([n]) => n);
  const series = new Map(top.map((n) => [n, new Array(b.keys.length).fill(0)]));
  const other = new Array(b.keys.length).fill(0);
  for (const t of expItems) {
    const i = idx.get(b.keyOf(t.date)); if (i === undefined) continue;
    (series.get(t.category) || other)[i] += toBase(t);
  }
  const ds = top.map((n) => ({ label: n, data: series.get(n), backgroundColor: catInfo(n).color, borderRadius: 3, maxBarThickness: 34 }));
  if (other.some((v) => v)) ds.push({ label: 'Other', data: other, backgroundColor: css('--faint'), borderRadius: 3, maxBarThickness: 34 });
  mkChart('ch-stack', {
    type: 'bar', data: { labels: b.labels, datasets: ds },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'end' }, tooltip: { ...moneyTip, filter: (i) => i.parsed.y > 0 } },
      scales: { x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } }, y: { ...yMoney, stacked: true } } },
  });
}

function renderTopTable(expCats, prevCats, total) {
  const box = $('#top-table');
  if (!expCats.length) { box.innerHTML = '<p class="panel-note">No costs in this period.</p>'; return; }
  const counts = new Map();
  const r = periodRange();
  for (const t of S.tx) if (t.type === 'expense' && t.date >= r.start && t.date <= r.end) counts.set(t.category, (counts.get(t.category) || 0) + 1);
  box.innerHTML = `<table><thead><tr><th>Category</th><th>Share</th><th class="r">Amount</th><th class="r">Entries</th><th class="r">Avg entry</th><th class="r">Change</th></tr></thead><tbody>
    ${expCats.slice(0, 10).map(([n, v]) => {
      const c = catInfo(n), pct = (v / total) * 100, cnt = counts.get(n) || 1;
      return `<tr><td><button type="button" class="th-sort cat-chip" data-cat="${esc(n)}"><span class="sw" style="background:${c.color}"></span>${esc(c.icon ? c.icon + ' ' : '')}${esc(n)}</button></td>
        <td><div class="meter" title="${pct.toFixed(1)}%"><i style="width:${pct}%;background:${c.color}"></i></div></td>
        <td class="r num"><b>${money(v)}</b></td><td class="r num">${cnt}</td><td class="r num">${money(v / cnt, S.base, 0)}</td>
        <td class="r">${delta(v, prevCats.get(n) || 0, true)}</td></tr>`;
    }).join('')}</tbody></table>`;
}

function renderRecent(inR) {
  const items = [...inR].sort((a, b) => (b.date + b.created_at).localeCompare(a.date + a.created_at)).slice(0, 8);
  $('#recent').innerHTML = items.length ? items.map((t) => {
    const c = catInfo(t.category), isExp = t.type === 'expense';
    return `<li><span class="ic" style="background:${c.color}22;color:${c.color}">${esc(c.icon || c.name.slice(0, 1).toUpperCase())}</span>
      <div style="min-width:0"><div class="t">${esc(t.category)}</div><div class="s">${prettyDate(t.date)}${t.note ? ', ' + esc(t.note) : ''}</div></div>
      <span class="num ${isExp ? 'amt-exp' : 'amt-inc'}">${isExp ? '−' : '+'}${money(t.amount, t.currency)}</span></li>`;
  }).join('') : '<li class="panel-note">Nothing in this period.</li>';
}

function openCategory(name) {
  S.f = { q: '', type: '', category: name, ...periodRange() };
  S.tab = 'tx'; S.pg = 1;
  location.hash = 'edit/tx';
}

/* ================= edit data ================= */
function renderEdit() {
  $$('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  $('#count-tx').textContent = S.tx.length;
  $('#count-cats').textContent = S.categories.length;
  $('#count-rates').textContent = S.rates.length;
  if (S.tab === 'tx') renderTxTab(); else if (S.tab === 'cats') renderCatsTab(); else renderRatesTab();
}

function filteredTx() {
  const f = S.f, q = norm(f.q);
  let list = S.tx.filter((t) => (!f.type || t.type === f.type) && (!f.category || norm(t.category) === norm(f.category))
    && (!f.start || t.date >= f.start) && (!f.end || t.date <= f.end)
    && (!q || norm(`${t.category} ${t.note} ${t.amount} ${t.currency} ${t.source}`).includes(q)));
  const dir = S.sort.dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    if (S.sort.key === 'amount') return (toBase(a) - toBase(b)) * dir;
    if (S.sort.key === 'category') return a.category.localeCompare(b.category) * dir;
    return (a.date + a.created_at).localeCompare(b.date + b.created_at) * dir;
  });
  return list;
}

function categoryOptions(selected, type) {
  const names = new Set(S.categories.filter((c) => !type || c.type === type || c.type === 'both').map((c) => c.name));
  if (!type) S.tx.forEach((t) => names.add(t.category));
  if (selected) names.add(selected);
  return [...names].sort((a, b) => a.localeCompare(b)).map((n) => `<option value="${esc(n)}" ${norm(n) === norm(selected) ? 'selected' : ''}>${esc(catInfo(n).icon ? catInfo(n).icon + ' ' : '')}${esc(n)}</option>`).join('');
}

function renderTxTab() {
  const box = $('#edit-body');
  const focused = document.activeElement?.id;
  if (!$('#tx-toolbar', box)) {
    box.innerHTML = `
      <div class="toolbar" id="tx-toolbar">
        <label class="field"><span>Search</span><input type="search" id="f-q" placeholder="Category, note, amount"></label>
        <label class="field"><span>Type</span><select id="f-type"><option value="">All types</option><option value="expense">Costs</option><option value="income">Income</option></select></label>
        <label class="field"><span>Category</span><select id="f-category"></select></label>
        <label class="field"><span>From</span><input type="date" id="f-start"></label>
        <label class="field"><span>To</span><input type="date" id="f-end"></label>
        <button class="btn btn-ghost" type="button" id="f-clear">Clear</button>
      </div>
      <div class="summary-line" id="tx-summary"></div>
      <div class="panel" style="padding:6px 10px"><div class="table-wrap" id="tx-table"></div></div>
      <div class="pager" id="tx-pager"></div>`;
    $('#f-q').addEventListener('input', (e) => { S.f.q = e.target.value; S.pg = 1; renderTxTab(); });
    ['type', 'category', 'start', 'end'].forEach((k) => $('#f-' + k).addEventListener('change', (e) => { S.f[k] = e.target.value; S.pg = 1; renderTxTab(); }));
    $('#f-clear').addEventListener('click', () => { S.f = { q: '', type: '', category: '', start: '', end: '' }; S.pg = 1; renderTxTab(); });
  }
  $('#f-q').value = S.f.q; $('#f-type').value = S.f.type; $('#f-start').value = S.f.start; $('#f-end').value = S.f.end;
  $('#f-category').innerHTML = `<option value="">All categories</option>${categoryOptions(S.f.category)}`;
  $('#f-category').value = S.f.category;
  if (focused) document.getElementById(focused)?.focus();

  const list = filteredTx();
  const e = list.reduce((a, t) => a + (t.type === 'expense' ? toBase(t) : 0), 0);
  const i = list.reduce((a, t) => a + (t.type === 'income' ? toBase(t) : 0), 0);
  $('#tx-summary').innerHTML = `<span><b>${list.length}</b> records</span><span>Costs <b class="amt-exp num">${money(e)}</b></span>
    <span>Income <b class="amt-inc num">${money(i)}</b></span><span class="grow"></span>
    <button class="btn btn-ghost" type="button" id="export-csv">${ICON.dl}Export CSV</button>`;
  $('#export-csv').addEventListener('click', () => exportCSV(list));

  const pages = Math.max(1, Math.ceil(list.length / S.pageSize));
  S.pg = Math.min(S.pg, pages);
  const rows = list.slice((S.pg - 1) * S.pageSize, S.pg * S.pageSize);
  const arrow = (k) => (S.sort.key === k ? (S.sort.dir === 'asc' ? '▲' : '▼') : '↕');
  $('#tx-table').innerHTML = rows.length ? `<table class="tx-table"><thead><tr>
      <th><button class="th-sort" data-sort="date">Date <span class="ar">${arrow('date')}</span></button></th>
      <th>Type</th>
      <th><button class="th-sort" data-sort="category">Category <span class="ar">${arrow('category')}</span></button></th>
      <th class="r"><button class="th-sort" data-sort="amount">Amount <span class="ar">${arrow('amount')}</span></button></th>
      <th class="hide-sm">Note</th><th class="hide-sm">Added via</th><th></th></tr></thead><tbody>
    ${rows.map((t) => {
      const c = catInfo(t.category);
      const conv = t.currency !== S.base ? `<div class="src">≈ ${money(toBase(t))}</div>` : '';
      return `<tr>
        <td class="num">${prettyDate(t.date, true)}</td>
        <td><span class="badge ${t.type}">${t.type === 'expense' ? 'Cost' : 'Income'}</span></td>
        <td><span class="cat-chip"><span class="sw" style="background:${c.color}"></span>${esc(c.icon ? c.icon + ' ' : '')}${esc(t.category)}</span></td>
        <td class="amount num ${t.type === 'expense' ? 'amt-exp' : 'amt-inc'}">${money(t.amount, t.currency)}${conv}</td>
        <td class="note hide-sm" title="${esc(t.note)}">${esc(t.note) || '<span class="src">—</span>'}</td>
        <td class="hide-sm"><span class="src">${esc(t.source.replace('telegram:', 'Telegram @'))}</span></td>
        <td class="actions"><button class="icon-btn" data-edit="${esc(t.id)}" aria-label="Edit">${ICON.edit}</button><button class="icon-btn danger" data-del="${esc(t.id)}" aria-label="Delete">${ICON.trash}</button></td>
      </tr>`;
    }).join('')}</tbody></table>`
    : `<div class="empty"><h3>No matching transactions</h3><p>Change the filters or add a new entry.</p></div>`;

  $('#tx-pager').innerHTML = list.length > S.pageSize ? `<span>Page ${S.pg} of ${pages}</span>
    <div class="btns"><button class="btn" data-pg="-1" ${S.pg <= 1 ? 'disabled' : ''}>Previous</button><button class="btn" data-pg="1" ${S.pg >= pages ? 'disabled' : ''}>Next</button></div>` : '';
}

function exportCSV(list) {
  const head = ['date', 'type', 'category', 'amount', 'currency', `amount_${S.base}`, 'note', 'source'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.join(','), ...list.map((t) => [t.date, t.type, t.category, t.amount, t.currency, toBase(t).toFixed(2), t.note, t.source].map(q).join(','))];
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `xerc-${todayISO()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- modal ---------- */
function openModal({ title, body, foot, onMount }) {
  const root = $('#modal-root');
  const prevFocus = document.activeElement;
  root.innerHTML = `<div class="overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
    <div class="modal-head"><h2 id="m-title">${title}</h2><button class="icon-btn" data-close aria-label="Close">${ICON.x}</button></div>
    <form id="m-form" novalidate><div class="modal-body">${body}<p class="form-error" id="m-error" hidden></p></div>
    <div class="modal-foot">${foot}</div></form></div></div>`;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('.overlay', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('overlay')) close(); });
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); close(); }));
  const form = $('#m-form', root);
  const fail = (msg) => { const el = $('#m-error', root); el.textContent = msg; el.hidden = !msg; };
  onMount?.({ root, form, close, fail });
  setTimeout(() => $('[autofocus]', root)?.focus() || $('input,select,textarea', root)?.focus(), 30);
  return close;
}
function busy(form, on) { $$('button[type=submit]', form).forEach((b) => { b.disabled = on; }); }

function confirmDialog({ title, message, confirm = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    let done = false;
    const close = openModal({
      title: esc(title), body: `<p style="margin:0">${message}</p>`,
      foot: `<button class="btn" type="button" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="submit" autofocus>${esc(confirm)}</button>`,
      onMount: ({ form, root }) => {
        form.addEventListener('submit', (e) => { e.preventDefault(); done = true; close(); resolve(true); });
        new MutationObserver((_, obs) => { if (!root.firstChild) { obs.disconnect(); if (!done) resolve(false); } }).observe(root, { childList: true });
      },
    });
  });
}

/* ---------- transaction form ---------- */
function txModal(tx = null, defType = 'expense') {
  const t = tx ? { ...tx } : { type: defType, date: todayISO(), category: '', amount: '', currency: S.base, note: '' };
  const curOpts = (sel) => { const set = new Set(S.rates.map((r) => r.currency)); set.add(sel); return [...set].map((c) => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join(''); };
  openModal({
    title: tx ? 'Edit transaction' : (defType === 'income' ? 'Add income' : 'Add cost'),
    body: `
      <div class="type-toggle" role="radiogroup" aria-label="Type">
        <label class="t-expense"><input type="radio" name="type" value="expense" ${t.type === 'expense' ? 'checked' : ''}>Cost</label>
        <label class="t-income"><input type="radio" name="type" value="income" ${t.type === 'income' ? 'checked' : ''}>Income</label>
      </div>
      <div class="row-amt">
        <label class="field"><span>Amount</span><input class="amount-input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${t.amount}" autofocus required></label>
        <label class="field"><span>Currency</span><select name="currency">${curOpts(t.currency)}</select></label>
      </div>
      <label class="field"><span>Category</span><select name="category" id="m-cat"></select></label>
      <label class="field"><span>Date</span><input type="date" name="date" value="${t.date}" required></label>
      <label class="field"><span>Note <span class="hint">optional</span></span><textarea name="note" rows="2" maxlength="500">${esc(t.note)}</textarea></label>`,
    foot: `${tx ? `<button class="btn btn-ghost" type="button" id="m-del" style="margin-right:auto;color:var(--expense)">Delete</button>` : ''}
      <button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${tx ? 'Save changes' : 'Add entry'}</button>`,
    onMount: ({ form, close, fail }) => {
      const fits = (n, type) => { const c = catInfo(n); return c.missing || c.type === type || c.type === 'both'; };
      const fillCats = () => {
        const type = $('input[name=type]:checked', form).value, sel = $('#m-cat');
        let keep = sel.value && sel.value !== '__new' ? sel.value : t.category;
        if (keep && !fits(keep, type)) keep = '';
        sel.innerHTML = `<option value="" disabled>Choose a category</option>${categoryOptions(keep, type)}<option value="__new">+ New category…</option>`;
        sel.value = keep || '';
      };
      fillCats();
      $$('input[name=type]', form).forEach((r) => r.addEventListener('change', fillCats));
      $('#m-cat').addEventListener('change', async (e) => {
        if (e.target.value !== '__new') return;
        const name = prompt('New category name');
        if (!name?.trim()) { fillCats(); return; }
        try {
          const c = await api('/api/categories', { method: 'POST', body: { name: name.trim(), type: $('input[name=type]:checked', form).value } });
          S.categories.push(c); t.category = c.name; e.target.value = ''; fillCats(); $('#m-cat').value = c.name;
          toast(`Category “${c.name}” created`);
        } catch (err) { fail(err.message); fillCats(); }
      });
      $('#m-del')?.addEventListener('click', async () => { close(); await deleteTx(tx); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); fail('');
        const amount = parseFloat(String(form.elements.amount.value).replace(/\s/g, '').replace(',', '.'));
        if (!(amount > 0)) return fail('Enter an amount greater than 0');
        if (!form.elements.category.value || form.elements.category.value === '__new') return fail('Choose a category');
        const body = { type: $('input[name=type]:checked', form).value, amount, currency: form.elements.currency.value, category: form.elements.category.value, date: form.elements.date.value, note: form.elements.note.value.trim() };
        busy(form, true);
        try {
          await api(tx ? `/api/transactions/${encodeURIComponent(tx.id)}` : '/api/transactions', { method: tx ? 'PUT' : 'POST', body });
          close(); toast(tx ? 'Changes saved' : 'Entry added'); await loadAll();
        } catch (err) { fail(err.message); busy(form, false); }
      });
    },
  });
}

async function deleteTx(t) {
  const ok = await confirmDialog({ title: 'Delete transaction?', message: `<b>${esc(t.category)}</b>, ${money(t.amount, t.currency)} on ${prettyDate(t.date, true)} will be removed from the sheet.` });
  if (!ok) return;
  try { await api(`/api/transactions/${encodeURIComponent(t.id)}`, { method: 'DELETE' }); toast('Transaction deleted'); await loadAll(); }
  catch (e) { toast(e.message, true); }
}

/* ---------- categories ---------- */
function catStats() {
  const m = new Map();
  for (const t of S.tx) { const k = norm(t.category); const s = m.get(k) || { n: 0, sum: 0 }; s.n++; s.sum += toBase(t); m.set(k, s); }
  return m;
}
function renderCatsTab() {
  const stats = catStats();
  const group = (title, filter, type) => {
    const list = S.categories.filter(filter);
    return `<div class="panel"><div class="panel-head"><h2 class="panel-title">${title}</h2>
      <button class="btn" type="button" data-newcat="${type}">${ICON.plus}New category</button></div>
      ${list.length ? list.map((c) => {
        const s = stats.get(norm(c.name)) || { n: 0, sum: 0 };
        return `<div class="cat-row"><span class="cat-icon" style="background:${c.color}22;color:${c.color}">${esc(c.icon || c.name[0].toUpperCase())}</span>
          <div style="min-width:0"><div class="cat-name">${esc(c.name)}</div>
            <div class="cat-sub">${c.type !== 'income' ? `<code>/${esc(c.command)}</code>` : '<span>Web panel only</span>'}${c.type === 'both' ? '<span class="badge both">Cost and income</span>' : ''}</div></div>
          <div class="cat-stats"><b class="num">${money(s.sum, S.base, 0)}</b>${s.n} entries</div>
          <div class="actions"><button class="icon-btn" data-editcat="${esc(c.name)}" aria-label="Edit ${esc(c.name)}">${ICON.edit}</button><button class="icon-btn danger" data-delcat="${esc(c.name)}" aria-label="Delete ${esc(c.name)}">${ICON.trash}</button></div></div>`;
      }).join('') : '<p class="panel-note">No categories yet.</p>'}</div>`;
  };
  const orphans = [...new Set(S.tx.map((t) => t.category))].filter((n) => !S.categories.some((c) => norm(c.name) === norm(n)));
  $('#edit-body').innerHTML = `
    ${orphans.length ? `<div class="banner" style="border-color:var(--saffron);background:transparent">Some transactions use categories that are not in the list: ${orphans.map((n) => `<b style="color:var(--ink)">${esc(n)}</b>`).join(', ')}. <button class="btn" type="button" id="adopt">Add them as categories</button></div>` : ''}
    <div class="cat-groups">${group('Cost categories', (c) => c.type !== 'income', 'expense')}${group('Income categories', (c) => c.type === 'income', 'income')}</div>`;
  $('#adopt')?.addEventListener('click', async () => {
    for (const n of orphans) { try { await api('/api/categories', { method: 'POST', body: { name: n, type: S.tx.find((t) => t.category === n)?.type || 'expense' } }); } catch (e) { toast(`${n}: ${e.message}`, true); } }
    toast('Categories added'); await loadAll();
  });
}

const slugify = (s) => String(s).replace(/[əƏ]/g, 'e').replace(/[şŞ]/g, 's').replace(/[çÇ]/g, 'c').replace(/[ğĞ]/g, 'g').replace(/[ıİ]/g, 'i').replace(/[öÖ]/g, 'o').replace(/[üÜ]/g, 'u')
  .toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32);

function catModal(cat = null, defType = 'expense') {
  const c = cat ? { ...cat } : { name: '', command: '', type: defType, color: PALETTE[S.categories.length % PALETTE.length], icon: '' };
  const used = cat ? (catStats().get(norm(cat.name))?.n || 0) : 0;
  openModal({
    title: cat ? 'Edit category' : 'New category',
    body: `
      <div class="row-2" style="grid-template-columns:90px 1fr">
        <label class="field"><span>Icon</span><input name="icon" value="${esc(c.icon)}" maxlength="8" placeholder="⛽" style="text-align:center;font-size:20px"></label>
        <label class="field"><span>Name</span><input name="name" value="${esc(c.name)}" maxlength="40" required autofocus></label>
      </div>
      <label class="field"><span>Used for</span><select name="type">
        <option value="expense" ${c.type === 'expense' ? 'selected' : ''}>Costs</option>
        <option value="income" ${c.type === 'income' ? 'selected' : ''}>Income</option>
        <option value="both" ${c.type === 'both' ? 'selected' : ''}>Costs and income</option></select></label>
      <label class="field" id="cmd-field"><span>Telegram command <span class="hint">letters a–z, digits, _</span></span>
        <input name="command" value="${esc(c.command)}" maxlength="32" placeholder="${esc(slugify(c.name) || 'benzin')}" autocomplete="off">
        <span class="hint" id="cmd-preview"></span></label>
      <div class="field"><span>Color</span><div class="swatches">${PALETTE.map((p) => `<button type="button" data-sw="${p}" style="background:${p}" aria-label="Color ${p}" aria-pressed="${p.toLowerCase() === c.color.toLowerCase()}"></button>`).join('')}
        <input type="color" name="color" value="${esc(c.color)}" aria-label="Custom color"></div></div>
      ${cat && used ? `<label class="check" id="rename-row" hidden><input type="checkbox" name="apply" checked><span>Also rename the category in ${used} existing ${used === 1 ? 'entry' : 'entries'}</span></label>` : ''}`,
    foot: `<button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${cat ? 'Save changes' : 'Create category'}</button>`,
    onMount: ({ form, close, fail }) => {
      const upd = () => {
        const cmd = form.elements.command.value.trim().replace(/^\//, '') || slugify(form.elements.name.value);
        form.elements.command.placeholder = slugify(form.elements.name.value) || 'benzin';
        $('#cmd-preview').textContent = cmd ? `In Telegram: /${cmd} 20` : '';
        $('#cmd-field').hidden = form.elements.type.value === 'income';
        const rr = $('#rename-row'); if (rr) rr.hidden = form.elements.name.value.trim() === cat.name;
      };
      upd();
      ['input', 'change'].forEach((ev) => form.addEventListener(ev, upd));
      $$('[data-sw]', form).forEach((b) => b.addEventListener('click', () => {
        form.elements.color.value = b.dataset.sw; $$('[data-sw]', form).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }));
      form.elements.color.addEventListener('input', () => $$('[data-sw]', form).forEach((x) => x.setAttribute('aria-pressed', 'false')));
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); fail('');
        if (!form.elements.name.value.trim()) return fail('Enter a name');
        const body = { name: form.elements.name.value.trim(), command: form.elements.command.value.trim().replace(/^\//, '').toLowerCase(), type: form.elements.type.value, color: form.elements.color.value, icon: form.elements.icon.value.trim() };
        if (cat) body.apply_to_transactions = form.elements.apply ? form.elements.apply.checked : true;
        busy(form, true);
        try {
          const res = await api(cat ? `/api/categories/${encodeURIComponent(cat.name)}` : '/api/categories', { method: cat ? 'PUT' : 'POST', body });
          close(); toast(cat ? (res.moved ? `Category saved, ${res.moved} entries renamed` : 'Category saved') : 'Category created'); await loadAll();
        } catch (err) { fail(err.message); busy(form, false); }
      });
    },
  });
}

function deleteCatModal(cat) {
  const used = catStats().get(norm(cat.name))?.n || 0;
  const others = S.categories.filter((c) => c.name !== cat.name);
  openModal({
    title: 'Delete category?',
    body: `<p style="margin:0"><b>${esc(cat.name)}</b> will be removed from the list${cat.type !== 'income' ? ` and <code>/${esc(cat.command)}</code> from the bot menu` : ''}.</p>
      ${used ? `<label class="field"><span>${used} ${used === 1 ? 'entry uses' : 'entries use'} this category</span>
        <select name="reassign"><option value="">Keep entries with the old name</option>${others.map((o) => `<option value="${esc(o.name)}">Move to ${esc(o.name)}</option>`).join('')}</select></label>` : ''}`,
    foot: `<button class="btn" type="button" data-close>Cancel</button><button class="btn btn-danger" type="submit">Delete category</button>`,
    onMount: ({ form, close, fail }) => form.addEventListener('submit', async (e) => {
      e.preventDefault(); busy(form, true);
      const rq = form.elements.reassign?.value ? `?reassign=${encodeURIComponent(form.elements.reassign.value)}` : '';
      try { const r = await api(`/api/categories/${encodeURIComponent(cat.name)}${rq}`, { method: 'DELETE' }); close(); toast(r.moved ? `Category deleted, ${r.moved} entries moved` : 'Category deleted'); await loadAll(); }
      catch (err) { fail(err.message); busy(form, false); }
    }),
  });
}

/* ---------- currencies ---------- */
function renderRatesTab() {
  const rows = S.rates.map((r) => ({ ...r }));
  const draw = () => {
    $('#edit-body').innerHTML = `<div class="panel" style="max-width:640px">
      <div class="panel-head"><h2 class="panel-title">Exchange rates</h2><span class="panel-note">Charts convert every amount to ${S.base}</span></div>
      <form id="rates-form"><table class="rates-table"><thead><tr><th>Currency</th><th>1 unit equals</th><th></th></tr></thead><tbody>
        ${rows.map((r, i) => r.currency === S.base
          ? `<tr><td><b>${esc(S.base)}</b></td><td class="panel-note">Main currency, always 1</td><td></td></tr>`
          : `<tr><td><input data-i="${i}" data-k="currency" value="${esc(r.currency)}" maxlength="5" style="text-transform:uppercase;max-width:110px" aria-label="Currency code"></td>
            <td><div style="display:flex;gap:8px;align-items:center"><input data-i="${i}" data-k="rate" value="${r.rate}" inputmode="decimal" style="max-width:150px" aria-label="Rate"><span class="panel-note">${esc(S.base)}</span></div></td>
            <td class="actions"><button class="icon-btn danger" type="button" data-rm="${i}" aria-label="Remove">${ICON.trash}</button></td></tr>`).join('')}
      </tbody></table>
      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap"><button class="btn" type="button" id="add-rate">${ICON.plus}Add currency</button><span style="flex:1"></span>
      <button class="btn btn-primary" type="submit">Save rates</button></div></form></div>`;
    $$('#rates-form input[data-i]').forEach((inp) => inp.addEventListener('input', () => { rows[inp.dataset.i][inp.dataset.k] = inp.value; }));
    $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { rows.splice(+b.dataset.rm, 1); draw(); }));
    $('#add-rate').addEventListener('click', () => { rows.push({ currency: '', rate: '' }); draw(); $$('#rates-form input[data-k=currency]').at(-1)?.focus(); });
    $('#rates-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = rows.filter((r) => r.currency !== S.base && String(r.currency).trim())
        .map((r) => ({ currency: String(r.currency).trim().toUpperCase(), rate: parseFloat(String(r.rate).replace(',', '.')) }));
      if (body.some((r) => !(r.rate > 0))) return toast('Every rate must be a number greater than 0', true);
      try { await api('/api/rates', { method: 'PUT', body }); toast('Rates saved'); await loadAll(); } catch (err) { toast(err.message, true); }
    });
  };
  draw();
}

/* ================= events ================= */
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  if (t.dataset.p) { S.period = t.dataset.p; store.set('period', S.period); renderMonitor(); }
  else if (t.dataset.pie) { S.pieType = t.dataset.pie; renderMonitor(); }
  else if (t.dataset.cat && S.page === 'monitor') openCategory(t.dataset.cat);
  else if (t.dataset.tab) { location.hash = `edit/${t.dataset.tab}`; }
  else if (t.dataset.add) txModal(null, t.dataset.add);
  else if (t.dataset.edit) txModal(S.tx.find((x) => x.id === t.dataset.edit));
  else if (t.dataset.del) deleteTx(S.tx.find((x) => x.id === t.dataset.del));
  else if (t.dataset.sort) { const k = t.dataset.sort; S.sort = { key: k, dir: S.sort.key === k && S.sort.dir === 'desc' ? 'asc' : 'desc' }; renderTxTab(); }
  else if (t.dataset.pg) { S.pg += +t.dataset.pg; renderTxTab(); }
  else if (t.dataset.newcat) catModal(null, t.dataset.newcat);
  else if (t.dataset.editcat) catModal(S.categories.find((c) => c.name === t.dataset.editcat));
  else if (t.dataset.delcat) deleteCatModal(S.categories.find((c) => c.name === t.dataset.delcat));
});
['c-start', 'c-end'].forEach((id) => $('#' + id).addEventListener('change', () => {
  S.custom = { start: $('#c-start').value, end: $('#c-end').value }; store.set('custom', S.custom); renderMonitor();
}));
$('#refresh').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.classList.add('spin');
  try { await api('/api/refresh', { method: 'POST' }); await loadAll(); toast('Data reloaded'); } catch (err) { toast(err.message, true); }
  b.classList.remove('spin');
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.href = '/login'; });
window.addEventListener('hashchange', route);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.loaded) loadAll(true); });
setInterval(() => { if (document.visibilityState === 'visible' && !$('#modal-root').firstChild && S.page === 'monitor') loadAll(true); }, 60000);

route();
loadAll();
