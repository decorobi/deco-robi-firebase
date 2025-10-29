import React, { useEffect, useMemo, useState } from 'react';
import Papa, { ParseResult } from 'papaparse';
import * as XLSX from 'xlsx';
import type { Operator, OrderItem } from './types';
import { db, ensureAnonAuth } from './lib/firebaseClient';
import {
  collection,
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
        style={{ minWidth: 360, maxWidth: '92vw', padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        {props.title && <h3 style={{ marginTop: 0 }}>{props.title}</h3>}
        {props.children}
        <div style={{ textAlign: 'right', marginTop: 12 }}>
          <button className="btn btn-secondary" onClick={props.onClose}>Chiudi</button>
        </div>
      </div>
    </div>
  );
}

/* -------------------- Component -------------------- */

type TimerState = { running: boolean; startedAt: number | null; elapsed: number };

export default function App() {
  const [operators, setOperators] = useState<Operator[]>([]);
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [timers, setTimers] = useState<Record<string, TimerState>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = 'blink-style';
    if (!document.getElementById(id)) {
      const el = document.createElement('style');
      el.id = id;
      el.innerHTML = `
        @keyframes blinkPulse {
          0% { transform: scale(1); filter: brightness(1); }
          50% { transform: scale(1.03); filter: brightness(1.25); }
          100% { transform: scale(1); filter: brightness(1); }
        }
        .blink { animation: blinkPulse 1s ease-in-out infinite; }
      `;
      document.head.appendChild(el);
    }
  }, []);

  const [stopOpen, setStopOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<OrderItem | null>(null);
  const [stopOperator, setStopOperator] = useState<string>('');
  const [stopPieces, setStopPieces] = useState<number>(0);
  const [stopStep, setStopStep] = useState<number>(1);
  const [stopNotes, setStopNotes] = useState<string>('');

  const [adminOpen, setAdminOpen] = useState(false);
  const [newOperatorName, setNewOperatorName] = useState('');

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

  const [filterFrom, setFilterFrom] = useState<string>(''); // yyyy-mm-dd

  useEffect(() => {
    (async () => {
      await ensureAnonAuth();
      const opsSnap = await getDocs(query(collection(db, 'operators'), orderBy('name')));
      setOperators(opsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Operator[]);
      const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')));
      setOrders(itemsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as OrderItem[]);
    })();
  }, []);

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

  const baseFiltered = useMemo(() => {
    if (!filterFrom) return orders;
    const from = new Date(filterFrom + 'T00:00:00').getTime();
    return orders.filter((o) => {
      const ts = createdAtMs(o as any);
      return ts ? ts >= from : false;
    });
  }, [orders, filterFrom]);

  // a sinistra mostro tutto tranne gli "eseguito" (che vanno solo a destra)
  const visibleOrders = useMemo(
    () => baseFiltered.filter((o: any) => !((o as any).hidden) && (o as any).status !== 'eseguito'),
    [baseFiltered]
  );

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
      const batch = parsed
        .map((r) => {
          const order_number = pick(r, ['numero ordine', 'n ordine', 'ordine', 'num ordine']);
          const customer = pick(r, ['cliente']);
          const product_code = pick(r, ['codice prodotto', 'codice', 'prodotto', 'codice prod']);
          const description = pick(r, ['descrizione', 'descr', 'descrizione prodotto', 'desc', 'descr.']);
          const mlVal = pick(r, ['ml']);
          const qty_requested = pick(r, ['quantita inserita', 'quantità inserita', 'quantita', 'qty richiesta', 'qta richiesta']);
          const qty_in_oven = pick(r, ['inforno', 'in forno']);
          const steps = pick(r, ['passaggi', 'n passaggi', 'passi']);
          if (!order_number || !product_code) return null;
          return {
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
          };
        })
        .filter(Boolean) as any[];

      for (const row of batch) {
        const id = toDocId(row.order_number, row.product_code);
        await setDoc(doc(db, 'order_items', id), row, { merge: true });
      }
      const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')));
      setOrders(itemsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as OrderItem[]);
      alert(`Import completato (${batch.length} righe).`);
    } catch (err: any) {
      console.error(err);
      alert('Errore import: ' + err.message);
    }
  };

  /* ------------------- TIMER ------------------- */
  const onStart = async (row: any) => {
    setTimers((t) => ({
      ...t,
      [row.id!]: { running: true, startedAt: Date.now(), elapsed: Number((row as any).elapsed_sec || 0) },
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
    const t = timers[row.id!] || { running: false, startedAt: null, elapsed: Number((row as any).elapsed_sec || 0) };
    const now = Date.now();
    const extra = t.startedAt ? Math.round((now - t.startedAt) / 1000) : 0;
    const elapsed = (t.elapsed || 0) + extra;

    setTimers((tt) => ({ ...tt, [row.id!]: { running: false, startedAt: null, elapsed } }));

    await updateDoc(doc(db, 'order_items', row.id!), {
      status: 'pausato',
      elapsed_sec: elapsed,
      timer_start: null,
    } as any);

    setOrders((prev) =>
      prev.map((o: any) =>
        o.id === row.id ? { ...o, status: 'pausato', elapsed_sec: elapsed, timer_start: null } : o
      ) as any
    );
  };

  const onResume = async (row: any) => {
    const prevElapsed = Number(timers[row.id!]?.elapsed ?? (row as any).elapsed_sec ?? 0);
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
    const now = Date.now();
    const elapsedFromRun = t?.startedAt ? Math.round((now - t.startedAt) / 1000) : 0;
    const spentSec = Math.max(0, (t?.elapsed || 0) + elapsedFromRun);

    const pass = Number(stopStep || 0);

    const nextStepsTime: Record<number, number> = { ...((row as any).steps_time || {}) };
    nextStepsTime[pass] = (nextStepsTime[pass] ?? 0) + spentSec;

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

    const richiesta = Number((row as any).qty_requested || 0);
    const isCompletedTot = richiesta > 0 && qtyDone >= richiesta;

    await setDoc(
      doc(db, 'order_items', row.id!),
      {
        status: isCompletedTot ? 'eseguito' : 'da_iniziare',
        elapsed_sec: 0,
        timer_start: null,
        last_done_at: serverTimestamp(),
        steps_time: nextStepsTime,
        steps_progress: nextStepsProg,
        qty_done: qtyDone,
        last_operator: stopOperator || null,
        last_notes: stopNotes || null,
        last_step: pass,
        last_pieces: Number(stopPieces || 0),
        last_duration_sec: spentSec,
        notes_log: notesLog,
      } as any,
      { merge: true }
    );

    setTimers((tt) => ({ ...tt, [row.id!]: { running: false, startedAt: null, elapsed: 0 } }));
    setOrders((prev) =>
      prev.map((o: any) =>
        o.id === row.id
          ? {
              ...o,
              status: isCompletedTot ? 'eseguito' : 'da_iniziare',
              elapsed_sec: 0,
              timer_start: null,
              steps_time: nextStepsTime,
              steps_progress: nextStepsProg,
              qty_done: qtyDone,
              last_operator: stopOperator || null,
              last_notes: stopNotes || null,
              last_step: pass,
              last_pieces: Number(stopPieces || 0),
              last_duration_sec: spentSec,
              last_done_at: new Date() as any,
              notes_log: notesLog,
            }
          : o
      ) as any
    );

    setStopOpen(false);
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
      return {
        Ordine: (o as any).order_number,
        Cliente: (o as any).customer || '',
        Codice: (o as any).product_code,
        Descrizione: (o as any).description || '',
        ML: (o as any).ml ?? '',
        'Q.ta richiesta': richiesta,
        'Q.ta fatta': fatta,
        'Q.ta rimanente': rimanente,
        Stato: (o as any).hidden ? 'CANCELLATO' : (o as any).status,
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

    XLSX.writeFile(wb, `deco-riepilogo-${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  /* ------------------- Render ------------------- */

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
    if (s === 'in_essiccazione') return '#168a3d';
    if (s === 'in_imballaggio') return '#d87f1f';
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

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ marginTop: 0 }}>Gestione Produzione</h2>

      {/* TOP ROW: controlli + CRUSCOTTO che si espande fino al bordo destro */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'stretch',
          marginBottom: 12,
          flexWrap: 'nowrap'
        }}
      >
        {/* controlli a sinistra */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ maxWidth: 320 }}>
            <input
              type="file"
              accept=".csv,.txt"
              onChange={(e) => e.target.files && handleImportCSV(e.target.files[0])}
              style={{ width: 320 }}
            />
          </div>
          <button className="btn" onClick={() => setAdminOpen(true)}>ADMIN</button>
          <button className="btn" onClick={() => setNewOrderOpen(true)}>INSERISCI ORDINE</button>
        </div>

        {/* CRUSCOTTO allargato: prende tutto lo spazio rimanente */}
        <div
          style={{
            marginLeft: 12,
            flex: 1,
            border: '1px solid #2b2f3a',
            borderRadius: 8,
            padding: 12,
            minWidth: 300
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: 18 }}>Cruscotto</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(140px,1fr))', gap: 12 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Ordini dal…</div>
              <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
            </label>

            <div style={{ borderLeft: '1px solid #2b2f3a', paddingLeft: 12, display:'grid', gap:4, alignContent:'start' }}>
              <div>Da iniziare: <strong>{kpi.da_iniziare}</strong></div>
              <div>In esecuzione: <strong>{kpi.in_esecuzione}</strong></div>
              <div>Completati: <strong>{kpi.eseguiti}</strong></div>
            </div>

            <div style={{ borderLeft: '1px solid #2b2f3a', paddingLeft: 12, display:'grid', gap:4, alignContent:'start' }}>
              <div>Pezzi oggi: <strong>{todayAgg.pezziOggi}</strong></div>
              <div>Tempo oggi: <strong>{secToHMS(todayAgg.secOggi)}</strong></div>
              <div><button className="btn" onClick={exportExcel}>SCARICO EXCEL</button></div>
            </div>
          </div>
        </div>
      </div>

      {/* TABELLA + COMPLETATI (destra) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16 }}>
        {/* TABELLA */}
        <div className="table-wrap">
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Ordine</th>
                <th>Cliente</th>
                <th>Codice</th>
                <th>Descrizione</th>
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
                const t = timers[row.id!] || { running: false, startedAt: null, elapsed: Number((row as any).elapsed_sec || 0) };
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
                    <td>{(row as any).product_code}</td>
                    <td>
                      <div
                        title={(row as any).description || ''}
                        style={{
                          maxWidth: 220,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          opacity: (row as any).description ? 1 : 0.6
                        }}
                      >
                        {(row as any).description || '—'}
                      </div>
                    </td>
                    <td>{richiesta || ''}</td>
                    <td>{fatta}</td>
                    <td>{rimanente}</td>
                    <td>{renderPassaggiCell(row)}</td>
                    <td>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{secToHMS(elapsed)}</span>
                      {(row as any).status === 'pausato' && (
                        <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 6, background: '#666', color: 'white' }}>
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

        {/* COMPLETATI */}
        <aside style={{ border: '1px solid #2b2f3a', borderRadius: 8, padding: 12, height: 'fit-content', position: 'sticky', top: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <h3 style={{ margin: 0, fontSize: 18 }}>Completati</h3>
          </div>
          <div style={{ maxHeight: 260, overflow: 'auto', display: 'grid', gap: 6 }}>
            {completati.length === 0 && <div style={{ opacity: 0.7, fontSize: 14 }}>— nessun ordine —</div>}
            {completati.map((o: any) => (
              <button
                key={(o as any).id}
                className="btn"
                onClick={() => setAdvanceOpen(true) || setAdvanceTarget(o as any)}
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
        <div style={{ textAlign: 'right', marginTop: 12 }}>
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
                {new Date(n.ts).toLocaleString()} • {n.operator || '—'} • Pass. {n.step} • {n.pieces} pz
              </div>
              <div>{n.text}</div>
            </div>
          ))}
        </div>
      </Modal>

      {/* AVANZA FASE */}
      <Modal open={advanceOpen} onClose={() => setAdvanceOpen(false)} title="Avanza fase ordine completato">
        <div style={{ display: 'grid', gap: 8 }}>
          <div><strong>{(advanceTarget as any)?.order_number}</strong> · {(advanceTarget as any)?.product_code}</div>
          <label>
            <div>Quale passaggio vuoi eseguire ora?</div>
            <select value={advancePhase} onChange={(e) => setAdvancePhase(e.target.value as any)}>
              <option value="in_essiccazione">IN ESSICCAZIONE</option>
              <option value="in_imballaggio">IN IMBALLAGGIO</option>
              <option value="pronti_consegna">PRONTI PER LA CONSEGNA</option>
            </select>
          </label>

          {advancePhase === 'pronti_consegna' && (
            <label>
              <div>Quanti pezzi imballati?</div>
              <input
                type="number"
                min={0}
                step={1}
                value={advancePacked}
                onChange={(e) => setAdvancePacked(Number(e.target.value || 0))}
              />
            </label>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
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
            }
            await updateDoc(doc(db, 'order_items', id), patch);
            setOrders((prev) =>
              prev.map((o: any) => (o.id === id ? { ...o, ...patch, status_changed_at: new Date() as any } : o))
            );
            setAdvanceOpen(false);
          }}>Salva</button>
        </div>
      </Modal>

      {/* ADMIN MODAL */}
      <Modal open={adminOpen} onClose={() => setAdminOpen(false)} title="Gestione Operatori & Ordini">
        <div style={{ display: 'grid', gap: 16 }}>
          <div>
            <h4 style={{ margin: '0 0 8px' }}>Operatori</h4>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                placeholder="Nuovo operatore"
                value={newOperatorName}
                onChange={(e) => setNewOperatorName(e.target.value)}
              />
              <button className="btn btn-primary" onClick={addOperator}>Aggiungi</button>
            </div>
            <div style={{ maxHeight: 200, overflow: 'auto', borderTop: '1px solid #eee', marginTop: 8, paddingTop: 8 }}>
              {operators.map((op: any) => (
                <div key={op.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                  <div style={{ flex: 1 }}>{op.name} {op.active ? '' : <span style={{ color: '#a00' }}>(disattivo)</span>}</div>
                  <button className="btn" onClick={() => toggleOperator(op)}>{op.active ? 'Disattiva' : 'Attiva'}</button>
                  <button className="btn btn-danger" onClick={() => removeOperator(op)}>Elimina</button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 style={{ margin: '0 0 8px' }}>Ordini (nascondi / ripristina)</h4>
            <div style={{ maxHeight: 300, overflow: 'auto', borderTop: '1px solid #eee', paddingTop: 8 }}>
              {baseFiltered.map((o: any) => (
                <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                  <div style={{ flex: 1, opacity: (o as any).hidden ? 0.6 : 1 }}>
                    {(o as any).order_number} · {(o as any).product_code} — <em>{(o as any).hidden ? 'CANCELLATO' : (o as any).status}</em>
                  </div>
                  {!(o as any).hidden ? (
                    <button className="btn btn-danger" onClick={() => hideOrder(o)}>Nascondi</button>
                  ) : (
                    <button className="btn" onClick={() => restoreOrder(o)}>Ripristina</button>
                  )}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
              Gli ordini nascosti non compaiono in schermata, ma saranno comunque presenti nello SCARICO EXCEL (Stato: CANCELLATO).
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
