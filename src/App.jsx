import { useState, useEffect, useRef, useCallback } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  writeBatch,
} from "firebase/firestore";

// ── FIREBASE ──────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAbAvCI9jwKzAdqxp7TBsPRKo2seIg2CSk",
  authDomain: "wedding-checkin-be0f5.firebaseapp.com",
  projectId: "wedding-checkin-be0f5",
  storageBucket: "wedding-checkin-be0f5.firebasestorage.app",
  messagingSenderId: "143671596549",
  appId: "1:143671596549:web:36ded6bacd8b68e5a66e6c",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ── CSV/EXCEL PARSER ──────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("Ficheiro sem dados");
  const sep = lines[0].includes(";")
    ? ";"
    : lines[0].includes("\t")
    ? "\t"
    : ",";
  const headers = lines[0]
    .split(sep)
    .map((h) => h.trim().replace(/^"|"$/g, ""));
  return lines
    .slice(1)
    .map((line) => {
      const vals = line.split(sep).map((v) => v.trim().replace(/^"|"$/g, ""));
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = vals[i] || "";
      });
      return obj;
    })
    .filter((r) => Object.values(r).some((v) => v));
}

function normalize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function detectCol(headers, candidates) {
  const normed = headers.map((h) => ({ orig: h, n: normalize(h) }));
  for (const c of candidates) {
    const nc = normalize(c);
    const found = normed.find(
      (h) => h.n === nc || h.n.includes(nc) || nc.includes(h.n)
    );
    if (found) return found.orig;
  }
  return null;
}

function processRows(rows) {
  if (!rows.length) throw new Error("Ficheiro vazio");
  const headers = Object.keys(rows[0]);
  const nameCol = detectCol(headers, [
    "nome",
    "name",
    "convidado",
    "guest",
    "convidados",
    "guests",
  ]);
  const tableCol = detectCol(headers, [
    "mesa",
    "table",
    "seat",
    "lugar",
    "numero",
    "número",
  ]);
  const notesCol = detectCol(headers, [
    "notas",
    "notes",
    "dieta",
    "observacoes",
    "observações",
    "obs",
    "diet",
    "especial",
    "special",
    "restricoes",
    "restrições",
  ]);
  if (!nameCol)
    throw new Error(
      "Coluna de nome não encontrada.\nUsa: Nome, Name ou Convidado"
    );
  return rows
    .map((r) => ({
      name: String(r[nameCol] || "").trim(),
      table: tableCol ? String(r[tableCol] || "").trim() : "",
      notes: notesCol ? String(r[notesCol] || "").trim() : "",
      checkedIn: false,
      checkedInAt: null,
    }))
    .filter((g) => g.name);
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const ext = file.name.split(".").pop().toLowerCase();

    if (ext === "csv" || ext === "txt") {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          resolve(processRows(parseCSV(e.target.result)));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error("Erro ao ler ficheiro"));
      reader.readAsText(file, "UTF-8");
      return;
    }

    if (ext === "xlsx" || ext === "xls") {
      const doRead = () => {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const wb = window.XLSX.read(e.target.result, { type: "array" });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = window.XLSX.utils.sheet_to_json(ws, { defval: "" });
            resolve(processRows(rows));
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(new Error("Erro ao ler ficheiro"));
        reader.readAsArrayBuffer(file);
      };
      if (window.XLSX) {
        doRead();
        return;
      }
      const script = document.createElement("script");
      script.src =
        "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      script.onload = doRead;
      script.onerror = () =>
        reject(
          new Error(
            "Não foi possível carregar o leitor de Excel.\nTenta converter para CSV."
          )
        );
      document.head.appendChild(script);
      return;
    }

    reject(new Error("Formato não suportado. Usa .xlsx ou .csv"));
  });
}

function formatTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
}

// ── FIRESTORE API ─────────────────────────────────────────────
const api = {
  // Cria evento e devolve o ID
  createEvent: async (name, date) => {
    const ref = await addDoc(collection(db, "events"), {
      name,
      date: date || "",
      createdAt: serverTimestamp(),
    });
    return ref.id;
  },

  // Adiciona todos os convidados em batch
  addGuests: async (eventId, guests) => {
    const batch = writeBatch(db);
    guests.forEach((g) => {
      const ref = doc(collection(db, "events", eventId, "guests"));
      batch.set(ref, g);
    });
    await batch.commit();
  },

  // Escuta eventos em tempo real
  listenEvents: (cb) => {
    const q = query(collection(db, "events"), orderBy("createdAt", "desc"));
    return onSnapshot(q, (snap) =>
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
  },

  // Escuta convidados de um evento em tempo real
  listenGuests: (eventId, cb) => {
    const col = collection(db, "events", eventId, "guests");
    return onSnapshot(col, (snap) =>
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
  },

  // Toggle check-in
  toggleCheckin: async (eventId, guestId, currentState) => {
    const ref = doc(db, "events", eventId, "guests", guestId);
    await updateDoc(ref, {
      checkedIn: !currentState,
      checkedInAt: !currentState ? serverTimestamp() : null,
    });
  },
};

// ── STYLES ────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400;1,500&family=Jost:wght@300;400;500&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --cream:    #faf8f3;
  --parchment:#f3ece0;
  --linen:    #e6ddd0;
  --taupe:    #bfad96;
  --warm:     #8b7255;
  --deep:     #5a4230;
  --espresso: #38281a;
  --gold:     #c8a84b;
  --gold-lt:  #e8c97a;
  --sage:     #6b8f70;
  --sage-bg:  #edf4ee;
  --sage-bd:  #89b08e;
  --radius:   5px;
  --sh:       0 2px 24px rgba(80,50,20,.07);
}

body { background: var(--cream); color: var(--espresso); font-family: 'Jost', sans-serif; font-weight: 300; }
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: var(--parchment); }
::-webkit-scrollbar-thumb { background: var(--taupe); border-radius: 10px; }

.app { min-height: 100vh; background: var(--cream); }

.hd { text-align: center; padding: 44px 24px 28px; border-bottom: 1px solid var(--linen); background: linear-gradient(180deg,#fff 0%,var(--cream) 100%); }
.hd-rule { width: 48px; height: 1px; background: var(--gold); margin: 0 auto 18px; }
.hd-title { font-family:'Cormorant Garamond',serif; font-size:clamp(26px,5vw,42px); font-weight:300; letter-spacing:.08em; line-height:1.15; color:var(--espresso); }
.hd-title em { font-style:italic; color:var(--warm); }
.hd-sub { font-size:10px; letter-spacing:.35em; text-transform:uppercase; color:var(--taupe); margin-top:8px; }

.snav { display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-bottom:1px solid var(--linen); background:rgba(250,248,243,.96); backdrop-filter:blur(8px); position:sticky; top:0; z-index:20; }
.snav-name { font-family:'Cormorant Garamond',serif; font-size:19px; font-weight:500; }
.snav-date { font-size:11px; color:var(--taupe); letter-spacing:.1em; margin-top:1px; }

.wrap { max-width:780px; margin:0 auto; padding:32px 18px 80px; }
.card { background:#fff; border:1px solid var(--linen); border-radius:var(--radius); padding:32px; box-shadow:var(--sh); margin-bottom:16px; }

.slabel { font-size:10px; letter-spacing:.35em; text-transform:uppercase; color:var(--gold); margin-bottom:20px; display:flex; align-items:center; gap:12px; }
.slabel::after { content:''; flex:1; height:1px; background:var(--linen); }

.flabel { display:block; font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:var(--warm); margin-bottom:7px; }
.finput { width:100%; padding:11px 15px; border:1px solid var(--linen); border-radius:var(--radius); background:var(--cream); font-family:'Jost',sans-serif; font-size:14px; color:var(--espresso); outline:none; transition:border-color .2s,background .2s; }
.finput:focus { border-color:var(--taupe); background:#fff; }
.finput::placeholder { color:var(--taupe); }
.fgroup { margin-bottom:18px; }

.drop { border:1.5px dashed var(--taupe); border-radius:var(--radius); padding:28px 20px; text-align:center; cursor:pointer; transition:all .2s; background:var(--cream); user-select:none; }
.drop:hover,.drop.over { border-color:var(--gold); background:rgba(200,168,75,.04); }
.drop-icon { font-size:26px; display:block; margin-bottom:8px; }
.drop-text { font-size:13px; color:var(--warm); line-height:1.6; }
.drop-hint { font-size:11px; color:var(--taupe); margin-top:5px; letter-spacing:.05em; }

.file-ok { display:flex; align-items:center; gap:12px; padding:13px 15px; background:var(--sage-bg); border:1px solid var(--sage-bd); border-radius:var(--radius); font-size:13px; color:var(--deep); }
.file-ok-icon { color:var(--sage); font-size:16px; flex-shrink:0; }

.btn-main { width:100%; padding:15px; background:var(--espresso); color:var(--gold-lt); border:none; border-radius:var(--radius); font-family:'Jost',sans-serif; font-size:11px; letter-spacing:.3em; text-transform:uppercase; cursor:pointer; transition:background .2s,opacity .2s; }
.btn-main:hover:not(:disabled) { background:var(--deep); }
.btn-main:disabled { opacity:.45; cursor:not-allowed; }

.btn-sec { padding:9px 18px; background:transparent; color:var(--warm); border:1px solid var(--taupe); border-radius:var(--radius); font-family:'Jost',sans-serif; font-size:11px; letter-spacing:.2em; text-transform:uppercase; cursor:pointer; transition:all .2s; white-space:nowrap; }
.btn-sec:hover { border-color:var(--warm); color:var(--espresso); }
.btn-ghost { padding:6px 12px; background:transparent; color:var(--taupe); border:none; font-family:'Jost',sans-serif; font-size:12px; cursor:pointer; transition:color .2s; }
.btn-ghost:hover { color:var(--warm); }

.tabs { display:flex; gap:6px; margin-bottom:20px; flex-wrap:wrap; }
.tab { padding:9px 16px; border:1px solid var(--linen); border-radius:30px; background:#fff; font-family:'Jost',sans-serif; font-size:11px; letter-spacing:.15em; color:var(--taupe); cursor:pointer; transition:all .2s; white-space:nowrap; }
.tab:hover { border-color:var(--taupe); color:var(--warm); }
.tab.active { background:var(--espresso); color:var(--gold-lt); border-color:var(--espresso); }

.ev-item { display:flex; align-items:center; justify-content:space-between; padding:16px 18px; border:1px solid var(--linen); border-radius:var(--radius); margin-bottom:9px; cursor:pointer; transition:all .2s; background:#fff; }
.ev-item:hover { border-color:var(--taupe); box-shadow:var(--sh); transform:translateY(-1px); }
.ev-name { font-family:'Cormorant Garamond',serif; font-size:19px; font-weight:500; }
.ev-meta { font-size:11px; color:var(--taupe); letter-spacing:.08em; margin-top:2px; }
.ev-badge { font-size:11px; color:var(--warm); background:var(--parchment); padding:4px 12px; border-radius:20px; }

.stats { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--linen); border-radius:var(--radius); overflow:hidden; margin-bottom:20px; }
.stat { background:#fff; padding:18px 12px; text-align:center; }
.stat-n { font-family:'Cormorant Garamond',serif; font-size:30px; font-weight:300; line-height:1; }
.stat-l { font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:var(--taupe); margin-top:4px; }

.prog-wrap { height:3px; background:var(--linen); border-radius:2px; margin-bottom:24px; overflow:hidden; }
.prog-fill { height:100%; background:linear-gradient(90deg,var(--warm),var(--gold)); border-radius:2px; transition:width .6s ease; }

.lcb { display:flex; align-items:center; gap:14px; padding:14px 18px; background:linear-gradient(135deg,var(--espresso),var(--deep)); border-radius:var(--radius); margin-bottom:18px; }
.lcb-dot { width:7px; height:7px; border-radius:50%; background:var(--gold); animation:pulse 2s infinite; flex-shrink:0; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
.lcb-label { font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:rgba(255,255,255,.5); }
.lcb-name { font-family:'Cormorant Garamond',serif; font-size:17px; color:var(--gold-lt); font-weight:500; margin-top:1px; }

.ctrls { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
.search-wrap { flex:1; min-width:160px; position:relative; }
.search-wrap input { width:100%; padding:10px 14px 10px 36px; border:1px solid var(--linen); border-radius:var(--radius); background:var(--cream); font-family:'Jost',sans-serif; font-size:13px; color:var(--espresso); outline:none; transition:all .2s; }
.search-wrap input:focus { border-color:var(--taupe); background:#fff; }
.search-wrap input::placeholder { color:var(--taupe); }
.search-icon { position:absolute; left:11px; top:50%; transform:translateY(-50%); color:var(--taupe); font-size:15px; pointer-events:none; }
.sort-sel { padding:10px 14px; border:1px solid var(--linen); border-radius:var(--radius); background:#fff; font-family:'Jost',sans-serif; font-size:11px; color:var(--warm); cursor:pointer; outline:none; }

.glist { display:flex; flex-direction:column; gap:7px; }
.grow { display:flex; align-items:center; gap:12px; padding:13px 16px; border:1px solid var(--linen); border-radius:var(--radius); background:#fff; cursor:pointer; transition:all .22s; user-select:none; }
.grow:hover { box-shadow:var(--sh); border-color:var(--taupe); }
.grow.ci { background:var(--sage-bg); border-color:var(--sage-bd); }
.grow:active { transform:scale(.993); }

.cbtn { width:30px; height:30px; border-radius:50%; border:1.5px solid var(--taupe); background:transparent; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all .18s; flex-shrink:0; font-size:13px; color:transparent; line-height:1; }
.grow.ci .cbtn { background:var(--sage); border-color:var(--sage); color:#fff; }
.cbtn:hover { border-color:var(--warm); }

.ginfo { flex:1; min-width:0; }
.gname { font-family:'Cormorant Garamond',serif; font-size:17px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.grow.ci .gname { color:var(--sage); }
.gmeta { display:flex; gap:10px; margin-top:2px; flex-wrap:wrap; }
.gtable,.gnotes { font-size:11px; color:var(--taupe); letter-spacing:.04em; }
.gtable::before { content:'◇ '; }
.gtime { font-size:11px; color:var(--sage); letter-spacing:.04em; flex-shrink:0; white-space:nowrap; }

.empty { text-align:center; padding:40px 20px; color:var(--taupe); font-size:13px; letter-spacing:.1em; }
.empty span { display:block; font-size:28px; margin-bottom:12px; }

.miss-title { font-size:10px; letter-spacing:.3em; text-transform:uppercase; color:var(--taupe); margin-bottom:10px; }
.miss-tags { display:flex; flex-wrap:wrap; gap:7px; }
.miss-tag { padding:5px 13px; background:var(--parchment); border:1px solid var(--linen); border-radius:20px; font-family:'Cormorant Garamond',serif; font-size:14px; color:var(--warm); }

.err { color:#b33; font-size:13px; margin-bottom:14px; padding:11px 14px; background:#fdf0f0; border-radius:var(--radius); border:1px solid #f0c0c0; white-space:pre-line; }
.rcount { font-size:11px; color:var(--taupe); letter-spacing:.08em; align-self:center; margin-left:auto; }

.loading-wrap { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:60px; gap:16px; }
.ring { width:32px; height:32px; border:2px solid var(--linen); border-top-color:var(--gold); border-radius:50%; animation:spin .8s linear infinite; }
@keyframes spin { to{transform:rotate(360deg)} }
.loading-text { font-size:11px; letter-spacing:.25em; text-transform:uppercase; color:var(--taupe); }

@media (max-width:580px) {
  .card { padding:22px 16px; }
  .stats { grid-template-columns:repeat(2,1fr); }
  .stat-n { font-size:26px; }
  .ctrls { flex-direction:column; }
  .rcount { margin-left:0; }
}
`;

// ── SETUP VIEW ────────────────────────────────────────────────
function SetupView({ onOpen }) {
  const [tab, setTab] = useState("new");
  const [events, setEvents] = useState([]);
  const [evLoading, setEvLoading] = useState(true);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [guests, setGuests] = useState([]);
  const [fileName, setFileName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef();

  useEffect(() => {
    const unsub = api.listenEvents((data) => {
      setEvents(data);
      setEvLoading(false);
    });
    return unsub;
  }, []);

  const handleFile = async (file) => {
    if (!file) return;
    setErr("");
    setBusy(true);
    try {
      const parsed = await readFile(file);
      setGuests(parsed);
      setFileName(file.name + "  ·  " + parsed.length + " convidados");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setErr("O nome do evento é obrigatório");
      return;
    }
    if (!guests.length) {
      setErr("Carrega um ficheiro com convidados");
      return;
    }
    setErr("");
    setBusy(true);
    try {
      const id = await api.createEvent(name.trim(), date);
      await api.addGuests(id, guests);
      onOpen(id, name.trim(), date);
    } catch (e) {
      setErr("Erro ao criar evento: " + e.message);
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="tabs">
        <button
          className={"tab" + (tab === "new" ? " active" : "")}
          onClick={() => setTab("new")}
        >
          Novo Evento
        </button>
        <button
          className={"tab" + (tab === "list" ? " active" : "")}
          onClick={() => setTab("list")}
        >
          {"Eventos" + (events.length > 0 ? " (" + events.length + ")" : "")}
        </button>
      </div>

      {tab === "new" && (
        <div className="card">
          <div className="slabel">Configurar Evento</div>

          <div className="fgroup">
            <label className="flabel">Nome do Evento *</label>
            <input
              className="finput"
              placeholder="Ex: Casamento Maria & João"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="fgroup">
            <label className="flabel">Data (opcional)</label>
            <input
              className="finput"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <div className="fgroup">
            <label className="flabel">Lista de Convidados (.xlsx · .csv)</label>
            {fileName ? (
              <div className="file-ok">
                <span className="file-ok-icon">✓</span>
                <span style={{ flex: 1 }}>{fileName}</span>
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setFileName("");
                    setGuests([]);
                  }}
                >
                  Remover
                </button>
              </div>
            ) : (
              <div
                className={"drop" + (drag ? " over" : "")}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  handleFile(e.dataTransfer.files[0]);
                }}
                onClick={() => fileRef.current && fileRef.current.click()}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  style={{ display: "none" }}
                  onChange={(e) => handleFile(e.target.files[0])}
                />
                <span className="drop-icon">{busy ? "⏳" : "📋"}</span>
                <div className="drop-text">
                  {busy
                    ? "A processar…"
                    : "Arrasta aqui ou clica para escolher"}
                </div>
                <div className="drop-hint">
                  .xlsx · .xls · .csv &nbsp;·&nbsp; Colunas: Nome, Mesa, Notas
                </div>
              </div>
            )}
          </div>

          {err && <div className="err">{err}</div>}

          {busy && !err ? (
            <div className="loading-wrap" style={{ padding: "20px" }}>
              <div className="ring" />
              <span className="loading-text">A criar evento…</span>
            </div>
          ) : (
            <button
              className="btn-main"
              onClick={handleCreate}
              disabled={busy || !name || !guests.length}
            >
              Iniciar Check-in
            </button>
          )}
        </div>
      )}

      {tab === "list" && (
        <div className="card">
          <div className="slabel">Eventos</div>
          {evLoading ? (
            <div className="loading-wrap">
              <div className="ring" />
              <span className="loading-text">A carregar…</span>
            </div>
          ) : events.length === 0 ? (
            <div className="empty">
              <span>🗓</span>Nenhum evento criado ainda
            </div>
          ) : (
            events.map((ev) => (
              <div
                key={ev.id}
                className="ev-item"
                onClick={() => onOpen(ev.id, ev.name, ev.date)}
              >
                <div>
                  <div className="ev-name">{ev.name}</div>
                  <div className="ev-meta">{ev.date || "Sem data"}</div>
                </div>
                <span className="ev-badge">Abrir →</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── CHECKIN VIEW ──────────────────────────────────────────────
function CheckinView({ eventId, eventName, eventDate, onBack }) {
  const [guests, setGuests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("name");

  useEffect(() => {
    const unsub = api.listenGuests(eventId, (data) => {
      setGuests(data);
      setLoading(false);
    });
    return unsub;
  }, [eventId]);

  const toggle = (guest) => {
    api.toggleCheckin(eventId, guest.id, guest.checkedIn);
  };

  const total = guests.length;
  const present = guests.filter((g) => g.checkedIn).length;
  const missing = total - present;
  const pct = total ? Math.round((present / total) * 100) : 0;

  const lastCheckin = guests
    .filter((g) => g.checkedIn && g.checkedInAt)
    .sort((a, b) => {
      const ta = a.checkedInAt?.toDate
        ? a.checkedInAt.toDate()
        : new Date(a.checkedInAt || 0);
      const tb = b.checkedInAt?.toDate
        ? b.checkedInAt.toDate()
        : new Date(b.checkedInAt || 0);
      return tb - ta;
    })[0];

  const filtered = guests
    .filter((g) => {
      if (filter === "present") return g.checkedIn;
      if (filter === "missing") return !g.checkedIn;
      return true;
    })
    .filter((g) => normalize(g.name).includes(normalize(search)))
    .sort((a, b) => {
      if (sortBy === "table") {
        const ta = a.table || "zzz",
          tb = b.table || "zzz";
        return ta.localeCompare(tb) || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });

  if (loading)
    return (
      <div className="loading-wrap">
        <div className="ring" />
        <span className="loading-text">A carregar convidados…</span>
      </div>
    );

  return (
    <div>
      <div className="snav">
        <div>
          <div className="snav-name">{eventName}</div>
          {eventDate && <div className="snav-date">{eventDate}</div>}
        </div>
        <button className="btn-sec" onClick={onBack}>
          ← Voltar
        </button>
      </div>

      <div className="wrap">
        <div className="stats">
          <div className="stat">
            <div className="stat-n">{total}</div>
            <div className="stat-l">Total</div>
          </div>
          <div className="stat">
            <div className="stat-n" style={{ color: "var(--sage)" }}>
              {present}
            </div>
            <div className="stat-l">Presentes</div>
          </div>
          <div className="stat">
            <div className="stat-n" style={{ color: "#c0877a" }}>
              {missing}
            </div>
            <div className="stat-l">Por Chegar</div>
          </div>
          <div className="stat">
            <div className="stat-n" style={{ color: "var(--gold)" }}>
              {pct}%
            </div>
            <div className="stat-l">Presença</div>
          </div>
        </div>

        <div className="prog-wrap">
          <div className="prog-fill" style={{ width: pct + "%" }} />
        </div>

        {lastCheckin && (
          <div className="lcb">
            <div className="lcb-dot" />
            <div>
              <div className="lcb-label">Último check-in</div>
              <div className="lcb-name">
                {lastCheckin.name}
                {lastCheckin.checkedInAt
                  ? "  ·  " + formatTime(lastCheckin.checkedInAt)
                  : ""}
              </div>
            </div>
          </div>
        )}

        <div className="ctrls">
          <div className="search-wrap">
            <span className="search-icon">⌕</span>
            <input
              placeholder="Pesquisar convidado…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="sort-sel"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="name">A → Z</option>
            <option value="table">Por Mesa</option>
          </select>
        </div>

        <div className="ctrls">
          <div className="tabs" style={{ margin: 0 }}>
            {[
              ["all", "Todos"],
              ["present", "Presentes"],
              ["missing", "Por chegar"],
            ].map(([v, l]) => (
              <button
                key={v}
                className={"tab" + (filter === v ? " active" : "")}
                onClick={() => setFilter(v)}
              >
                {l}
              </button>
            ))}
          </div>
          <span className="rcount">
            {filtered.length} convidado{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="glist" style={{ marginTop: 10 }}>
          {filtered.length === 0 && (
            <div className="empty">
              <span>🔍</span>Nenhum resultado
            </div>
          )}
          {filtered.map((g) => (
            <div
              key={g.id}
              className={"grow" + (g.checkedIn ? " ci" : "")}
              onClick={() => toggle(g)}
            >
              <button
                className="cbtn"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(g);
                }}
              >
                {g.checkedIn ? "✓" : ""}
              </button>
              <div className="ginfo">
                <div className="gname">{g.name}</div>
                <div className="gmeta">
                  {g.table && <span className="gtable">Mesa {g.table}</span>}
                  {g.notes && <span className="gnotes">{g.notes}</span>}
                </div>
              </div>
              {g.checkedIn && g.checkedInAt && (
                <span className="gtime">{formatTime(g.checkedInAt)}</span>
              )}
            </div>
          ))}
        </div>

        {filter === "all" && missing > 0 && (
          <div style={{ marginTop: 28 }}>
            <div className="miss-title">Por chegar ({missing})</div>
            <div className="miss-tags">
              {guests
                .filter((g) => !g.checkedIn)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((g) => (
                  <span key={g.id} className="miss-tag">
                    {g.name}
                  </span>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── APP ROOT ──────────────────────────────────────────────────
export default function App() {
  const [mode, setMode] = useState("admin");
  const [view, setView] = useState({ type: "setup" });
  const [eventId, setEventId] = useState(null);
  const [eventName, setEventName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const isWeddingMode = true;
  const handleOpen = (id, name, date) => {
    setEventId(id);
    setEventName(name);
    setEventDate(date);

    window.history.pushState({}, "", `/event/${id}`);
    setMode("public");

    setView({
      type: "checkin",
      id,
      name,
      date,
    });
  };
  const handleBack = () => setView({ type: "setup" });
  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        {view.type === "setup" && (
          <>
            <header className="hd">
              <div className="hd-rule" />
              <h1 className="hd-title">
                Wedding <em>Check-in</em>
              </h1>
              <p className="hd-sub">Gestão de Presenças</p>
              <div className="hd-rule" style={{ marginTop: 18 }} />
            </header>
            <div className="wrap">
              <SetupView onOpen={handleOpen} />
            </div>
          </>
        )}
        {view.type === "checkin" && (
          <CheckinView
            eventId={view.id}
            eventName={view.name}
            eventDate={view.date}
            onBack={handleBack}
          />
        )}
      </div>
    </>
  );
}
