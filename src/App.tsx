// App.tsx
import React, { useEffect, useMemo, useState } from 'react';
import Papa, { ParseResult } from 'papaparse';
import * as XLSX from 'xlsx';
import type { Operator, OrderItem } from './types';
import { db, ensureAnonAuth } from './lib/firebaseClient';
import {
  collection,
  getDocs,
  getDoc,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  query,
  orderBy,
} from 'firebase/firestore';

/* =============== Utils =============== */

type RowIn = Record<string, any>;
type TimerState = { running: boolean; startedAt: number | null; elapsed: number };

// batch per “parziali” a destra
type Batch = {
  id: string;
  qty: number;
  status: 'parziale' | 'in_essiccazione' | 'in_imballaggio' | 'pronti_consegna' | 'eseguito';
  created_at: any;
  status_changed_at?: any;
  packed_qty?: number;
  packed_boxes?: number | null;
  packed_size?: string | null;
  packed_weight?: number | null;
  packed_notes?: string | null;
};

const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const parseNumberIT = (v: any): number | null => {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (s === '') return null;
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (s.includes('.')) if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const secToHMS = (total = 0) => {
  const sec = Math.max(0, Math.floor(total || 0));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
};

type StepAgg = { step: number; pieces: number; timeSec: number };
const aggregateStepStats = (row: any): StepAgg[] => {
  const time = (row?.steps_time ?? {}) as Record<string | number, number>;
  const prog = (row?.steps_progress ?? {}) as Record<string | number, number>;
  const steps = new Set<number>([
    ...Object.keys(time).map((n) => Number(n)),
    ...Object.keys(prog).map((n) => Number(n)),
  ].filter((n) => Number.isFinite(n) && n > 0));
  return [...steps]
    .map((step) => ({
      step,
      pieces: Number((prog as any)[step] ?? 0),
      timeSec: Number((time as any)[step] ?? 0),
    }))
    .sort((a, b) => a.step - b.step);
};

const toDocId = (order: string | number, code: string) =>
  `${String(order)}__${String(code)}`.trim().replace(/[\/\\]/g, '_').replace(/\s+/g, ' ');

const normalize = (s: string) =>
  String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

const pick = (row: Record<string, any>, aliases: string[]) => {
  const nk = Object.keys(row).map((k) => [k, normalize(k)] as const);
  const want = aliases.map(normalize);
  const hit = nk.find(([_, n]) => want.includes(n));
  return hit ? row[hit[0]] : undefined;
};

const getDayBounds = (date: Date) => {
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end = new Date(date);   end.setHours(23, 59, 59, 999);
  return { start, end };
};

const computeFullyDone = (
  stepsCount: number,
  stepsProgress: Record<string | number, number> | undefined,
  defaultZero = 0,
) => {
  if (!stepsCount || stepsCount <= 0) return 0;
  const vals: number[] = [];
  for (let i = 1; i <= stepsCount; i++) {
    const v = (stepsProgress as any)?.[i] ?? 0;
    vals.push(Number(v) || 0);
  }
  if (vals.length === 0) return 0;
  return Math.max(defaultZero, Math.min(...vals));
};

/* =============== CSS compatto + header sticky =============== */

function useCompactStyles() {
  useEffect(() => {
    const id = 'extra-style';
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.innerHTML = `
      :root{ --bg-head:#0f1622; --bd:#2b2f3a; }
      .layout{display:grid;grid-template-columns:1fr 280px;gap:8px}
      @media (max-width:1200px){.layout{grid-template-columns:1fr}}

      .top-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
      .top-row .controls{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .top-row input[type="file"]{max-width:280px;width:100%}

      .table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
      table.table{border-collapse:collapse;width:100%;table-layout:auto}
      table.table thead th{
        position:sticky;top:0;z-index:10;background:var(--bg-head);
        padding:6px 8px;font-size:13px;text-align:left;white-space:nowrap;
        border-bottom:1px solid var(--bd)
      }
      table.table td{
        padding:6px 8px;white-space:nowrap;vertical-align:middle;
        border-bottom:1px solid rgba(255,255,255,.05);text-align:left
      }
      .cell-code-desc{max-width:520px;overflow:hidden}
      .cell-code-desc .code{font-weight:600;display:block;overflow:hidden;text-overflow:ellipsis}
      .cell-code-desc .desc{opacity:.9;font-size:12px;overflow:hidden;text-overflow:ellipsis}

      .actions{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
      .btn{min-height:24px;padding:3px 6px;font-size:11px;border-radius:6px}
      .btn-primary{background:#2563eb;color:#fff;border:1px solid #1f4fd1}
      .btn-warning{background:#f59e0b;color:#222;border:1px solid #d48809}
      .btn-success{background:#10b981;color:#073b2d;border:1px solid #0e9e71}
      .btn-danger{background:#ef4444;color:#fff;border:1px solid #c43333}
      .btn-secondary{background:#374151;color:#fff;border:1px solid #2c3441}

      aside.sticky-aside{position:sticky;top:8px;height:calc(100vh - 16px);display:flex;flex-direction:column}
      @media (max-width:1200px){aside.sticky-aside{position:static;height:auto}}

      @media (max-width:640px){
        .table-wrap{display:none}
        .mobile-list{display:grid;gap:8px}
        .mobile-card{border:1px solid #3a4153;border-radius:10px;background:rgba(255,255,255,.03);padding:8px}
        .mobile-card .row{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center}
        .mobile-card .meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;font-size:12px}
        .mobile-card .meta div{background:#111722;border:1px solid var(--bd);border-radius:8px;padding:6px 8px}
        .btn{min-height:30px;padding:6px 10px;font-size:12px}
      }
      @media (min-width:641px){.mobile-list{display:none}}
    `;
  }, []);
}

/* =============== Modale semplice =============== */

function Modal(props: { open: boolean; onClose: () => void; children: React.ReactNode; title?: string }) {
  if (!props.open) return null;
  return (
    <div
      onClick={props.onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ minWidth: 340, maxWidth: '92vw', padding: 12 }}
      >
        {props.title && <h3 style={{ marginTop: 0, marginBottom: 8 }}>{props.title}</h3>}
        {props.children}
        <div style={{ textAlign: 'right', marginTop: 10 }}>
          <button className="btn btn-secondary" onClick={props.onClose}>Chiudi</button>
        </div>
      </div>
    </div>
  );
}

/* =============== App =============== */

export default function App() {
  useCompactStyles();

  const [operators, setOperators] = useState<Operator[]>([]);
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [timers, setTimers] = useState<Record<string, TimerState>>({});
  const [tick, setTick] = useState(0);

  // Modali / stati
  const [stopOpen, setStopOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<any>(null);
  const [stopOperator, setStopOperator] = useState<string>('');
  const [stopPieces, setStopPieces] = useState<number>(0);
  const [stopStep, setStopStep] = useState<number>(1);
  const [stopNotes, setStopNotes] = useState<string>('');

  const [notesOpen, setNotesOpen] = useState(false);
  const [notesTarget, setNotesTarget] = useState<any>(null);

  // Avanza fase (BATCH)
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [advanceOrder, setAdvanceOrder] = useState<any>(null);
  const [advanceBatchId, setAdvanceBatchId] = useState<string>('');
  const [advancePhase, setAdvancePhase] =
    useState<'in_essiccazione'|'in_imballaggio'|'pronti_consegna'>('in_essiccazione');
  const [advancePacked, setAdvancePacked] = useState<number>(0);
  const [advanceBoxes, setAdvanceBoxes] = useState<number | ''>('');
  const [advanceSize, setAdvanceSize] = useState<string>('');
  const [advanceWeight, setAdvanceWeight] = useState<number | ''>('');
  const [advanceNotes, setAdvanceNotes] = useState<string>('');

  const [adminOpen, setAdminOpen] = useState(false);
  const [newOperatorName, setNewOperatorName] = useState('');
  const [adminForceQty, setAdminForceQty] = useState<Record<string, number | ''>>({});

  // Filtro cruscotto
  const [filterFrom, setFilterFrom] = useState<string>('');
  const [filterCustomer, setFilterCustomer] = useState<string>('');

  /* ---- Data load ---- */
  useEffect(() => {
    (async () => {
      await ensureAnonAuth();
      const opsSnap = await getDocs(query(collection(db, 'operators'), orderBy('name')));
      setOperators(opsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Operator[]);
      const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')));
      const list = itemsSnap.docs.map((d) => {
        const o: any = { id: d.id, ...(d.data() as any) };
        if (!Array.isArray(o.batches)) o.batches = []; // compat
        return o;
      });
      setOrders(list as OrderItem[]);
    })();
  }, []);

  const customers = useMemo(() => {
    const vals = new Set<string>();
    orders.forEach((o: any) => { const c = String(o.customer || '').trim(); if (c) vals.add(c); });
    return Array.from(vals).sort((a, b) => a.localeCompare(b));
  }, [orders]);

  // tick dei timer
  useEffect(() => {
    const anyRunning = Object.values(timers).some((t) => t.running);
    if (!anyRunning) return;
    const h = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(h);
  }, [timers]);

  const baseElapsedOf = (row: any) => Number((row?.total_elapsed_sec ?? row?.elapsed_sec) || 0);
  const createdAtMs = (o: any): number | null => {
    const ca: any = o.created_at; if (!ca) return null;
    return ca.toMillis ? ca.toMillis() : (typeof ca === 'number' ? ca : null);
  };

  const baseFiltered = useMemo(() => {
    let list = orders as any[];
    if (filterFrom) {
      const from = new Date(filterFrom + 'T00:00:00').getTime();
      list = list.filter((o) => {
        const ts = createdAtMs(o);
        return ts ? ts >= from : false;
      });
    }
    if (filterCustomer) list = list.filter((o) => (o.customer || '') === filterCustomer);
    return list;
  }, [orders, filterFrom, filterCustomer]);

  // Sinistra: ordini non interamente completati
  const visibleOrders = useMemo(() => {
    return baseFiltered.filter((o: any) => {
      if (o.hidden) return false;
      const req = Number(o.qty_requested || 0);
      const done = Number(o.qty_done || 0);
      const fullyDone = req > 0 && done >= req;
      const st = o.status;
      const showOnLeftIfNotDone = [
        'da_iniziare', 'in_esecuzione', 'pausato',
        'in_essiccazione', 'in_imballaggio', 'pronti_consegna',
      ].includes(st);
      return showOnLeftIfNotDone && !fullyDone;
    });
  }, [baseFiltered]);

  const kpi = useMemo(() => {
    const byStatus = (st: any) => baseFiltered.filter((o: any) => !o.hidden && o.status === st).length;
    return { da_iniziare: byStatus('da_iniziare'), in_esecuzione: byStatus('in_esecuzione'), eseguiti: byStatus('eseguito') };
  }, [baseFiltered]);

  const todayAgg = useMemo(() => {
    const { start, end } = getDayBounds(new Date());
    let pezzi = 0; let sec = 0;
    baseFiltered.forEach((o: any) => {
      const ldt: any = o.last_done_at;
      const ms = ldt?.toMillis ? ldt.toMillis() : (typeof ldt === 'number' ? ldt : null);
      if (ms && ms >= start.getTime() && ms <= end.getTime()) {
        pezzi += Number(o.last_pieces || 0);
        sec += Number(o.last_duration_sec || 0);
      }
    });
    return { pezziOggi: pezzi, secOggi: sec };
  }, [baseFiltered]);

  /* ---- Timer ---- */
  const onStart = async (row: any) => {
    setTimers((t) => ({ ...t, [row.id!]: { running: true, startedAt: Date.now(), elapsed: baseElapsedOf(row) } }));
    await updateDoc(doc(db, 'order_items', row.id!), { status: 'in_esecuzione', timer_start: Date.now() } as any);
    setOrders((prev: any[]) => prev.map((o) => o.id === row.id ? { ...o, status: 'in_esecuzione', timer_start: Date.now() } : o));
  };
  const onPause = async (row: any) => {
    const t = timers[row.id!] || { running: false, startedAt: null, elapsed: baseElapsedOf(row) };
    const now = Date.now();
    const extra = t.startedAt ? Math.round((now - t.startedAt) / 1000) : 0;
    const elapsed = (t.elapsed || 0) + extra;
    setTimers((tt) => ({ ...tt, [row.id!]: { running: false, startedAt: null, elapsed } }));
    await updateDoc(doc(db, 'order_items', row.id!), {
      status: 'pausato',
      elapsed_sec: elapsed, total_elapsed_sec: elapsed, timer_start: null,
    } as any);
    setOrders((prev: any[]) => prev.map((o) => o.id === row.id ? { ...o, status: 'pausato', elapsed_sec: elapsed, total_elapsed_sec: elapsed, timer_start: null } : o));
  };
  const onResume = async (row: any) => {
    const prevElapsed = Number(timers[row.id!]?.elapsed ?? baseElapsedOf(row) ?? 0);
    setTimers((t) => ({ ...t, [row.id!]: { running: true, startedAt: Date.now(), elapsed: prevElapsed } }));
    await updateDoc(doc(db, 'order_items', row.id!), { status: 'in_esecuzione', timer_start: Date.now() } as any);
    setOrders((prev: any[]) => prev.map((o) => o.id === row.id ? { ...o, status: 'in_esecuzione', timer_start: Date.now() } : o));
  };

  /* ---- Stop: aggiorna progress e crea BATCH nuovi ---- */
  const openStop = (row: any) => {
    setStopTarget(row);
    setStopPieces(0);
    setStopStep(1);
    setStopOperator('');
    setStopNotes('');
    setStopOpen(true);
  };

  const confirmStop = async () => {
    if (!stopTarget) return;
    const row: any = stopTarget;
    const stepsCount = Number(row.steps_count || 0);
    if (!stopStep || stopStep < 1 || (stepsCount > 0 && stopStep > stepsCount)) {
      alert('Seleziona un passaggio valido.'); return;
    }
    if (!stopPieces || stopPieces <= 0) { alert('Inserisci i pezzi.'); return; }
    if (!stopOperator) { alert('Seleziona un operatore.'); return; }

    const t = timers[row.id!];
    const now = Date.now();
    const extraFromRun = t?.startedAt ? Math.round((now - t.startedAt) / 1000) : 0;
    const prevElapsed = baseElapsedOf(row);
    const totalElapsed = Math.max(0, prevElapsed + extraFromRun);

    const pass = Number(stopStep || 0);
    const nextStepsTime: Record<number, number> = { ...(row.steps_time || {}) };
    nextStepsTime[pass] = (nextStepsTime[pass] ?? 0) + extraFromRun;

    const nextStepsProg: Record<number, number> = { ...(row.steps_progress || {}) };
    nextStepsProg[pass] = (nextStepsProg[pass] ?? 0) + Number(stopPieces || 0);

    const prevFully = Number(row.qty_done || 0);
    const newFully = computeFullyDone(stepsCount, nextStepsProg, 0);
    const deltaNewBatch = Math.max(0, newFully - prevFully); // ⬅️ NUOVO BATCH se >0

    // log
    const notesLog = Array.isArray(row.notes_log) ? [...row.notes_log] : [];
    if (stopNotes && stopNotes.trim()) {
      notesLog.push({
        ts: new Date().toISOString(),
        operator: stopOperator || null,
        text: stopNotes.trim(),
        step: pass,
        pieces: Number(stopPieces || 0),
      });
    }
    const opsLog = Array.isArray(row.ops_log) ? [...row.ops_log] : [];
    opsLog.push({
      ts: new Date().toISOString(),
      operator: stopOperator || null,
      step: pass,
      pieces: Number(stopPieces || 0),
      duration_sec: extraFromRun,
    });

    // batches (compat)
    const batches: Batch[] = Array.isArray(row.batches) ? [...row.batches] : [];
    if (deltaNewBatch > 0) {
      batches.push({
        id: genId(),
        qty: deltaNewBatch,
        status: 'parziale',
        created_at: new Date() as any,
      });
    }

    const richiesta = Number(row.qty_requested || 0);
    const isCompletedTot = richiesta > 0 && newFully >= richiesta;

    // persist
    const patch: any = {
      status: isCompletedTot ? 'eseguito' : 'da_iniziare',
      elapsed_sec: totalElapsed, total_elapsed_sec: totalElapsed, timer_start: null,
      last_done_at: serverTimestamp(),
      steps_time: nextStepsTime, steps_progress: nextStepsProg,
      qty_done: newFully,
      last_operator: stopOperator || null,
      last_notes: stopNotes || null,
      last_step: pass, last_pieces: Number(stopPieces || 0), last_duration_sec: extraFromRun,
      notes_log: notesLog, ops_log: opsLog,
      batches,                                         // ⬅️ salva i batch aggiornati
    };

    await setDoc(doc(db, 'order_items', row.id!), patch, { merge: true });

    // stato locale
    setTimers((tt) => ({ ...tt, [row.id!]: { running: false, startedAt: null, elapsed: totalElapsed } }));
    setOrders((prev: any[]) =>
      prev.map((o) => o.id === row.id ? {
        ...o,
        ...patch,
        last_done_at: new Date() as any,
        status_changed_at: isCompletedTot ? new Date() as any : o.status_changed_at
      } : o)
    );

    setStopOpen(false);
  };

  /* ---- Avanza fase BATCH ---- */
  const openAdvanceForBatch = (order: any, batch: Batch) => {
    setAdvanceOrder(order);
    setAdvanceBatchId(batch.id);
    const ph: any = ['in_essiccazione','in_imballaggio','pronti_consegna'].includes(batch.status) ? batch.status : 'in_essiccazione';
    setAdvancePhase(ph);
    setAdvancePacked(Number(batch.packed_qty || 0));
    setAdvanceBoxes(batch.packed_boxes === undefined || batch.packed_boxes === null ? '' : Number(batch.packed_boxes));
    setAdvanceSize(batch.packed_size || '');
    setAdvanceWeight(batch.packed_weight === undefined || batch.packed_weight === null ? '' : Number(batch.packed_weight));
    setAdvanceNotes(batch.packed_notes || '');
    setAdvanceOpen(true);
  };

  const saveAdvance = async () => {
    if (!advanceOrder) return;
    const id = advanceOrder.id as string;
    const order = orders.find((o: any) => o.id === id) as any;
    if (!order) return;

    const batches: Batch[] = Array.isArray(order.batches) ? [...order.batches] : [];
    const idx = batches.findIndex((b) => b.id === advanceBatchId);
    if (idx === -1) return;

    const b = { ...batches[idx] };
    b.status = advancePhase;
    b.status_changed_at = new Date() as any;

    if (advancePhase === 'pronti_consegna') {
      if (!advancePacked || advancePacked <= 0) { alert('Inserisci i pezzi imballati.'); return; }
      b.packed_qty = Number(advancePacked);
      b.packed_boxes = advanceBoxes === '' ? null : Number(advanceBoxes);
      b.packed_size = advanceSize.trim() || null;
      b.packed_weight = advanceWeight === '' ? null : Number(advanceWeight);
      b.packed_notes = advanceNotes.trim() || null;
    } else {
      b.packed_qty = 0; b.packed_boxes = null; b.packed_size = null; b.packed_weight = null; b.packed_notes = null;
    }

    batches[idx] = b;

    await updateDoc(doc(db, 'order_items', id), { batches } as any);

    setOrders((prev: any[]) => prev.map((o) => o.id === id ? { ...o, batches } : o));
    setAdvanceOpen(false);
  };

  /* ---- Admin: operatori & ordini ---- */

  const addOperator = async () => {
    const name = newOperatorName.trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/\s+/g, '_');
    await setDoc(doc(db, 'operators', id), { name, active: true });
    setOperators((prev: any) => [...prev, { id, name, active: true }]);
    setNewOperatorName('');
  };
  const toggleOperator = async (op: any) => {
    await updateDoc(doc(db, 'operators', op.id), { active: !op.active } as any);
    setOperators((prev: any) => prev.map((o: any) => o.id === op.id ? { ...o, active: !o.active } : o));
  };
  const removeOperator = async (op: any) => {
    await deleteDoc(doc(db, 'operators', op.id));
    setOperators((prev: any) => prev.filter((o: any) => o.id !== op.id));
  };

  const changeStatus = async (o: any, newStatus: any) => {
    const patch: any = { status: newStatus, status_changed_at: serverTimestamp() };
    await updateDoc(doc(db, 'order_items', o.id), patch);
    setOrders((prev: any[]) => prev.map((x) => x.id === o.id ? { ...x, ...patch, status_changed_at: new Date() as any } : x));
  };

  const hideOrder = async (o: any) => {
    await updateDoc(doc(db, 'order_items', o.id), { hidden: true, deleted_at: serverTimestamp() } as any);
    setOrders((prev: any[]) => prev.map((x) => x.id === o.id ? { ...x, hidden: true, deleted_at: new Date() as any } : x));
  };
  const restoreOrder = async (o: any) => {
    await updateDoc(doc(db, 'order_items', o.id), { hidden: false } as any);
    setOrders((prev: any[]) => prev.map((x) => x.id === o.id ? { ...x, hidden: false } : x));
  };

  const forceComplete = async (row: any, qtyOverride?: number) => {
    try {
      const richiesta = Number(row.qty_requested ?? 0);
      const qtyFinal =
        typeof qtyOverride === 'number' && qtyOverride >= 0 ? qtyOverride :
        (richiesta > 0 ? richiesta : Number(row.qty_done || 0));

      const notesLog = Array.isArray(row.notes_log) ? [...row.notes_log] : [];
      notesLog.push({ ts: new Date().toISOString(), operator: 'SYSTEM', text: 'Forza conclusione', step: null, pieces: qtyFinal });

      const patch: any = {
        status: 'eseguito', status_changed_at: serverTimestamp(), last_done_at: serverTimestamp(),
        forced_completed: true, qty_done: Number(qtyFinal || 0), notes_log: notesLog,
      };

      await setDoc(doc(db, 'order_items', row.id!), patch, { merge: true });
      setOrders((prev: any[]) => prev.map((o) => o.id === row.id ? { ...o, ...patch, status_changed_at: new Date() as any, last_done_at: new Date() as any } : o));
    } catch (err: any) { alert('Errore forza conclusione: ' + err.message); }
  };

  const resetOrder = async (row: any) => {
    try {
      const notesLog = Array.isArray(row.notes_log) ? [...row.notes_log] : [];
      notesLog.push({ ts: new Date().toISOString(), operator: 'SYSTEM', text: 'Azzera ordine (reset completo)', step: null, pieces: 0 });

      const patch: any = {
        status: 'da_iniziare', status_changed_at: serverTimestamp(),
        elapsed_sec: 0, total_elapsed_sec: 0, timer_start: null,
        qty_done: 0, steps_progress: {}, steps_time: {},
        packed_qty: 0, packed_boxes: null, packed_size: null, packed_weight: null, packed_notes: null,
        last_operator: null, last_notes: null, last_step: null, last_pieces: null, last_duration_sec: null, last_done_at: null,
        notes_log: notesLog, forced_completed: false,
        batches: [],   // azzera anche i batch
      };

      await setDoc(doc(db, 'order_items', row.id!), patch, { merge: true });
      setOrders((prev: any[]) => prev.map((o) => o.id === row.id ? { ...o, ...patch, status_changed_at: new Date() as any } : o));
      setTimers((tt) => ({ ...tt, [row.id!]: { running: false, startedAt: null, elapsed: 0 } }));
    } catch (err: any) { alert('Errore azzera ordine: ' + err.message); }
  };

  const deleteForever = async (row: any) => {
    try {
      const notesLog = Array.isArray(row.notes_log) ? [...row.notes_log] : [];
      notesLog.push({ ts: new Date().toISOString(), operator: 'SYSTEM', text: 'Eliminato definitivamente (soft-delete)', step: null, pieces: 0 });
      const patch: any = { hidden: true, deleted_permanently: true, deleted_at: serverTimestamp(), notes_log: notesLog };
      await setDoc(doc(db, 'order_items', row.id!), patch, { merge: true });
      setOrders((prev: any[]) => prev.map((o) => o.id === row.id ? { ...o, ...patch, deleted_at: new Date() as any } : o));
    } catch (err: any) { alert('Errore elimina per sempre: ' + err.message); }
  };

  /* ---- Import CSV ---- */
  const handleImportCSV = async (file: File) => {
    try {
      await ensureAnonAuth();
      const parsed = await new Promise<RowIn[]>((resolve, reject) => {
        Papa.parse<RowIn>(file, {
          header: true, skipEmptyLines: true,
          complete: (res: ParseResult<RowIn>) => resolve(res.data as RowIn[]),
          error: reject,
        });
      });
      if (!parsed || parsed.length === 0) throw new Error('Il file CSV sembra vuoto.');

      let created = 0; let updated = 0;
      for (const r of parsed) {
        const order_number = pick(r, ['numero ordine', 'n ordine', 'ordine', 'num ordine']);
        const customer = pick(r, ['cliente']);
        const product_code = pick(r, ['codice prodotto', 'codice', 'prodotto', 'codice prod']);
        const description = pick(r, ['descrizione', 'descr', 'descrizione prodotto', 'desc', 'descr.']);
        const mlVal = pick(r, ['ml']);
        const qty_requested = pick(r, ['quantita inserita', 'quantità inserita', 'quantita', 'qty richiesta', 'qta richiesta']);
        const qty_in_oven = pick(r, ['inforno', 'in forno']);
        const steps = pick(r, ['passaggi', 'n passaggi', 'passi']);
        if (!order_number || !product_code) continue;

        const id = toDocId(String(order_number), String(product_code));
        const ref = doc(db, 'order_items', id);
        const snap = await getDoc(ref);

        if (snap.exists()) {
          const patch: any = {};
          if (customer !== undefined) patch.customer = String(customer);
          if (description !== undefined) patch.description = String(description);
          if (mlVal !== undefined) patch.ml = parseNumberIT(mlVal);
          if (qty_requested !== undefined) patch.qty_requested = parseNumberIT(qty_requested);
          if (qty_in_oven !== undefined) patch.qty_in_oven = parseNumberIT(qty_in_oven);
          if (steps !== undefined) patch.steps_count = Number(parseNumberIT(steps) || 0);
          if (Object.keys(patch).length > 0) { await setDoc(ref, patch, { merge: true }); updated++; }
        } else {
          const row: any = {
            order_number: String(order_number),
            customer: customer ? String(customer) : '',
            product_code: String(product_code),
            description: description ? String(description) : '',
            ml: parseNumberIT(mlVal ?? null),
            qty_requested: parseNumberIT(qty_requested ?? null),
            qty_in_oven: parseNumberIT(qty_in_oven ?? null),
            qty_done: 0,
            steps_count: Number(parseNumberIT(steps ?? 0)) || 0,
            steps_progress: {}, steps_time: {},
            packed_qty: 0,
            status: 'da_iniziare' as const,
            created_at: serverTimestamp(),
            hidden: false,
            notes_log: [], ops_log: [],
            total_elapsed_sec: 0,
            batches: [],                    // ⬅️ pronto per i parziali
          };
          await setDoc(ref, row, { merge: true });
          created++;
        }
      }

      const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')));
      setOrders(itemsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any), batches: Array.isArray((d.data() as any).batches) ? (d.data() as any).batches : [] })) as any);
      alert(`Import completato. Creati: ${created}, Aggiornati: ${updated}.`);
    } catch (err: any) {
      console.error(err);
      alert('Errore import: ' + err.message);
    }
  };

  /* ---- Export Excel (con batches) ---- */
  const exportExcel = () => {
    const exportBase = baseFiltered as any[];

    const rows = exportBase.map((o) => {
      const richiesta = Number(o.qty_requested ?? 0);
      const fatta = Number(o.qty_done ?? 0);
      const rimanente = Math.max(0, richiesta - fatta);
      const ops = Array.from(new Set(((o.ops_log ?? []) as any[]).map(x => x.operator).filter(Boolean))) as string[];
      const noteStr = ((o.notes_log ?? []) as any[]).map((n) =>
        `${new Date(n.ts).toLocaleString()}${n.operator ? ` (${n.operator})` : ''}: ${n.text || ''}`.trim()
      ).join(' | ');
      return {
        Ordine: o.order_number, Cliente: o.customer || '',
        Codice: o.product_code, Descrizione: o.description || '',
        ML: o.ml ?? '',
        'Q.ta richiesta': richiesta, 'Q.ta fatta': fatta, 'Q.ta rimanente': rimanente,
        Operatori: ops.join(', '), Note: noteStr,
        'Tempo totale': secToHMS(Number(o.total_elapsed_sec || o.elapsed_sec || 0)),
        Stato: o.hidden ? 'CANCELLATO' : o.status,
      };
    });

    const batchRows = exportBase.flatMap((o) =>
      (Array.isArray(o.batches) ? o.batches : []).map((b: Batch, i: number) => ({
        Ordine: o.order_number,
        Riga: o.product_code,
        BatchID: b.id,
        N: i + 1,
        Qta: b.qty,
        Stato: b.status,
        'Imballati (pz)': b.packed_qty ?? '',
        'Scatole/Pallets': b.packed_boxes ?? '',
        'Misura': b.packed_size ?? '',
        'Peso (kg)': b.packed_weight ?? '',
        'Note consegna': b.packed_notes ?? '',
        Creato: b.created_at ? new Date(b.created_at).toLocaleString() : '',
        'Cambio stato': b.status_changed_at ? new Date(b.status_changed_at).toLocaleString() : '',
      }))
    );

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Riepilogo ordini');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(batchRows), 'Parziali (batches)');
    XLSX.writeFile(wb, `deco-riepilogo-${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  /* ---- Helpers rendering ---- */

  const renderPassaggiCell = (row: any) => {
    const stats = aggregateStepStats(row);
    if (!stats.length) return <>—</>;
    const richiesta = Number(row.qty_requested || 0) || Infinity;
    return (
      <div style={{ display: 'grid', gap: 2 }}>
        {stats.map((s) => {
          const showPieces = Math.min(Number(s.pieces || 0), richiesta);
          return (
            <div key={s.step} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              <strong style={{ display: 'inline-block', minWidth: 24 }}>P{s.step}</strong>{': '}
              <span>{showPieces} pz</span>{' · '}
              <span>{secToHMS(s.timeSec)}</span>
            </div>
          );
        })}
      </div>
    );
  };

  // lista batch a destra (per tutti gli ordini filtrati)
  const batchesOnRight = useMemo(() => {
    const out: Array<{ order: any; batch: Batch }> = [];
    baseFiltered.forEach((o: any) => {
      if (o.hidden) return;
      const arr: Batch[] = Array.isArray(o.batches) ? o.batches : [];
      arr.forEach((b) => out.push({ order: o, batch: b }));
      // compat “vecchio”: se non ha batches ma ha qty_done>0, mostra un “virtual batch”
      if (arr.length === 0 && Number(o.qty_done || 0) > 0) {
        out.push({
          order: o,
          batch: {
            id: '__virtual__',
            qty: Number(o.qty_done || 0),
            status: (['in_essiccazione','in_imballaggio','pronti_consegna','eseguito'].includes(o.status) ? o.status : 'parziale') as any,
            created_at: o.status_changed_at || o.created_at || new Date(),
            packed_qty: o.packed_qty || 0,
            packed_boxes: (o as any).packed_boxes ?? null,
            packed_size: (o as any).packed_size ?? null,
            packed_weight: (o as any).packed_weight ?? null,
            packed_notes: (o as any).packed_notes ?? null,
          },
        });
      }
    });
    return out;
  }, [baseFiltered]);

  const badgeColor = (s: any) => {
    if (s === 'in_essiccazione') return '#f2c14e';
    if (s === 'in_imballaggio') return '#8b5a2b';
    if (s === 'pronti_consegna') return '#168a3d';
    if (s === 'eseguito') return '#555';
    if (s === 'parziale') return '#1070c9';
    return '#666';
    };

  const badgeLabel = (s: any) => {
    if (s === 'in_essiccazione') return 'ESSICCAZIONE';
    if (s === 'in_imballaggio') return 'IMBALLAGGIO';
    if (s === 'pronti_consegna') return 'PRONTI';
    if (s === 'eseguito') return 'COMPLETATO';
    if (s === 'parziale') return 'PARZIALE';
    return s;
  };

  /* ---- Render ---- */

  return (
    <div style={{ padding: 8 }}>
      <h2 style={{ marginTop: 0, marginBottom: 8 }}>Gestione Produzione</h2>

      {/* TOP ROW */}
      <div className="top-row">
        <div className="controls">
          <div style={{ minWidth: 200, maxWidth: 320, width: '100%' }}>
            <input type="file" accept=".csv,.txt" onChange={(e) => e.target.files && handleImportCSV(e.target.files[0])} style={{ width: '100%' }} />
          </div>
          <button className="btn" onClick={() => setAdminOpen(true)}>ADMIN</button>
          {/* opzionale pulsante nuovo ordine, se lo usavi */}
          {/* <button className="btn" onClick={() => setNewOrderOpen(true)}>INSERISCI ORDINE</button> */}
        </div>

        {/* CRUSCOTTO */}
        <div style={{ marginLeft: 8, flex: 1, border: '1px solid #2b2f3a', borderRadius: 8, padding: 10, minWidth: 260 }}>
          <h3 style={{ marginTop: 0, marginBottom: 6, fontSize: 16 }}>Cruscotto</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(140px,1fr))', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Ordini dal…</div>
              <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Cliente</div>
              <select value={filterCustomer} onChange={(e) => setFilterCustomer(e.target.value)}>
                <option value="">— tutti —</option>
                {customers.map((c) => (<option key={c} value={c}>{c}</option>))}
              </select>
            </label>
            <div style={{ borderLeft: '1px solid #2b2f3a', paddingLeft: 10, display:'grid', gap:4, alignContent:'start' }}>
              <div>Da iniziare: <strong>{kpi.da_iniziare}</strong></div>
              <div>In esecuzione: <strong>{kpi.in_esecuzione}</strong></div>
              <div>Completati: <strong>{kpi.eseguiti}</strong></div>
            </div>
            <div style={{ borderLeft: '1px solid #2b2f3a', paddingLeft: 10, display:'grid', gap:4, alignContent:'start' }}>
              <div>Pezzi oggi: <strong>{todayAgg.pezziOggi}</strong></div>
              <div>Tempo oggi: <strong>{secToHMS(todayAgg.secOggi)}</strong></div>
              <div><button className="btn" onClick={exportExcel}>SCARICO EXCEL</button></div>
            </div>
          </div>
        </div>
      </div>

      {/* LAYOUT */}
      <div className="layout">
        {/* LISTA ORDINI (sinistra) */}
        <div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Ordine</th>
                  <th>Cliente</th>
                  <th>Codice / Descrizione</th>
                  <th>Q.ta rich.</th>
                  <th>Q.ta fatta</th>
                  <th>Rimanenti</th>
                  <th>Passaggi</th>
                  <th>Timer</th>
                  <th>Azioni</th>
                </tr>
              </thead>
              <tbody>
                {visibleOrders.map((row: any) => {
                  const t = timers[row.id!] || { running: false, startedAt: null, elapsed: baseElapsedOf(row) };
                  const now = Date.now(); const _ = tick;
                  const elapsed = t.running && t.startedAt ? t.elapsed + Math.round((now - t.startedAt) / 1000) : t.elapsed;
                  const richiesta = Number(row.qty_requested ?? 0);
                  const fatta = Number(row.qty_done ?? 0);
                  const rimanente = Math.max(0, richiesta - fatta);
                  const hasNotes = Array.isArray(row.notes_log) && row.notes_log.length > 0;

                  return (
                    <tr key={row.id}>
                      <td><strong>{row.order_number}</strong></td>
                      <td>{row.customer || ''}</td>
                      <td className="cell-code-desc" title={row.description || ''}>
                        <span className="code">{row.product_code}</span>
                        <span className="desc">{row.description || '—'}</span>
                      </td>
                      <td>{richiesta || ''}</td>
                      <td>{fatta}</td>
                      <td>{rimanente}</td>
                      <td>{renderPassaggiCell(row)}</td>
                      <td>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{secToHMS(elapsed)}</span>
                        {row.status === 'pausato' && (
                          <span style={{ marginLeft: 6, padding: '2px 6px', borderRadius: 6, background: '#666', color: 'white' }}>
                            Pausa
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="actions">
                          <button className="btn btn-primary" disabled={row.status !== 'da_iniziare'} onClick={() => onStart(row)}>Start</button>
                          {row.status === 'in_esecuzione' && (
                            <button className="btn btn-warning" onClick={() => onPause(row)}>Pausa</button>
                          )}
                          <button className="btn btn-success" disabled={row.status !== 'pausato'} onClick={() => onResume(row)}>Riprendi</button>
                          <button className="btn btn-danger" onClick={() => openStop(row)}>Stop</button>
                          <button
                            className="btn"
                            onClick={() => { setNotesTarget(row); setNotesOpen(true); }}
                            style={{ padding: '4px 8px', fontSize: 12, opacity: hasNotes ? 1 : 0.6, border: hasNotes ? '1px solid #888' : '1px dashed #666' }}
                            title={hasNotes ? 'Vedi note' : 'Aggiungi/vedi note'}
                          >
                            Note
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* COMPLETATI / PARZIALI (destra) */}
        <aside className="sticky-aside" style={{ border: '1px solid #2b2f3a', borderRadius: 8, padding: 10, alignSelf: 'start' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
            <h3 style={{ margin:0, fontSize:16 }}>Completati / Parziali</h3>
          </div>
          <div style={{ flex:1, minHeight:0, overflow:'auto', display:'grid', gap:6 }}>
            {batchesOnRight.length === 0 && <div style={{ opacity: .7, fontSize: 14 }}>— nessun parziale —</div>}
            {batchesOnRight.map(({ order, batch }, idx) => (
              <button
                key={order.id + '_' + batch.id + '_' + idx}
                className="btn"
                onClick={() => openAdvanceForBatch(order, batch)}
                style={{
                  justifyContent: 'space-between',
                  background: badgeColor(batch.status),
                  color: 'white',
                  padding: '6px 10px',
                }}
                title={order.description || ''}
              >
                <span style={{ textAlign:'left', fontSize: 13 }}>
                  {order.order_number} · {order.product_code}{' '}
                  <span style={{ opacity: .9 }}>({batch.qty}/{order.qty_requested || '—'})</span>
                </span>
                <span style={{ opacity: .9, fontSize: 12 }}>
                  {badgeLabel(batch.status)}
                </span>
              </button>
            ))}
          </div>
        </aside>
      </div>

      {/* STOP MODAL */}
      <Modal open={stopOpen} onClose={() => setStopOpen(false)} title="Concludi lavorazione">
        <div style={{ display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,background:'#10151c',border:'1px solid #223',borderRadius:8,padding:8,marginBottom:8 }}>
          <div><div style={{opacity:.7,fontSize:12}}>Ordine</div><strong>{stopTarget?.order_number}</strong></div>
          <div><div style={{opacity:.7,fontSize:12}}>Q.ta richiesta</div><strong>{Number(stopTarget?.qty_requested||0)}</strong></div>
          <div><div style={{opacity:.7,fontSize:12}}>Q.ta fatta</div><strong>{Number(stopTarget?.qty_done||0)}</strong></div>
        </div>
        <div style={{ display:'grid', gap:8 }}>
          <label>
            <div>Passaggio eseguito *</div>
            <select value={stopStep} onChange={(e) => setStopStep(Number(e.target.value))}>
              {Array.from({ length: Math.max(1, Math.min(10, Number(stopTarget?.steps_count || 10))) }).map((_, i) => (
                <option key={i+1} value={i+1}>{i+1}</option>
              ))}
            </select>
          </label>
          <label>
            <div>Pezzi (quantità fatta) *</div>
            <input type="number" min={1} step={1} value={stopPieces} onChange={(e) => setStopPieces(Number(e.target.value || 0))} />
          </label>
          <label>
            <div>Operatore *</div>
            <select value={stopOperator} onChange={(e) => setStopOperator(e.target.value)}>
              <option value="">— seleziona —</option>
              {operators.map((op: any) => (<option key={op.id} value={op.name}>{op.name}</option>))}
            </select>
          </label>
          <label>
            <div>Note (opzionale)</div>
            <input value={stopNotes} onChange={(e) => setStopNotes(e.target.value)} placeholder="Es. RAL 9010" />
          </label>
        </div>
        <div style={{ textAlign:'right', marginTop:10 }}>
          <button className="btn btn-danger" onClick={confirmStop}>Registra</button>
        </div>
      </Modal>

      {/* NOTE MODAL */}
      <Modal open={notesOpen} onClose={() => setNotesOpen(false)} title="Note ordine">
        <div style={{ display:'grid', gap:8, maxHeight: 360, overflow:'auto' }}>
          {(!(notesTarget?.notes_log) || notesTarget?.notes_log.length === 0) && <div>Nessuna nota.</div>}
          {((notesTarget?.notes_log) ?? []).slice().reverse().map((n: any, idx: number) => (
            <div key={idx} style={{ border:'1px solid #eee', borderRadius:6, padding:8 }}>
              <div style={{ fontSize:12, opacity:.8 }}>
                {new Date(n.ts).toLocaleString()} • {n.operator || '—'} • {n.step ? `Pass. ${n.step} • ` : ''}{n.pieces ? `${n.pieces} pz` : ''}
              </div>
              <div>{n.text}</div>
            </div>
          ))}
        </div>
      </Modal>

      {/* AVANZA FASE (BATCH) */}
      <Modal open={advanceOpen} onClose={() => setAdvanceOpen(false)} title="Avanza fase (parziale)">
        <div style={{ display:'grid', gap:8 }}>
          <div>
            <strong>{advanceOrder?.order_number}</strong> · {advanceOrder?.product_code}
            <div style={{ opacity:.9, fontSize:13 }}>{advanceOrder?.description || '—'}</div>
          </div>

          <label>
            <div>Nuova fase</div>
            <select value={advancePhase} onChange={(e) => setAdvancePhase(e.target.value as any)}>
              <option value="in_essiccazione">IN ESSICCAZIONE</option>
              <option value="in_imballaggio">IN IMBALLAGGIO</option>
              <option value="pronti_consegna">PRONTI PER LA CONSEGNA</option>
            </select>
          </label>

          {advancePhase === 'pronti_consegna' && (
            <div style={{ display:'grid', gap:8 }}>
              <label>
                <div>Imballati (pezzi) *</div>
                <input type="number" min={1} step={1} value={advancePacked} onChange={(e) => setAdvancePacked(Number(e.target.value || 0))} />
              </label>
              <label>
                <div>Nr. scatole / pallets</div>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={advanceBoxes === '' ? '' : Number(advanceBoxes)}
                  onChange={(e) => setAdvanceBoxes(e.target.value === '' ? '' : Number(e.target.value))}
                />
              </label>
              <label>
                <div>Misura</div>
                <input value={advanceSize} onChange={(e) => setAdvanceSize(e.target.value)} placeholder="Es. 80x120 cm" />
              </label>
              <label>
                <div>Peso (kg)</div>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={advanceWeight === '' ? '' : Number(advanceWeight)}
                  onChange={(e) => setAdvanceWeight(e.target.value === '' ? '' : Number(e.target.value))}
                />
              </label>
              <label>
                <div>Note</div>
                <input value={advanceNotes} onChange={(e) => setAdvanceNotes(e.target.value)} placeholder="Note per spedizione/consegna" />
              </label>
            </div>
          )}
        </div>
        <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:10 }}>
          <button className="btn btn-primary" onClick={saveAdvance}>Salva</button>
        </div>
      </Modal>

      {/* ADMIN */}
      <Modal open={adminOpen} onClose={() => setAdminOpen(false)} title="Gestione Operatori & Ordini">
        <div style={{ display:'grid', gap:14 }}>
          <div>
            <h4 style={{ margin:'0 0 6px' }}>Operatori</h4>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
              <input placeholder="Nuovo operatore" value={newOperatorName} onChange={(e) => setNewOperatorName(e.target.value)} />
              <button className="btn btn-primary" onClick={addOperator}>Aggiungi</button>
            </div>
            <div style={{ maxHeight:180, overflow:'auto', borderTop:'1px solid #eee', marginTop:6, paddingTop:6 }}>
              {operators.map((op: any) => (
                <div key={op.id} style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 0' }}>
                  <div style={{ flex:1 }}>{op.name} {op.active ? '' : <span style={{ color:'#a00' }}>(disattivo)</span>}</div>
                  <button className="btn" onClick={() => toggleOperator(op)}>{op.active ? 'Disattiva' : 'Attiva'}</button>
                  <button className="btn btn-danger" onClick={() => removeOperator(op)}>Elimina</button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 style={{ margin:'0 0 6px' }}>Ordini (stato / nascondi / ripristina / forza conclusione / azzera / elimina per sempre)</h4>
            <div style={{ maxHeight:420, overflow:'auto', borderTop:'1px solid #eee', paddingTop:6, display:'grid', gap:8 }}>
              {baseFiltered.filter((o: any) => !(o as any).deleted_permanently).map((o: any) => (
                <div key={o.id} style={{ display:'grid', gridTemplateColumns:'1fr auto auto', gap:6, alignItems:'center', padding:'4px 0' }}>
                  <div style={{ opacity: o.hidden ? 0.6 : 1 }}>
                    {o.order_number} · {o.product_code} — <em>{o.hidden ? 'CANCELLATO' : o.status}</em> — <strong>{o.qty_done || 0}</strong> / {o.qty_requested || 0}
                  </div>
                  <div style={{ display:'flex', gap:6, alignItems:'center', justifyContent:'flex-end' }}>
                    <select value={o.status} onChange={(e) => changeStatus(o, e.target.value)} title="Cambia stato">
                      <option value="da_iniziare">da_iniziare</option>
                      <option value="in_esecuzione">in_esecuzione</option>
                      <option value="pausato">pausato</option>
                      <option value="in_essiccazione">in_essiccazione</option>
                      <option value="in_imballaggio">in_imballaggio</option>
                      <option value="pronti_consegna">pronti_consegna</option>
                      <option value="eseguito">eseguito</option>
                    </select>

                    {!o.hidden ? (
                      <button className="btn btn-danger" onClick={() => hideOrder(o)}>Nascondi</button>
                    ) : (
                      <button className="btn" onClick={() => restoreOrder(o)}>Ripristina</button>
                    )}
                  </div>

                  <div style={{ display:'flex', gap:6, alignItems:'center', gridColumn:'1 / -1', flexWrap:'wrap' }}>
                    <input
                      type="number" min={0} step={1}
                      value={adminForceQty[o.id] === '' ? '' : Number(adminForceQty[o.id] ?? '')}
                      onChange={(e) => {
                        const v = e.target.value;
                        setAdminForceQty(prev => ({ ...prev, [o.id]: v === '' ? '' : Number(v) }));
                      }}
                      placeholder="Q.ta completata (facoltativa)" style={{ width: 180 }}
                      title="Se vuoto, userà la Q.ta richiesta (se presente)"
                    />
                    <button
                      className="btn" onClick={() =>
                        forceComplete(o, adminForceQty[o.id] === '' || adminForceQty[o.id] === undefined ? undefined : Number(adminForceQty[o.id]))
                      }
                      style={{ background:'#f2c14e', color:'#222', border:'1px solid #e0b23e' }}
                    >
                      Forza conclusione
                    </button>

                    <button className="btn" onClick={() => resetOrder(o)}>Azzera ordine</button>

                    <button className="btn btn-danger" onClick={() => deleteForever(o)}>Elimina per sempre</button>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize:12, opacity:.8, marginTop:6 }}>
              Gli ordini “Eliminati per sempre” non compaiono più in lista ma restano nello storico Excel.
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
