"use strict";
/* Conti sul telefono. Al posto del server del Mac, legge e scrive direttamente il repository
   privato su GitHub con un token fine-grained salvato solo su questo telefono.
   - Legge data/app.json, preparato dalle Actions con la stessa logica dei report (nessun calcolo qui).
   - Scrive SOLO i file che scrive anche l'app del Mac (WRITABLE qui sotto).
   - Dopo una modifica aspetta che le Actions ricalcolino app.json e aggiorna la vista da sola.
   - Nessun dato finanziario viene salvato sul telefono: restano solo in memoria finché l'app è aperta.
   Espone window.ContiBackend.api(path, body) con le stesse risposte del server del Mac. */
(() => {
  const REPO = "Frankdinapoli/Conti";
  const API = "https://api.github.com";
  const STORE = "conti-gh";
  const WRITABLE = new Set(["config/correzioni.json", "data/contanti.json", "data/previsti.json", "data/viaggi.json", "data/avvisi.json", "data/amex.json", "config/budget.toml"]);
  const EXPIRY_STORE = "conti-gh-scadenza";
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const CATEGORY_RE = /^[\p{L}\p{N}_'/&.,() -]{2,40}$/u;
  const POLL_MS = 15000;
  const POLL_MAX = 40;  // ~10 minuti
  const STALE_MS = 10 * 60 * 1000;

  const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status, payload });

  // Protezione contro il "clickjacking": l'app non funziona dentro un'altra pagina.
  if (window.top !== window.self) {
    window.ContiBackend = { api: async () => reply(403, { errore: "Conti non si può aprire dentro un'altra pagina." }) };
    return;
  }

  let token = null;
  try { token = localStorage.getItem(STORE); } catch { /* senza memoria del browser: solo per questa sessione */ }

  let snapshot = null;     // ultimo app.json letto (solo in memoria)
  let loadedAt = 0;
  let pending = null;      // { commit, patches: [fn] } dopo una modifica non ancora ricalcolata
  let pollTimer = null;
  let polls = 0;

  class Fail extends Error {
    constructor(status, payload) { super(payload.errore || "errore"); this.status = status; this.payload = payload; }
  }

  async function gh(path, opts = {}) {
    try {
      return await fetch(API + path, {
        method: opts.method || "GET",
        headers: { Accept: opts.accept || "application/vnd.github+json", Authorization: `Bearer ${opts.token || token}`,
          ...(opts.body ? { "Content-Type": "application/json" } : {}) },
        body: opts.body,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new Fail(502, { errore: "GitHub non è raggiungibile: controlla la connessione e riprova." });
    }
  }

  // Messaggi generici: mai il corpo delle risposte di GitHub.
  function failFor(r, writing) {
    if (r.status === 401) return new Fail(401, { setup: true, errore: "Il token non è più valido (scaduto o revocato): creane uno nuovo e incollalo qui." });
    if (writing && (r.status === 403 || r.status === 404)) return new Fail(403, { sola_lettura: true, errore: "il token è in sola lettura" });
    if (r.status === 403 || r.status === 429) return new Fail(502, { errore: "GitHub ha rifiutato la richiesta (limite di richieste o permessi): riprova tra qualche minuto." });
    if (r.status === 404) return new Fail(401, { setup: true, errore: "Il token non vede il repository Conti: in «Repository access» scegli Conti." });
    return new Fail(502, { errore: `GitHub ha risposto con un errore (${r.status}): riprova tra poco.` });
  }

  const encode = (text) => {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
  const sortKeys = (obj) => Object.fromEntries(Object.keys(obj || {}).sort().map((k) => [k, obj[k]]));
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const clean = (text, max) => String(text ?? "").replace(/[\p{C}]/gu, "").split(/\s+/).filter(Boolean).join(" ").slice(0, max);

  // ── lettura ───────────────────────────────────────────────────────────
  async function fetchAppJson() {
    const r = await gh(`/repos/${REPO}/contents/data/app.json?ref=main`, { accept: "application/vnd.github.raw+json" });
    if (r.status === 404) {
      // Il repo si vede (il token è stato verificato) ma il file non c'è ancora.
      const repo = await gh(`/repos/${REPO}`);
      if (!repo.ok) throw failFor(repo, false);
      throw new Fail(502, { errore: "Su GitHub non c'è ancora data/app.json: apri Actions → «Report mensile» → Run workflow (basta una volta), poi riprova." });
    }
    if (!r.ok) throw failFor(r, false);
    let data;
    try { data = await r.json(); } catch { data = null; }
    if (!data || !Array.isArray(data.mesi) || !Array.isArray(data.movimenti)) {
      throw new Fail(502, { errore: "Il file dei dati su GitHub non è leggibile: riprova dopo il prossimo sync." });
    }
    loadedAt = Date.now();
    return data;
  }

  // Le modifiche non ancora ricalcolate da GitHub restano visibili sopra i dati letti.
  // Scadenza del token: GitHub non la fa leggere alle pagine web, quindi la inserisci tu (una volta).
  let tokenExpiry = null;
  try { tokenExpiry = localStorage.getItem(EXPIRY_STORE); } catch { /* facoltativa */ }

  function view() {
    const d = structuredClone(snapshot);
    d.token_scadenza = DATE_RE.test(tokenExpiry || "") ? tokenExpiry : null;
    if (pending) {
      for (const patch of pending.patches) patch(d);
      d.aggiornamento = true;
    }
    return d;
  }

  async function included(data) {
    if (!pending) return true;
    if (!data.commit) return false;
    if (data.commit === pending.commit) return true;
    const r = await gh(`/repos/${REPO}/compare/${pending.commit}...${data.commit}`);
    if (!r.ok) return false;
    const j = await r.json();
    return j.status === "ahead" || j.status === "identical";
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!pending) return;
    if (polls++ >= POLL_MAX) return;  // GitHub è lento: le modifiche restano mostrate, i totali al prossimo "Aggiorna"
    pollTimer = setTimeout(async () => {
      try {
        const data = await fetchAppJson();
        snapshot = data;
        if (await included(data)) {
          pending = null;
          document.dispatchEvent(new CustomEvent("conti:dati", { detail: view() }));
          return;
        }
      } catch { /* rete assente o token scaduto: si riprova al giro dopo */ }
      schedulePoll();
    }, POLL_MS);
  }

  // ── scrittura ─────────────────────────────────────────────────────────
  async function writeJson(path, mutate, message, text = false) {
    if (!WRITABLE.has(path)) throw new Fail(400, { errore: "scrittura non consentita" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await gh(`/repos/${REPO}/contents/${path}?ref=main`);
      let sha, current = text ? "" : {};
      if (r.ok) {
        const j = await r.json();
        sha = j.sha;
        if (text) current = decode(j.content || "");
        else try { current = JSON.parse(decode(j.content || "")) || {}; } catch { current = {}; }
      } else if (r.status !== 404) {
        throw failFor(r, false);
      }
      const content = mutate(current);
      const w = await gh(`/repos/${REPO}/contents/${path}`, {
        method: "PUT",
        body: JSON.stringify({ message, content: encode(content), branch: "main", ...(sha ? { sha } : {}) }),
      });
      if (w.ok) {
        const j = await w.json();
        return j.commit?.sha || null;
      }
      if ((w.status === 409 || w.status === 422) && attempt === 0) continue;  // file cambiato nel frattempo
      throw failFor(w, true);
    }
    throw new Fail(502, { errore: "Salvataggio non riuscito: riprova." });
  }

  function remember(commit, patch) {
    if (!pending) pending = { commit, patches: [] };
    if (commit) pending.commit = commit;
    pending.patches.push(patch);
    polls = 0;
    schedulePoll();
  }

  async function correction(body) {
    const scope = body.ambito;
    if (!["esercente", "movimento", "ripristina"].includes(scope)) return reply(400, { errore: "richiesta non valida" });
    // Validazione sui dati letti da GitHub, mai su quello che arriva dalla pagina.
    const tx = snapshot?.movimenti.find((t) => t.id === String(body.id || ""));
    if (!tx || tx.contanti) return reply(400, { errore: "movimento non trovato" });
    const category = clean(body.categoria, 60);
    if (scope !== "ripristina" && !CATEGORY_RE.test(category)) return reply(400, { errore: "nome di categoria non valido" });
    const merchant = scope === "esercente" && !tx.generico;
    const key = tx.chiave;

    const commit = await writeJson("config/correzioni.json", (cur) => {
      const merchants = { ...(cur.esercenti || {}) }, txs = { ...(cur.movimenti || {}) };
      if (scope === "ripristina") {
        delete merchants[key];
        delete txs[tx.id];
      } else if (merchant) {
        delete txs[tx.id];
        merchants[key] = { categoria: category, esempio: tx.descrizione, data: today() };
      } else {
        txs[tx.id] = { categoria: category, data: today() };
      }
      return JSON.stringify({
        _nota: "Scritto dall'app Conti: correzioni delle categorie. Si può modificare anche a mano.",
        versione: 1,
        esercenti: sortKeys(merchants),
        movimenti: sortKeys(txs),
      }, null, 2) + "\n";
    }, "Correzione categorie dall'app");

    remember(commit, (d) => {
      for (const t of d.movimenti) {
        if (t.contanti) continue;
        if (scope === "ripristina") {
          if (t.id === tx.id || (t.chiave === key && t.corretto === "esercente")) t.corretto = null;
        } else if (merchant ? t.chiave === key && (t.id === tx.id || t.corretto !== "movimento") : t.id === tx.id) {
          t.categoria = category;
          t.corretto = merchant ? "esercente" : "movimento";
        }
      }
      if (scope !== "ripristina" && !d.categorie_disponibili.includes(category)) d.categorie_disponibili.push(category);
    });
    return reply(200, { ok: true, dati: view(), avviso: scope === "ripristina"
      ? "Salvato ✓ La categoria automatica torna appena GitHub ricalcola (1-2 minuti)."
      : "Salvato ✓ Totali e grafici si aggiornano tra 1-2 minuti." });
  }

  // Contante di partenza (quello che avevi già): solo nel portafoglio, mai entrata, spesa o prelievo.
  async function initialCash(body) {
    const action = body.azione;
    const id = String(body.id || "");
    if (!snapshot) return reply(409, { errore: "dati non ancora caricati" });
    if (id && !(view().contanti_iniziali || []).some((e) => e.id === id)) return reply(400, { errore: "voce non trovata" });
    let entry = null;
    if (action === "salva") {
      const when = String(body.data || "");
      const amountText = String(body.importo || "").trim().replace(",", ".");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(when) || Number.isNaN(Date.parse(when)) || !/^\d+(\.\d{1,2})?$/.test(amountText)) {
        return reply(400, { errore: "data o importo non validi" });
      }
      const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
      if (when < "2000-01-01" || when > tomorrow) return reply(400, { errore: "data non valida" });
      const amount = Number(amountText);
      if (!(amount > 0 && amount <= 1000000)) return reply(400, { errore: "l'importo deve essere positivo" });
      const currency = String(body.valuta || "EUR").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) return reply(400, { errore: "valuta non valida" });
      const rnd = crypto.getRandomValues(new Uint8Array(8));
      entry = {
        id: id || `init-${[...rnd].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
        data: when, importo: amount.toFixed(2), valuta: currency,
        eur: currency === "EUR" ? amount.toFixed(2) : null,  // le altre valute le converte GitHub (BCE)
      };
    } else if (!id) {
      return reply(400, { errore: "voce non trovata" });
    }
    const commit = await writeJson("data/contanti.json", (cur) => {
      let list = (Array.isArray(cur.iniziale) ? cur.iniziale : []).filter((e) => e && String(e.id || "").startsWith("init-"));
      list = list.filter((e) => e.id !== id);
      if (entry) list.push(entry);
      list.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.id < b.id ? -1 : 1));
      return JSON.stringify({
        _nota: "Scritto dall'app Conti: spese ed entrate in contanti registrate a mano.",
        versione: 1,
        movimenti: Array.isArray(cur.movimenti) ? cur.movimenti : [],
        ...(list.length ? { iniziale: list } : {}),
      }, null, 2) + "\n";
    }, "Contanti: contante di partenza aggiornato (app)");
    remember(commit, (d) => {
      d.contanti_iniziali = (d.contanti_iniziali || []).filter((e) => e.id !== id);
      if (entry) d.contanti_iniziali.push(entry);
    });
    return reply(200, { ok: true, dati: view(), avviso: "Salvato ✓ Portafoglio e patrimonio si aggiornano tra 1-2 minuti." });
  }

  async function cash(body) {
    const action = body.azione;
    if (!["salva", "elimina"].includes(action)) return reply(400, { errore: "richiesta non valida" });
    if (body.tipo === "iniziale" || String(body.id || "").startsWith("init-")) return await initialCash(body);
    const id = String(body.id || "");
    if (id && !snapshot) return reply(409, { errore: "dati non ancora caricati" });
    if (id && !view().contanti?.[id]) return reply(400, { errore: "movimento non trovato" });

    let entry = null, message;
    if (action === "elimina") {
      if (!id) return reply(400, { errore: "movimento non trovato" });
      message = "Contanti: eliminato un movimento (app)";
    } else {
      const when = String(body.data || "");
      const amountText = String(body.importo || "").trim().replace(",", ".");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(when) || Number.isNaN(Date.parse(when)) || !/^\d+(\.\d{1,2})?$/.test(amountText)) {
        return reply(400, { errore: "data o importo non validi" });
      }
      const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
      if (when < "2000-01-01" || when > tomorrow) return reply(400, { errore: "data non valida" });
      const amount = Number(amountText);
      if (!(amount > 0 && amount <= 100000)) return reply(400, { errore: "l'importo deve essere positivo" });
      if (!["spesa", "entrata"].includes(body.tipo)) return reply(400, { errore: "tipo non valido" });
      const currency = String(body.valuta || "EUR").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) return reply(400, { errore: "valuta non valida" });
      const desc = clean(body.descrizione, 80);
      const category = clean(body.categoria, 60);
      if (!desc) return reply(400, { errore: "scrivi una descrizione" });
      if (!CATEGORY_RE.test(category)) return reply(400, { errore: "nome di categoria non valido" });
      const signed = `${body.tipo === "spesa" ? "-" : ""}${amount.toFixed(2)}`;
      const rnd = crypto.getRandomValues(new Uint8Array(8));
      entry = {
        id: id || `cash-${[...rnd].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
        data: when,
        descrizione: desc,
        importo: signed,
        valuta: currency,
        eur: currency === "EUR" ? signed : null,  // le altre valute le converte il sync notturno (BCE)
        categoria: category,
      };
      message = id ? "Contanti: modificato un movimento (app)" : "Contanti: nuovo movimento (app)";
    }

    const commit = await writeJson("data/contanti.json", (cur) => {
      let list = (Array.isArray(cur.movimenti) ? cur.movimenti : []).filter((e) => e && String(e.id || "").startsWith("cash-"));
      if (id && !list.some((e) => e.id === id)) throw new Fail(400, { errore: "movimento non trovato" });
      list = list.filter((e) => e.id !== id);
      if (entry) list.push(entry);
      list.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return JSON.stringify({
        _nota: "Scritto dall'app Conti: spese ed entrate in contanti registrate a mano.",
        versione: 1,
        movimenti: list,
        ...(Array.isArray(cur.iniziale) && cur.iniziale.length ? { iniziale: cur.iniziale } : {}),  // il contante di partenza resta
      }, null, 2) + "\n";
    }, message);

    remember(commit, (d) => {
      d.movimenti = d.movimenti.filter((t) => t.id !== id);
      if (id) delete d.contanti[id];
      if (!entry) return;
      d.contanti[entry.id] = entry;
      const amount = Number(entry.importo);
      d.movimenti.push({
        data: entry.data, banca: "Contanti", descrizione: entry.descrizione, importo: amount, valuta: entry.valuta,
        eur: entry.eur == null ? null : amount, categoria: entry.categoria, gruppo: amount < 0 ? "spesa" : "entrata",
        id: entry.id, contanti: "manuale", corretto: null, simili: 1, chiave: "", generico: false,
      });
      // stesso ordine dell'app del Mac: data e descrizione, dal più recente
      d.movimenti.sort((a, b) => (a.data !== b.data ? (a.data < b.data ? 1 : -1) : b.descrizione.localeCompare(a.descrizione)));
      if (!d.categorie_disponibili.includes(entry.categoria)) d.categorie_disponibili.push(entry.categoria);
    });
    return reply(200, { ok: true, dati: view(), avviso: action === "elimina"
      ? "Eliminato ✓ Totali e grafici si aggiornano tra 1-2 minuti."
      : "Contanti salvati ✓ Totali e grafici si aggiornano tra 1-2 minuti." });
  }

  // Previsti: promemoria di entrate/spese attese (data/previsti.json), mai nei totali.
  async function planned(body) {
    const action = body.azione;
    if (!["salva", "elimina", "scarta"].includes(action)) return reply(400, { errore: "richiesta non valida" });
    if (!snapshot) return reply(409, { errore: "dati non ancora caricati" });
    const id = String(body.id || "");
    const known = (view().previsti || []).find((p) => p.id === id);
    if (id && !known) return reply(400, { errore: "voce non trovata" });

    let entry = null, message, rejected = null;
    if (action === "elimina") {
      if (!id) return reply(400, { errore: "voce non trovata" });
      message = "Previsti: tolta una voce (app)";
    } else if (action === "scarta") {
      // "Non è questo": il movimento proposto non è quello giusto e non si propone più
      rejected = String(body.movimento || "");
      if (!id || !known.forse || known.forse.id !== rejected) return reply(400, { errore: "abbinamento non trovato" });
      message = "Previsti: abbinamento scartato (app)";
    } else {
      const when = String(body.data || "");
      const amountText = String(body.importo || "").trim().replace(",", ".");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(when) || Number.isNaN(Date.parse(when)) || !/^\d+(\.\d{1,2})?$/.test(amountText)) {
        return reply(400, { errore: "data o importo non validi" });
      }
      const limit = new Date(Date.now() + 5 * 366 * 864e5).toISOString().slice(0, 10);
      if (when < "2000-01-01" || when > limit) return reply(400, { errore: "data non valida" });
      const amount = Number(amountText);
      if (!(amount > 0 && amount <= 1000000)) return reply(400, { errore: "l'importo deve essere positivo" });
      if (!["spesa", "entrata"].includes(body.tipo)) return reply(400, { errore: "tipo non valido" });
      const currency = String(body.valuta || "EUR").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) return reply(400, { errore: "valuta non valida" });
      const desc = clean(body.descrizione, 80);
      if (!desc) return reply(400, { errore: "scrivi una descrizione" });
      const signed = `${body.tipo === "spesa" ? "-" : ""}${amount.toFixed(2)}`;
      const rnd = crypto.getRandomValues(new Uint8Array(8));
      entry = {
        id: id || `plan-${[...rnd].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
        data: when,
        creato: known?.creato || today(),
        descrizione: desc,
        importo: signed,
        valuta: currency,
        eur: currency === "EUR" ? signed : null,
      };
      message = id ? "Previsti: modificata una voce (app)" : "Previsti: nuova voce (app)";
    }

    const commit = await writeJson("data/previsti.json", (cur) => {
      let list = (Array.isArray(cur.voci) ? cur.voci : []).filter((e) => e && String(e.id || "").startsWith("plan-"));
      const old = list.find((e) => e.id === id);
      if (id && !old) throw new Fail(400, { errore: "voce non trovata" });
      const scartati = (Array.isArray(old?.scartati) ? old.scartati : []).filter((x) => typeof x === "string");
      if (rejected) {
        old.scartati = (scartati.includes(rejected) ? scartati : [...scartati, rejected]).slice(-20);
        entry = old;
      } else if (entry) {
        entry.scartati = scartati;  // modificando la voce, gli abbinamenti scartati restano scartati
      }
      list = list.filter((e) => e.id !== id);
      if (entry) list.push(entry);
      list.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return JSON.stringify({
        _nota: "Scritto dall'app Conti: entrate e spese previste. Non entrano nelle statistiche.",
        versione: 1,
        voci: list,
      }, null, 2) + "\n";
    }, message);

    remember(commit, (d) => {
      if (rejected) {
        for (const p of d.previsti || []) if (p.id === id) p.forse = null;
        return;
      }
      d.previsti = (d.previsti || []).filter((p) => p.id !== id);
      if (!entry) return;
      const amount = Number(entry.importo);
      d.previsti.push({ ...entry, importo: amount, eur: entry.eur == null ? null : amount,
        scaduto: entry.data < today(), forse: null });
      d.previsti.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.id < b.id ? -1 : 1));
    });
    return reply(200, { ok: true, dati: view() });
  }

  // Viaggi (data/viaggi.json): nome e date, movimenti tolti o aggiunti a mano.
  async function trips(body) {
    const action = body.azione;
    if (!["salva", "elimina", "togli", "aggiungi", "ripristina"].includes(action)) return reply(400, { errore: "richiesta non valida" });
    if (!snapshot) return reply(409, { errore: "dati non ancora caricati" });
    const id = String(body.id || "");
    const known = (view().viaggi || []).find((v) => v.id === id);
    if ((id || action !== "salva") && !known) return reply(400, { errore: "viaggio non trovato" });
    let entry = null;
    const tx = String(body.movimento || "");
    if (action === "salva") {
      const from = String(body.dal || ""), to = String(body.al || "");
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from || (Date.parse(to) - Date.parse(from)) / 864e5 > 366) {
        return reply(400, { errore: "date non valide (al massimo un anno di viaggio)" });
      }
      const name = clean(body.nome, 60);
      if (!name) return reply(400, { errore: "scrivi il nome del viaggio" });
      const rnd = crypto.getRandomValues(new Uint8Array(8));
      entry = { id: id || `trip-${[...rnd].map((b) => b.toString(16).padStart(2, "0")).join("")}`, nome: name, dal: from, al: to };
    } else if (action !== "elimina" && !snapshot.movimenti.some((t) => t.id === tx)) {
      return reply(400, { errore: "movimento non trovato" });
    }
    const commit = await writeJson("data/viaggi.json", (cur) => {
      let list = (Array.isArray(cur.viaggi) ? cur.viaggi : []).filter((v) => v && String(v.id || "").startsWith("trip-"));
      if (id && !list.some((v) => v.id === id)) throw new Fail(400, { errore: "viaggio non trovato" });
      if (action === "elimina") list = list.filter((v) => v.id !== id);
      else if (action === "salva") {
        const old = list.find((v) => v.id === entry.id);
        list = list.filter((v) => v.id !== entry.id);
        list.push({ ...entry, escludi: old?.escludi || [], includi: old?.includi || [] });
      } else {
        list = list.map((v) => {
          if (v.id !== id) return v;
          const escludi = (v.escludi || []).filter((x) => x !== tx), includi = (v.includi || []).filter((x) => x !== tx);
          if (action === "togli") escludi.push(tx);
          if (action === "aggiungi") includi.push(tx);
          return { ...v, escludi, includi };
        });
      }
      list.sort((a, b) => (a.dal < b.dal ? -1 : a.dal > b.dal ? 1 : a.id < b.id ? -1 : 1));
      return JSON.stringify({
        _nota: "Scritto dall'app Conti: viaggi (date e movimenti tolti o aggiunti a mano).",
        versione: 1,
        viaggi: list,
      }, null, 2) + "\n";
    }, "Viaggi aggiornati dall'app");
    remember(commit, (d) => {
      d.viaggi = d.viaggi || [];
      const amount = (tid) => -(d.movimenti.find((t) => t.id === tid)?.eur || 0);
      if (action === "elimina") d.viaggi = d.viaggi.filter((v) => v.id !== id);
      else if (action === "salva") {
        const old = d.viaggi.find((v) => v.id === entry.id);
        d.viaggi = d.viaggi.filter((v) => v.id !== entry.id);
        d.viaggi.push({ stato: "futuro", giorni: 1, tra_giorni: null, totale: 0, al_giorno: null, categorie: [],
          movimenti: [], esclusi: [], aggiunti: [], valute: [], ...old, ...entry });
        d.viaggi.sort((a, b) => (a.dal < b.dal ? -1 : 1));
      } else {
        const v = d.viaggi.find((x) => x.id === id);
        if (!v) return;
        const had = v.movimenti.includes(tx);
        v.movimenti = v.movimenti.filter((x) => x !== tx);
        v.esclusi = v.esclusi.filter((x) => x !== tx);
        v.aggiunti = v.aggiunti.filter((x) => x !== tx);
        if (action === "togli") { v.esclusi.push(tx); if (had) v.totale -= amount(tx); }
        if (action === "aggiungi") { v.aggiunti.push(tx); v.movimenti.push(tx); if (!had) v.totale += amount(tx); }
        v.totale = Math.round(v.totale * 100) / 100;
      }
    });
    return reply(200, { ok: true, dati: view(), avviso: "Salvato ✓ Il resoconto si aggiorna tra 1-2 minuti." });
  }

  // «Va bene» su un avviso (data/avvisi.json): non ricompare più.
  async function alertOk(body) {
    const id = String(body.id || "");
    const shown = [...(view().avvisi || []), ...(view().consigli || [])];  // anche i consigli si nascondono così
    if (body.azione !== "ok" || !snapshot || !shown.some((a) => a.id === id)) return reply(400, { errore: "avviso non trovato" });
    const commit = await writeJson("data/avvisi.json", (cur) => {
      const ok = new Set((Array.isArray(cur.ok) ? cur.ok : []).filter((x) => typeof x === "string"));
      ok.add(id);
      return JSON.stringify({ _nota: "Scritto dall'app Conti: avvisi già controllati («Va bene»).", versione: 1, ok: [...ok].sort() }, null, 2) + "\n";
    }, "Avvisi controllati dall'app");
    remember(commit, (d) => {
      d.avvisi = (d.avvisi || []).filter((a) => a.id !== id);
      d.consigli = (d.consigli || []).filter((a) => a.id !== id);
    });
    return reply(200, { ok: true, dati: view() });
  }

  // Budget mensili (config/budget.toml): stesso formato che scrive l'app del Mac (app/budget.py).
  const BUDGET_HEADER = `# Budget mensili per categoria, in EUR.
#
# Si modificano dall'app Conti (scheda Budget → Modifica), dal Mac o dal telefono.
# Si può anche modificare qui su GitHub: una riga "Categoria" = importo per ogni budget,
# con il punto per i decimali (es. 99.50). Le categorie senza riga non hanno budget.
#
# In fondo, [obiettivo] risparmio = quanto vuoi mettere da parte ogni mese (scheda Obiettivo).
# Nel report: ✅ sotto l'80%, ⚠️ tra 80% e 100%, 🔴 budget superato.

[budget]
`;
  // Obiettivo di risparmio del mese: stesso calcolo di app/data.py::_goal (finché GitHub non ricalcola).
  function goalFor(m, goal) {
    const out = { importo: goal, messo_da_parte: m.saldo };
    if (m.partial) return { ...out, stato: "parziale" };
    if (!m.in_progress) return { ...out, stato: m.saldo >= goal ? "raggiunto" : "mancato" };
    const extra = (m.previsione?.speso ?? m.speso) - m.speso;
    const expected = m.saldo - extra, left = m.saldo - goal, days = Math.max(m.previsione?.giorni_rimasti || 0, 0);
    return { ...out, stato: expected >= goal ? "in_linea" : left > 0 ? "a_rischio" : "difficile", previsto: expected,
      spendibile: Math.max(left, 0), al_giorno: left > 0 && days ? left / days : null, giorni: days };
  }
  function budgetAmount(value) {
    if (value == null || String(value).trim() === "") return null;
    const n = Number(String(value).trim().replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Fail(400, { errore: "importo non valido" });
    const r = Math.round(n * 100) / 100;
    return r > 0 ? r : null;
  }
  // Legge il formato fisso scritto da budget.dump: righe `"Categoria" = numero` in [budget],
  // `risparmio = numero` in [obiettivo]. null se il testo non si legge.
  function parseBudgetText(text) {
    if (typeof text !== "string" || !/^\[budget\]\s*$/m.test(text)) return null;
    const budget = {};
    let section = "", obiettivo = null;
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const h = /^\[(\w+)\]$/.exec(t);
      if (h) { section = h[1]; continue; }
      if (section === "budget") {
        const m = /^("(?:[^"\\]|\\.)*")\s*=\s*(\d+(?:\.\d+)?)$/.exec(t);
        if (!m) return null;
        try { budget[JSON.parse(m[1])] = Number(m[2]); } catch { return null; }
      } else if (section === "obiettivo") {
        const m = /^risparmio\s*=\s*(\d+(?:\.\d+)?)$/.exec(t);
        if (!m) return null;
        obiettivo = Number(m[1]);
      }
    }
    return { budget, obiettivo };
  }
  async function budgets(body) {
    const changes = body.budget ?? {};
    if (!snapshot || !changes || typeof changes !== "object" || Array.isArray(changes) || Object.keys(changes).length > 100) {
      return reply(400, { errore: "richiesta non valida" });
    }
    const parsed = {};
    for (const [cat, value] of Object.entries(changes)) {
      if (!CATEGORY_RE.test(cat)) return reply(400, { errore: "nome di categoria non valido" });
      parsed[cat] = budgetAmount(value);
    }
    const num = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(2));
    // Si parte dal testo attuale del file su GitHub (non dai dati in memoria, che possono essere
    // vecchi se il Mac ha appena cambiato un budget o l'obiettivo); view() solo se il testo non si legge.
    let next = {}, goal = null;
    const content = (text) => {
      const old = parseBudgetText(text);
      const current = old ? old.budget : (view().budget || Object.fromEntries((view().mesi.at(-1)?.budget || []).map((b) => [b.nome, b.budget])));
      // obiettivo di risparmio: assente = resta com'è, vuoto = tolto
      goal = "obiettivo" in body ? budgetAmount(body.obiettivo) : (old ? old.obiettivo : (view().obiettivo?.importo ?? null));
      next = {};
      for (const [cat, amount] of Object.entries(current)) if (!(cat in parsed) || parsed[cat] != null) next[cat] = cat in parsed ? parsed[cat] : amount;
      for (const [cat, amount] of Object.entries(parsed)) if (amount != null) next[cat] = amount;
      return BUDGET_HEADER + Object.entries(next).map(([c, a]) => `${JSON.stringify(c)} = ${num(a)}`).join("\n") + "\n"
        + (goal != null ? `\n[obiettivo]\nrisparmio = ${num(goal)}\n` : "");
    };
    const commit = await writeJson("config/budget.toml", content, "Budget aggiornati dall'app", true);
    remember(commit, (d) => {
      d.budget = { ...next };
      d.budget_attivi = Object.keys(next).length;
      for (const m of d.mesi) {
        const old = Object.fromEntries((m.budget || []).map((b) => [b.nome, b]));
        m.budget = Object.entries(next).map(([nome, b]) => ({ nome, budget: b,
          speso: m.categorie.find((c) => c.nome === nome)?.speso || 0, previsto: old[nome]?.previsto }));
      }
      for (const s of d.budget_suggeriti || []) s.attuale = next[s.nome] ?? null;
      d.obiettivo = { ...(d.obiettivo || {}), importo: goal };
      for (const m of d.mesi) m.obiettivo = goal != null ? goalFor(m, goal) : null;
    });
    return reply(200, { ok: true, dati: view() });
  }

  // Amex: spese inserite a mano e abbonamenti sulla carta (data/amex.json). Gli estratti si importano dal Mac.
  async function amexEntry(body) {
    const kind = body.tipo, action = body.azione;
    if (!["manuale", "abbonamento", "estratto"].includes(kind) || !["salva", "elimina"].includes(action)) return reply(400, { errore: "richiesta non valida" });
    if (kind === "estratto" && action === "salva") return reply(400, { errore: "l'estratto conto si importa dall'app del Mac" });
    if (!snapshot) return reply(409, { errore: "dati non ancora caricati" });
    const key = { manuale: "manuali", abbonamento: "abbonamenti", estratto: "estratti" }[kind];
    const id = String(body.id || "");
    if ((id || action === "elimina") && !((view().amex || {})[key] || []).some((x) => x.id === id)) return reply(400, { errore: "voce non trovata" });
    let entry = null;
    if (action === "salva") {
      const when = String(body.data || ""), amountText = String(body.importo || "").trim().replace(",", ".");
      if (!DATE_RE.test(when) || !/^\d+(\.\d{1,2})?$/.test(amountText) || !(Number(amountText) > 0 && Number(amountText) <= 100000)) {
        return reply(400, { errore: "data o importo non validi" });
      }
      const desc = clean(body.descrizione, 60);
      if (!desc) return reply(400, { errore: "scrivi una descrizione" });
      const rnd = crypto.getRandomValues(new Uint8Array(8));
      const newId = id || `${kind === "manuale" ? "amexm-" : "amexsub-"}${[...rnd].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      const amount = Number(amountText).toFixed(2);
      if (kind === "manuale") entry = { id: newId, data: when, descrizione: desc, importo: amount };
      else {
        if (!["mensile", "annuale"].includes(body.frequenza)) return reply(400, { errore: "frequenza non valida" });
        entry = { id: newId, nome: desc, importo: amount, frequenza: body.frequenza, dal: when };
      }
    }
    const commit = await writeJson("data/amex.json", (cur) => {
      const out = { estratti: [], manuali: [], abbonamenti: [] };
      for (const k of Object.keys(out)) out[k] = Array.isArray(cur[k]) ? cur[k] : [];
      if (id && !out[key].some((x) => x.id === id)) throw new Fail(400, { errore: "voce non trovata" });
      out[key] = out[key].filter((x) => x.id !== id);
      if (entry) out[key].push(entry);
      return JSON.stringify({ _nota: "Scritto dall'app Conti: dettaglio degli addebiti American Express.", versione: 1, ...out }, null, 2) + "\n";
    }, `Amex: ${kind} aggiornato (app)`);
    remember(commit, (d) => {
      if (!d.amex) return;
      d.amex[key] = (d.amex[key] || []).filter((x) => x.id !== id);
      if (entry) d.amex[key].push(entry);
    });
    return reply(200, { ok: true, dati: view(), avviso: "Salvato ✓ Il dettaglio si aggiorna tra 1-2 minuti." });
  }

  async function setToken(body) {
    const candidate = String(body.token || "").trim();
    if (!candidate || candidate.length > 400 || /\s/.test(candidate)) return reply(400, { errore: "token non valido" });
    const r = await gh(`/repos/${REPO}`, { token: candidate });
    if (r.status === 401) return reply(400, { errore: "GitHub non riconosce questo token: ricopialo per intero." });
    if (r.status === 403 || r.status === 404) return reply(400, { errore: "Il token non vede il repository Conti: in «Repository access» scegli Conti." });
    if (!r.ok) return reply(400, { errore: `Verifica non riuscita (${r.status}): riprova.` });
    token = candidate;
    try { localStorage.setItem(STORE, token); } catch { /* resta solo per questa sessione */ }
    setExpiry(body.scadenza);
    return reply(200, { ok: true });
  }

  function setExpiry(value) {
    const v = String(value || "");
    if (v && !DATE_RE.test(v)) return reply(400, { errore: "data non valida" });
    tokenExpiry = v || null;
    try { v ? localStorage.setItem(EXPIRY_STORE, v) : localStorage.removeItem(EXPIRY_STORE); } catch { /* facoltativa */ }
    return reply(200, { ok: true, dati: snapshot ? view() : null });
  }

  function logout() {
    token = null;
    snapshot = null;
    pending = null;
    clearTimeout(pollTimer);
    try { localStorage.removeItem(STORE); localStorage.removeItem(EXPIRY_STORE); } catch { /* niente da cancellare */ }
    tokenExpiry = null;
    return reply(200, { ok: true });
  }

  async function api(path, body) {
    try {
      const route = path.split("?")[0];
      if (route === "/api/token") return await setToken(body || {});
      if (route === "/api/logout") return logout();
      if (!token) return reply(401, { setup: true });
      if (route === "/api/data") {
        snapshot = await fetchAppJson();
        if (pending && await included(snapshot)) {
          pending = null;
          clearTimeout(pollTimer);
        }
        return reply(200, view());
      }
      if (route === "/api/correzione") return await correction(body || {});
      if (route === "/api/contanti") return await cash(body || {});
      if (route === "/api/previsti") return await planned(body || {});
      if (route === "/api/viaggi") return await trips(body || {});
      if (route === "/api/avvisi") return await alertOk(body || {});
      if (route === "/api/budget") return await budgets(body || {});
      if (route === "/api/amex") return await amexEntry(body || {});
      if (route === "/api/scadenza") return setExpiry((body || {}).scadenza);
      return reply(404, { errore: "non disponibile sul telefono" });
    } catch (e) {
      if (e instanceof Fail) return reply(e.status, e.payload);
      return reply(500, { errore: "Errore imprevisto: riprova." });
    }
  }

  // Aggiornamenti dell'app: se sul sito c'è una versione nuova, la pagina si ricarica da sola
  // (con un indirizzo diverso, così l'iPhone non usa la copia vecchia che tiene in memoria).
  async function checkUpdate() {
    const mine = document.querySelector('meta[name="conti-versione"]')?.content;
    if (!mine || document.querySelector("dialog[open]") || pending) return;
    try {
      const r = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store", credentials: "omit" });
      const latest = r.ok ? (await r.json()).versione : null;
      if (!latest || latest === mine || !/^[0-9a-f]{12}$/.test(latest)) return;
      const tried = `conti-agg-${latest}`;
      try {
        if (sessionStorage.getItem(tried)) return;  // già provato: niente ricariche a ripetizione
        sessionStorage.setItem(tried, "1");
      } catch { /* senza memoria di sessione si prova comunque una volta */ }
      location.replace(`${location.pathname}?v=${latest}`);
    } catch { /* offline: si riprova la prossima volta */ }
  }
  checkUpdate();

  // Riaprendo l'app dopo un po' (era in background), i dati si aggiornano da soli.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkUpdate(); });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !token || !snapshot || pending || Date.now() - loadedAt < STALE_MS) return;
    try {
      snapshot = await fetchAppJson();
      document.dispatchEvent(new CustomEvent("conti:dati", { detail: view() }));
    } catch { /* si riprova con "Aggiorna" */ }
  });

  window.ContiBackend = { api };
})();
