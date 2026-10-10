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

const state = { data: null, idx: 0, group: "tutti", cat: "", search: "", view: "mese", allMonths: false, years: null };

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
  }));
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
  buildMonthSelect();
  render();
}
function setMonth(i) {
  const n = periods().length;
  state.idx = Math.max(0, Math.min(n - 1, i));
  state.cat = "";
  render();
}

// ── rendering ───────────────────────────────────────────────────────────
function render() {
  const list = periods();
  const m = list[state.idx];
  const prev = state.idx > 0 ? list[state.idx - 1] : null;
  const year = state.view === "anno";
  $("month-select").value = state.idx;
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
  const stale = staleDays();
  if (stale != null) notes.unshift(`Il sync automatico non gira da ${stale} giorni: i dati potrebbero non essere aggiornati. Controlla Actions → Sync spese su GitHub (o STATO.md).`);
  $("month-notice").hidden = !notes.length;
  $("month-notice").className = `notice${stale != null ? " critical" : ""}`;
  $("month-notice").textContent = notes.join(" ");

  renderWorth();
  renderAlerts();
  renderTiles(m, prev);
  renderTrend();
  renderCategories(m, prev);
  renderBudget(m);
  renderInternal(m);
  renderWallet(m);
  renderRecurring();
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
  if (Math.abs(d) < 0.005) return h("div", { class: "delta", text: `= rispetto a ${prevLabel}` });
  const good = upIsGood ? d > 0 : d < 0;
  return h("div", { class: "delta" },
    h("span", { class: good ? "good" : "bad", text: `${d > 0 ? "▲ +" : "▼ "}${EUR0.format(d)}` }),
    ` rispetto a ${prevLabel}`);
}

function renderTiles(m, prev) {
  const pl = prev ? prev.short.toLowerCase() : "";
  const tiles = [
    { label: "Entrate", v: m.entrate, p: prev?.entrate, up: true, sub: `di cui da persone ${fmt(m.da_persone)}` },
    { label: "Uscite", v: m.uscite, p: prev?.uscite, up: false, sub: `di cui a persone ${fmt(m.a_persone)}` },
    { label: m.year ? "Saldo dell'anno" : "Saldo del mese", v: m.saldo, p: prev?.saldo, up: true, hero: true, sub: "entrate − uscite" },
    { label: "Totale speso", v: m.speso, p: prev?.speso, up: false,
      sub: m.previsione ? `previsione a fine mese ≈ ${EUR0.format(m.previsione.speso)}` : `${m.categorie.reduce((a, c) => a + c.n, 0)} movimenti` },
  ];
  $("tiles").replaceChildren(...tiles.map((t) =>
    h("div", { class: `card tile${t.hero ? " hero" : ""}` },
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
    return list.replaceChildren(h("p", { class: "empty", text: "Nessun budget impostato. Apri config/budget.toml su GitHub e togli il # davanti alle categorie." }));
  }
  const all = m.budget.map((b) => ({ ...b, r: b.speso / b.budget })).sort((a, b) => b.r - a.r);
  const rows = all.filter((b) => b.speso > 0);
  const unused = all.filter((b) => b.speso <= 0);
  const extra = unused.length ? h("p", { class: "empty small" },
    h("span", { class: "status-icon st-good", "aria-hidden": "true", text: "✓" }),
    ` ${unused.length} budget ancora a 0 €: ${unused.map((b) => b.nome).join(", ")}`) : null;
  list.replaceChildren(...rows.map((b) => {
    const st = b.r > 1 ? ["critical", "✕", "Superato"] : b.r >= 0.8 ? ["warning", "!", "Quasi al limite"]
      : b.previsto > b.budget ? ["warning", "!", `A rischio: a fine mese ≈ ${EUR0.format(b.previsto)}`] : ["good", "✓", "Nei limiti"];
    return h("div", { class: "budget-row" },
      h("span", { class: "bname" }, h("span", { class: `status-icon st-${st[0]}`, "aria-hidden": "true", text: st[1] }),
        h("span", { text: b.nome }), h("span", { class: "muted small", text: `· ${st[2]}` })),
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
function renderTransactions() {
  const q = state.search.trim().toLowerCase();
  const rows = monthTx().filter((t) =>
    inFilter(t, state.group) &&
    (!state.cat || t.categoria === state.cat) &&
    (!q || t.descrizione.toLowerCase().includes(q) || t.categoria.toLowerCase().includes(q)));
  const total = rows.reduce((a, t) => a + (t.eur || 0), 0);
  $("tx-sub").textContent = `${rows.length} movimenti · somma ${fmt(total)}` +
    (state.allMonths ? " · tutti i mesi" : ` · ${current().label.toLowerCase()}`);
  const body = $("tx-body");
  if (!rows.length) return body.replaceChildren(h("tr", {}, h("td", { colspan: 5, class: "empty", text: "Nessun movimento con questi filtri." })));
  body.replaceChildren(...rows.map((t) => h("tr", {},
    h("td", { class: "date", text: fmtDate(t.data) }),
    h("td", { text: t.descrizione }),
    h("td", {}, t.contanti === "portafoglio"
      ? h("span", { class: `tag ${t.gruppo}`, title: "Contante prelevato: entra nel portafoglio", text: t.categoria })
      : h("button", {
        class: `tag ${t.gruppo}${t.corretto || t.contanti ? " learned" : ""}`, type: "button",
        title: t.contanti ? "Contanti registrati da te · clicca per modificare" : t.corretto ? "Categoria scelta da te · clicca per cambiarla" : "Clicca per cambiare la categoria",
        onclick: () => (t.contanti ? openCash(t.id) : openEdit(t)),
      }, t.categoria, h("span", { class: "pen", "aria-hidden": "true", text: "✎" }))),
    h("td", { class: "muted", text: t.banca }),
    h("td", { class: "num" },
      h("span", { class: t.eur > 0 ? "pos-amt" : null, text: (t.eur > 0 ? "+" : "") + fmt(t.eur) }),
      t.valuta !== "EUR" ? h("span", { class: "orig", text: `${NUM.format(t.importo)} ${t.valuta}` }) : null))));
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
      chip.replaceChildren(h("span", { class: `status-icon st-${worst.level}`, text: icon }), h("span", { text: worst.text }));
      chip.title = banks.map((b) => `${b.nome}: ${b.esito}${b.consenso_fino_a ? `, consenso fino al ${fmtDate(b.consenso_fino_a)}` : ""}`).join("\n");
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
  $("edit-cat").select();
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
  $("cash-amount").focus();
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
      h("span", {}, h("strong", { text: x.nome }), h("small", { class: "muted", text: ` · ${x.categoria} · ${x.frequenza}` })),
      h("span", { class: "muted", text: `prossimo ${fmtDate(x.prossimo)}` }),
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
  const init = mode === "iniziale";
  $("cash-tipo").hidden = init;
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
  $("cash-desc").placeholder = plan ? "es. Matteo mi restituisce la cena" : "es. Caffè al bar";
}
function openPlan(id) {
  const e = id ? (state.data.previsti || []).find((p) => p.id === id) : null;
  setEntryMode("previsti");
  cashEditing = e ? id : null;
  $("cash-title").textContent = e ? "Modifica previsto" : "Nuovo previsto";
  $("cash-form").elements.tipo.value = e && e.importo > 0 ? "entrata" : "spesa";
  $("cash-date").value = e ? e.data : new Date().toISOString().slice(0, 10);
  $("cash-amount").value = e ? Math.abs(e.importo).toFixed(2) : "";
  $("cash-currency").value = e ? e.valuta : "EUR";
  $("cash-desc").value = e ? e.descrizione : "";
  $("cash-delete").hidden = !e;
  $("cash-error").hidden = true;
  $("cash-dialog").showModal();
  (e ? $("cash-desc") : $("cash-amount")).focus();
}
function openInitial(id) {
  const e = id ? (state.data.contanti_iniziali || []).find((x) => x.id === id) : null;
  setEntryMode("iniziale");
  cashEditing = e ? id : null;
  $("cash-title").textContent = "Contante che hai già";
  $("cash-date").value = e ? e.data : new Date().toISOString().slice(0, 10);
  $("cash-amount").value = e ? Number(e.importo).toFixed(2) : "";
  $("cash-currency").value = e ? e.valuta : "EUR";
  $("cash-delete").hidden = !e;
  $("cash-error").hidden = true;
  $("cash-dialog").showModal();
  $("cash-amount").focus();
}
function openCash(id) {
  const e = id ? state.data.contanti[id] : null;
  setEntryMode("contanti");
  cashEditing = e ? id : null;
  $("cash-title").textContent = e ? "Modifica contanti" : "Registra contanti";
  const amount = e ? Number(e.importo) : 0;
  $("cash-form").elements.tipo.value = amount > 0 ? "entrata" : "spesa";
  $("cash-date").value = e ? e.data : new Date().toISOString().slice(0, 10);
  $("cash-amount").value = e ? Math.abs(amount).toFixed(2) : "";
  let lastCurrency = "EUR";
  try { lastCurrency = localStorage.getItem("conti-valuta") || "EUR"; } catch { /* opzionale */ }
  $("cash-currency").value = e ? e.valuta : lastCurrency;
  $("cash-desc").value = e ? e.descrizione : "";
  $("cash-cat").value = e ? e.categoria : "";
  $("cash-cat-list").replaceChildren(...state.data.categorie_disponibili.map((c) => h("option", { value: c })));
  $("cash-delete").hidden = !e;
  $("cash-error").hidden = true;
  $("cash-dialog").showModal();
  (e ? $("cash-desc") : $("cash-amount")).focus();
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
for (const id of ["add-cash", "add-cash-2"]) $(id).addEventListener("click", () => openCash(null));
$("add-plan").addEventListener("click", () => openPlan(null));
$("add-initial").addEventListener("click", () => openInitial(null));

// ── da controllare: doppi addebiti, spese insolite, abbonamenti, movimenti mancanti ──
function renderAlerts() {
  const list = state.data.avvisi || [];
  $("alerts-card").hidden = !list.length;
  if (!list.length) return;
  const byId = Object.fromEntries(state.data.movimenti.map((t) => [t.id, t]));
  $("alerts-body").replaceChildren(...list.map((a) => h("div", { class: "alert-row" },
    h("span", { class: `status-icon st-${a.tipo === "mancanti" || a.tipo === "doppio" ? "critical" : "warning"}`, "aria-hidden": "true", text: "!" }),
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
function renderWorth() {
  const w = state.data.patrimonio;
  $("worth-card").hidden = !w;
  if (!w) return;
  $("worth-total").textContent = fmt(w.totale);
  const parts = w.banche.map((b) => h("span", { class: `worth-part${b.vecchio ? " old" : ""}`,
    title: b.vecchio ? `Ultimo saldo letto il ${fmtDate(b.data)}` : b.incompleto ? "Un conto in valuta senza tasso di cambio non è incluso" : null },
    h("span", { class: "muted", text: b.nome }), h("strong", { text: fmt(b.eur) }), b.vecchio ? h("span", { class: "muted", text: ` · ${fmtDate(b.data)}` }) : null));
  if (w.contanti != null) parts.push(h("span", { class: "worth-part" }, h("span", { class: "muted", text: "Contanti" }), h("strong", { text: fmt(w.contanti) })));
  $("worth-parts").replaceChildren(...parts);
  const notes = [`Saldi disponibili del ${fmtDate(w.aggiornato)}, come nell'app della banca.`];
  if (w.con_previsti != null) notes.push(`Con i previsti: ${fmt(w.con_previsti)}.`);
  $("worth-note").textContent = notes.join(" ");

  const box = $("worth-chart");
  const pts = w.storico;
  if (pts.length < 2) {
    return box.replaceChildren(h("p", { class: "empty small", text: "L'andamento si riempie giorno dopo giorno, a ogni sync." }));
  }
  const W = box.clientWidth || 420, H = box.clientHeight || 150;
  const pad = { l: 44, r: 8, t: 10, b: 22 };
  const vals = pts.map((p) => p.totale);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, Math.abs(hi) * 0.02, 10);
  lo -= span * 0.15; hi += span * 0.15;
  const x = (i) => pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r);
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
    s("text", { x: pad.l, y: H - 6 }, fmtDate(pts[0].data)),
    s("text", { x: W - pad.r, y: H - 6, "text-anchor": "end" }, fmtDate(pts.at(-1).data)));
  const hit = s("rect", { class: "hit", x: pad.l, y: 0, width: W - pad.l - pad.r, height: H });
  let hover = null;
  hit.addEventListener("mousemove", (e) => {
    const r = hit.getBoundingClientRect();
    hover = Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1));
  });
  tip(hit, () => {
    const p = pts[Math.max(0, Math.min(pts.length - 1, hover ?? pts.length - 1))];
    return [fmtDate(p.data), [["Patrimonio", fmt(p.totale), css("--series-1")]]];
  });
  svg.append(hit);
  box.replaceChildren(svg);
}

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
          p.scaduto ? h("span", { class: "status-icon st-warning", "aria-hidden": "true", text: "!" }) : null,
          h("span", { text: whenText(p.data) })),
        h("span", { class: "plan-desc", text: p.descrizione }),
        h("span", { class: `plan-amt${p.importo > 0 ? " pos-amt" : ""}`,
          text: p.valuta === "EUR" ? (p.importo > 0 ? "+" : "") + fmt(p.importo) : `${p.importo > 0 ? "+" : ""}${NUM.format(p.importo)} ${p.valuta}` })),
      p.forse ? h("div", { class: "plan-match" },
        h("span", { class: "status-icon st-good", "aria-hidden": "true", text: "✓" }),
        h("span", { class: "plan-match-text", text: `Arrivato? «${p.forse.descrizione}» del ${fmtDate(p.forse.data)}, ${p.forse.valuta === "EUR" ? fmt(p.forse.importo) : `${NUM.format(p.forse.importo)} ${p.forse.valuta}`} (${p.forse.banca})` }),
        h("button", { class: "btn small-btn", type: "button", onclick: () => saveCash("elimina", p.id), text: "Segna come fatto" })) : null)));
}

let toastTimer;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

load();
