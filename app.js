"use strict";
/* Conti — dashboard. Tutto il testo dei movimenti è inserito con textContent (mai innerHTML). */

const $ = (id) => document.getElementById(id);
const EUR = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });
const EUR0 = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const fmt = (v) => (v == null ? "n/d" : EUR.format(v));
const fmtDate = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
const compact = (v) => {
  const a = Math.abs(v);
  if (a >= 1000) return `${(v / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })}k`;
  return v.toLocaleString("it-IT", { maximumFractionDigits: 0 });
};

// Sul telefono non c'è il server del Mac: telefono.js fornisce le stesse "API" lette da GitHub.
const PHONE = Boolean(window.ContiBackend);

const state = { data: null, idx: 0, group: "tutti", cat: "", search: "", view: "mese", allMonths: false, years: null, showAll: false };
// Sul telefono i movimenti sono la cosa più consultata: subito dopo il patrimonio, i più recenti.
const PHONE_RECENT = 10;

// ── periodi: mesi oppure anni (l'anno ha la stessa forma di un mese, sommato) ──
function buildYears(mesi) {
  const byYear = new Map();
  for (const m of mesi) {
    const y = m.key.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(m);
  }
  const sum = (arr, k) => arr.reduce((a, m) => a + (m[k] || 0), 0);
  const merge = (arr, field, keys) => {
    const out = new Map();
    for (const m of arr) for (const c of m[field]) {
      const cur = out.get(c.nome) || { nome: c.nome, ...Object.fromEntries(keys.map((k) => [k, 0])) };
      for (const k of keys) cur[k] += c[k] || 0;
      out.set(c.nome, cur);
    }
    return [...out.values()];
  };
  const thisYear = String(new Date().getFullYear());
  return [...byYear.entries()].map(([y, ms]) => ({
    key: y, label: `Anno ${y}`, short: y, year: true, months: ms,
    in_progress: y === thisYear, partial: ms.some((m) => m.partial),
    entrate: sum(ms, "entrate"), uscite: sum(ms, "uscite"), saldo: sum(ms, "saldo"), speso: sum(ms, "speso"),
    entrate_vere: sum(ms, "entrate_vere"), da_persone: sum(ms, "da_persone"), a_persone: sum(ms, "a_persone"),
    netto_interni: sum(ms, "netto_interni"), variazione: sum(ms, "variazione"), senza_cambio: sum(ms, "senza_cambio"),
    categorie: merge(ms, "categorie", ["speso", "n"]).sort((a, b) => b.speso - a.speso),
    interni: merge(ms, "interni", ["entrati", "usciti"]),
    budget: [],
    portafoglio: [...ms].reverse().find((m) => m.portafoglio)?.portafoglio ?? null,
    costi: Object.fromEntries(["cambi", "commissioni", "totale"].map((k) => [k, ms.reduce((a, m) => a + (m.costi?.[k] || 0), 0)])),
  })).map((y) => ({ ...y, risparmio: y.entrate > 0 ? (y.saldo / y.entrate) * 100 : null }));
}
const periods = () => (state.view === "anno" ? state.years : state.data.mesi);
const current = () => periods()[state.idx];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") el.style.cssText = v; // CSSOM: consentito dalla CSP (gli attributi style no)
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const SVG = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}
// icona di stato in stile SF Symbols (checkmark/exclamationmark/xmark/minus .circle.fill): cerchio pieno + segno
// disegnati nello stesso SVG, quindi perfettamente centrati (niente caratteri di testo)
const STATUS_SIGNS = {
  "✓": [["path", { d: "M7 12.4 10.4 15.8 17 8.4", class: "sg" }]],
  "!": [["path", { d: "M12 6.6v6", class: "sg" }], ["circle", { cx: 12, cy: 16.9, r: 1.45, class: "sf" }]],
  "✕": [["path", { d: "M8.3 8.3l7.4 7.4M15.7 8.3l-7.4 7.4", class: "sg" }]],
  "–": [["path", { d: "M7.6 12h8.8", class: "sg" }]],
  "…": [["circle", { cx: 7.8, cy: 12, r: 1.3, class: "sf" }], ["circle", { cx: 12, cy: 12, r: 1.3, class: "sf" }], ["circle", { cx: 16.2, cy: 12, r: 1.3, class: "sf" }]],
};
function statusIcon(color, sign, extra = {}) {
  return s("svg", { class: `status-icon st-${color}`, viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false", ...extra },
    s("circle", { cx: 12, cy: 12, r: 12, class: "disc" }), ...(STATUS_SIGNS[sign] || STATUS_SIGNS["–"]).map(([t, a]) => s(t, a)));
}
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ── rete ────────────────────────────────────────────────────────────────
async function api(path, body) {
  if (PHONE) return window.ContiBackend.api(path, body);
  const opts = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, opts);
  let payload = {};
  try { payload = await r.json(); } catch { /* vuoto */ }
  return { ok: r.ok, status: r.status, payload };
}

function show(id) {
  for (const sec of ["loading", "setup", "error", "dashboard"]) $(sec).hidden = sec !== id;
  $("month-nav").hidden = id !== "dashboard";
  $("view-bar").hidden = id !== "dashboard";
  $("large-title").hidden = $("view-switch").hidden = id !== "dashboard";  // sul Mac stanno nella barra in alto
  $("brand").hidden = id === "dashboard";  // nella dashboard la barra mostra il mese, non il nome
  $("tabbar").hidden = id !== "dashboard";
}

async function load(refresh = false) {
  show("loading");
  const { ok, status, payload } = await api(`/api/data${refresh ? "?refresh=1" : ""}`);
  if (status === 401 && payload.setup) {
    $("setup-error").hidden = !payload.errore;
    $("setup-error").textContent = payload.errore || "";
    return show("setup");
  }
  if (!ok) {
    $("error-text").textContent = payload.errore || "Impossibile leggere i dati.";
    return show("error");
  }
  const keep = state.data ? current()?.key : null;
  if (!payload.mesi.length) {
    $("error-text").textContent = "Nessun movimento ancora: il primo sync non ha importato dati.";
    return show("error");
  }
  setData(payload, keep);
  buildMonthSelect();
  show("dashboard");
  render();
  checkUpdate();
}

// ── aggiornamento dell'app del Mac (il telefono si aggiorna da solo) ────
async function checkUpdate() {
  if (PHONE) return;
  const { ok, payload } = await api("/api/aggiornamento");
  $("update-banner").hidden = !(ok && payload.stato === "disponibile");
}
$("update-btn").addEventListener("click", async () => {
  const btn = $("update-btn");
  btn.disabled = true;
  $("update-text").textContent = "Aggiornamento in corso: verifico e scarico la versione nuova…";
  const { ok, payload } = await api("/api/aggiorna", {});
  if (!ok) {
    btn.disabled = false;
    $("update-banner").classList.add("critical");
    $("update-text").textContent = `Aggiornamento non riuscito: ${payload.errore || "riprova più tardi"}.`;
    return;
  }
  document.body.replaceChildren(h("main", {}, h("section", { class: "center-card" },
    h("div", { class: "card setup" }, h("h1", { text: "Conti è aggiornata ✓" }),
      h("p", { class: "muted", text: "Si riapre in una nuova finestra: questa si può chiudere." })))));
  setTimeout(() => window.close(), 2500);
});

function setData(payload, keepKey) {
  state.data = payload;
  state.years = buildYears(payload.mesi);
  const list = periods();
  const found = keepKey ? list.findIndex((m) => m.key === keepKey) : -1;
  state.idx = found >= 0 ? found : list.length - 1;
}

// ── navigazione mesi / anni ─────────────────────────────────────────────
function buildMonthSelect() {
  const sel = $("month-select");
  const narrow = innerWidth < 640;  // sul telefono "in corso"/"parziale" li dice già l'avviso sotto
  sel.replaceChildren(...periods().map((m, i) =>
    h("option", { value: i, text: m.label + (narrow ? "" : m.in_progress ? " · in corso" : m.partial ? " · parziale" : "") })).reverse());
  for (const b of $("view-switch").children) b.setAttribute("aria-selected", String(b.dataset.view === state.view));
}
function setView(view, key) {
  state.view = view;
  const list = periods();
  const found = key ? list.findIndex((p) => p.key === key) : -1;
  state.idx = found >= 0 ? found : list.length - 1;
  state.cat = "";
  state.showAll = false;
  buildMonthSelect();
  render();
}
function setMonth(i) {
  const n = periods().length;
  state.idx = Math.max(0, Math.min(n - 1, i));
  state.cat = "";
  state.showAll = false;
  render();
}

// ── rendering ───────────────────────────────────────────────────────────
function render() {
  const list = periods();
  const m = list[state.idx];
  const prev = state.idx > 0 ? list[state.idx - 1] : null;
  const year = state.view === "anno";
  $("month-select").value = state.idx;
  $("nav-title").textContent = m.label;
  $("prev-month").disabled = state.idx === 0;
  $("next-month").disabled = state.idx === list.length - 1;

  const notes = [];
  if (m.in_progress) notes.push(year ? "Anno in corso." : "Mese in corso: i numeri crescono man mano che le banche contabilizzano i movimenti.");
  if (m.partial) notes.push(year ? "Il tracciamento è iniziato durante quest'anno: i mesi precedenti non ci sono." : "Mese parziale: i dati iniziano dopo i primi giorni del mese (inizio del tracciamento).");
  if (state.data.aggiornamento) notes.push("Modifica salvata: GitHub sta ricalcolando totali e grafici, si aggiornano da soli tra un paio di minuti.");
  if (m.senza_cambio) notes.push(`${m.senza_cambio} movimenti senza tasso di cambio non sono nei totali.`);
  const tokenDays = state.data.token_scadenza ? Math.ceil((new Date(state.data.token_scadenza) - new Date()) / 864e5) : null;
  if (tokenDays != null && tokenDays <= 21) {
    notes.unshift(`Il token GitHub di questo ${PHONE ? "telefono" : "Mac"} scade il ${fmtDate(state.data.token_scadenza)} (tra ${Math.max(tokenDays, 0)} giorni): `
      + "su GitHub → Settings → Developer settings → Fine-grained tokens apri il token → Regenerate token, poi incolla quello nuovo quando l'app lo chiede.");
  }
  // consenso scaduto, in errore o in scadenza: sul telefono il chip in alto è solo un'icona, il testo va qui
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  let urgent = false;
  for (const b of (state.data.stato?.banche || []).filter((x) => x.esito !== "non configurata")) {
    const days = b.consenso_fino_a ? Math.round((new Date(b.consenso_fino_a) - today0) / 864e5) : null;
    if (b.esito !== "ok") { urgent = true; notes.unshift(`${b.nome}: ${b.esito}. Controlla STATO.md su GitHub.`); }
    else if (days != null && days <= 14) {
      urgent ||= days <= 7;  // rosso come il chip solo nell'ultima settimana
      notes.unshift(`Il consenso ${b.nome} scade tra ${Math.max(days, 0)} giorni: va rinnovato (scripts/link_account.py, poi aggiorna il secret).`);
    }
  }
  const stale = staleDays();
  if (stale != null) notes.unshift(`Il sync automatico non gira da ${stale} giorni: i dati potrebbero non essere aggiornati. Controlla Actions → Sync spese su GitHub (o STATO.md).`);
  $("month-notice").hidden = !notes.length;
  $("month-notice").className = `notice${stale != null || urgent ? " critical" : ""}`;
  $("month-notice").textContent = notes.join(" ");

  renderWorth();
  renderAlerts();
  renderTiles(m, prev);
  renderTrend();
  renderCategories(m, prev);
  renderGoal(m);
  renderBudget(m);
  renderTips();
  renderInternal(m);
  renderCosts(m);
  renderRecon(m);
  renderWallet(m);
  renderRecurring();
  renderAmex();
  renderTrips();
  if (tripEditing && $("trip-dialog")?.open && state.data.viaggi?.some((v) => v.id === tripEditing)) openTrip(tripEditing);
  renderPlanned();
  renderYear(m);
  renderFilters(m);
  renderTransactions();
  renderStatus();
}

function delta(cur, before, upIsGood, prevLabel) {
  if (before == null) return h("div", { class: "delta", text: "—" });
  const d = cur - before;
  if (Math.abs(d) < 0.005) return h("div", { class: "delta", text: `= rispetto\u00a0a\u00a0${prevLabel}` });
  const good = upIsGood ? d > 0 : d < 0;
  return h("div", { class: "delta" },
    h("span", { class: good ? "good" : "bad", text: `${d > 0 ? "▲ +" : "▼ "}${EUR0.format(d)}` }),
    ` rispetto\u00a0a\u00a0${prevLabel}`);
}

// Quota delle entrate che resta: il numero da far crescere per spendere meno.
function savingText(m) {
  if (m.risparmio == null) return "entrate − uscite";
  const r = Math.round(m.risparmio);
  return r >= 0 ? `hai messo da parte il ${r}% delle entrate` : `uscite oltre le entrate del ${-r}%`;
}

function renderTiles(m, prev) {
  const pl = prev ? prev.short.toLowerCase().replace(/ /g, "\u00a0") : "";
  const tiles = [
    { label: "Entrate", v: m.entrate, p: prev?.entrate, up: true, sub: `di cui da persone ${fmt(m.da_persone)}` },
    { label: "Uscite", v: m.uscite, p: prev?.uscite, up: false, sub: `di cui a persone ${fmt(m.a_persone)}` },
    { label: m.year ? "Saldo dell'anno" : "Saldo del mese", v: m.saldo, p: prev?.saldo, up: true, hero: true, sub: savingText(m) },
    { label: "Totale speso", v: m.speso, p: prev?.speso, up: false,
      sub: m.previsione ? `previsione a fine mese ≈ ${EUR0.format(m.previsione.speso)}` : `${m.categorie.reduce((a, c) => a + c.n, 0)} movimenti` },
  ];
  $("tiles").replaceChildren(...tiles.map((t) =>
    h("div", { class: `tile${t.hero ? " hero" : ""}` },
      h("div", { class: "label", text: t.label }),
      h("div", { class: "value", text: fmt(t.v) }),
      delta(t.v, t.p, t.up, pl),
      h("div", { class: "delta muted", text: t.sub }))));
}

// grafico: entrate/uscite a barre affiancate + saldo separato (mai doppio asse)
// massimo dell'asse = 4 passi "tondi" (es. 600 → 2.400), così le etichette sono leggibili
function niceMax(v, steps = 4) {
  if (v <= 0) return steps;
  const raw = v / steps, p = 10 ** Math.floor(Math.log10(raw));
  for (const k of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= raw) return k * p * steps;
  return 10 * p * steps;
}
const money0 = (v) => EUR0.format(Math.abs(v) < 0.5 ? 0 : v);
function roundedTop(x, y, w, hgt, r) {
  // barra ancorata alla base: angoli arrotondati solo in cima
  if (hgt <= 0) return "";
  r = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}
function roundedBottom(x, y, w, hgt, r) {
  if (hgt <= 0) return "";
  r = Math.min(r, w / 2, hgt);
  return `M${x},${y}H${x + w}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x + r}Q${x},${y + hgt} ${x},${y + hgt - r}Z`;
}

function trendWindow() {
  const { mesi } = state.data;
  if (state.view === "anno") {  // i mesi dell'anno scelto (clic = apri il mese)
    const y = current().key;
    const start = mesi.findIndex((m) => m.key.startsWith(y));
    return { mesi: mesi.filter((m) => m.key.startsWith(y)), offset: start, all: true };
  }
  const n = innerWidth < 640 ? 6 : 12;  // sul telefono 6 mesi, altrimenti le barre sono troppo strette
  const end = Math.max(state.idx, Math.min(mesi.length - 1, state.idx + Math.floor(n / 2) - 1));
  const start = Math.max(0, end - (n - 1));
  return { mesi: mesi.slice(start, end + 1), offset: start };
}
function openMonth(i) {
  if (state.view === "anno") setView("mese", state.data.mesi[i].key);
  else setMonth(i);
}

function renderTrend() {
  const { mesi, offset, all } = trendWindow();
  $("trend-legend").replaceChildren(
    h("span", {}, h("i", { class: "swatch", style: `background:${css("--series-1")}` }), "Entrate"),
    h("span", {}, h("i", { class: "swatch", style: `background:${css("--series-2")}` }), "Uscite"));

  // entrate / uscite
  const box = $("trend-chart");
  const W = box.clientWidth || 600, H = box.clientHeight || 230;
  const pad = { l: 44, r: 8, t: 10, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(...mesi.map((m) => Math.max(m.entrate, m.uscite))));
  const y = (v) => pad.t + ih - (v / max) * ih;
  const band = iw / mesi.length;
  const bw = Math.min(22, (band - 14) / 2);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Entrate e uscite per mese" });
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    svg.append(s("line", { class: i ? "gridline" : "baseline", x1: pad.l, x2: W - pad.r, y1: yy, y2: yy }),
      s("text", { x: pad.l - 8, y: yy + 4, "text-anchor": "end" }, compact(v)));
  }
  mesi.forEach((m, i) => {
    const cx = pad.l + band * i + band / 2;
    const active = all || offset + i === state.idx;
    const g = s("g", { class: `col${active ? "" : " dim"}` });
    g.append(
      s("path", { class: "bar", d: roundedTop(cx - bw - 1, y(m.entrate), bw, y(0) - y(m.entrate), 4), fill: css("--series-1") }),
      s("path", { class: "bar", d: roundedTop(cx + 1, y(m.uscite), bw, y(0) - y(m.uscite), 4), fill: css("--series-2") }));
    const label = s("text", { x: cx, y: H - 8, "text-anchor": "middle", class: active ? "tick-active" : null }, m.short);
    const hit = s("rect", { class: "hit", x: pad.l + band * i, y: pad.t, width: band, height: ih + pad.b });
    hit.addEventListener("click", () => openMonth(offset + i));
    tip(hit, () => [m.label, [["Entrate", fmt(m.entrate), css("--series-1")], ["Uscite", fmt(m.uscite), css("--series-2")], ["Saldo", fmt(m.saldo)]]]);
    svg.append(g, label, hit);
  });
  box.replaceChildren(svg);

  // saldo (divergente: blu sopra zero, rosso sotto)
  const box2 = $("saldo-chart");
  const W2 = box2.clientWidth || 600, H2 = box2.clientHeight || 120;
  const ih2 = H2 - 14;
  const lim = niceMax(Math.max(1, ...mesi.map((m) => Math.abs(m.saldo))), 1);
  const y2 = (v) => 4 + ih2 / 2 - (v / lim) * (ih2 / 2 - 4);
  const svg2 = s("svg", { viewBox: `0 0 ${W2} ${H2}`, role: "img", "aria-label": "Saldo del mese" });
  svg2.append(s("line", { class: "baseline", x1: pad.l, x2: W2 - pad.r, y1: y2(0), y2: y2(0) }),
    s("text", { x: pad.l - 8, y: y2(lim) + 8, "text-anchor": "end" }, `+${compact(lim)}`),
    s("text", { x: pad.l - 8, y: y2(-lim), "text-anchor": "end" }, `−${compact(lim)}`));
  const bw2 = Math.min(26, band - 16);
  mesi.forEach((m, i) => {
    const cx = pad.l + band * i + band / 2;
    const active = all || offset + i === state.idx;
    const pos = m.saldo >= 0;
    const top = pos ? y2(m.saldo) : y2(0);
    const hgt = Math.abs(y2(m.saldo) - y2(0));
    const g = s("g", { class: `col${active ? "" : " dim"}` },
      s("path", { class: "bar", d: pos ? roundedTop(cx - bw2 / 2, top, bw2, hgt, 4) : roundedBottom(cx - bw2 / 2, top, bw2, hgt, 4),
        fill: pos ? css("--pos") : css("--neg") }));
    const hit = s("rect", { class: "hit", x: pad.l + band * i, y: 0, width: band, height: H2 });
    hit.addEventListener("click", () => openMonth(offset + i));
    tip(hit, () => [m.label, [["Saldo", fmt(m.saldo), pos ? css("--pos") : css("--neg")]]]);
    svg2.append(g, hit);
  });
  box2.replaceChildren(svg2);
}

function renderCategories(m, prev) {
  const cats = m.categorie.filter((c) => c.speso > 0);
  const nMonths = m.year ? m.months.length : 1;
  $("cat-sub").textContent = `${fmt(m.speso)} in ${cats.length} categorie` +
    (m.year ? ` · media ${EUR0.format(m.speso / nMonths)} al mese` : "") + " · clicca per filtrare i movimenti";
  if (!cats.length) return $("cat-chart").replaceChildren(h("p", { class: "empty", text: "Nessuna spesa in questo periodo." }));
  const max = cats[0].speso;
  const prevBy = Object.fromEntries((prev?.categorie || []).map((c) => [c.nome, c.speso]));
  $("cat-chart").replaceChildren(...cats.map((c) => {
    const p = prevBy[c.nome] ?? 0;
    const d = c.speso - p;
    const row = h("div", { class: `hbar${state.cat === c.nome ? " active" : ""}`, onclick: () => {
      state.cat = state.cat === c.nome ? "" : c.nome; state.group = "uscite"; render();
      $("tx-card").scrollIntoView({ behavior: "smooth", block: "start" });
    } },
      h("span", { class: "name", title: c.nome, text: c.nome }),
      h("div", { class: "track" }, h("div", { class: "fill", style: `width:${(c.speso / max) * 100}%` })),
      h("span", { class: "val", text: EUR0.format(c.speso) },
        m.year ? h("small", { text: `${EUR0.format(c.speso / nMonths)}/mese` })
          : prev ? h("small", { text: Math.abs(d) < 1 ? "= mese prec." : `${d > 0 ? "▲ +" : "▼ "}${EUR0.format(d)}` }) : null));
    tip(row, () => [c.nome, [["Speso", fmt(c.speso)], ["Movimenti", String(c.n)],
      ...(m.year ? [["Media mensile", fmt(c.speso / nMonths)]] : prev ? [["Mese precedente", fmt(p)]] : [])]]);
    return row;
  }));
}

function renderBudget(m) {
  const list = $("budget-list");
  if (m.year) return list.replaceChildren(h("p", { class: "empty", text: "I budget sono mensili: apri un mese per vederli." }));
  if (!m.budget.length) {
    return list.replaceChildren(h("p", { class: "empty", text: "Nessun budget impostato: tocca Modifica (ci sono anche quelli suggeriti)." }));
  }
  const all = m.budget.map((b) => ({ ...b, r: b.speso / b.budget })).sort((a, b) => b.r - a.r);
  const rows = all.filter((b) => b.speso > 0);
  const unused = all.filter((b) => b.speso <= 0);
  const extra = unused.length ? h("p", { class: "empty small" },
    statusIcon("good", "✓"),
    ` ${unused.length} budget ancora a 0 €: ${unused.map((b) => b.nome).join(", ")}`) : null;
  list.replaceChildren(...rows.map((b) => {
    const st = b.r > 1 ? ["critical", "✕", "Superato"] : b.r >= 0.8 ? ["warning", "!", "Quasi al limite"]
      : b.previsto > b.budget ? ["warning", "!", `A rischio: a fine mese\u00a0≈\u00a0${EUR0.format(b.previsto)}`] : ["good", "✓", "Nei limiti"];
    return h("div", { class: "budget-row" },
      h("span", { class: "bname" }, statusIcon(st[0], st[1]),
        h("span", { text: b.nome }), h("span", { class: "muted small bstate", text: st[2] })),
      h("span", { class: "bval", text: `${EUR0.format(b.speso)} / ${EUR0.format(b.budget)} · ${Math.round(b.r * 100)}%` }),
      h("div", { class: "btrack" }, h("div", { class: "bfill", style: `width:${Math.min(100, b.r * 100)}%;background:var(--${st[0]})` })));
  }), extra ?? "");
}

function renderInternal(m) {
  const box = $("internal-list");
  if (!m.interni.length) return box.replaceChildren(h("p", { class: "empty", text: "Nessun movimento tra i tuoi conti." }));
  box.replaceChildren(
    h("div", { class: "internal-row head" }, h("span", { text: "Categoria" }), h("span", { text: "Entrati" }), h("span", { text: "Usciti" }), h("span", { text: "Netto" })),
    ...m.interni.map((r) => h("div", { class: "internal-row" },
      h("span", { text: r.nome }), h("span", { text: money0(r.entrati) }), h("span", { text: money0(r.usciti) }),
      h("span", { text: money0(r.entrati - r.usciti) }))),
    h("div", { class: "internal-row" }, h("span", { class: "muted", text: "Variazione complessiva dei conti" }), h("span"), h("span"),
      h("span", { text: fmt(m.variazione) })));
}

// ── costi di banca e cambio ─────────────────────────────────────────────
function renderCosts(m) {
  const c = m.costi;
  $("costs-card").hidden = !c;
  if (!c) return;
  const year = state.years?.find((y) => y.key === m.key.slice(0, 4));
  const row = (label, v, hint) => h("div", { class: "internal-row cost-row" }, h("span", {}, label, hint ? h("small", { class: "muted", text: hint }) : null),
    h("span", { text: fmt(v) }));
  $("costs-body").replaceChildren(
    h("div", { class: "wallet-balance" }, h("span", { class: "muted small", text: m.year ? "Nell'anno" : "Nel mese" }), h("strong", { text: fmt(c.totale) })),
    row("Cambi valuta", c.cambi, c.cambi < 0 ? "a tuo favore rispetto al tasso BCE" : "rispetto al tasso BCE"),
    row("Commissioni", c.commissioni, "es. imposta di bollo"),
    ...(!m.year && year ? [row("Da inizio anno", year.costi.totale)] : []),  // replaceChildren(null) scriverebbe "null"
    h("p", { class: "hint", text: "I cambi fatti pagando con la carta in un'altra valuta non si vedono: sono già dentro l'importo della spesa." }));
}

// ── obiettivo di risparmio del mese ─────────────────────────────────────
const GOAL_STATES = {  // [colore, icona, titolo]
  in_linea: ["good", "✓", "In linea"], raggiunto: ["good", "✓", "Raggiunto"],
  a_rischio: ["warning", "!", "Finora bene, attento al resto del mese"], mancato: ["critical", "✕", "Mancato"],
  difficile: ["critical", "✕", "Difficile"], parziale: ["neutral", "–", "Mese parziale"],
};
function goalBar(saved, goal, color) {
  const pct = goal > 0 ? Math.max(0, Math.min(100, (saved / goal) * 100)) : 0;
  return h("div", { class: "goal-track", role: "img", "aria-label": `${Math.round(pct)}% dell'obiettivo` },
    h("div", { class: `goal-fill st-${color}`, style: `width:${pct}%` }));
}
function goalStatus(color, icon, title, text) {
  return h("p", { class: "goal-status" }, statusIcon(color, icon),
    h("span", {}, h("strong", { text: `${title}. ` }), text));
}
function renderGoal(m) {
  const info = state.data.obiettivo;
  const card = $("goal-card");
  card.hidden = !info;
  if (!info) return;
  $("goal-edit").textContent = info.importo ? "Modifica" : "Imposta";
  const body = $("goal-body");
  if (!info.importo) {
    $("goal-sub").textContent = "Quanto metti da parte ogni mese: entrate meno uscite";
    return body.replaceChildren(h("p", { class: "empty" }, "Scegli quanto vuoi mettere da parte ogni mese: l'app ti dice se ci stai arrivando e quanto puoi ancora spendere.",
      info.suggerito ? ` Per iniziare: ${EUR0.format(info.suggerito)} (il 10% delle tue entrate tipiche).` : ""));
  }
  if (m.year) {  // anno: somma dei mesi confrontabili
    // solo i mesi chiusi: quello in corso non è ancora raggiunto né mancato
    const months = m.months.filter((x) => x.obiettivo && !x.in_progress && x.obiettivo.stato !== "parziale");
    const goal = months.reduce((a, x) => a + x.obiettivo.importo, 0), saved = months.reduce((a, x) => a + x.saldo, 0);
    const hit = months.filter((x) => x.saldo >= x.obiettivo.importo).length;
    $("goal-sub").textContent = `${m.label} · ${EUR0.format(info.importo)} al mese`;
    const chips = h("div", { class: "goal-months" }, ...m.months.filter((x) => x.obiettivo).map((x) => {
      const [color, icon] = x.in_progress ? ["neutral", "…"] : GOAL_STATES[x.obiettivo.stato] || GOAL_STATES.parziale;
      return h("span", { class: "goal-month", title: `${x.label}: ${fmt(x.saldo)}${x.in_progress ? " (in corso)" : ""}` },
        statusIcon(color, icon), x.short);
    }));
    if (!months.length) {
      return body.replaceChildren(chips, h("p", { class: "muted small", text: "Nessun mese chiuso da confrontare ancora: il primo bilancio arriva a fine mese." }));
    }
    return body.replaceChildren(
      h("div", { class: "goal-head" }, h("span", { class: "muted small", text: "Messo da parte nei mesi chiusi" }),
        h("strong", { class: "goal-value", text: fmt(saved) }), h("span", { class: "muted", text: `su ${EUR0.format(goal)}${goal > 0 ? ` · ${Math.max(0, Math.round(saved / goal * 100))}%` : ""}` })),
      goalBar(saved, goal, saved >= goal ? "good" : "accent"),
      chips,
      h("p", { class: "muted small", text: `Obiettivo raggiunto in ${hit} ${hit === 1 ? "mese" : "mesi"} su ${months.length}.` }));
  }
  const g = m.obiettivo;
  if (!g) return body.replaceChildren();
  const [color, icon, title] = GOAL_STATES[g.stato] || GOAL_STATES.parziale;
  $("goal-sub").textContent = `${m.label} · ${EUR0.format(g.importo)} al mese`;
  const when = g.giorni > 1 ? `nei prossimi ${g.giorni} giorni` : g.giorni === 1 ? "nel prossimo giorno" : "nelle ultime ore del mese";
  const prev = g.spese_previste ?? 0;
  // stima a fine mese: se negativa si spenderebbe più di quanto entra
  const neg = g.previsto != null && g.previsto < 0;
  const endTxt = neg ? `saresti in rosso di ≈\u00a0${EUR0.format(-g.previsto)}` : `metteresti da parte ≈\u00a0${EUR0.format(g.previsto ?? 0)}`;
  const endShort = neg ? `in rosso di ≈\u00a0${EUR0.format(-g.previsto)}` : `≈\u00a0${EUR0.format(g.previsto ?? 0)}`;
  const limit = `Per restare sopra ${EUR0.format(g.importo)} puoi spendere al massimo ${EUR0.format(g.spendibile)}` + (g.al_giorno != null ? `, circa ${EUR0.format(g.al_giorno)} al giorno.` : ".");
  const texts = {
    in_linea: `Anche se ${when} spendi come nei mesi scorsi (≈ ${EUR0.format(prev)}), a fine mese ${endTxt}.`,
    a_rischio: `Oggi sei sopra l'obiettivo, ma se ${when} spendi come nei mesi scorsi (≈ ${EUR0.format(prev)}) a fine mese ${endTxt}. ${limit}`,
    difficile: `Finora hai messo da parte ${EUR0.format(g.messo_da_parte)}, meno di ${EUR0.format(g.importo)}`
      + (g.previsto != null ? `; se ${when} spendi come nei mesi scorsi (≈ ${EUR0.format(prev)}) a fine mese ${endTxt}` : "")
      + `. Per arrivarci servirebbero altre entrate o spese più leggere.`,
    raggiunto: `Hai messo da parte ${fmt(g.messo_da_parte)}: ${EUR0.format(g.messo_da_parte - g.importo)} oltre l'obiettivo.`,
    mancato: `Ne sono mancati ${EUR0.format(g.importo - g.messo_da_parte)}.`,
    parziale: "Il tracciamento è iniziato a metà mese: non è confrontabile.",
  };
  // sopra l'obiettivo ma con una stima a fine mese diversa: due righe, "Finora" e "Previsione"
  const over = m.in_progress && g.messo_da_parte >= g.importo;
  const split = over && (g.stato === "a_rischio" || g.stato === "in_linea") && g.previsto != null;
  const rows = split ? [
    goalStatus("good", "✓", "Finora sei sopra l'obiettivo", `Hai messo da parte ${EUR0.format(g.messo_da_parte)}, ${EUR0.format(g.messo_da_parte - g.importo)} oltre l'obiettivo.`),
    goalStatus(color, icon, `Previsione a fine mese: ${endShort}`,
      `È la stima se ${when} spendi come nei mesi scorsi (≈ ${EUR0.format(prev)}).` + (g.stato === "a_rischio" ? ` ${limit}` : "")),
  ] : [goalStatus(color, icon, title, texts[g.stato] || "")];
  body.replaceChildren(
    h("div", { class: "goal-head" }, h("span", { class: "muted small", text: m.in_progress ? "Messo da parte finora" : "Messo da parte" }),
      h("strong", { class: "goal-value", text: fmt(g.messo_da_parte) }), h("span", { class: "muted", text: `su ${EUR0.format(g.importo)} · ${Math.max(0, Math.round(g.messo_da_parte / g.importo * 100))}%` })),
    goalBar(g.messo_da_parte, g.importo, g.stato === "raggiunto" || over ? "good" : g.stato === "mancato" ? "critical" : "accent"),
    ...rows);
}
function openGoal() {
  const info = state.data.obiettivo || {};
  $("goal-amount").value = info.importo ? String(info.importo).replace(".", ",") : "";
  $("goal-error").hidden = true;
  $("goal-delete").hidden = !info.importo;
  const hint = $("goal-hint");
  hint.hidden = !info.suggerito;
  if (info.suggerito) {
    hint.replaceChildren(`Suggerito: ${EUR0.format(info.suggerito)}, il 10% delle tue entrate tipiche. `,
      h("button", { class: "link-btn", type: "button", text: "Usa questo", onclick: () => { $("goal-amount").value = String(info.suggerito); } }));
  }
  $("goal-dialog").showModal();
  focusField($("goal-amount"), true);
}
async function saveGoal(value) {
  $("goal-save").disabled = true;
  const { ok, payload } = await api("/api/budget", { obiettivo: value });
  $("goal-save").disabled = false;
  if (!ok) {
    $("goal-error").textContent = payload.sola_lettura ? "Il token è in sola lettura: serve Contents: Read and write." : payload.errore || "Non riuscito.";
    $("goal-error").hidden = false;
    return;
  }
  $("goal-dialog").close();
  setData(payload.dati, current().key);
  render();
  toast(value ? "Obiettivo salvato ✓" : "Obiettivo tolto.");
}
$("goal-edit").addEventListener("click", openGoal);
$("goal-cancel").addEventListener("click", () => $("goal-dialog").close());
$("goal-delete").addEventListener("click", () => saveGoal(""));
$("goal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("goal-amount").value.trim();
  if (!/^\d{1,6}([.,]\d{1,2})?$/.test(v) || Number(v.replace(",", ".")) <= 0) {
    $("goal-error").textContent = "Scrivi un importo, per esempio 300 o 250,50.";
    $("goal-error").hidden = false;
    return;
  }
  saveGoal(v);
});

// ── quadratura dei conti (saldo della banca = saldo iniziale + movimenti) ─
const RECON_STATES = {  // [colore, icona, titolo]
  ok: ["good", "✓", "Torna"], diff: ["critical", "✕", "Non torna"], verifica: ["warning", "!", "Da ricontrollare"],
  attesa: ["neutral", "…", "In attesa"],
};
const money = (v, cur) => (cur === "EUR" ? fmt(v) : `${NUM.format(v)} ${cur}`);
function reconLine(x) {
  const [color, icon, title] = RECON_STATES[x.stato] || RECON_STATES.attesa;
  const period = x.dal === x.al ? `il ${shortDate(x.dal)}` : `dal ${shortDate(x.dal)} al ${shortDate(x.al)}`;
  const texts = {
    ok: `I movimenti scaricati spiegano il saldo della banca, ${period}.`,
    diff: `Differenza di ${money(Math.abs(x.differenza), x.valuta)} ${period}: probabilmente un movimento non è arrivato o è doppio.`,
    verifica: `Differenza di ${money(Math.abs(x.differenza), x.valuta)} negli ultimi giorni: forse movimenti ancora in arrivo, si ricontrolla da sola.`,
    attesa: "Serve un secondo saldo: il prossimo arriva con il sync di stanotte.",
  };
  const summary = h("summary", { class: "recon-summary" },
    statusIcon(color, icon),
    h("span", { class: "recon-name" }, h("strong", { text: `${x.banca} · ${x.valuta}` }), h("span", { class: "muted small", text: `${title}. ${texts[x.stato]}` })),
    x.stato === "diff" || x.stato === "verifica" ? h("span", { class: "recon-diff", text: money(x.differenza, x.valuta) }) : null);
  if (x.movimenti == null) return h("div", { class: "recon" }, summary);
  const row = (label, v, strong) => h("div", { class: "internal-row cost-row" }, h("span", { text: label }),
    h(strong ? "strong" : "span", { text: money(v, x.valuta) }));
  return h("details", { class: "recon" }, summary, h("div", { class: "recon-detail" },
    row(`Saldo della banca il ${shortDate(x.dal)}`, x.iniziale),
    row("Movimenti scaricati", x.movimenti),
    row("Saldo atteso", x.iniziale + x.movimenti),
    row(`Saldo della banca dopo il ${shortDate(x.al)}`, x.saldo, true)));
}
function renderRecon(m) {
  const body = $("recon-body");
  if (!state.data.quadratura_attiva) {
    $("recon-sub").textContent = "Saldo della banca = saldo iniziale + movimenti scaricati";
    return body.replaceChildren(h("p", { class: "empty", text: "Parte con il sync di stanotte: servono due saldi per ogni valuta, quindi i primi risultati arrivano tra due notti." }));
  }
  const lines = m.year ? m.months.flatMap((x) => (x.quadratura || []).map((l) => ({ ...l, mese: x.short }))) : m.quadratura || [];
  const bad = lines.filter((l) => l.stato === "diff").length;
  $("recon-sub").textContent = !lines.length ? "Nessun saldo per questo periodo"
    : bad ? `${bad} ${bad === 1 ? "conto non torna" : "conti non tornano"}: tocca per i dettagli` : "Tutto torna · tocca una riga per i dettagli";
  if (!lines.length) return body.replaceChildren(h("p", { class: "empty", text: "Per questo periodo non ci sono saldi delle banche (la quadratura è iniziata dopo)." }));
  if (m.year) {  // anno: solo i mesi con qualcosa che non torna, il resto in una riga
    const issues = lines.filter((l) => l.stato !== "ok");
    return body.replaceChildren(
      ...issues.map((l) => { const el = reconLine(l); el.querySelector(".recon-name strong").textContent += ` · ${l.mese}`; return el; }),
      ...(lines.length > issues.length ? [goalStatus("good", "✓", issues.length ? "Il resto torna" : "Tutto torna",
        `${lines.length - issues.length} controlli su ${lines.length}.`)] : []));
  }
  body.replaceChildren(...lines.map(reconLine));
}

// ── consigli per spendere meno ──────────────────────────────────────────
function renderTips() {
  const list = state.data.consigli || [];
  $("tips-card").hidden = !list.length;
  if (!list.length) return;
  const total = list.reduce((a, t) => a + (t.risparmio || 0), 0);
  $("tips-sub").textContent = "Calcolati sulle tue spese degli ultimi mesi · stime prudenti"
    + (total ? ` · fino a circa ${EUR0.format(total)} al mese, se li segui tutti` : "");
  $("tips-body").replaceChildren(...list.map((t) => h("div", { class: "tip-row" },
    h("div", { class: "tip-main" },
      h("strong", { text: t.titolo }),
      t.risparmio ? h("span", { class: "tip-save", text: `≈ ${EUR0.format(t.risparmio)} al mese` }) : null,
      h("p", { class: "tip-text", text: t.testo })),
    h("button", { class: "btn ghost small-btn", type: "button", text: "Nascondi", title: "Non mostrarlo più questo mese",
      onclick: async (e) => {
        e.target.disabled = true;
        const { ok, payload } = await api("/api/avvisi", { azione: "ok", id: t.id });
        if (!ok) { e.target.disabled = false; return toast(payload.sola_lettura ? "Il token è in sola lettura: serve Contents: Read and write." : payload.errore || "Non riuscito."); }
        setData(payload.dati, current().key);
        render();
      } }))));
}

// ── budget: modifica dall'app, con i suggeriti ──────────────────────────
const budgetNum = (v) => (v == null ? "" : String(Math.round(v * 100) / 100).replace(".", ","));
function openBudget() {
  const rows = state.data.budget_suggeriti || [];
  $("budget-error").hidden = true;
  $("budget-all").hidden = !rows.some((r) => r.suggerito != null && (r.attuale == null || r.suggerito < r.attuale));
  $("budget-rows").replaceChildren(...rows.map((r) => {
    const input = h("input", { type: "text", inputmode: "decimal", value: budgetNum(r.attuale), placeholder: "nessuno",
      "aria-label": `Budget ${r.nome}`, "data-cat": r.nome, "data-was": budgetNum(r.attuale) });
    return h("div", { class: "budget-edit-row" },
      h("div", { class: "budget-edit-name" }, h("strong", { text: r.nome }),
        h("small", { class: "muted", text: `di solito ${EUR0.format(r.tipico)} al mese${r.fissa ? " · spesa fissa" : ""}` })),
      r.suggerito != null ? h("button", { class: "link-btn small", type: "button", text: `usa ${EUR0.format(r.suggerito)}`,
        // "Usa tutti" non alza mai un budget che hai già: l'obiettivo è spendere meno
        "data-sugg": r.attuale == null || r.suggerito < r.attuale ? "bulk" : "one",
        onclick: () => { input.value = String(r.suggerito); } }) : h("span"),
      h("label", { class: "budget-input" }, input, h("span", { class: "muted", text: "€" })));
  }));
  $("budget-dialog").showModal();
}
$("budget-edit").addEventListener("click", openBudget);
$("budget-cancel").addEventListener("click", () => $("budget-dialog").close());
$("budget-all").addEventListener("click", () => {
  for (const b of $("budget-rows").querySelectorAll('button[data-sugg="bulk"]')) b.click();
});
$("budget-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const changes = {};
  for (const input of $("budget-rows").querySelectorAll("input[data-cat]")) {
    const v = input.value.trim();
    if (v && !/^\d{1,6}([.,]\d{1,2})?$/.test(v)) {
      $("budget-error").textContent = `Importo non valido per ${input.dataset.cat}: scrivi un numero, per esempio 150 o 99,50.`;
      $("budget-error").hidden = false;
      return input.focus();
    }
    if (v !== input.dataset.was) changes[input.dataset.cat] = v;
  }
  if (!Object.keys(changes).length) return $("budget-dialog").close();
  $("budget-save").disabled = true;
  const { ok, payload } = await api("/api/budget", { budget: changes });
  $("budget-save").disabled = false;
  if (!ok) {
    $("budget-error").textContent = payload.sola_lettura ? "Il token è in sola lettura: serve Contents: Read and write." : payload.errore || "Non riuscito.";
    $("budget-error").hidden = false;
    return;
  }
  $("budget-dialog").close();
  setData(payload.dati, current().key);
  render();
  toast("Budget salvati ✓");
});

// ── portafoglio contanti ────────────────────────────────────────────────
function renderWallet(m) {
  const card = $("wallet-card");
  const w = m.portafoglio;
  card.hidden = !state.data.portafoglio_attivo_dal;
  if (card.hidden) return;
  if (!w) {
    $("wallet-body").replaceChildren(h("p", { class: "empty",
      text: `Il portafoglio contanti è attivo dal ${fmtDate(state.data.portafoglio_attivo_dal)}.` }));
    return;
  }
  $("wallet-body").replaceChildren(
    h("div", { class: "wallet-balance" }, h("span", { class: "muted small", text: m.year ? "Contante stimato a fine anno" : "Contante stimato a fine mese" }),
      h("strong", { text: fmt(w.saldo) })),
    ...(state.data.contanti_iniziali || []).map((e) => h("div", { class: "internal-row link", role: "button", tabindex: "0",
      title: "Contante che avevi già: clicca per modificarlo", onclick: () => openInitial(e.id),
      onkeydown: (ev) => { if (ev.key === "Enter") openInitial(e.id); } },
      h("span", { text: `Contante che avevi già · dal ${fmtDate(e.data)}` }), h("span"), h("span"),
      h("span", { text: e.valuta === "EUR" ? fmt(Number(e.importo)) : `${NUM.format(Number(e.importo))} ${e.valuta}${e.eur == null ? " · cambio in arrivo" : ""}` }))),
    h("div", { class: "internal-row" }, h("span", { text: "Prelevato al bancomat" }), h("span"), h("span"), h("span", { text: fmt(w.prelevato) })),
    h("div", { class: "internal-row" }, h("span", { text: "Spese in contanti registrate" }), h("span"), h("span"), h("span", { text: fmt(w.speso) })),
    h("p", { class: "muted small", text: "Se nel portafoglio hai meno contante di così, la differenza sono spese non registrate: aggiungile con + Contanti." }));
}

// ── vista annuale: mese per mese ────────────────────────────────────────
function renderYear(m) {
  const card = $("year-card");
  card.hidden = !m.year;
  if (!m.year) return;
  const maxSpent = Math.max(...m.months.map((x) => x.speso));
  $("year-body").replaceChildren(
    h("div", { class: "internal-row year head" }, ...["Mese", "Entrate", "Uscite", "Saldo", "Speso"].map((t) => h("span", { text: t }))),
    ...m.months.map((x) => h("div", { class: "internal-row year link", role: "button", tabindex: "0",
      onclick: () => setView("mese", x.key), onkeydown: (e) => { if (e.key === "Enter") setView("mese", x.key); } },
      h("span", { text: x.label + (x.in_progress ? " · in corso" : x.partial ? " · parziale" : "") }),
      h("span", { text: money0(x.entrate) }), h("span", { text: money0(x.uscite) }),
      h("span", { class: x.saldo < 0 ? "neg-amt" : null, text: money0(x.saldo) }),
      h("span", {}, x.speso === maxSpent && m.months.length > 1 ? h("span", { class: "badge", text: "mese più caro" }) : null, money0(x.speso)))),
    h("div", { class: "internal-row year total" }, h("span", { text: "Media mensile" }),
      h("span", { text: money0(m.entrate / m.months.length) }), h("span", { text: money0(m.uscite / m.months.length) }),
      h("span", { text: money0(m.saldo / m.months.length) }), h("span", { text: money0(m.speso / m.months.length) })));
}

// ── movimenti ───────────────────────────────────────────────────────────
// Entrate/Uscite = stessi movimenti dei riquadri in alto (persone incluse, nel verso giusto).
function inFilter(t, f) {
  switch (f) {
    case "tutti": return true;
    case "entrate": return t.gruppo === "entrata" || (t.gruppo === "persone" && t.importo > 0);
    case "uscite": return t.gruppo === "spesa" || (t.gruppo === "persone" && t.importo < 0);
    default: return t.gruppo === f;
  }
}
function monthTx() {
  if (state.allMonths) return state.data.movimenti;  // ricerca su tutto lo storico
  const key = current().key;
  return state.data.movimenti.filter((t) => t.data.startsWith(key));
}
function renderFilters(m) {
  const groups = [["tutti", "Tutti"], ...Object.entries(state.data.gruppi)];
  $("group-filter").replaceChildren(...groups.map(([k, label]) =>
    h("button", { role: "tab", "aria-selected": String(state.group === k), onclick: () => { state.group = k; state.cat = ""; render(); } }, label)));
  const cats = [...new Set(monthTx().filter((t) => inFilter(t, state.group)).map((t) => t.categoria))].sort();
  $("cat-filter").replaceChildren(h("option", { value: "", text: "Tutte le categorie" }),
    ...cats.map((c) => h("option", { value: c, text: c })));
  $("cat-filter").value = cats.includes(state.cat) ? state.cat : "";
}
// ── raggruppamento per giorno (testato da tests/test_telefono.py) ──
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// "Oggi", "Ieri", poi "lun 12 ottobre" (con l'anno se non è quello corrente)
function dayLabel(iso, now = new Date()) {
  if (!iso) return "Senza data";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (iso === isoLocal(today)) return "Oggi";
  if (iso === isoLocal(yesterday)) return "Ieri";
  const [y, m, d] = iso.split("-").map(Number);
  const opts = { weekday: "short", day: "numeric", month: "long" };
  if (y !== today.getFullYear()) opts.year = "numeric";
  return new Date(y, m - 1, d).toLocaleDateString("it-IT", opts).replace(",", "");
}
// Righe già ordinate: gruppi consecutivi con la stessa data.
function groupByDay(rows) {
  const out = [];
  for (const t of rows) {
    if (!out.length || out.at(-1).data !== t.data) out.push({ data: t.data, righe: [] });
    out.at(-1).righe.push(t);
  }
  return out;
}

function txRow(t, { pending = false } = {}) {
  const open = !pending && t.contanti !== "portafoglio" && !t.virtuale ? () => (t.contanti ? openCash(t.id) : openEdit(t)) : null;
  const money = t.eur != null ? fmt(t.eur) : `${NUM.format(t.importo)} ${t.valuta}`;
  const cat = pending ? "in attesa" : t.categoria;
  const note = pending ? "In attesa di contabilizzazione: non conta nei totali finché la banca non la contabilizza"
    : t.id?.startsWith("amexpay-") ? "Pagamento della carta: soldi spostati da Isybank alla Amex"
    : t.contanti === "portafoglio" ? "Contante prelevato: entra nel portafoglio"
    : t.contanti ? "Contanti registrati da te" : t.corretto ? "Categoria scelta da te" : null;
  const row = h("div", { class: `tx-row${pending ? " pending" : ""}${open ? " tappable" : ""}`, title: note,
    role: open ? "button" : null, tabindex: open ? "0" : null },
    h("span", { class: "tx-name" }, t.descrizione, !pending && amexOf(t.id) ? h("button", { class: "link-btn amex-link", type: "button", text: " · vedi le voci",
      onclick: () => openAmex(t.id) }) : null),
    h("span", { class: `tx-amount${!pending && t.eur > 0 ? " pos-amt" : ""}`, text: (t.eur > 0 || (pending && t.importo > 0) ? "+" : "") + money }),
    h("span", { class: "tx-meta" }, `${t.banca} · `,
      h("span", { class: `tx-cat ${pending ? "pending-tag" : t.gruppo}${!pending && (t.corretto || t.contanti) ? " learned" : ""}`, text: cat })),
    t.valuta !== "EUR" && t.eur != null ? h("span", { class: "tx-orig", text: `${NUM.format(t.importo)} ${t.valuta}` }) : null);
  if (open) {
    row.addEventListener("click", (e) => { if (!e.target.closest("button")) open(); });
    row.addEventListener("keydown", (e) => {
      if (e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      open();
    });
  }
  return h("li", { class: "tx-item" }, row);
}
function txSection(title, rows, extra = "") {
  return h("section", { class: `tx-section${extra}` },
    h("h3", { class: "tx-day", text: title }),
    h("ul", { class: "tx-group" }, rows));
}
function renderTransactions() {
  const q = state.search.trim().toLowerCase();
  const rows = monthTx().filter((t) =>
    inFilter(t, state.group) &&
    (!state.cat || t.categoria === state.cat) &&
    (!q || t.descrizione.toLowerCase().includes(q) || t.categoria.toLowerCase().includes(q)));
  const total = rows.reduce((a, t) => a + (t.eur || 0), 0);
  // Telefono, senza filtri: solo gli ultimi movimenti; "Mostra tutti" apre l'elenco del periodo.
  const short = PHONE && !state.showAll && !q && !state.cat && state.group === "tutti" && !state.allMonths && rows.length > PHONE_RECENT;
  $("tx-more").hidden = !short;
  if (short) $("tx-more").textContent = `Mostra tutti i ${rows.length} movimenti ${current().year ? `del ${current().key}` : `di ${current().label.toLowerCase()}`}`;
  const shown = short ? rows.slice(0, PHONE_RECENT) : rows;
  // In attesa di contabilizzazione: in cima, solo nel periodo in corso e senza filtri; mai nella somma.
  const pending = current().in_progress && !state.allMonths && !q && !state.cat && state.group === "tutti" ? state.data.in_attesa || [] : [];
  $("tx-sub").textContent = `${short ? `ultimi ${PHONE_RECENT} di ` : ""}${rows.length} movimenti · somma ${fmt(total)}` +
    (state.allMonths ? " · tutti i mesi" : ` · ${current().label.toLowerCase()}`) +
    (pending.length ? ` · ${pending.length} in attesa, fuori dai totali` : "");
  const waiting = pending.length ? [txSection("In attesa", pending.map((t) => txRow(t, { pending: true })), " tx-pending")] : [];
  if (!rows.length) {
    return $("tx-body").replaceChildren(...waiting, h("p", { class: "tx-empty", text: "Nessun movimento con questi filtri." }));
  }
  $("tx-body").replaceChildren(...waiting,
    ...groupByDay(shown).map((g) => txSection(dayLabel(g.data), g.righe.map((t) => txRow(t)))));
}

// ── stato consensi ──────────────────────────────────────────────────────
// Sync fermo: se l'ultimo sync ha più di 2 giorni lo segnaliamo in rosso.
function staleDays() {
  const st = state.data?.stato;
  if (!st?.ultimo_sync) return null;
  const hours = (Date.now() - new Date(st.ultimo_sync).getTime()) / 36e5;
  return hours > 48 ? Math.floor(hours / 24) : null;
}

function renderStatus() {
  const st = state.data.stato;
  const chip = $("status-chip");
  const foot = [];
  if (st) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const banks = st.banche.filter((b) => b.esito !== "non configurata");
    let worst = null;
    for (const b of banks) {
      const days = b.consenso_fino_a ? Math.round((new Date(b.consenso_fino_a) - today) / 864e5) : null;
      b._days = days;
      if (b.esito !== "ok") worst = { level: "critical", text: `${b.nome}: ${b.esito}` };
      else if (days != null && (!worst || (worst.level !== "critical" && days < worst.days))) {
        worst = { level: days <= 7 ? "critical" : days <= 14 ? "warning" : "good", days, text: `Consensi ok · ${days} giorni` };
        if (days <= 14) worst.text = `Rinnova il consenso ${b.nome}: ${days} giorni`;
      }
    }
    const stale = staleDays();
    if (stale != null) worst = { level: "critical", text: `Sync fermo da ${stale} giorni` };
    if (worst) {
      chip.hidden = false;
      const icon = { good: "✓", warning: "!", critical: "✕" }[worst.level];
      chip.classList.toggle("quiet", worst.level === "good");  // tutto ok: forma discreta, il testo resta per i lettori di schermo
      chip.replaceChildren(statusIcon(worst.level, icon, { "aria-hidden": null }), h("span", { class: "chip-text", text: worst.text }));
      chip.setAttribute("aria-label", worst.text);  // sul telefono il testo è nascosto: resta l'icona
      chip.title = worst.text + "\n" + banks.map((b) => `${b.nome}: ${b.esito}${b.consenso_fino_a ? `, consenso fino al ${fmtDate(b.consenso_fino_a)}` : ""}`).join("\n");
    }
    const when = new Date(st.ultimo_sync);
    foot.push(`Ultimo sync: ${when.toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" })}`);
    for (const b of banks) foot.push(`${b.nome}: consenso fino al ${b.consenso_fino_a ? fmtDate(b.consenso_fino_a) : "n/d"}`);
  }
  if (state.data.correzioni) foot.push(`${state.data.correzioni} correzioni insegnate al sistema`);
  foot.push(PHONE ? "I dati restano su GitHub: sul telefono resta solo il token." : "I dati restano su GitHub: nulla viene salvato sul Mac.");
  if (state.data.token_scadenza) foot.push(`Token GitHub valido fino al ${fmtDate(state.data.token_scadenza)}`);
  $("foot").replaceChildren(...foot.map((t) => h("span", { text: t })),
    PHONE ? h("button", { class: "link-btn", type: "button", onclick: askExpiry,
      text: state.data.token_scadenza ? "Cambia la scadenza del token" : "Imposta la scadenza del token (per l'avviso)" }) : "");
}

// Telefono: la scadenza del token la vedi su GitHub (pagina del token); l'app avvisa 3 settimane prima.
async function askExpiry() {
  const now = state.data.token_scadenza ? fmtDate(state.data.token_scadenza) : "";
  const answer = prompt("Data di scadenza del token del telefono (GG/MM/AAAA). La trovi su GitHub → Settings → Developer settings → Fine-grained tokens.", now);
  if (answer == null) return;
  const m = answer.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (answer.trim() && !m) return toast("Data non valida: usa GG/MM/AAAA.");
  const iso = m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
  const { ok, payload } = await api("/api/scadenza", { scadenza: iso });
  if (!ok) return toast(payload.errore || "Non riuscito.");
  setData(payload.dati, current().key);
  render();
  toast(iso ? "Scadenza salvata ✓" : "Scadenza tolta.");
}

// ── tooltip ─────────────────────────────────────────────────────────────
const tt = $("tooltip");
// Sul telefono il tocco non ha un "mouse che esce": il riquadro si chiude toccando altrove,
// scorrendo la pagina o da solo dopo qualche secondo.
let tipOwner = null, tipTimer;
const hideTip = () => { tt.hidden = true; tipOwner = null; clearTimeout(tipTimer); };
const touchOnly = matchMedia("(hover: none)");
document.addEventListener("pointerdown", (e) => { if (!tipOwner || !tipOwner.contains(e.target)) hideTip(); }, true);
addEventListener("scroll", hideTip, { passive: true, capture: true });
// Sul telefono una finestra che si apre non deve far comparire subito la tastiera (copre metà
// schermo): il campo lo tocchi tu. Su Mac il cursore va direttamente nel campo giusto.
function focusField(el, selectAll) {
  if (touchOnly.matches) return;
  el.focus();
  if (selectAll) el.select();
}
if (touchOnly.matches) for (const d of document.querySelectorAll("dialog")) { d.tabIndex = -1; d.autofocus = true; }
function tip(el, content) {
  el.addEventListener("mousemove", (e) => {
    tipOwner = el;
    if (touchOnly.matches) { clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 3000); }
    const [title, rows] = content();
    tt.replaceChildren(h("div", { class: "tt-title", text: title }), ...rows.map(([k, v, color]) =>
      h("div", { class: "tt-row" }, h("span", {}, color ? h("i", { class: "swatch", style: `background:${color}` }) : null, k), h("strong", { text: v }))));
    tt.hidden = false;
    const r = tt.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
    x = Math.max(8, Math.min(x, innerWidth - r.width - 8)); y = Math.max(8, y);  // mai fuori dallo schermo
    tt.style.left = `${x}px`; tt.style.top = `${y}px`;
  });
  el.addEventListener("mouseleave", hideTip);
}

// ── eventi ──────────────────────────────────────────────────────────────
for (const b of $("view-switch").children) b.addEventListener("click", () => {
  if (b.dataset.view === state.view) return;
  const cur = current().key;
  setView(b.dataset.view, b.dataset.view === "anno" ? cur.slice(0, 4) : state.data.mesi.filter((m) => m.key.startsWith(cur)).at(-1)?.key);
});
$("tx-more").addEventListener("click", () => { state.showAll = true; renderTransactions(); });
// Disposizione per tipo di schermo. Telefono/iPad/finestre strette: titolo grande e segmentato in cima alla pagina, sul telefono
// i movimenti subito dopo il patrimonio. Mac (puntatore preciso, >= 641px): titolo del mese e segmentato Mese/Anno stanno nella
// barra degli strumenti, e Impostazioni entra tra le schede a colonne (i Movimenti restano a tutta larghezza in fondo).
const macLayout = matchMedia("(min-width: 641px) and (not ((hover: none) and (pointer: coarse)))");
const macWide = matchMedia("(min-width: 900px) and (not ((hover: none) and (pointer: coarse)))");
function placeParts() {
  const bar = document.querySelector(".topbar-row");
  const dash = $("dashboard");
  if (macLayout.matches) {
    bar.insertBefore($("large-title"), $("nav-title"));
    bar.insertBefore($("view-switch"), document.querySelector(".top-actions"));
    // Impostazioni tra le schede solo con le colonne (>= 900px); più stretto resta in fondo alla pagina
    const wide = macWide.matches;
    dash.querySelector(".grid").after(...(wide ? [$("settings")] : []), $("year-card"), $("tx-card"), ...(wide ? [] : [$("settings")]));
  } else {
    $("view-bar").append($("large-title"), $("view-switch"));
    if (PHONE) $("worth-card").after($("tx-card"));  // telefono: movimenti subito dopo il patrimonio
    dash.append($("year-card"), ...(PHONE ? [] : [$("tx-card")]), $("settings"));
  }
}
placeParts();
macLayout.addEventListener("change", placeParts);
macWide.addEventListener("change", placeParts);

// barra delle schede (solo schermi stretti): il tocco scorre alla scheda, la voce attiva segue lo scorrimento
const tabs = [...document.querySelectorAll("#tabbar .tab[data-target]")];
function setTab(id) {
  for (const t of tabs) {
    if (t.dataset.target === id) t.setAttribute("aria-current", "true");
    else t.removeAttribute("aria-current");
  }
}
for (const t of tabs) t.addEventListener("click", () => {
  const el = $(t.dataset.target);
  setTab(t.dataset.target);
  if (!el || el.hidden) return scrollTo({ top: 0, behavior: "smooth" });
  const bar = $("topbar").getBoundingClientRect().height + 8;
  scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + scrollY - bar), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});
if ("IntersectionObserver" in window) {
  // fascia sottile a circa un terzo dall'alto: la scheda che la attraversa è quella attiva
  // con più colonne (Mac) più schede attraversano la fascia insieme: vince la prima voce della barra
  const inBand = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? inBand.add(e.target.id) : inBand.delete(e.target.id);
    // in cima alla pagina vince la prima voce con la scheda visibile (anche se la sua scheda è corta o nascosta)
    const visible = (t) => { const el = $(t.dataset.target); return el && !el.hidden && el.offsetParent !== null; };
    const first = window.scrollY < 10 ? tabs.find(visible) : tabs.find((t) => inBand.has(t.dataset.target));
    if (first) setTab(first.dataset.target);
  }, { rootMargin: "-30% 0px -65% 0px" });
  for (const t of tabs) { const el = $(t.dataset.target); if (el) io.observe(el); }
}
$("all-months").addEventListener("change", (e) => { state.allMonths = e.target.checked; renderFilters(); renderTransactions(); });
$("prev-month").addEventListener("click", () => setMonth(state.idx - 1));
$("next-month").addEventListener("click", () => setMonth(state.idx + 1));
$("month-select").addEventListener("change", (e) => setMonth(Number(e.target.value)));
$("cat-filter").addEventListener("change", (e) => { state.cat = e.target.value; renderTransactions(); });
$("search").addEventListener("input", (e) => { state.search = e.target.value; renderTransactions(); });
$("refresh").addEventListener("click", () => load(true));
$("retry").addEventListener("click", () => load(true));
$("quit").addEventListener("click", async () => {
  if (PHONE) {  // sul telefono "Esci" scollega: cancella il token da questo dispositivo
    if (!confirm("Scollegare Conti da GitHub su questo telefono? Il token verrà cancellato dal telefono.")) return;
    await api("/api/logout", {});
    state.data = null;
    return load();
  }
  await api("/api/quit", {});
  document.body.replaceChildren(h("main", {}, h("section", { class: "center-card" },
    h("div", { class: "card setup" }, h("h1", { text: "Conti è chiuso" }), h("p", { class: "muted", text: "Puoi chiudere questa finestra." })))));
  window.close();
});
$("token-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("token-input");
  const { ok, payload } = await api("/api/token", { token: input.value, scadenza: $("token-expiry")?.value || "" });
  input.value = "";
  if (!ok) { $("setup-error").hidden = false; $("setup-error").textContent = payload.errore || "Token non valido."; return; }
  load(true);
});
document.addEventListener("keydown", (e) => {
  if (!state.data || e.target.matches("input, select")) return;
  if (e.key === "ArrowLeft") setMonth(state.idx - 1);
  if (e.key === "ArrowRight") setMonth(state.idx + 1);
});
let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.data) { renderTrend(); renderWorth(); } }, 120); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.data && render());

// battito: se la finestra viene chiusa il server si spegne da solo
if (!PHONE) setInterval(() => fetch("/api/ping").catch(() => {}), 20000);
// telefono: quando GitHub ha ricalcolato i dati dopo una modifica, li mostriamo senza ricaricare
document.addEventListener("conti:dati", (e) => {
  if (!state.data) return;
  setData(e.detail, current()?.key);
  buildMonthSelect();
  render();
});

// ── modifica categoria (il sistema impara dalle correzioni) ─────────────
const GENERIC = new Set(["Bonifico in uscita", "Bonifico ricevuto", "(senza descrizione)"]);
let editing = null;
function openEdit(t) {
  editing = t;
  const generic = t.generico ?? GENERIC.has(t.descrizione);
  $("edit-desc").replaceChildren(h("strong", { text: t.descrizione }), ` · ${fmtDate(t.data)} · ${fmt(t.eur)}`);
  $("cat-list").replaceChildren(...state.data.categorie_disponibili.map((c) => h("option", { value: c })));
  $("edit-cat").value = t.categoria;
  $("scope-merchant").textContent = t.simili > 1
    ? `Tutti i movimenti di «${t.descrizione}» (${t.simili}), anche quelli futuri`
    : `Anche i futuri movimenti di «${t.descrizione}»`;
  $("edit-scope").querySelector('input[value="esercente"]').parentElement.hidden = generic;
  $("edit-scope").querySelector(`input[value="${generic || t.corretto === "movimento" ? "movimento" : "esercente"}"]`).checked = true;
  $("edit-hint").textContent = generic
    ? "Descrizione generica: la correzione vale solo per questo movimento."
    : "L'app ricorda la scelta e impara dalle parole del nome a riconoscere da sola esercenti simili.";
  $("edit-reset").hidden = !t.corretto;
  $("edit-error").hidden = true;
  $("edit-advance").hidden = !(t.eur < 0 && t.gruppo === "spesa");
  const trips = state.data.viaggi || [];
  $("edit-trip-field").hidden = !trips.length || t.gruppo !== "spesa";
  $("edit-trip").replaceChildren(h("option", { value: "", text: "Nessun viaggio" }),
    ...trips.map((v) => h("option", { value: v.id, text: `${v.nome} (${fmtDate(v.dal)})` })));
  $("edit-trip").value = trips.find((v) => v.movimenti.includes(t.id))?.id || "";
  $("edit-dialog").showModal();
  focusField($("edit-cat"), true);
}
async function saveEdit(scope) {
  const btn = $("edit-save");
  btn.disabled = true;
  const categoria = $("edit-cat").value.trim();
  const { ok, payload } = await api("/api/correzione", { id: editing.id, categoria, ambito: scope });
  btn.disabled = false;
  if (!ok) {
    const err = $("edit-error");
    err.hidden = false;
    err.replaceChildren(...(payload.sola_lettura ? [
      h("div", { text: "Il token dell'app è in sola lettura. Per salvare le correzioni:" }),
      h("ol", {},
        h("li", { text: "github.com → foto profilo → Settings → Developer settings → Personal access tokens → Fine-grained tokens" }),
        h("li", { text: "apri il token dell'app → Edit → Repository permissions → Contents: Read and write" }),
        h("li", { text: "Update, poi riprova qui (il token resta lo stesso)." })),
    ] : [h("div", { text: payload.errore || "Salvataggio non riuscito." })]));
    return;
  }
  setData(payload.dati, current().key);
  $("edit-dialog").close();
  render();
  toast(payload.avviso || (scope === "ripristina" ? "Ripristinata la categoria automatica." : "Salvato ✓ I report su GitHub si aggiornano tra qualche minuto."));
}
$("edit-form").addEventListener("submit", (e) => {
  e.preventDefault();
  saveEdit(new FormData($("edit-form")).get("scope") || "movimento");
});
$("edit-cancel").addEventListener("click", () => $("edit-dialog").close());
$("edit-reset").addEventListener("click", () => saveEdit("ripristina"));
// "Ho pagato anche per altri": diventa un Previsto da ricevere, abbinato quando arriva il rimborso.
$("edit-advance").addEventListener("click", () => {
  const t = editing;
  $("edit-dialog").close();
  openPlan(null);
  $("cash-title").textContent = "Ho pagato anche per altri";
  $("cash-form").elements.tipo.value = "entrata";
  $("cash-currency").value = t.valuta;
  $("cash-desc").value = `Rimborso da …: ${t.descrizione}`.slice(0, 80);
  $("cash-date").value = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  $("cash-hint").textContent = "Scrivi al posto dei puntini chi ti deve i soldi e quanto. Lo trovi tra i Previsti: quando arriva il rimborso, l'app lo abbina.";
  focusField($("cash-amount"));
});
// Viaggio del movimento: aggiungilo (es. il volo prenotato prima) o toglilo
$("edit-trip").addEventListener("change", async (e) => {
  const t = editing, target = e.target.value;
  const was = (state.data.viaggi || []).find((v) => v.movimenti.includes(t.id))?.id || "";
  if (target === was) return;
  let res = { ok: true, payload: {} };
  if (was) res = await api("/api/viaggi", { azione: "togli", id: was, movimento: t.id });
  if (res.ok && target) res = await api("/api/viaggi", { azione: "aggiungi", id: target, movimento: t.id });
  if (!res.ok) {
    $("edit-error").hidden = false;
    $("edit-error").textContent = res.payload.sola_lettura ? "Il token è in sola lettura: serve Contents: Read and write." : res.payload.errore || "Non riuscito.";
    return;
  }
  setData(res.payload.dati, current().key);
  render();
  toast(target ? "Aggiunto al viaggio ✓" : "Tolto dal viaggio ✓");
});

// ── spese ricorrenti (riconosciute da sole) ─────────────────────────────
function renderRecurring() {
  const list = state.data.ricorrenti || [];
  const box = $("recurring-body");
  if (!list.length) {
    return box.replaceChildren(h("p", { class: "empty", text: "Nessuna spesa ricorrente riconosciuta per ora: servono almeno due pagamenti regolari con importi simili." }));
  }
  const month = list.reduce((a, x) => a + x.mensile, 0);
  box.replaceChildren(
    h("div", { class: "plan-sum two" },
      h("div", {}, h("span", { class: "muted small", text: "Al mese" }), h("strong", { text: fmt(month) })),
      h("div", {}, h("span", { class: "muted small", text: "All'anno" }), h("strong", { text: fmt(month * 12) }))),
    ...list.map((x) => h("div", { class: "internal-row rec-row" },
      h("span", {}, h("strong", { text: x.nome }), h("small", { class: "muted", text: `${x.categoria} · ${x.frequenza}${x.carta ? ` · ${x.carta}` : ""}` })),
      h("span", { class: "muted", text: x.prossimo ? `prossimo ${fmtDate(x.prossimo)}` : "" }),
      h("span", { text: fmt(x.importo) }))));
}

// ── viaggi ──────────────────────────────────────────────────────────────
const shortDate = (iso) => new Date(iso + "T12:00").toLocaleDateString("it-IT", { day: "numeric", month: "short" });
function tripStatus(v) {
  if (v.stato === "futuro") return v.tra_giorni === 1 ? "domani" : `tra ${v.tra_giorni} giorni`;
  if (v.stato === "in_corso") return `in corso · ${fmt(v.totale)} finora`;
  return `${fmt(v.totale)}${v.al_giorno != null ? ` · ${fmt(v.al_giorno)} al giorno` : ""}`;
}
function renderTrips() {
  const list = state.data.viaggi || [];
  const box = $("trips-body");
  if (!list.length) {
    return box.replaceChildren(h("p", { class: "empty", text: "Aggiungi un viaggio con le sue date (anche futuro): durante quei giorni l'app raggruppa le spese e alla fine ti mostra il resoconto." }));
  }
  box.replaceChildren(...[...list].reverse().map((v) => h("button", { class: "plan-main trip-row", type: "button", onclick: () => openTrip(v.id) },
    h("span", { class: "plan-when", text: `${shortDate(v.dal)} – ${shortDate(v.al)}` }),
    h("span", { class: "plan-desc" }, h("strong", { text: v.nome }), v.stato === "in_corso" ? h("span", { class: "badge", text: "in corso" }) : null),
    h("span", { class: "plan-amt", text: tripStatus(v) }))));
}
let tripEditing = null;
function openTrip(id) {
  const v = id ? state.data.viaggi.find((x) => x.id === id) : null;
  tripEditing = v ? id : null;
  $("trip-title").textContent = v ? v.nome : "Nuovo viaggio";
  $("trip-name").value = v ? v.nome : "";
  $("trip-from").value = v ? v.dal : "";
  $("trip-to").value = v ? v.al : "";
  $("trip-delete").hidden = !v;
  $("trip-error").hidden = true;
  const box = $("trip-report");
  if (!v) box.replaceChildren(h("p", { class: "hint", text: "Durante quei giorni le spese finiscono nel viaggio (affitto e abbonamenti esclusi). Le spese fatte prima, come il volo, le aggiungi dalla finestra del movimento." }));
  else if (v.stato === "futuro") box.replaceChildren(h("p", { class: "hint", text: `Parti ${tripStatus(v)}. Spese già aggiunte: ${fmt(v.totale)}.` }));
  else {
    const byId = Object.fromEntries(state.data.movimenti.map((t) => [t.id, t]));
    const max = Math.max(...v.categorie.map((c) => c.speso), 1);
    box.replaceChildren(
      h("div", { class: "plan-sum" },
        h("div", {}, h("span", { class: "muted small", text: v.stato === "in_corso" ? "Speso finora" : "Totale" }), h("strong", { text: fmt(v.totale) })),
        h("div", {}, h("span", { class: "muted small", text: "Al giorno" }), h("strong", { text: v.al_giorno != null ? fmt(v.al_giorno) : "—" })),
        h("div", {}, h("span", { class: "muted small", text: "Giorni" }), h("strong", { text: String(v.giorni) }))),
      h("div", { class: "hbars trip-cats" }, ...v.categorie.map((c) => h("div", { class: "hbar" },
        h("span", { class: "name", text: c.nome }),
        h("div", { class: "track" }, h("div", { class: "fill", style: `width:${(c.speso / max) * 100}%` })),
        h("span", { class: "val", text: EUR0.format(c.speso) })))),
      h("h3", { class: "subhead", text: `Movimenti (${v.movimenti.length})` }),
      h("div", { class: "trip-tx" }, ...v.movimenti.map((tid) => byId[tid]).filter(Boolean).map((t) => h("div", { class: "internal-row trip-line" },
        h("span", {}, h("span", { class: "muted", text: `${fmtDate(t.data)} · ` }), t.descrizione, v.aggiunti.includes(t.id) ? h("span", { class: "badge", text: "aggiunto" }) : null),
        h("span", { text: fmt(t.eur) }),
        h("button", { class: "btn ghost small-btn", type: "button", title: "Togli dal viaggio", text: "Togli",
          onclick: () => tripAction({ azione: "togli", id: v.id, movimento: t.id }) })))),
      splitSection(v),
      ...(v.esclusi.length ? [h("h3", { class: "subhead", text: "Tolti a mano" }),
        h("div", { class: "trip-tx" }, ...v.esclusi.map((tid) => byId[tid]).filter(Boolean).map((t) => h("div", { class: "internal-row trip-line muted" },
          h("span", { text: `${fmtDate(t.data)} · ${t.descrizione}` }), h("span", { text: fmt(t.eur) }),
          h("button", { class: "btn ghost small-btn", type: "button", text: "Rimetti",
            onclick: () => tripAction({ azione: "ripristina", id: v.id, movimento: t.id }) }))))] : []));
  }
  if (!$("trip-dialog").open) $("trip-dialog").showModal();
}
// Dividere le spese del viaggio: quota uguale per tutti; chi ha pagato per il gruppo lo indica.
// Crea Previsti: "da ricevere" da chi ti deve soldi, "da pagare" se sei tu a doverne.
function splitSection(v) {
  const mine = h("input", { type: "text", inputmode: "decimal", value: v.totale.toFixed(2).replace(".", ","), "aria-label": "Spese di gruppo pagate da te" });
  const names = h("input", { type: "text", maxlength: "120", placeholder: "es. Matteo, Luca", "aria-label": "Con chi" });
  const rows = h("div", { class: "split-rows" });
  const result = h("div", { class: "split-result" });
  const create = h("button", { class: "btn primary small-btn", type: "button", text: "Crea i previsti", disabled: true });
  const num = (s) => { const n = Number(String(s).replace(",", ".")); return Number.isFinite(n) && n >= 0 ? n : NaN; };
  let plan = [];
  const recalc = () => {
    const people = [...rows.querySelectorAll("input")].map((i) => ({ nome: i.dataset.nome, pagato: num(i.value || "0") }));
    const myPaid = num(mine.value);
    if (!people.length || Number.isNaN(myPaid) || people.some((p) => Number.isNaN(p.pagato))) {
      plan = []; create.disabled = true;
      return result.replaceChildren(h("p", { class: "muted small", text: "Scrivi con chi hai diviso: la quota si calcola da sola." }));
    }
    const total = myPaid + people.reduce((a, p) => a + p.pagato, 0);
    const share = total / (people.length + 1);
    plan = people.map((p) => ({ ...p, saldo: Math.round((share - p.pagato) * 100) / 100 })).filter((p) => Math.abs(p.saldo) >= 0.01);
    create.disabled = !plan.length;
    result.replaceChildren(
      h("p", { class: "small", text: `Spesa del gruppo ${fmt(total)} · quota a testa ${fmt(share)}` }),
      ...plan.map((p) => h("p", { class: "small" }, h("strong", { text: p.nome }),
        p.saldo > 0 ? ` ti deve ${fmt(p.saldo)}` : ` deve ricevere da te ${fmt(-p.saldo)}`)));
  };
  names.addEventListener("input", () => {
    const list = [...new Set(names.value.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 12);
    const old = Object.fromEntries([...rows.querySelectorAll("input")].map((i) => [i.dataset.nome, i.value]));
    rows.replaceChildren(...list.map((n) => h("label", { class: "split-row" }, h("span", { text: `${n} ha pagato per il gruppo` }),
      h("input", { type: "text", inputmode: "decimal", placeholder: "0", value: old[n] || "", "data-nome": n, oninput: recalc }))));
    recalc();
  });
  mine.addEventListener("input", recalc);
  create.addEventListener("click", async () => {
    create.disabled = true;
    const when = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    let res = null;
    for (const p of plan) {
      res = await api("/api/previsti", { azione: "salva", tipo: p.saldo > 0 ? "entrata" : "spesa", data: when,
        importo: Math.abs(p.saldo).toFixed(2), valuta: "EUR",
        descrizione: p.saldo > 0 ? `${v.nome}: quota di ${p.nome}` : `${v.nome}: da dare a ${p.nome}` });
      if (!res.ok) break;
    }
    if (!res?.ok) {
      create.disabled = false;
      return toast(res?.payload?.sola_lettura ? "Il token è in sola lettura: serve Contents: Read and write." : res?.payload?.errore || "Non riuscito.");
    }
    setData(res.payload.dati, current().key);
    render();
    toast(`Creati ${plan.length} previsti ✓ Li trovi nel riquadro Previsti.`);
  });
  recalc();
  return h("details", { class: "split" }, h("summary", { text: "Dividi le spese con altri" }),
    h("label", { class: "field" }, h("span", { text: "Spese di gruppo pagate da te" }), mine),
    h("label", { class: "field" }, h("span", { text: "Con chi (nomi separati da virgola)" }), names),
    rows, result, h("div", { class: "dialog-actions" }, h("span", { class: "spacer" }), create));
}

async function tripAction(body) {
  $("trip-save").disabled = true;
  const { ok, payload } = await api("/api/viaggi", body);
  $("trip-save").disabled = false;
  if (!ok) {
    $("trip-error").hidden = false;
    $("trip-error").textContent = payload.sola_lettura ? "Il token è in sola lettura: serve Contents: Read and write." : payload.errore || "Salvataggio non riuscito.";
    return false;
  }
  setData(payload.dati, current().key);
  render();
  return true;
}
$("add-trip").addEventListener("click", () => openTrip(null));
$("trip-cancel").addEventListener("click", () => $("trip-dialog").close());
$("trip-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await tripAction({ azione: "salva", id: tripEditing, nome: $("trip-name").value, dal: $("trip-from").value, al: $("trip-to").value })) {
    $("trip-dialog").close();
    toast("Viaggio salvato ✓");
  }
});
$("trip-delete").addEventListener("click", async () => {
  if (!confirm("Eliminare questo viaggio? I movimenti restano, sparisce solo il raggruppamento.")) return;
  if (await tripAction({ azione: "elimina", id: tripEditing })) { $("trip-dialog").close(); toast("Viaggio eliminato."); }
});
// ── contanti registrati a mano e previsti (stessa finestra) ─────────────
let cashEditing = null;
let entryMode = "contanti";  // oppure "previsti"
function setEntryMode(mode) {
  entryMode = mode;
  const amexMode = mode === "amex" || mode === "amexsub";
  const init = mode === "iniziale";
  $("cash-tipo").hidden = init || mode === "amex";
  $("cash-desc-field").hidden = init;
  $("cash-desc").required = !init;
  const plan = mode === "previsti";
  $("tipo-spesa").textContent = plan ? "Da pagare" : "Spesa";
  $("tipo-entrata").textContent = plan ? "Da ricevere" : "Entrata";
  $("cash-date-label").textContent = plan ? "Quando" : "Data";
  $("cash-cat-field").hidden = plan || init;
  $("cash-cat").required = !plan && !init;
  $("cash-hint").hidden = !plan && !init;
  $("cash-hint").textContent = init
    ? "Il contante che avevi già in tasca da quella data. Entra solo nel portafoglio e nel patrimonio: non è un'entrata, una spesa o un prelievo."
    : "Promemoria: non entra in statistiche, report e budget. Quando sul conto arriva un movimento simile, l'app te lo propone.";
  if (init) $("cash-date-label").textContent = "Da quando";
  if (amexMode) {
    $("cash-cat-field").hidden = true;
    $("cash-cat").required = false;
    $("cash-currency").value = "EUR";
    $("cash-currency").closest(".field").hidden = true;
    $("cash-hint").hidden = false;
    $("cash-date-label").textContent = mode === "amexsub" ? "Primo addebito" : "Data";
    $("tipo-spesa").textContent = "Mensile";
    $("tipo-entrata").textContent = "Annuale";
    $("cash-desc").placeholder = mode === "amexsub" ? "es. Netflix" : "es. Ristorante";
    $("cash-hint").textContent = mode === "amexsub"
      ? "Abbonamento pagato con la Amex: compare tra le spese ricorrenti e nel dettaglio dell'addebito. Non si somma alle spese (c'è già l'addebito)."
      : "Spesa fatta con la Amex: finisce nel dettaglio del prossimo addebito. Non si somma alle spese (c'è già l'addebito); quando importi l'estratto conto la sostituisce.";
  } else {
    $("cash-currency").closest(".field").hidden = false;
  }
  $("cash-desc").placeholder = plan ? "es. Matteo mi restituisce la cena" : "es. Caffè al bar";
}
function openPlan(id) {
  const e = id ? (state.data.previsti || []).find((p) => p.id === id) : null;
  setEntryMode("previsti");
  cashEditing = e ? id : null;
  $("cash-title").textContent = e ? "Modifica previsto" : "Nuovo previsto";
  $("cash-form").elements.tipo.value = e && e.importo > 0 ? "entrata" : "spesa";
  $("cash-date").value = e ? e.data : new Date().toISOString().slice(0, 10);
  $("cash-amount").value = e ? Math.abs(e.importo).toFixed(2).replace(".", ",") : "";
  $("cash-currency").value = e ? e.valuta : "EUR";
  $("cash-desc").value = e ? e.descrizione : "";
  $("cash-delete").hidden = !e;
  $("cash-error").hidden = true;
  $("cash-dialog").showModal();
  focusField(e ? $("cash-desc") : $("cash-amount"));
}
function openInitial(id) {
  const e = id ? (state.data.contanti_iniziali || []).find((x) => x.id === id) : null;
  setEntryMode("iniziale");
  cashEditing = e ? id : null;
  $("cash-title").textContent = "Contante che hai già";
  $("cash-date").value = e ? e.data : new Date().toISOString().slice(0, 10);
  $("cash-amount").value = e ? Number(e.importo).toFixed(2).replace(".", ",") : "";
  $("cash-currency").value = e ? e.valuta : "EUR";
  $("cash-delete").hidden = !e;
  $("cash-error").hidden = true;
  $("cash-dialog").showModal();
  focusField($("cash-amount"));
}
function openCash(id) {
  const e = id ? state.data.contanti[id] : null;
  setEntryMode("contanti");
  cashEditing = e ? id : null;
  $("cash-title").textContent = e ? "Modifica contanti" : "Registra contanti";
  const amount = e ? Number(e.importo) : 0;
  $("cash-form").elements.tipo.value = amount > 0 ? "entrata" : "spesa";
  $("cash-date").value = e ? e.data : new Date().toISOString().slice(0, 10);
  $("cash-amount").value = e ? Math.abs(amount).toFixed(2).replace(".", ",") : "";
  let lastCurrency = "EUR";
  try { lastCurrency = localStorage.getItem("conti-valuta") || "EUR"; } catch { /* opzionale */ }
  $("cash-currency").value = e ? e.valuta : lastCurrency;
  $("cash-desc").value = e ? e.descrizione : "";
  $("cash-cat").value = e ? e.categoria : "";
  $("cash-cat-list").replaceChildren(...state.data.categorie_disponibili.map((c) => h("option", { value: c })));
  $("cash-delete").hidden = !e;
  $("cash-error").hidden = true;
  $("cash-dialog").showModal();
  focusField(e ? $("cash-desc") : $("cash-amount"));
}
async function saveCash(action, planId) {
  const f = $("cash-form").elements;
  const plan = entryMode === "previsti" || planId;
  const body = planId ? { azione: "elimina", id: planId } : action === "elimina" ? { azione: "elimina", id: cashEditing } : {
    azione: "salva", id: cashEditing, tipo: f.tipo.value, data: $("cash-date").value,
    importo: $("cash-amount").value.replace(",", "."), valuta: $("cash-currency").value,
    descrizione: $("cash-desc").value, categoria: $("cash-cat").value,
  };
  if (plan) delete body.categoria;
  if ((entryMode === "amex" || entryMode === "amexsub") && !planId) {
    const sub = entryMode === "amexsub";
    const req = action === "elimina" ? { azione: "elimina", tipo: sub ? "abbonamento" : "manuale", id: cashEditing }
      : { azione: "salva", tipo: sub ? "abbonamento" : "manuale", id: cashEditing, data: $("cash-date").value,
        importo: $("cash-amount").value.replace(",", "."), descrizione: $("cash-desc").value,
        frequenza: f.tipo.value === "entrata" ? "annuale" : "mensile" };
    $("cash-save").disabled = true;
    const res = await api("/api/amex", req);
    $("cash-save").disabled = false;
    if (!res.ok) {
      $("cash-error").hidden = false;
      $("cash-error").textContent = res.payload.sola_lettura ? "Il token è in sola lettura: serve Contents: Read and write." : res.payload.errore || "Salvataggio non riuscito.";
      return;
    }
    setData(res.payload.dati, current().key);
    $("cash-dialog").close();
    render();
    return toast(action === "elimina" ? "Eliminato." : "Salvato ✓");
  }
  if (entryMode === "iniziale" && !planId) {
    body.tipo = "iniziale";
    delete body.categoria; delete body.descrizione;
  }
  $("cash-save").disabled = true;
  const { ok, payload } = await api(plan ? "/api/previsti" : "/api/contanti", body);
  $("cash-save").disabled = false;
  if (!ok && planId) return toast(payload.sola_lettura ? "Il token è in sola lettura: serve Contents: Read and write." : payload.errore || "Non riuscito.");
  if (!ok) {
    $("cash-error").hidden = false;
    $("cash-error").textContent = payload.sola_lettura
      ? "Il token dell'app è in sola lettura: su GitHub apri il token → Edit → Contents: Read and write → Update, poi riprova."
      : payload.errore || "Salvataggio non riuscito.";
    return;
  }
  if (!plan) try { localStorage.setItem("conti-valuta", $("cash-currency").value); } catch { /* opzionale */ }
  setData(payload.dati, current().key);
  if ($("cash-dialog").open) $("cash-dialog").close();
  render();
  toast(plan
    ? (planId ? "Fatto ✓ Tolto dai previsti." : action === "elimina" ? "Tolto dai previsti." : "Previsto salvato ✓")
    : entryMode === "iniziale" ? payload.avviso || (action === "elimina" ? "Contante di partenza eliminato." : "Contante di partenza salvato ✓")
    : payload.avviso || (action === "elimina" ? "Movimento in contanti eliminato." : "Contanti salvati ✓"));
}
$("cash-form").addEventListener("submit", (e) => { e.preventDefault(); saveCash("salva"); });
$("cash-cancel").addEventListener("click", () => $("cash-dialog").close());
$("cash-delete").addEventListener("click", () => saveCash("elimina"));
for (const id of ["add-cash", "add-cash-2", "tab-add-cash"]) $(id).addEventListener("click", () => openCash(null));
$("add-plan").addEventListener("click", () => openPlan(null));
$("add-initial").addEventListener("click", () => openInitial(null));

// ── da controllare: doppi addebiti, spese insolite, abbonamenti, movimenti mancanti ──
function renderAlerts() {
  const list = state.data.avvisi || [];
  $("alerts-card").hidden = !list.length;
  if (!list.length) return;
  const byId = Object.fromEntries(state.data.movimenti.map((t) => [t.id, t]));
  $("alerts-body").replaceChildren(...list.map((a) => h("div", { class: "alert-row" },
    statusIcon(a.tipo === "mancanti" || a.tipo === "doppio" ? "critical" : "warning", "!"),
    h("span", { class: "alert-text", text: a.testo }),
    h("span", { class: "alert-actions" },
      a.movimenti.length && byId[a.movimenti.at(-1)] ? h("button", { class: "btn ghost small-btn", type: "button", text: "Vedi",
        onclick: () => openEdit(byId[a.movimenti.at(-1)]) }) : null,
      h("button", { class: "btn small-btn", type: "button", text: "Va bene", title: "Non mostrarlo più",
        onclick: async (e) => {
          e.target.disabled = true;
          const { ok, payload } = await api("/api/avvisi", { azione: "ok", id: a.id });
          if (!ok) { e.target.disabled = false; return toast(payload.sola_lettura ? "Il token è in sola lettura: serve Contents: Read and write." : payload.errore || "Non riuscito."); }
          setData(payload.dati, current().key);
          render();
        } })))));
}

// ── patrimonio: saldi dei conti + contanti (niente investimenti) ────────
// Date sull'asse del patrimonio: da 2 a 5 etichette (in base alla larghezza), un giorno al massimo una volta.
function worthTicks(t0, t1, width) {
  const days = Math.round((t1 - t0) / 864e5);
  const n = Math.max(1, Math.min(days, width < 420 ? 3 : 4));
  const out = [];
  for (let k = 0; k <= n; k++) {
    const t = t0 + Math.round(((t1 - t0) * k) / n / 864e5) * 864e5;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
function renderWorth() {
  const w = state.data.patrimonio;
  $("worth-card").hidden = !w;
  if (!w) return;
  $("worth-total").textContent = fmt(w.totale);
  // le banche sono righe di una lista (etichetta a sinistra, valore grigio a destra), non pillole
  const parts = w.banche.map((b) => h("div", { class: `internal-row worth-part${b.vecchio ? " old" : ""}`,
    title: b.vecchio ? `Ultimo saldo letto il ${fmtDate(b.data)}` : b.incompleto ? "Un conto in valuta senza tasso di cambio non è incluso" : null },
    h("span", { text: b.nome }), h("span", { class: "worth-val", text: fmt(b.eur) }),
    b.vecchio ? h("small", { class: "worth-old", text: `Ultimo saldo letto il ${fmtDate(b.data)}` }) : null));
  if (w.contanti != null) parts.push(h("div", { class: "internal-row worth-part" }, h("span", { text: "Contanti" }), h("span", { class: "worth-val", text: fmt(w.contanti) })));
  $("worth-parts").replaceChildren(...parts);
  const notes = [`Saldi disponibili del ${fmtDate(w.aggiornato)}, come nell'app della banca.`];
  if (w.con_previsti != null) notes.push(`Con i previsti: ${fmt(w.con_previsti)}.`);
  $("worth-note").textContent = notes.join(" ");

  const box = $("worth-chart");
  const pts = w.storico;
  box.classList.toggle("waiting", pts.length < 2);
  if (pts.length < 2) {
    return box.replaceChildren(h("p", { class: "empty small", text: "L'andamento si riempie giorno dopo giorno, a ogni sync." }));
  }
  const W = box.clientWidth || 420, H = box.clientHeight || 150;
  const pad = { l: 44, r: 8, t: 10, b: 22 };
  const vals = pts.map((p) => p.totale);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, Math.abs(hi) * 0.02, 10);
  lo -= span * 0.15; hi += span * 0.15;
  // asse del tempo vero: un giorno senza sync resta un buco, non viene schiacciato
  const day = (p) => Date.parse(p.data + "T12:00");
  const t0 = day(pts[0]), t1 = Math.max(day(pts.at(-1)), t0 + 864e5);
  const xt = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const x = (i) => xt(day(pts[i]));
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.totale).toFixed(1)}`).join("");
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Andamento del patrimonio" });
  for (const v of [lo + (hi - lo) * 0.15, hi - (hi - lo) * 0.15]) {
    svg.append(s("line", { class: "gridline", x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }),
      s("text", { x: pad.l - 8, y: y(v) + 4, "text-anchor": "end" }, compact(v)));
  }
  svg.append(
    s("path", { d: `${line}L${x(pts.length - 1)},${H - pad.b}L${pad.l},${H - pad.b}Z`, fill: css("--series-1"), opacity: "0.12" }),
    s("path", { d: line, fill: "none", stroke: css("--series-1"), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }),
    s("circle", { cx: x(pts.length - 1), cy: y(vals.at(-1)), r: 3.5, fill: css("--series-1") }),
    ...worthTicks(t0, t1, W).map((t, i, all) => s("text", { x: xt(t), y: H - 6,
      "text-anchor": i === 0 ? "start" : i === all.length - 1 ? "end" : "middle" },
      new Date(t).toLocaleDateString("it-IT", { day: "numeric", month: "short" }))));  // ora locale, come t
  const hit = s("rect", { class: "hit", x: pad.l, y: 0, width: W - pad.l - pad.r, height: H });
  let hover = null;
  hit.addEventListener("mousemove", (e) => {
    const r = hit.getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
    hover = pts.reduce((best, p, i) => (Math.abs(day(p) - t) < Math.abs(day(pts[best]) - t) ? i : best), 0);
  });
  tip(hit, () => {
    const p = pts[Math.max(0, Math.min(pts.length - 1, hover ?? pts.length - 1))];
    return [p.oggi ? `${fmtDate(p.data)} · adesso` : fmtDate(p.data), [["Patrimonio", fmt(p.totale), css("--series-1")]]];
  });
  svg.append(hit);
  box.replaceChildren(svg);
}

// ── American Express: dettaglio degli addebiti ──────────────────────────
const amexOf = (txId) => state.data.amex?.addebiti?.find((d) => d.id === txId);
function amexLines(voci, extra) {
  return h("div", { class: "trip-tx" }, ...voci.map((v) => h("div", { class: `internal-row trip-line${v.fonte !== "estratto" ? " link" : ""}`,
    onclick: v.fonte === "manuale" ? () => openAmexEntry("amex", v.id) : v.fonte === "abbonamento" ? () => openAmexEntry("amexsub", v.id.split(":")[0]) : null },
    h("span", {}, h("span", { class: "muted", text: `${fmtDate(v.data)} · ` }), v.descrizione,
      h("small", { class: "muted", text: ` · ${v.categoria}${v.importo < 0 ? " · rimborso" : ""}${v.fonte === "abbonamento" ? " · abbonamento" : v.fonte === "manuale" ? " · inserita da te" : ""}` })),
    h("span", { class: v.importo < 0 ? "pos-amt" : null, text: fmt(v.importo) }), h("span"))), extra || null);
}
function openAmex(txId, upcoming) {
  const d = upcoming || amexOf(txId);
  if (!d) return;
  $("amex-title").textContent = upcoming ? (d.stimato ? "Prossimo addebito Amex (finora)" : "Prossimo addebito Amex") : "Addebito American Express";
  $("amex-sub").textContent = `${d.stimato ? "Stimato il" : "Il"} ${fmtDate(d.data)} · ${fmt(d.importo)}`
    + (d.dal ? ` · spese dal ${fmtDate(d.dal)} al ${fmtDate(d.al)}` : "")
    + (d.fonte === "estratto" ? " · dall'estratto conto" : " · spese inserite da te e abbonamenti");
  const missing = d.non_registrate > 0.005
    ? h("div", { class: "internal-row trip-line warn" }, h("span", { text: "Spese non registrate (senza dettaglio)" }), h("span", { text: fmt(d.non_registrate) }), h("span"))
    : null;
  $("amex-items").replaceChildren(d.voci.length || missing ? amexLines(d.voci, missing)
    : h("p", { class: "empty", text: "Nessuna voce: importa l'estratto conto o aggiungi le spese a mano." }));
  if (!$("amex-dialog").open) $("amex-dialog").showModal();
}
$("amex-close").addEventListener("click", () => $("amex-dialog").close());
function openAmexEntry(mode, id) {
  const a = state.data.amex || {};
  const e = id ? (mode === "amex" ? a.manuali : a.abbonamenti)?.find((x) => x.id === id) : null;
  if ($("amex-dialog").open) $("amex-dialog").close();
  setEntryMode(mode);
  cashEditing = e ? id : null;
  $("cash-title").textContent = mode === "amexsub" ? (e ? "Abbonamento sulla Amex" : "Nuovo abbonamento sulla Amex") : (e ? "Spesa Amex" : "Nuova spesa Amex");
  $("cash-form").elements.tipo.value = e?.frequenza === "annuale" ? "entrata" : "spesa";
  $("cash-date").value = e ? (e.data || e.dal) : new Date().toISOString().slice(0, 10);
  $("cash-amount").value = e ? Number(e.importo).toFixed(2).replace(".", ",") : "";
  $("cash-desc").value = e ? (e.descrizione || e.nome) : "";
  $("cash-delete").hidden = !e;
  $("cash-error").hidden = true;
  $("cash-dialog").showModal();
  focusField(e ? $("cash-desc") : $("cash-amount"));
}
function renderAmex() {
  const a = state.data.amex;
  $("amex-card").hidden = !a;
  if (!a) return;
  $("amex-import").hidden = PHONE;  // il PDF si legge nell'app del Mac
  const rows = [];
  for (const u of a.in_arrivo) {
    if (u.stimato && !u.voci.length) continue;  // nessuna spesa inserita a mano: non serve la riga
    rows.push(h("button", { class: "plan-main", type: "button", onclick: () => openAmex(null, u) },
      h("span", { class: "plan-when", text: u.stimato ? "in corso" : `il ${fmtDate(u.data)}` }),
      h("span", { class: "plan-desc" }, h("strong", { text: u.stimato ? "Spese registrate finora" : "Prossimo addebito" }),
        h("small", { class: "muted", text: ` · ${u.voci.length} voci${u.fonte === "estratto" ? " · estratto conto" : ""}` })),
      h("span", { class: "plan-amt", text: fmt(u.importo) })));
  }
  for (const d of a.addebiti.slice(0, 6)) {
    rows.push(h("button", { class: "plan-main", type: "button", onclick: () => openAmex(d.id) },
      h("span", { class: "plan-when", text: fmtDate(d.data) }),
      h("span", { class: "plan-desc" }, "Addebito",
        h("small", { class: "muted", text: d.fonte === "estratto" ? " · dettaglio completo"
          : d.non_registrate > 0.005 ? ` · ${fmt(d.non_registrate)} senza dettaglio` : " · registrato da te" })),
      h("span", { class: "plan-amt", text: fmt(d.importo) })));
  }
  const subs = a.abbonamenti.map((s) => h("button", { class: "plan-main", type: "button", onclick: () => openAmexEntry("amexsub", s.id) },
    h("span", { class: "plan-when", text: s.frequenza }), h("span", { class: "plan-desc", text: s.nome }),
    h("span", { class: "plan-amt", text: fmt(Number(s.importo)) })));
  $("amex-body").replaceChildren(...rows,
    h("h3", { class: "subhead" }, "Abbonamenti sulla carta ",
      h("button", { class: "link-btn", type: "button", text: "+ aggiungi", onclick: () => openAmexEntry("amexsub", null) })),
    ...(subs.length ? subs : [h("p", { class: "empty small", text: "Nessuno: aggiungi quelli che paghi con la Amex." })]),
    ...(PHONE ? [h("p", { class: "muted small", text: "L'estratto conto (PDF) si importa dall'app del Mac." })] : []));
}
$("amex-add").addEventListener("click", () => openAmexEntry("amex", null));
$("amex-import").addEventListener("click", () => $("amex-file").click());
$("amex-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 10e6) return toast("File troppo grande.");
  toast("Leggo l'estratto conto…");
  let r, payload = {};
  try {
    r = await fetch("/api/amex/estratto", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: await file.arrayBuffer() });
    payload = await r.json();
  } catch { /* rete */ }
  if (!r?.ok) return toast(payload.sola_lettura ? "Il token è in sola lettura: serve Contents: Read and write." : `Importazione non riuscita: ${payload.errore || "riprova"}.`);
  setData(payload.dati, current().key);
  render();
  const s = payload.estratto;
  toast(`Estratto al ${fmtDate(s.chiusura)} importato: ${s.voci} voci${s.quadra ? " ✓ il totale torna" : " · attenzione: il totale non torna, controlla"}.`);
});

// ── previsti: promemoria, mai nei totali ────────────────────────────────
function whenText(iso) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, mo, d] = iso.split("-").map(Number);
  const days = Math.round((new Date(y, mo - 1, d) - today) / 864e5);
  if (days === 0) return "oggi";
  if (days === 1) return "domani";
  if (days < 0) return `in ritardo di ${-days} ${days === -1 ? "giorno" : "giorni"}`;
  return days <= 31 ? `tra ${days} giorni` : fmtDate(iso);
}
async function rejectMatch(button, p) {
  button.disabled = true;
  const { ok, payload } = await api("/api/previsti", { azione: "scarta", id: p.id, movimento: p.forse.id });
  if (!ok) { button.disabled = false; return toast(payload.sola_lettura ? "Il token è in sola lettura: serve Contents: Read and write." : payload.errore || "Non riuscito."); }
  setData(payload.dati, current().key);
  render();
  toast("Va bene: quel movimento non verrà più proposto.");
}
function renderPlanned() {
  const list = state.data.previsti || [];
  const box = $("plan-body");
  if (!list.length) {
    return box.replaceChildren(h("p", { class: "empty", text: "Nessuna voce. Con + Previsto annoti un pagamento che aspetti o una spesa che sai di dover fare: non cambia i totali." }));
  }
  const known = list.filter((p) => p.eur != null);
  const inc = known.filter((p) => p.eur > 0).reduce((a, p) => a + p.eur, 0);
  const out = known.filter((p) => p.eur < 0).reduce((a, p) => a - p.eur, 0);
  const other = list.length - known.length;
  box.replaceChildren(
    h("div", { class: "plan-sum" },
      h("div", {}, h("span", { class: "muted small", text: "Da ricevere" }), h("strong", { class: "pos-amt", text: fmt(inc) })),
      h("div", {}, h("span", { class: "muted small", text: "Da pagare" }), h("strong", { text: fmt(out) })),
      h("div", {}, h("span", { class: "muted small", text: "Netto" }), h("strong", { class: inc - out < 0 ? "neg-amt" : null, text: (inc - out > 0 ? "+" : "") + fmt(inc - out) }))),
    // replaceChildren scriverebbe "null" come testo: solo elementi veri
    ...(other ? [h("p", { class: "muted small", text: `${other} ${other === 1 ? "voce" : "voci"} in altra valuta non ${other === 1 ? "è" : "sono"} nei totali qui sopra.` })] : []),
    ...list.map((p) => h("div", { class: `plan-row${p.scaduto ? " late" : ""}` },
      h("button", { class: "plan-main", type: "button", title: "Clicca per modificare", onclick: () => openPlan(p.id) },
        h("span", { class: "plan-when" },
          p.scaduto ? statusIcon("warning", "!") : null,
          h("span", { text: whenText(p.data) })),
        h("span", { class: "plan-desc", text: p.descrizione }),
        h("span", { class: `plan-amt${p.importo > 0 ? " pos-amt" : ""}`,
          text: p.valuta === "EUR" ? (p.importo > 0 ? "+" : "") + fmt(p.importo) : `${p.importo > 0 ? "+" : ""}${NUM.format(p.importo)} ${p.valuta}` })),
      p.forse ? h("div", { class: "plan-match" },
        statusIcon("good", "✓"),
        h("span", { class: "plan-match-text", text: `Arrivato? «${p.forse.descrizione}» del ${fmtDate(p.forse.data)}, ${p.forse.valuta === "EUR" ? fmt(p.forse.importo) : `${NUM.format(p.forse.importo)} ${p.forse.valuta}`} (${p.forse.banca})` }),
        h("span", { class: "plan-match-actions" },
          h("button", { class: "btn ghost small-btn", type: "button", text: "Non è questo", title: "Il movimento non corrisponde: non proporlo più",
            onclick: (e) => rejectMatch(e.target, p) }),
          h("button", { class: "btn small-btn", type: "button", onclick: () => saveCash("elimina", p.id), text: "Segna come fatto" }))) : null)));
}

let toastTimer;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// barra in alto: il filetto compare solo quando la pagina scorre (come le barre di iOS)
{
  const bar = $("topbar");
  const sync = () => bar.classList.toggle("scrolled", window.scrollY > 0);
  window.addEventListener("scroll", sync, { passive: true });
  sync();
  // altezza reale della barra (cambia con la Dynamic Island, il testo e gli avvisi): sul telefono è fissa
  // titolo grande (come le app di iOS): quando esce sotto la barra, il titolo piccolo compare al centro della barra
  let titleObserver, watched = -1;
  const watchTitle = () => {
    if (!window.IntersectionObserver || watched === bar.offsetHeight) return;
    watched = bar.offsetHeight;
    titleObserver?.disconnect();
    titleObserver = new IntersectionObserver(([e]) => bar.classList.toggle("show-title", !e.isIntersecting && e.boundingClientRect.top < watched),
      { rootMargin: `-${watched}px 0px 0px 0px` });
    titleObserver.observe($("large-title"));
  };
  const measure = () => { document.documentElement.style.setProperty("--topbar-h", `${bar.offsetHeight}px`); watchTitle(); };
  if (window.ResizeObserver) new ResizeObserver(measure).observe(bar);
  else for (const ev of ["resize", "scroll", "load"]) window.addEventListener(ev, measure, { passive: true });  // Safari vecchi
  measure();
}

load();
