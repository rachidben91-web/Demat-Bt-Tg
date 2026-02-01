/* app.js — DEMAT-BT Technicien (V9.4.1-TG)
   Objectif:
   - Interface technicien "pure" (pas de Référent / pas de Brief)
   - Import PDF local (JOURNEE_YYYY-MM-DD_...pdf)
   - Extraction BT + docs associés (sans zones.json)
   - Affichage responsive (mobile/tablette/PC)
*/

const APP_VERSION = "V9.4.1-TG";

const state = {
  pdfFile: null,
  pdfBytes: null,        // ArrayBuffer
  pdfName: "",
  dayISO: null,          // YYYY-MM-DD
  bts: [],
  docCount: 0,
};

// -------------------------
// DOM helpers
// -------------------------
const $ = (sel) => document.querySelector(sel);
const pdfStatus = () => $("#pdfStatus");
const progMsg = () => $("#progMsg");
const progBar = () => $("#progBar");

function setProgress(message, pct = 0) {
  if (progMsg()) progMsg().textContent = message;
  if (progBar()) progBar().style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function setPdfStatus(message) {
  if (pdfStatus()) pdfStatus().textContent = message;
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function norm(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();
}

// -------------------------
// PDF.js loader
// -------------------------
async function ensurePdfJs() {
  if (window.pdfjsLib) return;

  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Impossible de charger pdf.js"));
    document.head.appendChild(s);
  });

  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// -------------------------
// Date journée
// -------------------------
function parseDayFromFilename(name) {
  const m = String(name || "").match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function parseDayFromText(text) {
  // Essaie dd/mm/yyyy
  const m = String(text || "").match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function updateDayUI() {
  const day = state.dayISO ? state.dayISO : "—";
  const btCount = state.bts.length ? String(state.bts.length) : "—";
  const docCount = state.docCount ? String(state.docCount) : "—";
  const hint = $("#dayHint");
  if (hint) hint.innerHTML = `Journée : <b>${escapeHtml(day)}</b><br/>BT : <b>${escapeHtml(btCount)}</b> • Docs : <b>${escapeHtml(docCount)}</b>`;

  const sub = $("#daySubtitle");
  if (sub) {
    if (state.bts.length) sub.textContent = `Journée : ${day} — ${state.bts.length} BT détecté(s)`;
    else sub.textContent = `Charge un PDF “JOURNÉE_YYYY-MM-DD_…” puis clique Extraire.`;
  }
}

// -------------------------
// Extraction texte (page entière)
// -------------------------
async function extractFullText(page) {
  const tc = await page.getTextContent();
  const items = tc.items || [];
  // Tri lecture approximatif : y desc, x asc
  const picked = items
    .map((it) => {
      const t = it.transform;
      return { str: (it.str || "").trim(), x: t?.[4] ?? 0, y: t?.[5] ?? 0 };
    })
    .filter((p) => p.str);

  picked.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  return norm(picked.map((p) => p.str).join(" "));
}

function pickBTId(text) {
  return ((text || "").match(/BT\d{8,14}/i) || [""])[0].toUpperCase();
}

function pickATId(text) {
  return ((text || "").match(/AT\d{3,}/i) || [""])[0].toUpperCase();
}

function detectDocType(text) {
  const up = String(text || "").toUpperCase();
  if (up.includes("AUTORISATION") || up.includes("AT N") || up.includes("AT N°")) return "AT";
  if (up.includes("PROCEDURE") || up.includes("PROC") || up.includes("ORDONNANCEMENT")) return "PROC";
  if (up.includes("PLAN") || up.includes("PLANS")) return "PLAN";
  if (up.includes("PHOTO") || up.includes("PHOTOS")) return "PHOTO";
  if (up.includes("STREET")) return "STREET";
  return "DOC";
}

function extractMetaFromBTText(text) {
  const t = String(text || "");

  const btId = pickBTId(t);
  const atId = pickATId(t);

  // Objet : prend ce qui suit OBJET ... jusqu'à DATE PREVUE / DATE PRÉVUE / NOM CLIENT
  let objet = "";
  const mObj = t.match(/\bOBJET\b\s*([^]+?)(?=\bDATE\s*PREVUE\b|\bDATE\s*PR\u00C9VUE\b|\bNOM\s*CLIENT\b|\bNOM\b\s*CLIENT\b|$)/i);
  if (mObj) objet = norm(mObj[1]);

  // Date prévue
  let datePrevue = "";
  const mDate = t.match(/\bDATE\s*(?:PREVUE|PR\u00C9VUE)\b\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (mDate) datePrevue = mDate[1];

  // Créneau horaire (ex: 13h00 - 14h00)
  let horaire = "";
  const mHour = t.match(/\b(\d{1,2}h\d{2})\s*[-–]\s*(\d{1,2}h\d{2})\b/i);
  if (mHour) horaire = `${mHour[1]} - ${mHour[2]}`;

  // Client
  let client = "";
  const mClient = t.match(/\bNOM\s*CLIENT\b\s*([^]+?)(?=\bT\u00C9L\b|\bTELEPHONE\b|\bTEL\b|\bADRESSE\b|\b\d{1,4}\s|$)/i);
  if (mClient) client = norm(mClient[1]);

  // Adresse : prend à partir d'un numéro de rue jusqu'à fin
  let adresse = "";
  const mAdr = t.match(/\b(\d{1,4}\s+[^]+?)\b(\d{5})\b/i);
  if (mAdr) {
    // tente de garder jusqu'au CP + ville
    const start = mAdr.index;
    const seg = norm(t.slice(start, Math.min(t.length, start + 160)));
    adresse = seg;
  }

  return { btId, atId, objet, datePrevue, horaire, client, adresse };
}

// -------------------------
// Group pages into BT blocks
// -------------------------
async function extractBTsFromPdf(arrayBuffer, filename) {
  await ensurePdfJs();

  const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;

  const bts = [];
  let current = null;
  let docCount = 0;

  for (let i = 1; i <= pdf.numPages; i++) {
    setProgress(`Analyse page ${i}/${pdf.numPages}…`, Math.round((i / pdf.numPages) * 100));
    const page = await pdf.getPage(i);
    const text = await extractFullText(page);

    const btId = pickBTId(text);
    if (btId) {
      // nouvelle fiche BT
      current = {
        btId,
        pages: [],
        meta: extractMetaFromBTText(text),
      };
      bts.push(current);

      current.pages.push({ page: i, type: "BT", text });
    } else if (current) {
      const type = detectDocType(text);
      current.pages.push({ page: i, type, text });
      docCount++;
    } else {
      // pages avant premier BT -> ignore (rare)
    }
  }

  // Date journée : nom de fichier puis fallback texte
  let day = parseDayFromFilename(filename);
  if (!day && bts.length) {
    day = parseDayFromText(bts[0].pages[0]?.text || "");
  }

  return { bts, docCount, dayISO: day };
}

// -------------------------
// Viewer modal (simple)
// -------------------------
function ensureViewerModal() {
  if ($("#viewerOverlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "viewerOverlay";
  overlay.className = "viewer-overlay";
  overlay.innerHTML = `
    <div class="viewer">
      <div class="viewer__top">
        <div class="viewer__title" id="viewerTitle">Document</div>
        <div class="viewer__actions">
          <button class="btn btn--secondary" id="viewerPrev" title="Page précédente">◀</button>
          <div class="viewer__page" id="viewerPage">—</div>
          <button class="btn btn--secondary" id="viewerNext" title="Page suivante">▶</button>
          <button class="btn" id="viewerClose">Fermer</button>
        </div>
      </div>
      <div class="viewer__body">
        <canvas id="viewerCanvas"></canvas>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hideViewer();
  });
  $("#viewerClose").addEventListener("click", hideViewer);
}

let viewerCtx = null;

async function showViewer(pageNumber, title = "Document") {
  ensureViewerModal();
  await ensurePdfJs();

  const overlay = $("#viewerOverlay");
  overlay.style.display = "flex";

  $("#viewerTitle").textContent = title;

  if (!viewerCtx) {
    viewerCtx = {
      pdf: null,
      page: 1,
      scale: 1.25,
    };
  }

  if (!viewerCtx.pdf) {
    const loadingTask = window.pdfjsLib.getDocument({ data: state.pdfBytes });
    viewerCtx.pdf = await loadingTask.promise;
  }

  viewerCtx.page = Math.max(1, Math.min(viewerCtx.pdf.numPages, pageNumber));
  await renderViewerPage();

  $("#viewerPrev").onclick = async () => {
    viewerCtx.page = Math.max(1, viewerCtx.page - 1);
    await renderViewerPage();
  };
  $("#viewerNext").onclick = async () => {
    viewerCtx.page = Math.min(viewerCtx.pdf.numPages, viewerCtx.page + 1);
    await renderViewerPage();
  };
}

function hideViewer() {
  const overlay = $("#viewerOverlay");
  if (overlay) overlay.style.display = "none";
}

async function renderViewerPage() {
  const canvas = $("#viewerCanvas");
  const pageLabel = $("#viewerPage");

  const page = await viewerCtx.pdf.getPage(viewerCtx.page);
  const viewport = page.getViewport({ scale: viewerCtx.scale });

  const ctx = canvas.getContext("2d");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  pageLabel.textContent = `Page ${viewerCtx.page} / ${viewerCtx.pdf.numPages}`;

  await page.render({ canvasContext: ctx, viewport }).promise;
}

// -------------------------
// UI rendering
// -------------------------
function renderCards() {
  const root = $("#techCards");
  if (!root) return;

  if (!state.bts.length) {
    root.innerHTML = "";
    updateDayUI();
    return;
  }

  root.innerHTML = state.bts.map((bt, idx) => {
    const m = bt.meta || {};
    const title = m.btId || bt.btId || `BT ${idx + 1}`;

    const chips = bt.pages.map((p) => {
      const label = `${p.type} (p.${p.page})`;
      return `<button class="chip" data-page="${p.page}" data-title="${escapeHtml(title)}" title="Ouvrir page ${p.page}">${escapeHtml(label)}</button>`;
    }).join("");

    const lines = [];
    if (m.objet) lines.push(`<div class="kv"><span class="k">🧾 OBJET</span><span class="v">${escapeHtml(m.objet)}</span></div>`);
    if (m.datePrevue) lines.push(`<div class="kv"><span class="k">📅 DATE</span><span class="v">${escapeHtml(m.datePrevue)}</span></div>`);
    if (m.horaire) lines.push(`<div class="kv"><span class="k">⏱️ HORAIRE</span><span class="v">${escapeHtml(m.horaire)}</span></div>`);
    if (m.client) lines.push(`<div class="kv"><span class="k">👤 CLIENT</span><span class="v">${escapeHtml(m.client)}</span></div>`);
    if (m.adresse) lines.push(`<div class="kv"><span class="k">📍 ADRESSE</span><span class="v">${escapeHtml(m.adresse)}</span></div>`);

    const badges = [];
    if (m.atId) badges.push(`<span class="pill pill--blue">${escapeHtml(m.atId)}</span>`);
    badges.push(`<span class="pill pill--gray">${escapeHtml(bt.pages.length)} page(s)</span>`);

    return `
      <article class="btcard">
        <div class="btcard__head">
          <div class="btcard__title">${escapeHtml(title)}</div>
          <div class="btcard__badges">${badges.join(" ")}</div>
        </div>
        <div class="btcard__body">
          ${lines.join("") || `<div class="hint">(Infos BT non détectées — tu peux quand même ouvrir les pages.)</div>`}
        </div>
        <div class="btcard__chips">${chips}</div>
      </article>
    `;
  }).join("");

  // attach listeners
  root.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const p = Number(btn.getAttribute("data-page"));
      const t = btn.getAttribute("data-title") || "Document";
      await showViewer(p, t);
    });
  });

  updateDayUI();
}

// -------------------------
// Cache (localStorage)
// -------------------------
const LS_KEY = "dematbt_tg_state_v1";

function clearCache() {
  localStorage.removeItem(LS_KEY);
  setProgress("Cache vidé.", 0);
}

// -------------------------
// Events
// -------------------------
async function onPickPdf(file) {
  state.pdfFile = file;
  state.pdfName = file?.name || "";

  setPdfStatus(state.pdfName ? state.pdfName : "Aucun PDF");

  state.dayISO = parseDayFromFilename(state.pdfName);
  updateDayUI();
}

async function onExtract() {
  try {
    if (!state.pdfFile) {
      alert("Importe d'abord un PDF de journée.");
      return;
    }

    setProgress("Lecture du PDF…", 5);
    const buf = await state.pdfFile.arrayBuffer();
    state.pdfBytes = buf;

    const { bts, docCount, dayISO } = await extractBTsFromPdf(buf, state.pdfName);

    state.bts = bts;
    state.docCount = docCount;
    state.dayISO = dayISO || state.dayISO;

    setProgress(`Terminé : ${bts.length} BT détecté(s).`, 100);
    renderCards();
  } catch (err) {
    console.error("[DEMAT-BT TG] Erreur extraction:", err);
    setProgress("Erreur extraction (voir console).", 0);
    alert(`Erreur d'extraction : ${err?.message || err}`);
  }
}

function initTopDatetime() {
  const el = $("#topDatetime");
  if (!el) return;
  const tick = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    el.textContent = `${d.toLocaleDateString("fr-FR", { weekday: "long" })} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} — ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

function initFullscreenButton() {
  const btn = $("#btnFullscreen");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (e) {
      console.warn("Fullscreen error", e);
    }
  });
}

function init() {
  console.log(`[DEMAT-BT] Technicien init ${APP_VERSION}`);

  initTopDatetime();
  initFullscreenButton();
  updateDayUI();

  $("#pdfFile").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) onPickPdf(f);
  });

  $("#btnExtract").addEventListener("click", onExtract);
  $("#btnClearCache").addEventListener("click", clearCache);

  setProgress("Prêt.", 0);
}

document.addEventListener("DOMContentLoaded", init);
