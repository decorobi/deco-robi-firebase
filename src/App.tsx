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

function secToHMS(total: number = 0) {
  const sec = Math.max(0, Math.floor(total || 0));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// Aggrega tempo e pezzi per passaggio per una riga
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

/** Calcola qty_done come "pezzi realmente finiti", min tra i passaggi */
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
  const [timers, setTimers] = useState<Record<string, TimerState>>({});

  // STOP modal
  const [stopOpen, setStopOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<OrderItem | null>(null);
  const [stopOperator, setStopOperator] = useState<string>('');
  const [stopPieces, setStopPieces] = useState<number>(0);
  const [stopStep, setStopStep] = useState<number>(1);
  const [stopNotes, setStopNotes] = useState<string>('');

  // Load data
  useEffect(() => {
    (async () => {
      await ensureAnonAuth();
      const opsSnap = await getDocs(query(collection(db, 'operators'), orderBy('name')));
      setOperators(opsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Operator[]);

      const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')));
      const fetched = itemsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as OrderItem[];
      setOrders(fetched);
    })();
  }, []);

  // Sincronizza timer locali con lo stato Firestore quando arrivano/variano gli ordini
  useEffect(() => {
    setTimers((prev) => {
      const next: Record<string, TimerState> = { ...prev };
      for (const o of orders) {
        if (next[o.id!]) continue;
        if (o.status === 'in_esecuzione' && o.timer_start) {
          next[o.id!] = { running: true, startedAt: Number(o.timer_start), elapsed: Number(o.elapsed_sec || 0) };
        } else {
          next[o.id!] = { running: false, startedAt: null, elapsed: Number(o.elapsed_sec || 0) };
        }
      }
      return next;
    });
  }, [orders]);

  const kpi = useMemo(() => {
    const byStatus = (st: OrderItem['status']) => orders.filter((o) => o.status === st).length;
    const piecesToday = orders.reduce((sum, o: any) => sum + (o.qty_done || 0), 0);
    return {
      da_iniziare: byStatus('da_iniziare'),
      in_esecuzione: byStatus('in_esecuzione'),
      eseguiti: byStatus('eseguito'),
      pezziOggi: piecesToday,
    };
  }, [orders]);

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
            steps_progress: {},        // { [passaggio]: pezzi }
            steps_time: {},            // { [passaggio]: secondi }
            packed_qty: 0,
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
      alert(`Import completato (${batch.length} righe).`);
    } catch (err: any) {
      console.error(err);
      alert('Errore import: ' + err.message);
    }
  };

  /* ------------------- Timer actions ------------------- */
  const onStart = async (row: any) => {
    // avvia timer locale
    setTimers((t) => ({
      ...t,
      [row.id!]: { running: true, startedAt: Date.now(), elapsed: Number(row.elapsed_sec || 0) },
    }));
    // persisti su Firestore
    await updateDoc(doc(db, 'order_items', row.id!), {
      status: 'in_esecuzione',
      timer_start: Date.now(),
    } as any);
    // aggiorna UI
    setOrders((prev) => prev.map((o: any) => (o.id === row.id ? { ...o, status: 'in_esecuzione', timer_start: Date.now() } : o)) as any);
  };

  // >>> PAUSA: salva tempo cumulato, mette stato "pausato" e azzera timer_start
  const onPause = async (row: any) => {
    const t = timers[row.id!];
    const now = Date.now();
    const elapsed = (t?.elapsed || 0) + (t?.startedAt ? Math.round((now - t.startedAt) / 1000) : 0);

    // ferma timer locale
    setTimers((tt) => ({ ...tt, [row.id!]: { running: false, startedAt: null, elapsed, paused: true } }));

    // persisti su Firestore
    await updateDoc(doc(db, 'order_items', row.id!), {
      status: 'pausato',
      elapsed_sec: elapsed,
      timer_start: null,
    } as any);

    // aggiorna lista in memoria
    setOrders((prev) => prev.map((o: any) =>
      o.id === row.id ? { ...o, status: 'pausato', elapsed_sec: elapsed, timer_start: null } : o
    ) as any);
  };

  // >>> RIPRENDI: riparte timer e torna "in_esecuzione"
  const onResume = async (row: any) => {
    // riavvia timer locale
    setTimers((t) => ({
      ...t,
      [row.id!]: { running: true, startedAt: Date.now(), elapsed: Number(t[row.id!]?.elapsed ?? row.elapsed_sec ?? 0) },
    }));

    // persisti su Firestore
    await updateDoc(doc(db, 'order_items', row.id!), {
      status: 'in_esecuzione',
      timer_start: Date.now(),
    } as any);

    // aggiorna UI
    setOrders((prev) => prev.map((o: any) =>
      o.id === row.id ? { ...o, status: 'in_esecuzione', timer_start: Date.now() } : o
    ) as any);
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
    const t = timers[row.id!];
    const now = Date.now();
    const elapsedFromRun = t?.startedAt ? Math.round((now - t.startedAt) / 1000) : 0;
    const spentSec = Math.max(0, (t?.elapsed || 0) + elapsedFromRun);

    // accumula tempo e pezzi sul passaggio scelto
    const pass = Number(stopStep || 0);
    if (!pass || pass < 1) { alert('Seleziona un passaggio valido'); return; }

    const nextStepsTime: Record<number, number> = { ...(row.steps_time || {}) };
    nextStepsTime[pass] = (nextStepsTime[pass] ?? 0) + spentSec;

    const nextStepsProg: Record<number, number> = { ...(row.steps_progress || {}) };
    nextStepsProg[pass] = (nextStepsProg[pass] ?? 0) + (Number(stopPieces || 0));

    // ricalcola qty_done (pezzi finiti su tutti i passaggi)
    const qtyDone = computeFullyDone(Number(row.steps_count || 0), nextStepsProg, 0);

    await setDoc(doc(db, 'order_items', row.id!), {
      status: 'da_iniziare',
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
    } as any, { merge: true });

    // aggiorna UI locale
    setTimers((tt) => ({ ...tt, [row.id!]: { running: false, startedAt: null, elapsed: 0 } }));
    setOrders((prev) => prev.map((o: any) =>
      o.id === row.id
        ? {
            ...o,
            status: 'da_iniziare',
            elapsed_sec: 0,
            timer_start: null,
            steps_time: nextStepsTime,
            steps_progress: nextStepsProg,
            qty_done: qtyDone,
            last_operator: stopOperator || null,
            last_notes: stopNotes || null,
            last_step: pass,
            last_pieces: Number(stopPieces || 0),
          }
        : o
    ) as any);

    setStopOpen(false);
  };

  /* ------------------- EXPORT ------------------- */
  const exportExcel = () => {
    // Foglio 1: Righe (stato corrente)
    const rows = orders.map((o: any) => ({
      Ordine: o.order_number,
      Cliente: o.customer || '',
      Codice: o.product_code,
      ML: o.ml ?? '',
      'Q.ta richiesta': o.qty_requested ?? '',
      'Q.ta in forno': o.qty_in_oven ?? '',
      'Q.ta finita': o.qty_done ?? 0,
      'N. passaggi': o.steps_count ?? 0,
      Stato: o.status,
    }));

    // Foglio 2: Aggregato tempi per passaggio
    const aggRows: Array<{ Ordine: any; Riga: string; Passaggio: number; Pezzi: number; Tempo: string }> = [];
    orders.forEach((o: any, idx: number) => {
      const stats
