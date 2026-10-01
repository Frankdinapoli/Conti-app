"use strict";
/* Conti sul telefono. Al posto del server del Mac, legge e scrive direttamente il repository
   privato su GitHub con un token fine-grained salvato solo su questo telefono.
   - Legge data/app.json, preparato dalle Actions con la stessa logica dei report (nessun calcolo qui).
   - Scrive SOLO config/correzioni.json e data/contanti.json, come l'app del Mac.
   - Dopo una modifica aspetta che le Actions ricalcolino app.json e aggiorna la vista da sola.
   - Nessun dato finanziario viene salvato sul telefono: restano solo in memoria finché l'app è aperta.
   Espone window.ContiBackend.api(path, body) con le stesse risposte del server del Mac. */
(() => {
  const REPO = "Frankdinapoli/Conti";
  const API = "https://api.github.com";
  const STORE = "conti-gh";
  const WRITABLE = new Set(["config/correzioni.json", "data/contanti.json"]);
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
  function view() {
    const d = structuredClone(snapshot);
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
  async function writeJson(path, mutate, message) {
    if (!WRITABLE.has(path)) throw new Fail(400, { errore: "scrittura non consentita" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await gh(`/repos/${REPO}/contents/${path}?ref=main`);
      let sha, current = {};
      if (r.ok) {
        const j = await r.json();
        sha = j.sha;
        try { current = JSON.parse(decode(j.content || "")) || {}; } catch { current = {}; }
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

  async function cash(body) {
    const action = body.azione;
    if (!["salva", "elimina"].includes(action)) return reply(400, { errore: "richiesta non valida" });
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

  async function setToken(body) {
    const candidate = String(body.token || "").trim();
    if (!candidate || candidate.length > 400 || /\s/.test(candidate)) return reply(400, { errore: "token non valido" });
    const r = await gh(`/repos/${REPO}`, { token: candidate });
    if (r.status === 401) return reply(400, { errore: "GitHub non riconosce questo token: ricopialo per intero." });
    if (r.status === 403 || r.status === 404) return reply(400, { errore: "Il token non vede il repository Conti: in «Repository access» scegli Conti." });
    if (!r.ok) return reply(400, { errore: `Verifica non riuscita (${r.status}): riprova.` });
    token = candidate;
    try { localStorage.setItem(STORE, token); } catch { /* resta solo per questa sessione */ }
    return reply(200, { ok: true });
  }

  function logout() {
    token = null;
    snapshot = null;
    pending = null;
    clearTimeout(pollTimer);
    try { localStorage.removeItem(STORE); } catch { /* niente da cancellare */ }
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
      return reply(404, { errore: "non disponibile sul telefono" });
    } catch (e) {
      if (e instanceof Fail) return reply(e.status, e.payload);
      return reply(500, { errore: "Errore imprevisto: riprova." });
    }
  }

  // Riaprendo l'app dopo un po' (era in background), i dati si aggiornano da soli.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !token || !snapshot || pending || Date.now() - loadedAt < STALE_MS) return;
    try {
      snapshot = await fetchAppJson();
      document.dispatchEvent(new CustomEvent("conti:dati", { detail: view() }));
    } catch { /* si riprova con "Aggiorna" */ }
  });

  window.ContiBackend = { api };
})();
