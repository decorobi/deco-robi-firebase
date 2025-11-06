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

/* -------------------- Utils -------------------- */

type RowIn = Record<string, any>;

const parseNumberIT = (v: any): number | null => {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (s === '') return null;
  if (s.includes('.') && s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  } else if (s.includes('.')) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function secToHMS(total: number = 0) {
  const sec = Math.max(0, Math.floor(total || 0));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

type StepAgg = { step: number; pieces: number; timeSec: number };
function aggregateStepStats(row: any): StepAgg[] {
  const time = (row?.steps_time ?? {}) as Record<string | number, number>;
  const prog = (row?.steps_progress ?? {}) as Record<string | number, number>;
  const steps = new Set<number>(
    [
      ...Object.keys(time).map((n) => Number(n)),
      ...Object.keys(prog).map((n) => Number(n)),
    ].filter((n) => Number.isFinite(n) && n > 0)
  );
  return [...steps]
    .map((step) => ({
      step,
      pieces: Number((prog as any)[step] ?? 0),
      timeSec: Number((time as any)[step] ?? 0),
    }))
    .sort((a, b) => a.step - b.step);
}

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

function getDayBounds(date: Date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function computeFullyDone(
  stepsCount: number,
  stepsProgress: Record<string | number, number> | undefined,
  defaultZero = 0,
): number {
  if (!stepsCount || stepsCount <= 0) return 0;
  const vals: number[] = [];
  for (let i = 1; i <= stepsCount; i++) {
    const v = (stepsProgress as any)?.[i] ?? 0;
    vals.push(Number(v) || 0);
  }
  if (vals.length === 0) return 0;
  return Math.max(defaultZero, Math.min(...vals));
}

/* -------------------- UI Helpers -------------------- */

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
        style={{ minWidth: 320, maxWidth: '92vw', padding: 12 }}
        onClick={(e) => e.stopPropagation()}
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

/* -------------------- Mobile helpers -------------------- */

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState<boolean>(() => (typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false));
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isMobile;
}

/* -------------------- Component -------------------- */

type TimerState = { running: boolean; startedAt: number | null; elapsed: number };

export default function App() {
  const [operators, setOperators] = useState<Operator[]>([]);
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [timers, setTimers] = useState<Record<string, TimerState>>({});
  const [tick, setTick] = useState(0);
  const isMobile = useIsMobile();

  // stile + layout
  useEffect(() => {
    const id = 'extra-style';
    if (!document.getElementById(id)) {
      const el = document.createElement('style');
      el.id = id;
      el.innerHTML = `
        @keyframes blinkPulse { 0%{transform:scale(1);filter:brightness(1)}50%{transform:scale(1.03);filter:brightness(1.25)}100%{transform:scale(1);filter:brightness(1)} }
        .blink { animation: blinkPulse 1s ease-in-out infinite; }
        .table { border-collapse: separate !important; border-spacing: 0 8px !important; width: 100%; }
        .table tbody tr { position: relative; }
        .table tbody tr::before { content:""; position:absolute; left:-6px; right:-6px; top:-4px; bottom:-4px; border:1px solid #3a4153; border-radius:12px; background:rgba(255,255,255,0.03); z-index:-1; box-shadow:0 1px 6px rgba(0,0,0,0.25); }
        .table tbody tr:hover::before { border-color:#55607a; background:rgba(255,255,255,0.05); }
        .table thead th { position: sticky; top: 0; z-index: 2; background: #0f1622; }
        .top-row { display:flex; gap:8px; align-items:stretch; margin-bottom:8px; flex-wrap:wrap; }
        .top-row .controls { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
        .top-row input[type="file"] { width: 100%; max-width: 320px; }
        .layout { display:grid; grid-template-columns: 1fr 260px; gap:12px; }
        aside.sticky-aside { position: sticky; top: 8px; height: calc(100vh - 16px); display: flex; flex-direction: column; }
        @media (max-width: 1024px) { .layout { grid-template-columns: 1fr; } aside.sticky-aside { position: static !important; height: auto; } }
        .table-wrap { overflow-x:auto; -webkit-overflow-scrolling: touch; }
        .table th, .table td { white-space: nowrap; padding: 8px 8px; }
        .btn { min-height: 32px; padding: 6px 10px; font-size: 13px; border-radius: 8px; }
        .cell-code-desc { max-width: 520px; }
        .cell-code-desc .code { font-weight: 600; }
        .cell-code-desc .desc { opacity:.95; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        @media (max-width: 640px) {
          .table-wrap { display:none; }
          .mobile-list { display:grid; gap:8px; }
          .mobile-card { border:1px solid #3a4153; border-radius:12px; background:rgba(255,255,255,0.03); padding:10px; box-shadow:0 1px 6px rgba(0,0,0,0.25); display:grid; gap:8px; }
          .mobile-card .row { display:grid; grid-template-columns:1fr auto; gap:8px; align-items:center; }
          .mobile-card .meta { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; font-size:13px; opacity:.95; }
          .mobile-card .meta div{ background:#111722; border:1px solid #2b2f3a; border-radius:8px; padding:6px 8px;}
          .mobile-card .actions { display:flex; flex-wrap:wrap; gap:6px; }
          .btn { padding:8px 10px; font-size:13px; min-height:34px; }
        }
        @media (min-width: 641px) { .mobile-list { display:none; } }
      `;
      document.head.appendChild(el);
    }
  }, []);

  /* -------------------- State & Modals -------------------- */
  const [stopOpen, setStopOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<OrderItem | null>(null);
  const [stopOperator, setStopOperator] = useState<string>('');
  const [stopPieces, setStopPieces] = useState<number>(0);
  const [stopStep, setStopStep] = useState<number>(1);
  const [stopNotes, setStopNotes] = useState<string>('');

  const [adminOpen, setAdminOpen] = useState(false);
  const [newOperatorName, setNewOperatorName] = useState('');

  // Forza conclusione (qty per ordine in ADMIN)
  const [adminForceQty, setAdminForceQty] = useState<Record<string, number | ''>>({});

  const [newOrderOpen, setNewOrderOpen] = useState(false);
  const [newOrder, setNewOrder] = useState({
    order_number: '',
    customer: '',
    product_code: '',
    description: '',
    ml: '' as any,
    qty_requested: '' as any,
    steps_count: 0,
  });

  const [notesOpen, setNotesOpen] = useState(false);
  const [notesTarget, setNotesTarget] = useState<OrderItem | null>(null);

  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [advanceTarget, setAdvanceTarget] = useState<OrderItem | null>(null);
  const [advancePhase, setAdvancePhase] =
    useState<'in_essiccazione'|'in_imballaggio'|'pronti_consegna'>('in_essiccazione');
  const [advancePacked, setAdvancePacked] = useState<number>(0);

  // campi pronti_consegna
  const [advanceBoxes, setAdvanceBoxes] = useState<number | ''>('');
  const [advanceSize, setAdvanceSize] = useState<string>('');
  const [advanceWeight, setAdvanceWeight] = useState<number | ''>('');
  const [advanceNotes, setAdvanceNotes] = useState<string>('');

  // Filtro cruscotto
  const [filterFrom, setFilterFrom] = useState<string>('');
  const [filterCustomer, setFilterCustomer] = useState<string>('');

  // carica dati
  useEffect(() => {
    (async () => {
      await ensureAnonAuth();
      const opsSnap = await getDocs(query(collection(db, 'operators'), orderBy('name')));
      setOperators(opsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Operator[]);
      const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')));
      setOrders(itemsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as OrderItem[]);
    })();
  }, []);

  // clienti unici per select filtro
  const customers = useMemo(() => {
    const vals = new Set<string>();
    orders.forEach((o: any) => {
      const c = String(o.customer || '').trim();
      if (c) vals.add(c);
    });
    return Array.from(vals).sort((a, b) => a.localeCompare(b));
  }, [orders]);

  // tick timer
  useEffect(() => {
    const anyRunning = Object.values(timers).some((t) => t.running);
    if (!anyRunning) return;
    const h = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(h);
  }, [timers]);

  const createdAtMs = (o: any): number | null => {
    const ca: any = o.created_at;
    if (!ca) return null;
    return ca.toMillis ? ca.toMillis() : (typeof ca === 'number' ? ca : null);
  };

  // filtro base: data + cliente
  const baseFiltered = useMemo(() => {
    let list = orders;
    if (filterFrom) {
      const from = new Date(filterFrom + 'T00:00:00').getTime();
      list = list.filter((o) => {
        const ts = createdAtMs(o as any);
        return ts ? ts >= from : false;
      });
    }
    if (filterCustomer) {
      list = list.filter((o: any) => (o.customer || '') === filterCustomer);
    }
    return list;
  }, [orders, filterFrom, filterCustomer]);

  // SINISTRA: mostra anche ordini in essiccazione/imballaggio/pronti se NON completamente finiti
  const visibleOrders = useMemo(() => {
    return baseFiltered.filter((o: any) => {
      if ((o as any).hidden) return false;

      const req = Number((o as any).qty_requested || 0);
      const done = Number((o as any).qty_done || 0);
      const fullyDone = req > 0 && done >= req;

      // FIX: lasciamo a sinistra qualsiasi stato "di flusso" finché non è completamente finito
      const st = (o as any).status;
      const showOnLeftIfNotDone = [
        'da_iniziare',
        'in_esecuzione',
        'pausato',
        'in_essiccazione',
        'in_imballaggio',
        'pronti_consegna',
      ].includes(st);

      return showOnLeftIfNotDone && !fullyDone;
    });
  }, [baseFiltered]);

  const kpi = useMemo(() => {
    const byStatus = (st: any) =>
      baseFiltered.filter((o: any) => !((o as any).hidden) && (o as any).status === st).length;
    return {
      da_iniziare: byStatus('da_iniziare'),
      in_esecuzione: byStatus('in_esecuzione'),
      eseguiti: byStatus('eseguito'),
    };
  }, [baseFiltered]);

  const todayAgg = useMemo(() => {
    const { start, end } = getDayBounds(new Date());
    let pezzi = 0;
    let sec = 0;
    baseFiltered.forEach((o: any) => {
      const ldt: any = (o as any).last_done_at;
      const ms = ldt?.toMillis ? ldt.toMillis() : (typeof ldt === 'number' ? ldt : null);
      if (ms && ms >= start.getTime() && ms <= end.getTime()) {
        pezzi += Number((o as any).last_pieces || 0);
        sec += Number((o as any).last_duration_sec || 0);
      }
    });
    return { pezziOggi: pezzi, secOggi: sec };
  }, [baseFiltered]);

  /* ------------------- IMPORT ------------------- */
  const handleImportCSV = async (file: File) => {
    try {
      await ensureAnonAuth();
      const parsed = await new Promise<RowIn[]>((resolve, reject) => {
        Papa.parse<RowIn>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (res: ParseResult<RowIn>) => resolve(res.data as RowIn[]),
          error: reject,
        });
      });
      if (!parsed || parsed.length === 0) throw new Error('Il file CSV sembra vuoto o senza intestazioni.');

      let created = 0;
      let updated = 0;

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
          if (Object.keys(patch).length > 0) {
            await setDoc(ref, patch, { merge: true });
            updated++;
          }
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
            steps_progress: {},
            steps_time: {},
            packed_qty: 0,
            status: 'da_iniziare' as const,
            created_at: serverTimestamp(),
            hidden: false,
            notes_log: [],
            ops_log: [],
            total_elapsed_sec: 0,
          };
          await setDoc(ref, row, { merge: true });
          created++;
        }
      }

      const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')));
      setOrders(itemsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as OrderItem[]);
      alert(`Import completato. Creati: ${created}, Aggiornati: ${updated}.`);
    } catch (err: any) {
      console.error(err);
      alert('Errore import: ' + err.message);
    }
  };

  /* ------------------- TIMER ------------------- */
  const baseElapsedOf = (row: any) => Number((row as any).total_elapsed_sec ?? (row as any).elapsed_sec ?? 0);

  const onStart = async (row: any) => {
    setTimers((t) => ({
      ...t,
      [row.id!]: { running: true, startedAt: Date.now(), elapsed: baseElapsedOf(row) },
    }));
    await updateDoc(doc(db, 'order_items', row.id!), {
      status: 'in_esecuzione',
      timer_start: Date.now(),
    } as any);
    setOrders((prev) =>
      prev.map((o: any) =>
        o.id === row.id ? { ...o, status: 'in_esecuzione', timer_start: Date.now() } : o
      ) as any
    );
  };

  const onPause = async (row: any) => {
    const t = timers[row.id!] || { running: false, startedAt: null, elapsed: baseElapsedOf(row) };
    const now = Date.now();
    const extra = t.startedAt ? Math.round((now - t.startedAt) / 1000) : 0;
    const elapsed = (t.elapsed || 0) + extra;

    setTimers((tt) => ({ ...tt, [row.id!]: { running: false, startedAt: null, elapsed } }));

    await updateDoc(doc(db, 'order_items', row.id!), {
      status: 'pausato',
      elapsed_sec: elapsed,
      total_elapsed_sec: elapsed,
      timer_start: null,
    } as any);

    setOrders((prev) =>
      prev.map((o: any) =>
        o.id === row.id ? { ...o, status: 'pausato', elapsed_sec: elapsed, total_elapsed_sec: elapsed, timer_start: null } : o
      ) as any
    );
  };

  const onResume = async (row: any) => {
    const prevElapsed = Number(timers[row.id!]?.elapsed ?? baseElapsedOf(row) ?? 0);
    setTimers((t) => ({
      ...t,
      [row.id!]: { running: true, startedAt: Date.now(), elapsed: prevElapsed },
    }));

    await updateDoc(doc(db, 'order_items', row.id!), {
      status: 'in_esecuzione',
      timer_start: Date.now(),
    } as any);

    setOrders((prev) =>
      prev.map((o: any) =>
        o.id === row.id ? { ...o, status: 'in_esecuzione', timer_start: Date.now() } : o
      ) as any
    );
  };

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

    const stepsCount = Number((row as any).steps_count || 0);
    if (!stopStep || stopStep < 1 || (stepsCount > 0 && stopStep > stepsCount)) {
      alert('Seleziona un passaggio valido.');
      return;
    }
    if (!stopPieces || stopPieces <= 0) {
      alert('Inserisci il numero di pezzi (maggiore di 0).');
      return;
    }
    if (!stopOperator) {
      alert('Seleziona un operatore.');
      return;
    }

    const t = timers[row.id!];
    the_now: {
      const now = Date.now();
      const extraFromRun = t?.startedAt ? Math.round((now - t.startedAt) / 1000) : 0;
      const prevElapsed = baseElapsedOf(row);
      const totalElapsed = Math.max(0, prevElapsed + extraFromRun);

      const pass = Number(stopStep || 0);

      const nextStepsTime: Record<number, number> = { ...((row as any).steps_time || {}) };
      nextStepsTime[pass] = (nextStepsTime[pass] ?? 0) + extraFromRun;

      const nextStepsProg: Record<number, number> = { ...((row as any).steps_progress || {}) };
      nextStepsProg[pass] = (nextStepsProg[pass] ?? 0) + (Number(stopPieces || 0));

      const qtyDone = computeFullyDone(Number((row as any).steps_count || 0), nextStepsProg, 0);

      const notesLog = Array.isArray((row as any).notes_log) ? [...(row as any).notes_log] : [];
      if (stopNotes && stopNotes.trim()) {
        notesLog.push({
          ts: new Date().toISOString(),
          operator: stopOperator || null,
          text: stopNotes.trim(),
          step: pass,
          pieces: Number(stopPieces || 0),
        });
      }
      const opsLog = Array.isArray((row as any).ops_log) ? [...(row as any).ops_log] : [];
      opsLog.push({
        ts: new Date().toISOString(),
        operator: stopOperator || null,
        step: pass,
        pieces: Number(stopPieces || 0),
        duration_sec: extraFromRun,
      });

      const richiesta = Number((row as any).qty_requested || 0);
      const isCompletedTot = richiesta > 0 && qtyDone >= richiesta;

      await setDoc(
        doc(db, 'order_items', row.id!),
        {
          status: isCompletedTot ? 'eseguito' : 'da_iniziare',
          elapsed_sec: totalElapsed,
          total_elapsed_sec: totalElapsed,
          timer_start: null,
          last_done_at: serverTimestamp(),
          steps_time: nextStepsTime,
          steps_progress: nextStepsProg,
          qty_done: qtyDone,
          last_operator: stopOperator || null,
          last_notes: stopNotes || null,
          last_step: pass,
          last_pieces: Number(stopPieces || 0),
          last_duration_sec: extraFromRun,
          notes_log: notesLog,
          ops_log: opsLog,
        } as any,
        { merge: true }
      );

      setTimers((tt) => ({ ...tt, [row.id!]: { running: false, startedAt: null, elapsed: totalElapsed } }));
      setOrders((prev) =>
        prev.map((o: any) =>
          o.id === row.id
            ? {
                ...o,
                status: isCompletedTot ? 'eseguito' : 'da_iniziare',
                elapsed_sec: totalElapsed,
                total_elapsed_sec: totalElapsed,
                timer_start: null,
                steps_time: nextStepsTime,
                steps_progress: nextStepsProg,
                qty_done: qtyDone,
                last_operator: stopOperator || null,
                last_notes: stopNotes || null,
                last_step: pass,
                last_pieces: Number(stopPieces || 0),
                last_duration_sec: extraFromRun,
                last_done_at: new Date() as any,
                notes_log: notesLog,
                ops_log: opsLog,
              }
            : o
        ) as any
      );
    }

    setStopOpen(false);
  };

  /* --------- Forza conclusione (ADMIN) --------- */
  const forceComplete = async (row: any, qtyOverride?: number) => {
    try {
      const richiesta = Number((row as any).qty_requested ?? 0);
      const qtyFromAdmin = typeof qtyOverride === 'number' && qtyOverride >= 0 ? qtyOverride : null;
      const qtyFinal =
        qtyFromAdmin !== null ? qtyFromAdmin :
        (richiesta > 0 ? richiesta : Number((row as any).qty_done || 0));

      const notesLog = Array.isArray((row as any).notes_log) ? [...(row as any).notes_log] : [];
      notesLog.push({
        ts: new Date().toISOString(),
        operator: 'SYSTEM',
        text: 'Forza conclusione',
        step: null,
        pieces: qtyFinal,
      });

      const patch: any = {
        status: 'eseguito',
        status_changed_at: serverTimestamp(),
        last_done_at: serverTimestamp(),
        forced_completed: true,
        qty_done: Number(qtyFinal || 0),
        notes_log: notesLog,
      };

      await setDoc(doc(db, 'order_items', (row as any).id!), patch, { merge: true });

      setOrders((prev) =>
        prev.map((o: any) =>
          o.id === row.id
            ? { ...o, ...patch, status_changed_at: new Date() as any, last_done_at: new Date() as any }
            : o
        ) as any
      );
    } catch (err: any) {
      alert('Errore forza conclusione: ' + err.message);
    }
  };

  /* --------- AZZERA COMPLETAMENTE (ADMIN) --------- */
  const resetOrder = async (row: any) => {
    try {
      const notesLog = Array.isArray((row as any).notes_log) ? [...(row as any).notes_log] : [];
      notesLog.push({
        ts: new Date().toISOString(),
        operator: 'SYSTEM',
        text: 'Azzera ordine (reset completo)',
        step: null,
        pieces: 0,
      });

      const patch: any = {
        status: 'da_iniziare',
        status_changed_at: serverTimestamp(),
        elapsed_sec: 0,
        total_elapsed_sec: 0,
        timer_start: null,

        qty_done: 0,
        steps_progress: {},
        steps_time: {},

        packed_qty: 0,
        packed_boxes: null,
        packed_size: null,
        packed_weight: null,
        packed_notes: null,

        last_operator: null,
        last_notes: null,
        last_step: null,
        last_pieces: null,
        last_duration_sec: null,
        last_done_at: null,

        notes_log: notesLog,
        forced_completed: false,
      };

      await setDoc(doc(db, 'order_items', (row as any).id!), patch, { merge: true });

      setOrders((prev) =>
        prev.map((o: any) =>
          o.id === row.id ? { ...o, ...patch, status_changed_at: new Date() as any } : o
        ) as any
      );
      setTimers((tt) => ({ ...tt, [row.id!]: { running: false, startedAt: null, elapsed: 0 } }));
    } catch (err: any) {
      alert('Errore azzera ordine: ' + err.message);
    }
  };

  /* ------------------- ADMIN & GESTIONE ------------------- */
  const addOperator = async () => {
    const name = newOperatorName.trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/\s+/g, '_');
    await setDoc(doc(db, 'operators', id), { name, active: true });
    setOperators((prev) => [...prev, { id, name, active: true } as any]);
    setNewOperatorName('');
  };
  const toggleOperator = async (op: Operator) => {
    await updateDoc(doc(db, 'operators', (op as any).id!), { active: !(op as any).active } as any);
    setOperators((prev) => prev.map((o: any) => (o.id === (op as any).id ? { ...o, active: !o.active } : o)));
  };
  const removeOperator = async (op: Operator) => {
    if (!(op as any).id) return;
    await deleteDoc(doc(db, 'operators', (op as any).id));
    setOperators((prev) => prev.filter((o: any) => o.id !== (op as any).id));
  };

  const changeStatus = async (o: any, newStatus: any) => {
    const patch: any = { status: newStatus, status_changed_at: serverTimestamp() };
    await updateDoc(doc(db, 'order_items', o.id), patch);
    setOrders((prev) => prev.map((x: any) => (x.id === o.id ? { ...x, ...patch, status_changed_at: new Date() as any } : x)));
  };

  const hideOrder = async (o: any) => {
    await updateDoc(doc(db, 'order_items', o.id), { hidden: true, deleted_at: serverTimestamp() } as any);
    setOrders((prev) => prev.map((x: any) => (x.id === o.id ? { ...x, hidden: true, deleted_at: new Date() as any } : x)));
  };
  const restoreOrder = async (o: any) => {
    await updateDoc(doc(db, 'order_items', o.id), { hidden: false } as any);
    setOrders((prev) => prev.map((x: any) => (x.id === o.id ? { ...x, hidden: false } : x)));
  };

  const createOrder = async () => {
    const order_number = newOrder.order_number.trim();
    const product_code = newOrder.product_code.trim();
    if (!order_number || !product_code) { alert('Ordine e Codice sono obbligatori'); return; }

    const row: any = {
      order_number,
      customer: newOrder.customer.trim(),
      product_code,
      description: newOrder.description.trim(),
      ml: parseNumberIT(newOrder.ml),
      qty_requested: parseNumberIT(newOrder.qty_requested) ?? 0,
      qty_in_oven: 0,
      qty_done: 0,
      steps_count: Number(parseNumberIT(newOrder.steps_count) || 0),
      steps_progress: {},
      steps_time: {},
      packed_qty: 0,
      status: 'da_iniziare',
      created_at: serverTimestamp(),
      hidden: false,
      notes_log: [],
      ops_log: [],
      total_elapsed_sec: 0,
    };

    const id = toDocId(row.order_number, row.product_code);
    await setDoc(doc(db, 'order_items', id), row, { merge: true });

    setOrders((prev) => [{ id, ...(row as any) }, ...prev]);
    setNewOrderOpen(false);
    setNewOrder({
      order_number: '',
      customer: '',
      product_code: '',
      description: '',
      ml: '' as any,
      qty_requested: '' as any,
      steps_count: 0
    });
  };

  /* ------------------- EXPORT ------------------- */
  const exportExcel = () => {
    const exportBase = baseFiltered;

    const rows = exportBase.map((o: any) => {
      const richiesta = Number((o as any).qty_requested ?? 0);
      const fatta = Number((o as any).qty_done ?? 0);
      const rimanente = Math.max(0, richiesta - fatta);
      const ops = Array.from(new Set(((((o as any).ops_log ?? []) as any[]).map(x => x.operator).filter(Boolean)))) as string[];
      const noteStr = ((((o as any).notes_log ?? []) as any[]).map((n) =>
        `${new Date(n.ts).toLocaleString()}${n.operator ? ` (${n.operator})` : ''}: ${n.text || ''}`.trim()
      )).join(' | ');
      return {
        Ordine: (o as any).order_number,
        Cliente: (o as any).customer || '',
        Codice: (o as any).product_code,
        Descrizione: (o as any).description || '',
        ML: (o as any).ml ?? '',
        'Q.ta richiesta': richiesta,
        'Q.ta fatta': fatta,
        'Q.ta rimanente': rimanente,
        Operatori: ops.join(', '),
        Note: noteStr,
        'Tempo totale': secToHMS(Number((o as any).total_elapsed_sec || (o as any).elapsed_sec || 0)),
        Stato: (o as any).hidden ? 'CANCELLATO' : (o as any).status,
        'Imballati (pz)': (o as any).packed_qty ?? '',
        'Scatole/Pallets': (o as any).packed_boxes ?? '',
        'Misura': (o as any).packed_size ?? '',
        'Peso (kg)': (o as any).packed_weight ?? '',
        'Note consegna': (o as any).packed_notes ?? '',
      };
    });

    const aggRows: Array<{ Ordine: any; Riga: string; Passaggio: number; Pezzi: number; Tempo: string }> = [];
    exportBase.forEach((o: any, idx: number) => {
      const stats = aggregateStepStats(o);
      stats.forEach((s) => {
        aggRows.push({
          Ordine: (o as any).order_number,
          Riga: String((o as any).product_code || idx + 1),
          Passaggio: s.step,
          Pezzi: s.pieces || 0,
          Tempo: secToHMS(s.timeSec || 0),
        });
      });
    });

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws1, 'Riepilogo');

    const ws2 = XLSX.utils.json_to_sheet(aggRows, { header: ['Ordine', 'Riga', 'Passaggio', 'Pezzi', 'Tempo'] });
    XLSX.utils.book_append_sheet(wb, ws2, 'Tempi per passaggio');

    const activityRows = exportBase.flatMap((o: any) =>
      (((o as any).ops_log ?? []) as any[]).map((a) => ({
        Ordine: (o as any).order_number,
        Riga: (o as any).product_code,
        TS: new Date(a.ts).toLocaleString(),
        Operatore: a.operator || '',
        Passaggio: a.step,
        Pezzi: a.pieces,
        'Durata sec': a.duration_sec || 0,
      }))
    );
    if (activityRows.length) {
      const ws3 = XLSX.utils.json_to_sheet(activityRows, { header: ['Ordine','Riga','TS','Operatore','Passaggio','Pezzi','Durata sec'] });
      XLSX.utils.book_append_sheet(wb, ws3, 'Attività');
    }

    XLSX.writeFile(wb, `deco-riepilogo-${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  /* ------------------- Render helpers ------------------- */

  const renderPassaggiCell = (row: any) => {
    const stats = aggregateStepStats(row);
    if (!stats.length) return <>—</>;
    const richiesta = Number((row as any).qty_requested || 0) || Infinity;
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

  const completati = useMemo(() => {
    const now = Date.now();
    const week = 7 * 24 * 3600 * 1000;
    return baseFiltered
      .filter((o: any) => !((o as any).hidden))
      .filter((o: any) => {
        const status = (o as any).status;
        const inRightPhase =
          status === 'eseguito' ||
          status === 'in_essiccazione' ||
          status === 'in_imballaggio' ||
          status === 'pronti_consegna';
        const parziale = Number((o as any).qty_done || 0) > 0;

        if (status === 'pronti_consegna') {
          const sca: any = (o as any).status_changed_at;
          const ts = sca?.toMillis ? sca.toMillis() : (typeof sca === 'number' ? sca : null);
          if (ts && now - ts > week) return false;
        }
        return inRightPhase || parziale;
      });
  }, [baseFiltered]);

  const badgeColor = (s: any, qtyDone?: number) => {
    if (s === 'in_essiccazione') return '#f2c14e';
    if (s === 'in_imballaggio') return '#8b5a2b';
    if (s === 'pronti_consegna') return '#168a3d';
    if (s === 'eseguito') return '#555';
    if ((qtyDone ?? 0) > 0) return '#555';
    return '#666';
  };
  const badgeLabel = (s: any, qtyDone?: number) => {
    if (s === 'in_essiccazione') return 'ESSICCAZIONE';
    if (s === 'in_imballaggio') return 'IMBALLAGGIO';
    if (s === 'pronti_consegna') return 'PRONTI';
    if (s === 'eseguito') return 'COMPLETATO';
    if ((qtyDone ?? 0) > 0) return 'PARZIALE';
    return 'COMPLETATO';
  };

  /* ------------------- Prefill campi modal AVANZA quando selezioni un ordine ------------------- */
  const openAdvanceFor = (o: any) => {
    setAdvanceTarget(o);
    // Prefill dalla riga selezionata
    const currentPhase: any =
      ['in_essiccazione','in_imballaggio','pronti_consegna'].includes(o.status) ? o.status : 'in_essiccazione';
    setAdvancePhase(currentPhase);
    setAdvancePacked(Number(o.packed_qty || 0));
    setAdvanceBoxes(
      o.packed_boxes === null || o.packed_boxes === undefined || o.packed_boxes === ''
        ? ''
        : Number(o.packed_boxes)
    );
    setAdvanceSize(o.packed_size || '');
    setAdvanceWeight(
      o.packed_weight === null || o.packed_weight === undefined || o.packed_weight === ''
        ? ''
        : Number(o.packed_weight)
    );
    setAdvanceNotes(o.packed_notes || '');
    setAdvanceOpen(true);
  };

  /* ------------------- Mobile Card ------------------- */
  const MobileOrderCard = ({ row }: { row: any }) => {
    const t = timers[row.id!] || { running: false, startedAt: null, elapsed: baseElapsedOf(row) };
    const now = Date.now();
    const _ = tick;
    const elapsed = t.running && t.startedAt ? t.elapsed + Math.round((now - t.startedAt) / 1000) : t.elapsed;

    const richiesta = Number((row as any).qty_requested ?? 0);
    const fatta = Number((row as any).qty_done ?? 0);
    const rimanente = Math.max(0, richiesta - fatta);
    const hasNotes = Array.isArray((row as any).notes_log) && (row as any).notes_log.length > 0;

    return (
      <div className="mobile-card">
        <div className="row">
          <div>
            <div style={{ fontWeight: 700 }}>{(row as any).order_number} · {(row as any).product_code}</div>
            <div style={{ opacity: 0.9, fontSize: 13 }}>
              {(row as any).customer || '—'} • {(row as any).description || '—'}
            </div>
          </div>
          <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
            {secToHMS(elapsed)}{(row as any).status === 'pausato' ? ' ⏸️' : ''}
          </div>
        </div>

        <div className="meta">
          <div><strong>Rich.</strong> {richiesta || '—'}</div>
          <div><strong>Fatta</strong> {fatta}</div>
          <div><strong>Riman.</strong> {rimanente}</div>
          <div><strong>Passi</strong> {aggregateStepStats(row).length || 0}</div>
        </div>

        <div className="actions">
          <button
            className="btn btn-primary"
            disabled={(row as any).status !== 'da_iniziare'}
            onClick={() => onStart(row)}
          >
            Start
          </button>

          {(row as any).status === 'in_esecuzione' && (
            <button className="btn btn-warning" onClick={() => onPause(row)}>Pausa</button>
          )}

          <button
            className={`btn btn-success ${(row as any).status === 'pausato' ? 'blink' : ''}`}
            disabled={(row as any).status !== 'pausato'}
            onClick={() => onResume(row)}
          >
            Riprendi
          </button>

          <button className="btn btn-danger" onClick={() => openStop(row)}>Stop</button>

          <button
            className="btn"
            onClick={() => { setNotesTarget(row); setNotesOpen(true); }}
            style={{
              padding: '6px 8px',
              opacity: hasNotes ? 1 : 0.7,
              border: hasNotes ? '1px solid #888' : '1px dashed #666'
            }}
            title={hasNotes ? 'Vedi note' : 'Aggiungi/vedi note'}
          >
            Note
          </button>
        </div>
      </div>
    );
  };

  /* ------------------- Render ------------------- */
  return (
    <div style={{ padding: 8 }}>
      <h2 style={{ marginTop: 0, marginBottom: 8 }}>Gestione Produzione</h2>

      {/* TOP ROW */}
      <div className="top-row">
        {/* controlli */}
        <div className="controls">
          <div style={{ minWidth: 200, maxWidth: 320, width: '100%' }}>
            <input
              type="file"
              accept=".csv,.txt"
              onChange={(e) => e.target.files && handleImportCSV(e.target.files[0])}
              style={{ width: '100%' }}
            />
          </div>
          <button className="btn" onClick={() => setAdminOpen(true)}>ADMIN</button>
          <button className="btn" onClick={() => setNewOrderOpen(true)}>INSERISCI ORDINE</button>
        </div>

        {/* CRUSCOTTO */}
        <div
          style={{
            marginLeft: 8,
            flex: 1,
            border: '1px solid #2b2f3a',
            borderRadius: 8,
            padding: 10,
            minWidth: 260
          }}
        >
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
                {customers.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
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
        {/* LISTA ORDINI */}
        <div>
          {/* mobile cards */}
          <div className="mobile-list">
            {visibleOrders.map((row: any) => (
              <MobileOrderCard key={row.id} row={row} />
            ))}
          </div>

          {/* tabella per >=641px */}
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
                  const now = Date.now();
                  const _ = tick;
                  const elapsed = t.running && t.startedAt ? t.elapsed + Math.round((now - t.startedAt) / 1000) : t.elapsed;

                  const richiesta = Number((row as any).qty_requested ?? 0);
                  const fatta = Number((row as any).qty_done ?? 0);
                  const rimanente = Math.max(0, richiesta - fatta);

                  const hasNotes = Array.isArray((row as any).notes_log) && (row as any).notes_log.length > 0;

                  return (
                    <tr key={row.id}>
                      <td><strong>{(row as any).order_number}</strong></td>
                      <td>{(row as any).customer || ''}</td>
                      <td className="cell-code-desc" title={(row as any).description || ''}>
                        <div className="code">{(row as any).product_code}</div>
                        <div className="desc">{(row as any).description || '—'}</div>
                      </td>
                      <td>{richiesta || ''}</td>
                      <td>{fatta}</td>
                      <td>{rimanente}</td>
                      <td>{renderPassaggiCell(row)}</td>
                      <td>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{secToHMS(elapsed)}</span>
                        {(row as any).status === 'pausato' && (
                          <span style={{ marginLeft: 6, padding: '2px 6px', borderRadius: 6, background: '#666', color: 'white' }}>
                            Pausa
                          </span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <button
                            className="btn btn-primary"
                            disabled={(row as any).status !== 'da_iniziare'}
                            onClick={() => onStart(row)}
                          >
                            Start
                          </button>

                          {(row as any).status === 'in_esecuzione' && (
                            <button className="btn btn-warning" onClick={() => onPause(row)}>
                              Pausa
                            </button>
                          )}

                          <button
                            className={`btn btn-success ${(row as any).status === 'pausato' ? 'blink' : ''}`}
                            disabled={(row as any).status !== 'pausato'}
                            onClick={() => onResume(row)}
                          >
                            Riprendi
                          </button>

                          <button className="btn btn-danger" onClick={() => openStop(row)}>Stop</button>

                          <button
                            className="btn"
                            onClick={() => { setNotesTarget(row); setNotesOpen(true); }}
                            style={{
                              padding: '4px 8px',
                              fontSize: 12,
                              opacity: hasNotes ? 1 : 0.6,
                              border: hasNotes ? '1px solid #888' : '1px dashed #666'
                            }}
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

        {/* COMPLETATI - Aside full height */}
        <aside
          className="sticky-aside"
          style={{
            border: '1px solid #2b2f3a',
            borderRadius: 8,
            padding: 10,
            alignSelf: 'start',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Completati</h3>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', gap: 6 }}>
            {completati.length === 0 && <div style={{ opacity: 0.7, fontSize: 14 }}>— nessun ordine —</div>}
            {completati.map((o: any) => (
              <button
                key={(o as any).id}
                className="btn"
                onClick={() => openAdvanceFor(o)}
                style={{
                  justifyContent: 'space-between',
                  background: badgeColor((o as any).status, (o as any).qty_done as any),
                  color: 'white',
                  padding: '6px 10px'
                }}
                title={(o as any).description || ''}
              >
                <span style={{ textAlign: 'left', fontSize: 13 }}>
                  {(o as any).order_number} · {(o as any).product_code}
                </span>
                <span style={{ opacity: 0.9, fontSize: 12 }}>
                  {badgeLabel((o as any).status, (o as any).qty_done as any)}{' '}
                  {(o as any).qty_done ? `(${(o as any).qty_done}/${(o as any).qty_requested})` : ''}
                </span>
              </button>
            ))}
          </div>
        </aside>
      </div>

      {/* STOP MODAL */}
      <Modal open={stopOpen} onClose={() => setStopOpen(false)} title="Concludi lavorazione">
        <div style={{
          display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,
          background:'#10151c',border:'1px solid #223',borderRadius:8,padding:8,marginBottom:8
        }}>
          <div><div style={{opacity:.7,fontSize:12}}>N. Ordine</div><strong>{(stopTarget as any)?.order_number}</strong></div>
          <div><div style={{opacity:.7,fontSize:12}}>Q.ta richiesta</div><strong>{Number((stopTarget as any)?.qty_requested||0)}</strong></div>
          <div><div style={{opacity:.7,fontSize:12}}>Q.ta fatta</div><strong>{Number((stopTarget as any)?.qty_done||0)}</strong></div>
        </div>

        <div className="grid" style={{ display: 'grid', gap: 8 }}>
          <label>
            <div>Passaggio eseguito *</div>
            <select
              value={stopStep}
              onChange={(e) => setStopStep(Number(e.target.value))}
              required
            >
              {Array.from({ length: Math.max(1, Math.min(10, Number((stopTarget as any)?.steps_count || 10))) }).map((_, i) => (
                <option key={i+1} value={i+1}>{i+1}</option>
              ))}
            </select>
          </label>
          <label>
            <div>Pezzi (quantità fatta) *</div>
            <input
              type="number"
              min={1}
              step={1}
              value={stopPieces}
              onChange={(e) => setStopPieces(Number(e.target.value || 0))}
              required
            />
          </label>
          <label>
            <div>Operatore *</div>
            <select
              value={stopOperator}
              onChange={(e) => setStopOperator(e.target.value)}
              required
            >
              <option value="">— seleziona —</option>
              {operators.map((op: any) => (<option key={op.id} value={op.name}>{op.name}</option>))}
            </select>
          </label>
          <label>
            <div>Note (opzionale)</div>
            <input value={stopNotes} onChange={(e) => setStopNotes(e.target.value)} placeholder="Es. RAL 9010" />
          </label>
        </div>
        <div style={{ textAlign: 'right', marginTop: 10 }}>
          <button className="btn btn-danger" onClick={confirmStop}>Registra</button>
        </div>
      </Modal>

      {/* NOTE MODAL */}
      <Modal open={notesOpen} onClose={() => setNotesOpen(false)} title="Note ordine">
        <div style={{ display: 'grid', gap: 8, maxHeight: 360, overflow: 'auto' }}>
          {(!((notesTarget as any)?.notes_log) || (notesTarget as any).notes_log.length === 0) && <div>Nessuna nota.</div>}
          {(((notesTarget as any)?.notes_log) ?? []).slice().reverse().map((n: any, idx: number) => (
            <div key={idx} style={{ border: '1px solid #eee', borderRadius: 6, padding: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                {new Date(n.ts).toLocaleString()} • {n.operator || '—'} • {n.step ? `Pass. ${n.step} • ` : ''}{n.pieces ? `${n.pieces} pz` : ''}
              </div>
              <div>{n.text}</div>
            </div>
          ))} 
        </div>
      </Modal>

      {/* AVANZA FASE */}
      <Modal open={advanceOpen} onClose={() => setAdvanceOpen(false)} title="Avanza fase ordine completato">
        <div style={{ display: 'grid', gap: 8 }}>
          <div>
            <strong>{(advanceTarget as any)?.order_number}</strong> · {(advanceTarget as any)?.product_code}
            <div style={{ opacity: .9, fontSize: 13, marginTop: 2 }}>{(advanceTarget as any)?.description || '—'}</div>
          </div>

          <label>
            <div>Quale passaggio vuoi eseguire ora?</div>
            <select value={advancePhase} onChange={(e) => setAdvancePhase(e.target.value as any)}>
              <option value="in_essiccazione">IN ESSICCAZIONE</option>
              <option value="in_imballaggio">IN IMBALLAGGIO</option>
              <option value="pronti_consegna">PRONTI PER LA CONSEGNA</option>
            </select>
          </label>

          {advancePhase === 'pronti_consegna' && (
            <div style={{ display:'grid', gap:8 }}>
              <label>
                <div>Quanti pezzi imballati? *</div>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={advancePacked}
                  onChange={(e) => setAdvancePacked(Number(e.target.value || 0))}
                  required
                />
              </label>
              <label>
                <div>Nr. scatole / pallets</div>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={advanceBoxes === '' ? '' : Number(advanceBoxes)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAdvanceBoxes(v === '' ? '' : Number(v));
                  }}
                  placeholder="Es. 2"
                />
              </label>
              <label>
                <div>Misura</div>
                <input
                  value={advanceSize}
                  onChange={(e) => setAdvanceSize(e.target.value)}
                  placeholder="Es. 80x120 cm"
                />
              </label>
              <label>
                <div>Peso (kg)</div>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={advanceWeight === '' ? '' : Number(advanceWeight)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAdvanceWeight(v === '' ? '' : Number(v));
                  }}
                  placeholder="Es. 120"
                />
              </label>
              <label>
                <div>Note</div>
                <input
                  value={advanceNotes}
                  onChange={(e) => setAdvanceNotes(e.target.value)}
                  placeholder="Note per spedizione/consegna"
                />
              </label>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="btn btn-primary" onClick={async () => {
            if (!advanceTarget) return;
            const id = (advanceTarget as any).id!;
            const patch: any = { status: advancePhase, status_changed_at: serverTimestamp() };

            if (advancePhase === 'pronti_consegna') {
              if (!advancePacked || advancePacked <= 0) {
                alert('Inserisci i pezzi imballati per passare a PRONTI PER LA CONSEGNA');
                return;
              }
              patch.packed_qty = Number(advancePacked);
              if (advanceBoxes !== '') patch.packed_boxes = Number(advanceBoxes);
              if (advanceSize.trim()) patch.packed_size = advanceSize.trim();
              if (advanceWeight !== '') patch.packed_weight = Number(advanceWeight);
              if (advanceNotes.trim()) patch.packed_notes = advanceNotes.trim();
            } else {
              // se non è "pronti", puliamo i campi imballo
              patch.packed_qty = 0;
              patch.packed_boxes = null;
              patch.packed_size = null;
              patch.packed_weight = null;
              patch.packed_notes = null;
            }

            await updateDoc(doc(db, 'order_items', id), patch);

            // aggiorna subito in memoria locale (così al riaprire vedi i dati)
            setOrders((prev) =>
              prev.map((o: any) => (o.id === id ? { ...o, ...patch, status_changed_at: new Date() as any } : o))
            );

            // mantieni il target aggiornato (se resta aperto)
            setAdvanceTarget((prev: any) => prev && prev.id === id ? { ...prev, ...patch } : prev);

            setAdvanceOpen(false);
          }}>Salva</button>
        </div>
      </Modal>

      {/* ADMIN MODAL */}
      <Modal open={adminOpen} onClose={() => setAdminOpen(false)} title="Gestione Operatori & Ordini">
        <div style={{ display: 'grid', gap: 14 }}>
          {/* Operatori */}
          <div>
            <h4 style={{ margin: '0 0 6px' }}>Operatori</h4>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <input
                placeholder="Nuovo operatore"
                value={newOperatorName}
                onChange={(e) => setNewOperatorName(e.target.value)}
              />
              <button className="btn btn-primary" onClick={addOperator}>Aggiungi</button>
            </div>
            <div style={{ maxHeight: 180, overflow: 'auto', borderTop: '1px solid #eee', marginTop: 6, paddingTop: 6 }}>
              {operators.map((op: any) => (
                <div key={op.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
                  <div style={{ flex: 1 }}>{op.name} {op.active ? '' : <span style={{ color: '#a00' }}>(disattivo)</span>}</div>
                  <button className="btn" onClick={() => toggleOperator(op)}>{op.active ? 'Disattiva' : 'Attiva'}</button>
                  <button className="btn btn-danger" onClick={() => removeOperator(op)}>Elimina</button>
                </div>
              ))}
            </div>
          </div>

          {/* Ordini */}
          <div>
            <h4 style={{ margin: '0 0 6px' }}>Ordini (stato / nascondi / ripristina / forza conclusione / azzera)</h4>
            <div style={{ maxHeight: 420, overflow: 'auto', borderTop: '1px solid #eee', paddingTop: 6, display:'grid', gap:8 }}>
              {baseFiltered.map((o: any) => (
                <div key={o.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 6, alignItems: 'center', padding: '4px 0' }}>
                  <div style={{ opacity: (o as any).hidden ? 0.6 : 1 }}>
                    {(o as any).order_number} · {(o as any).product_code} — <em>{(o as any).hidden ? 'CANCELLATO' : (o as any).status}</em> — <strong>{o.qty_done || 0}</strong> / {o.qty_requested || 0}
                  </div>
                  <div style={{ display:'flex', gap:6, alignItems:'center', justifyContent:'flex-end' }}>
                    <select
                      value={(o as any).status}
                      onChange={(e) => changeStatus(o, e.target.value)}
                      title="Cambia stato"
                    >
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

                  {/* Forza conclusione + Azzera */}
                  <div style={{ display:'flex', gap:6, alignItems:'center', gridColumn: '1 / -1', flexWrap:'wrap' }}>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={adminForceQty[o.id] === '' ? '' : Number(adminForceQty[o.id] ?? '')}
                      onChange={(e) => {
                        const v = e.target.value;
                        setAdminForceQty(prev => ({ ...prev, [o.id]: v === '' ? '' : Number(v) }));
                      }}
                      placeholder="Q.ta completata (facoltativa)"
                      style={{ width: 180 }}
                      title="Se vuoto, userà la Q.ta richiesta (se presente)"
                    />
                    <button
                      className="btn"
                      onClick={() => forceComplete(o, adminForceQty[o.id] === '' || adminForceQty[o.id] === undefined ? undefined : Number(adminForceQty[o.id]))}
                      style={{ background: '#f2c14e', color: '#222', border: '1px solid #e0b23e' }}
                      title="Segna come completato con la quantità indicata"
                    >
                      Forza conclusione
                    </button>

                    <button
                      className="btn"
                      onClick={() => resetOrder(o)}
                      title="Azzera completamente: quantità, passaggi, tempi, imballo e stato a 'da_iniziare'"
                    >
                      Azzera ordine
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
              Gli ordini nascosti non compaiono in schermata, ma saranno comunque presenti nello SCARICO EXCEL (Stato: CANCELLATO).
            </div>
          </div>
        </div>
      </Modal>

      {/* NUOVO ORDINE */}
      <Modal open={newOrderOpen} onClose={() => setNewOrderOpen(false)} title="Nuovo ordine">
        <div style={{ display:'grid', gap:8 }}>
          <label>
            <div>Numero ordine *</div>
            <input value={newOrder.order_number} onChange={(e) => setNewOrder({ ...newOrder, order_number: e.target.value })} />
          </label>
          <label>
            <div>Cliente</div>
            <input value={newOrder.customer} onChange={(e) => setNewOrder({ ...newOrder, customer: e.target.value })} />
          </label>
          <label>
            <div>Codice prodotto *</div>
            <input value={newOrder.product_code} onChange={(e) => setNewOrder({ ...newOrder, product_code: e.target.value })} />
          </label>
          <label>
            <div>Descrizione</div>
            <input value={newOrder.description} onChange={(e) => setNewOrder({ ...newOrder, description: e.target.value })} />
          </label>
          <label>
            <div>ML</div>
            <input value={newOrder.ml as any} onChange={(e) => setNewOrder({ ...newOrder, ml: e.target.value })} />
          </label>
          <label>
            <div>Q.ta richiesta</div>
            <input value={newOrder.qty_requested as any} onChange={(e) => setNewOrder({ ...newOrder, qty_requested: e.target.value })} />
          </label>
          <label>
            <div>Numero passaggi</div>
            <input value={newOrder.steps_count as any} onChange={(e) => setNewOrder({ ...newOrder, steps_count: e.target.value as any })} />
          </label>
        </div>
        <div style={{ textAlign:'right', marginTop:10 }}>
          <button className="btn btn-primary" onClick={createOrder}>Crea</button>
        </div>
      </Modal>
    </div>
  );
}
