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

function getDayBounds(date: Date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

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

  // MODALS
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
    ml: '' as any,
    qty_requested: '' as any,
    steps_count: 0,
  });

  // CRUSCOTTO: filtro "Ordini dal ..."
  const [filterFrom, setFilterFrom] = useState<string>(''); // yyyy-mm-dd

  // Load data
  useEffect(() => {
    (async () => {
      await ensureAnonAuth();
      const opsSnap = await getDocs(query(collection(db, 'operators'), orderBy('name')));
      setOperators(opsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Operator[]);
      const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')));
      setOrders(itemsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as OrderItem[]);
    })();
  }, []);

  // Ordini filtrati dal "from"
  const filteredOrders = useMemo(() => {
    if (!filterFrom) return orders;
    const from = new Date(filterFrom + 'T00:00:00');
    return orders.filter((o) => {
      const ca: any = o.created_at;
      const ts = ca?.toMillis ? ca.toMillis() : (typeof ca === 'number' ? ca : null);
      if (!ts) return false;
      return ts >= from.getTime();
    });
  }, [orders, filterFrom]);

  const kpi = useMemo(() => {
    const byStatus = (st: OrderItem['status']) => filteredOrders.filter((o) => o.status === st).length;
    return {
      da_iniziare: byStatus('da_iniziare'),
      in_esecuzione: byStatus('in_esecuzione'),
      eseguiti: byStatus('eseguito'),
    };
  }, [filteredOrders]);

  // Oggi (pezzi e tempo)
  const todayAgg = useMemo(() => {
    const { start, end } = getDayBounds(new Date());
    let pezzi = 0;
    let sec = 0;
    orders.forEach((o: any) => {
      const ldt: any = o.last_done_at;
      const ms = ldt?.toMillis ? ldt.toMillis() : (typeof ldt === 'number' ? ldt : null);
      if (ms && ms >= start.getTime() && ms <= end.getTime()) {
        pezzi += Number(o.last_pieces || 0);
        sec += Number((o as any).last_duration_sec || 0);
      }
    });
    return { pezziOggi: pezzi, secOggi: sec };
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
    setTimers((t) => ({
      ...t,
      [row.id!]: { running: true, startedAt: Date.now(), elapsed: Number(row.elapsed_sec || 0) },
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

  // PAUSA: salva il tempo e imposta stato "pausato"
  const onPause = async (row: any) => {
    const t = timers[row.id!] || { running: false, startedAt: null, elapsed: Number(row.elapsed_sec || 0) };
    const now = Date.now();
    const extra = t.startedAt ? Math.round((now - t.startedAt) / 1000) : 0;
    const elapsed = (t.elapsed || 0) + extra;

    setTimers((tt) => ({
      ...tt,
      [row.id!]: { running: false, startedAt: null, elapsed },
    }));

    await updateDoc(doc(db, 'order_items', row.id!), {
      status: 'pausato',
      elapsed_sec: elapsed,
      timer_start: null,
    } as any);

    setOrders((prev) =>
      prev.map((o: any) =>
        o.id === row.id
          ? { ...o, status: 'pausato', elapsed_sec: elapsed, timer_start: null }
          : o
      ) as any
    );
  };

  // RIPRENDI: riparte e torna "in_esecuzione"
  const onResume = async (row: any) => {
    const prevElapsed = Number(timers[row.id!]?.elapsed ?? row.elapsed_sec ?? 0);
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
    const t = timers[row.id!];
    const now = Date.now();
    const elapsedFromRun = t?.startedAt ? Math.round((now - t.startedAt) / 1000) : 0;
    const spentSec = Math.max(0, (t?.elapsed || 0) + elapsedFromRun);

    const pass = Number(stopStep || 0);
    if (!pass || pass < 1) { alert('Seleziona un passaggio valido'); return; }

    // accumula tempo e pezzi sul passaggio scelto
    const nextStepsTime: Record<number, number> = { ...(row.steps_time || {}) };
    nextStepsTime[pass] = (nextStepsTime[pass] ?? 0) + spentSec;

    const nextStepsProg: Record<number, number> = { ...(row.steps_progress || {}) };
    nextStepsProg[pass] = (nextStepsProg[pass] ?? 0) + (Number(stopPieces || 0));

    // ricalcola qty_done (pezzi finiti su tutti i passaggi)
    const qtyDone = computeFullyDone(Number(row.steps_count || 0), nextStepsProg, 0);

    await setDoc(
      doc(db, 'order_items', row.id!),
      {
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
        // per cruscotto "tempo eseguito oggi"
        last_duration_sec: spentSec,
      } as any,
      { merge: true }
    );

    // aggiorna UI locale
    setTimers((tt) => ({ ...tt, [row.id!]: { running: false, startedAt: null, elapsed: 0 } }));
    setOrders((prev) =>
      prev.map((o: any) =>
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
              last_duration_sec: spentSec,
              last_done_at: new Date() as any,
            }
          : o
      ) as any
    );

    setStopOpen(false);
  };

  /* ------------------- ADMIN operators ------------------- */
  const addOperator = async () => {
    const name = newOperatorName.trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/\s+/g, '_');
    await setDoc(doc(db, 'operators', id), { name, active: true });
    setOperators((prev) => [...prev, { id, name, active: true }]);
    setNewOperatorName('');
  };

  const toggleOperator = async (op: Operator) => {
    await updateDoc(doc(db, 'operators', op.id!), { active: !op.active } as any);
    setOperators((prev) => prev.map((o) => (o.id === op.id ? { ...o, active: !o.active } : o)));
  };

  const removeOperator = async (op: Operator) => {
    if (!op.id) return;
    await deleteDoc(doc(db, 'operators', op.id));
    setOperators((prev) => prev.filter((o) => o.id !== op.id));
  };

  /* ------------------- Inserisci Ordine ------------------- */
  const createOrder = async () => {
    const order_number = newOrder.order_number.trim();
    const product_code = newOrder.product_code.trim();
    if (!order_number || !product_code) { alert('Ordine e Codice sono obbligatori'); return; }

    const row = {
      order_number,
      customer: newOrder.customer.trim(),
      product_code,
      ml: asNumber(newOrder.ml),
      qty_requested: asNumber(newOrder.qty_requested) ?? 0,
      qty_in_oven: 0,
      qty_done: 0,
      steps_count: Number(newOrder.steps_count || 0),
      steps_progress: {},
      steps_time: {},
      packed_qty: 0,
      status: 'da_iniziare' as const,
      created_at: serverTimestamp(),
    };

    const id = toDocId(row.order_number, row.product_code);
    await setDoc(doc(db, 'order_items', id), row, { merge: true });

    setOrders((prev) => [{ id, ...(row as any) }, ...prev]);
    setNewOrderOpen(false);
    setNewOrder({ order_number: '', customer: '', product_code: '', ml: '' as any, qty_requested: '' as any, steps_count: 0 });
  };

  /* ------------------- EXPORT ------------------- */
  const exportExcel = () => {
    // RIEPILOGO: usa gli ordini filtrati dal cruscotto
    const rows = filteredOrders.map((o: any) => {
      const richiesta = Number(o.qty_requested ?? 0);
      const fatta = Number(o.qty_done ?? 0);
      const rimanente = Math.max(0, richiesta - fatta);
      return {
        Ordine: o.order_number,
        Cliente: o.customer || '',
        Codice: o.product_code,
        ML: o.ml ?? '',
        'Q.ta richiesta': richiesta,
        'Q.ta fatta': fatta,
        'Q.ta rimanente': rimanente,
        Stato: o.status,
      };
    });

    // Foglio 2: Aggregato tempi per passaggio (su filtrati)
    const aggRows: Array<{ Ordine: any; Riga: string; Passaggio: number; Pezzi: number; Tempo: string }> = [];
    filteredOrders.forEach((o: any, idx: number) => {
      const stats = aggregateStepStats(o);
      stats.forEach((s) => {
        aggRows.push({
          Ordine: o.order_number,
          Riga: String(o.product_code || idx + 1),
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
    return (
      <div style={{ display: 'grid', gap: 2 }}>
        {stats.map((s) => (
          <div key={s.step} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            <strong style={{ display: 'inline-block', minWidth: 24 }}>P{s.step}</strong>{': '}
            <span>{s.pieces} pz</span>{' · '}
            <span>{secToHMS(s.timeSec)}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ marginTop: 0 }}>Gestione Produzione</h2>

      {/* Top bar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input type="file" accept=".csv,.txt" onChange={(e) => e.target.files && handleImportCSV(e.target.files[0])} />
        <button className="btn" onClick={exportExcel}>Scarico Excel</button>
        <button className="btn" onClick={() => setAdminOpen(true)}>ADMIN</button>
        <button className="btn" onClick={() => setNewOrderOpen(true)}>INSERISCI ORDINE</button>
        <div style={{ marginLeft: 'auto' }}>
          {/* spazio vuoto, KPI nel cruscotto a destra */}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        {/* TABELLA ORDINI */}
        <div className="table-wrap">
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Ordine</th>
                <th>Cliente</th>
                <th>Codice</th>
                <th>Q.ta rich.</th>
                <th>Q.ta fatta</th>
                <th>Rimanenti</th>
                <th>Passaggi</th>
                <th>Timer</th>
                <th>Azioni</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((row: any) => {
                const t = timers[row.id!] || { running: false, startedAt: null, elapsed: Number(row.elapsed_sec || 0) };
                const now = Date.now();
                const elapsed = t.running && t.startedAt ? t.elapsed + Math.round((now - t.startedAt) / 1000) : t.elapsed;

                const richiesta = Number(row.qty_requested ?? 0);
                const fatta = Number(row.qty_done ?? 0);
                const rimanente = Math.max(0, richiesta - fatta);

                return (
                  <tr key={row.id}>
                    <td><strong>{row.order_number}</strong></td>
                    <td>{row.customer || ''}</td>
                    <td>{row.product_code}</td>
                    <td>{richiesta || ''}</td>
                    <td>{fatta}</td>
                    <td>{rimanente}</td>
                    <td>{renderPassaggiCell(row)}</td>
                    <td>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{secToHMS(elapsed)}</span>
                      {row.status === 'pausato' && (
                        <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 6, background: '#666', color: 'white' }}>
                          Pausa
                        </span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-primary"
                          disabled={row.status !== 'da_iniziare'}
                          onClick={() => onStart(row)}
                        >
                          Start
                        </button>

                        <button
                          className="btn btn-warning"
                          disabled={row.status !== 'in_esecuzione'}
                          onClick={() => onPause(row)}
                        >
                          Pausa
                        </button>

                        <button
                          className="btn btn-success"
                          disabled={row.status !== 'pausato'}
                          onClick={() => onResume(row)}
                        >
                          Riprendi
                        </button>

                        <button className="btn btn-danger" onClick={() => openStop(row)}>Stop</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* CRUSCOTTO OPERATIVO */}
        <aside style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>CRUSCOTTO OPERATIVO</h3>
          <div style={{ display: 'grid', gap: 8 }}>
            <label>
              <div>Ordini dal…</div>
              <input
                type="date"
                value={filterFrom}
                onChange={(e) => setFilterFrom(e.target.value)}
              />
            </label>

            <div style={{ borderTop: '1px solid #eee', paddingTop: 8 }}>
              <div>Ordini: <strong>da iniziare</strong> n° {kpi.da_iniziare}</div>
              <div>Ordini: <strong>in esecuzione</strong> n° {kpi.in_esecuzione}</div>
              <div>Ordini: <strong>eseguiti</strong> n° {kpi.eseguiti}</div>
            </div>

            <div style={{ borderTop: '1px solid #eee', paddingTop: 8 }}>
              <div>Oggi sono stati prodotti n° <strong>{todayAgg.pezziOggi}</strong> pezzi</div>
              <div>Tempo eseguito oggi: <strong>{secToHMS(todayAgg.secOggi)}</strong></div>
            </div>

            <div style={{ borderTop: '1px solid #eee', paddingTop: 8 }}>
              <button className="btn" onClick={exportExcel}>SCARICO EXCEL</button>
            </div>
          </div>
        </aside>
      </div>

      {/* STOP MODAL */}
      <Modal open={stopOpen} onClose={() => setStopOpen(false)} title="Concludi lavorazione">
        <div className="grid" style={{ display: 'grid', gap: 8 }}>
          <label>
            <div>Passaggio eseguito (1–9)</div>
            <input type="number" min={1} max={9} value={stopStep} onChange={(e) => setStopStep(Number(e.target.value || 1))} />
          </label>
          <label>
            <div>Pezzi (quantità fatta)</div>
            <input type="number" min={0} step={1} value={stopPieces} onChange={(e) => setStopPieces(Number(e.target.value || 0))} />
          </label>
          <label>
            <div>Operatore</div>
            <select value={stopOperator} onChange={(e) => setStopOperator(e.target.value)}>
              <option value="">— seleziona —</option>
              {operators.map((op) => (<option key={op.id} value={(op as any).name}>{(op as any).name}</option>))}
            </select>
          </label>
          <label>
            <div>Note</div>
            <input value={stopNotes} onChange={(e) => setStopNotes(e.target.value)} placeholder="Es. RAL 9010" />
          </label>
        </div>
        <div style={{ textAlign: 'right', marginTop: 12 }}>
          <button className="btn btn-danger" onClick={confirmStop}>Registra</button>
        </div>
      </Modal>

      {/* ADMIN MODAL */}
      <Modal open={adminOpen} onClose={() => setAdminOpen(false)} title="Gestione Operatori">
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              placeholder="Nuovo operatore"
              value={newOperatorName}
              onChange={(e) => setNewOperatorName(e.target.value)}
            />
            <button className="btn btn-primary" onClick={addOperator}>Aggiungi</button>
          </div>
          <div style={{ maxHeight: 240, overflow: 'auto', borderTop: '1px solid #eee', paddingTop: 8 }}>
            {operators.map((op) => (
              <div key={op.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <div style={{ flex: 1 }}>{op.name} {op.active ? '' : <span style={{ color: '#a00' }}>(disattivo)</span>}</div>
                <button className="btn" onClick={() => toggleOperator(op)}>{op.active ? 'Disattiva' : 'Attiva'}</button>
                <button className="btn btn-danger" onClick={() => removeOperator(op)}>Elimina</button>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      {/* INSERISCI ORDINE MODAL */}
      <Modal open={newOrderOpen} onClose={() => setNewOrderOpen(false)} title="Inserisci Ordine">
        <div style={{ display: 'grid', gap: 8 }}>
          <label>
            <div>Numero Ordine *</div>
            <input value={newOrder.order_number} onChange={(e) => setNewOrder({ ...newOrder, order_number: e.target.value })} />
          </label>
          <label>
            <div>Cliente</div>
            <input value={newOrder.customer} onChange={(e) => setNewOrder({ ...newOrder, customer: e.target.value })} />
          </label>
          <label>
            <div>Codice Prodotto *</div>
            <input value={newOrder.product_code} onChange={(e) => setNewOrder({ ...newOrder, product_code: e.target.value })} />
          </label>
          <label>
            <div>ML</div>
            <input value={newOrder.ml as any} onChange={(e) => setNewOrder({ ...newOrder, ml: e.target.value })} />
          </label>
          <label>
            <div>Q.ta richiesta</div>
            <input type="number" value={newOrder.qty_requested as any} onChange={(e) => setNewOrder({ ...newOrder, qty_requested: e.target.value })} />
          </label>
          <label>
            <div>N. passaggi</div>
            <input type="number" min={0} value={newOrder.steps_count} onChange={(e) => setNewOrder({ ...newOrder, steps_count: Number(e.target.value || 0) })} />
          </label>
        </div>
        <div style={{ textAlign: 'right', marginTop: 12 }}>
          <button className="btn btn-primary" onClick={createOrder}>Crea</button>
        </div>
      </Modal>
    </div>
  );
}
