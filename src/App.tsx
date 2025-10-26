import React, { useEffect, useMemo, useState } from 'react';
import Papa, { ParseResult } from 'papaparse';
import * as XLSX from 'xlsx';
import type { Operator, OrderItem, OrderLog } from './types';
import { db, ensureAnonAuth } from './lib/firebaseClient';
import {
  collection,
  addDoc,
  getDocs,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  query,
  orderBy,
} from 'firebase/firestore';

/* -------------------- Utils -------------------- */

type RowIn = Record<string, any>;

const asNumber = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const formatTime = (sec: number) => {
  const h = Math.floor(sec / 3600).toString().padStart(2, '0');
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
};

const toDocId = (order: string | number, code: string) =>
  `${String(order)}__${String(code)}`
    .trim()
    .replace(/[\/\\]/g, '_')
    .replace(/\s+/g, ' ');

const normalize = (s: string) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const pick = (row: Record<string, any>, aliases: string[]) => {
  const nk = Object.keys(row).map((k) => [k, normalize(k)] as const);
  const want = aliases.map(normalize);
  const hit = nk.find(([_, n]) => want.includes(n));
  return hit ? row[hit[0]] : undefined;
};

/** Calcola qty_done come "pezzi realmente finiti", cioè il minimo tra i passaggi */
function computeFullyDone(
  stepsCount: number,
  stepsProgress: Record<string | number, number> | undefined,
  defaultZero = 0,
): number {
  if (!stepsCount || stepsCount <= 0) return 0;
  const vals: number[] = [];
  for (let i = 1; i <= stepsCount; i++) {
    const v = stepsProgress?.[i] ?? 0;
    vals.push(Number(v) || 0);
  }
  if (vals.length === 0) return 0;
  return Math.max(defaultZero, Math.min(...vals));
}

/** True se ogni passaggio ha raggiunto almeno qty_requested */
function isOrderCompletedBySteps(
  stepsCount: number,
  stepsProgress: Record<string | number, number> | undefined,
  qtyRequested: number | null | undefined,
): boolean {
  const req = Number(qtyRequested) || 0;
  if (!req || !stepsCount) return false;
  for (let i = 1; i <= stepsCount; i++) {
    const done = Number(stepsProgress?.[i] ?? 0);
    if (done < req) return false;
  }
  return true;
}

/* -------------------- Modal -------------------- */

function Modal(props: { open: boolean; onClose: () => void; children: React.ReactNode; title?: string }) {
  if (!props.open) return null;
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
      }}
      onClick={props.onClose}
    >
      <div
        className="card"
        style={{ minWidth: 360, maxWidth: '90vw', padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        {props.title && <h3>{props.title}</h3>}
        {props.children}
        <div style={{ textAlign: 'right', marginTop: 12 }}>
          <button className="btn btn-secondary" onClick={props.onClose}>Chiudi</button>
        </div>
      </div>
    </div>
  );
}

/* -------------------- Component -------------------- */

type TimerState = { running: boolean; startedAt: number | null; elapsed: number; paused?: boolean };

export default function App() {
  const [operators, setOperators] = useState<Operator[]>([]);
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [dateFilter, setDateFilter] = useState<string>('');
  const [showAdmin, setShowAdmin] = useState(false);
  const [timers, setTimers] = useState<Record<string, TimerState>>({});

  // STOP modal
  const [stopOpen, setStopOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<OrderItem | null>(null);
  const [stopOperator, setStopOperator] = useState<string>('');
  const [stopPieces, setStopPieces] = useState<number>(0);
  const [stopStep, setStopStep] = useState<number>(1);
  const [stopNotes, setStopNotes] = useState<string>('');

  // load data
  useEffect(() => {
    (async () => {
      await ensureAnonAuth();
      const opsSnap = await getDocs(query(collection(db, 'operators'), orderBy('name')));
      setOperators(opsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Operator[]);
      const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')));
      setOrders(itemsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as OrderItem[]);
    })();
  }, []);

  const kpi = useMemo(() => {
    const byStatus = (st: OrderItem['status']) => orders.filter((o) => o.status === st).length;
    const piecesToday = orders.reduce((sum, o) => sum + (o.qty_done || 0), 0);
    return { da_iniziare: byStatus('da_iniziare'), in_esecuzione: byStatus('in_esecuzione'), eseguiti: byStatus('eseguito'), pezziOggi: piecesToday, tempoOggi: 0 };
  }, [orders]);

  /* ------------------- IMPORT ------------------- */
  const handleImportCSV = async (file: File) => {
    try {
      await ensureAnonAuth();
      const parsed = await new Promise<RowIn[]>((resolve, reject) => {
        Papa.parse<RowIn>(file, { header: true, skipEmptyLines: true, complete: (res: ParseResult<RowIn>) => resolve(res.data as RowIn[]), error: reject });
      });
      if (!parsed || parsed.length === 0) throw new Error('Il file CSV sembra vuoto o senza intestazioni.');

      const batch = parsed
        .map((r) => {
          const order_number = pick(r, ['numero ordine', 'n ordine', 'ordine', 'num ordine']);
          const customer = pick(r, ['cliente']);
          const product_code = pick(r, ['codice prodotto', 'codice', 'prodotto', 'codice prod']);
          const mlVal = pick(r, ['ml']);
          const qty_requested = pick(r, ['quantita inserita', 'quantità inserita', 'quantita', 'qty richiesta', 'qta richiesta']);
          const qty_in_oven = pick(r, ['inforno', 'in forno']);
          const steps = pick(r, ['passaggi', 'n passaggi', 'passi']);
          if (!order_number || !product_code) return null;
          return {
            order_number: String(order_number),
            customer: customer ? String(customer) : '',
            product_code: String(product_code),
            ml: asNumber(mlVal ?? null),
            qty_requested: asNumber(qty_requested ?? null),
            qty_in_oven: asNumber(qty_in_oven ?? null),
            qty_done: 0,
            steps_count: Number(asNumber(steps ?? 0)) || 0,
            steps_progress: {}, // inizializzato vuoto
            status: 'da_iniziare' as const,
            created_at: serverTimestamp(),
          };
        })
        .filter(Boolean) as any[];

      for (const row of batch) {
        const id = toDocId(row.order_number, row.product_code);
        await setDoc(doc(db, 'order_items', id), row, { merge: true });
      }

      const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')));
      setOrders(itemsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as OrderItem[]);
      alert('Import completato: ' + batch.length + ' righe');
    } catch (e: any) {
      console.error('Errore import CSV', e);
      alert('Errore import: ' + (e?.message || String(e)));
    }
  };

  const importFromSheet = async () => {
    const url = prompt('Link Google Sheet (condiviso “chiunque col link”):');
    if (!url) return;
    try {
      const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (!m) throw new Error('Link non valido');
      const gid = url.match(/[?&]gid=(\d+)/)?.[1] || '0';
      const csvUrl = `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv&gid=${gid}`;
      const res = await fetch(csvUrl);
      const blob = await res.blob();
      const f = new File([blob], 'sheet.csv', { type: 'text/csv' });
      await handleImportCSV(f);
    } catch (e: any) {
      alert('Errore import: ' + e.message);
    }
  };

  /* ------------------- ADMIN ------------------- */
  const addOperator = async () => {
    const name = prompt('Nome operatore:');
    if (!name) return;
    const ref = await addDoc(collection(db, 'operators'), { name, active: true, created_at: serverTimestamp() });
    setOperators([...(operators), { id: ref.id, name, active: true }]);
  };
  const toggleOperator = async (op: Operator) => {
    if (!op.id) return;
    await updateDoc(doc(db, 'operators', op.id), { active: !op.active });
    setOperators(operators.map((o) => (o.id === op.id ? { ...o, active: !o.active } : o)));
  };
  const removeOperator = async (op: Operator) => {
    if (!op.id) return;
    if (!confirm(`Eliminare operatore "${op.name}"?`)) return;
    await deleteDoc(doc(db, 'operators', op.id));
    setOperators(operators.filter((o) => o.id !== op.id));
  };

  /* ------------------- MANUALE ------------------- */
  const manualInsert = async () => {
    const order_number = prompt('Numero ordine:') || '';
    const customer = prompt('Cliente:') || '';
    const product_code = prompt('Codice prodotto:') || '';
    const steps_count = Number(prompt('Numero passaggi (es. 3):') || '0') || 0;
    const id = toDocId(order_number, product_code);
    const row: OrderItem = { order_number, customer, product_code, steps_count, status: 'da_iniziare', steps_progress: {} };
    await setDoc(doc(db, 'order_items', id), { ...row, created_at: serverTimestamp() }, { merge: true });
    setOrders([{ id, ...row }, ...orders]);
  };

  /* ------------------- TIMER ------------------- */
  useEffect(() => {
    const id = setInterval(() => {
      setTimers((t) => {
        const n = { ...t }; const now = Date.now();
        for (const k of Object.keys(n)) {
          const tm = n[k];
          if (tm.running && tm.startedAt) n[k] = { ...tm, elapsed: Math.floor((now - tm.startedAt) / 1000) };
        }
        return n;
      });
    }, 250);
    return () => clearInterval(id);
  }, []);

  const startTimer = (id: string) =>
    setTimers((t) => ({ ...t, [id]: { running: true, startedAt: Date.now(), elapsed: t[id]?.elapsed || 0, paused: false } }));

  const pauseTimer = (id: string) =>
    setTimers((t) => ({ ...t, [id]: { ...(t[id] || { running: false, startedAt: null, elapsed: 0 }), running: false, paused: true } }));

  const resumeTimer = (id: string) =>
    setTimers((t) => ({ ...t, [id]: { ...(t[id] || { elapsed: 0 }), running: true, startedAt: Date.now(), paused: false } }));

  const openStopModal = (o: OrderItem) => {
    setStopTarget(o);
    setStopOperator('');
    setStopPieces(0);
    setStopStep(1);
    setStopNotes('');
    setStopOpen(true);
  };

  /** Conferma STOP: aggiorna order_logs e steps_progress; ricalcola qty_done e stato */
  const confirmStop = async () => {
    if (!stopTarget) return;
    const o = stopTarget;
    const tm = timers[o.id!] || { elapsed: 0 };

    if (!stopOperator) { alert('Seleziona un operatore'); return; }
    if (!stopStep || stopStep < 1 || stopStep > 10) { alert('Seleziona un passaggio valido (1..10)'); return; }
    if (!Number.isFinite(stopPieces) || stopPieces < 0) { alert('Inserisci un numero pezzi valido'); return; }

    // 1) Log
    const log: Partial<OrderLog> = {
      order_item_id: o.id!, operator_name: stopOperator, step_number: stopStep,
      pieces_done: stopPieces, notes: stopNotes, duration_seconds: tm.elapsed, created_at: new Date().toISOString()
    };
    await addDoc(collection(db, 'order_logs'), log as any);

    // 2) Aggiorna avanzamento per passaggio
    const prevProg = (o.steps_progress || {}) as Record<string | number, number>;
    const newProg = { ...prevProg };
    const curr = Number(newProg[stopStep] || 0);
    newProg[stopStep] = curr + stopPieces;

    // 3) Ricalcola qty_done come "min dei passaggi"
    const requested = Number(o.qty_requested || 0);
    const stepsCount = Number(o.steps_count || 0);
    const fullyDone = computeFullyDone(stepsCount, newProg, 0);

    // 4) Stato: completato solo se TUTTI i passaggi >= richiesto
    const completed = isOrderCompletedBySteps(stepsCount, newProg, requested);
    const nextStatus: OrderItem['status'] = completed ? 'eseguito' : 'in_esecuzione';

    await updateDoc(doc(db, 'order_items', o.id!), {
      steps_progress: newProg,
      qty_done: fullyDone,
      status: nextStatus
    });

    setOrders(orders.map((x) =>
      x.id === o.id ? { ...x, steps_progress: newProg, qty_done: fullyDone, status: nextStatus } : x
    ));
    setTimers((t) => ({ ...t, [o.id!]: { running: false, startedAt: null, elapsed: 0, paused: false } }));
    setStopOpen(false);
  };

  const closeOrder = async (o: OrderItem) => {
    await updateDoc(doc(db, 'order_items', o.id!), { status: 'eseguito' });
    setOrders(orders.map((x) => (x.id === o.id ? { ...x, status: 'eseguito' } : x)));
  };

  /* ------------------- EXPORT ------------------- */
  const exportExcel = () => {
    const rows = orders.map((o) => ({
      Cliente: o.customer,
      'Numero Ordine': o.order_number,
      'Codice Prodotto': o.product_code,
      'Q.ta Richiesta': o.qty_requested || '',
      'Q.ta In Forno': o.qty_in_oven || '',
      'Q.ta Eseguita (tutti passaggi)': o.qty_done || 0,
      Passaggi: o.steps_count,
      Stato: o.status,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Riepilogo');
    XLSX.writeFile(wb, 'riepilogo_ordini.xlsx');
  };

  const filtered = orders;
  const executed = filtered.filter(o => o.status === 'eseguito');
  const active = filtered.filter(o => o.status !== 'eseguito');

  const qtyWarnStyle = (o: OrderItem) => {
    const req = o.qty_requested || 0;
    const done = o.qty_done || 0;
    if (req && done > 0.4 * req) {
      return { background: 'rgba(255,210,0,0.2)', border: '1px solid #ffd200' };
    }
    return {};
  };

  return (
    <div className="container">
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <label>Ordini dal... <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} /></label>

        <input
          type="file"
          accept=".csv"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) { await handleImportCSV(f); e.currentTarget.value = ''; }
          }}
        />

        <button className="btn btn-secondary" onClick={importFromSheet}>IMPORT DOC (Google Sheet)</button>
        <button className="btn btn-secondary" onClick={() => setShowAdmin(true)}>ADMIN (Operatori)</button>
        <button className="btn btn-primary" onClick={manualInsert}>INSERISCI ORDINE</button>
      </div>

      {/* ==== LAYOUT: SINISTRA (CRUSCOTTO+COMPLETATI) / DESTRA (ORDINI) ==== */}
      <div
        className="row"
        style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}
      >
        {/* Colonna SINISTRA */}
        <div style={{ display: 'grid', gap: 12 }}>
          {/* Cruscotto */}
          <div className="card">
            <h2>CRUSCOTTO OPERATIVO</h2>
            <div className="kpi">
              <div className="tile"><div className="muted">Da iniziare</div><div style={{ fontSize: 24, fontWeight: 800 }}>{kpi.da_iniziare}</div></div>
              <div className="tile"><div className="muted">In esecuzione</div><div style={{ fontSize: 24, fontWeight: 800 }}>{kpi.in_esecuzione}</div></div>
              <div className="tile"><div className="muted">Eseguiti</div><div style={{ fontSize: 24, fontWeight: 800 }}>{kpi.eseguiti}</div></div>
              <div className="tile"><div className="muted">Prodotti oggi</div><div style={{ fontSize: 24, fontWeight: 800 }}>{kpi.pezziOggi}</div></div>
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="muted" style={{ marginBottom: 6 }}>Tempo eseguito oggi</div>
              <div className="timer">{formatTime(kpi.tempoOggi)}</div>
            </div>
            <div className="footer"><button className="btn btn-secondary" onClick={exportExcel}>SCARICO EXCEL</button></div>
          </div>

          {/* Completati */}
          {executed.length > 0 && (
            <div className="card">
              <h3>Completati (passano al reparto successivo)</h3>
              <div style={{ display: 'grid', gap: 8 }}>
                {executed.map(o => (
                  <div key={o.id} className="card" style={{ border: '1px solid #4ade80' }}>
                    <strong>{o.customer}</strong> — Ordine {o.order_number} — <span className="pill">eseguito</span>
                    <div className="muted">
                      Codice: {o.product_code} • Eseguiti (tutti passaggi): {o.qty_done ?? 0} / {o.qty_requested ?? '-'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Colonna DESTRA: Ordini attivi */}
        <div className="card">
          <h2>Ordini</h2>
          <div className="orders">
            {active.map((o) => {
              const tm = timers[o.id!] || { running: false, elapsed: 0, paused: false };
              const canResume = !tm.running && tm.elapsed > 0 && tm.paused;
              const requested = o.qty_requested || 0;
              const done = o.qty_done || 0;
              const canClose = requested > 0 && isOrderCompletedBySteps(o.steps_count, o.steps_progress, requested) && o.status !== 'eseguito';

              return (
                <div key={o.id || o.order_number + o.product_code} className="card order-card">
                  <h3>{o.customer}</h3>
                  <div className="muted">Ordine {o.order_number}</div>

                  <div className="fieldrow">
                    <div><label>Codice prodotto</label><div>{o.product_code}</div></div>
                    <div><label>Q.ta richiesta</label><div>{requested || '-'}</div></div>
                    <div><label>Q.ta in forno</label><div>{o.qty_in_oven ?? '-'}</div></div>
                  </div>

                  <div className="fieldrow">
                    <div><label>Q.ta eseguita (tutti passaggi)</label><div className="pill" style={qtyWarnStyle(o)}>{done}</div></div>
                    <div><label>Passaggi</label><div>{o.steps_count}</div></div>
                    <div><label>Stato</label><div className="pill">{o.status}</div></div>
                  </div>

                  {/* Avanzamento per passaggio */}
                  {o.steps_count > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <label className="muted" style={{ display: 'block', marginBottom: 4 }}>Avanzamento per passaggio</label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {Array.from({ length: o.steps_count }, (_, i) => {
                          const n = i + 1;
                          const prog = Number(o.steps_progress?.[n] ?? 0);
                          return (
                            <div key={n} className="pill">
                              P{n}: {prog} / {requested || '-'}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
                    <div className="timer">{formatTime(tm.elapsed)}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {!tm.running && !canResume && (
                        <button className="btn btn-primary" onClick={() => startTimer(o.id! || o.order_number)}>Start</button>
                      )}
                      {tm.running && (
                        <button className="btn btn-secondary" onClick={() => pauseTimer(o.id! || o.order_number)}>Pausa</button>
                      )}
                      {canResume && (
                        <button className="btn btn-primary" onClick={() => resumeTimer(o.id! || o.order_number)}>Riprendi</button>
                      )}
                      <button className="btn btn-danger" onClick={() => openStopModal(o)}>Stop</button>
                      {canClose && (
                        <button className="btn" style={{ background: '#22c55e' }} onClick={() => closeOrder(o)}>
                          Chiudi ordine
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Admin Operatori */}
      <Modal open={showAdmin} onClose={() => setShowAdmin(false)} title="Operatori">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '8px 0', minWidth: 320 }}>
          {operators.map((op) => (
            <div key={op.id} style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
              <span className={'pill ' + (op.active ? 'done' : '')}>{op.name}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-secondary" onClick={() => toggleOperator(op)}>{op.active ? 'Disattiva' : 'Attiva'}</button>
                <button className="btn btn-danger" onClick={() => removeOperator(op)}>Elimina</button>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={addOperator}>Aggiungi operatore</button>
        </div>
      </Modal>

      {/* Stop modal */}
      <Modal open={stopOpen} onClose={() => setStopOpen(false)} title="Registra produzione">
        <div style={{ display: 'grid', gap: 8, minWidth: 320 }}>
          <label>
            Operatore
            <select value={stopOperator} onChange={(e) => setStopOperator(e.target.value)}>
              <option value="">-- seleziona --</option>
              {operators.filter(o => o.active).map((o) => (
                <option key={o.id} value={o.name}>{o.name}</option>
              ))}
            </select>
          </label>
          <label>
            Passaggio
            <select value={stopStep} onChange={(e) => setStopStep(Number(e.target.value))}>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <label>
            Pezzi eseguiti
            <input type="number" min={0} value={stopPieces} onChange={(e) => setStopPieces(Number(e.target.value))} />
          </label>
          <label>
            Note
            <input type="text" value={stopNotes} onChange={(e) => setStopNotes(e.target.value)} placeholder="opzionale" />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={confirmStop}>Conferma</button>
        </div>
      </Modal>
    </div>
  );
}
