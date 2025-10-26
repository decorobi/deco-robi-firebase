import React, { useEffect, useMemo, useState } from 'react'
import Papa, { ParseResult } from 'papaparse'
import * as XLSX from 'xlsx'
import { Operator, OrderItem, OrderLog } from './types'
import { db, ensureAnonAuth } from './lib/firebaseClient'
import {
  collection, addDoc, getDocs, doc, setDoc, updateDoc, serverTimestamp, query, orderBy
} from 'firebase/firestore'

type RowIn = {
  "numero ordine": string | number
  "descrizione"?: string
  "codice prodotto": string
  "ml"?: string | number
  "Quantità inserita"?: string | number
  "inforno"?: string | number
  "Cliente": string
  "Passaggi": string | number
}

const asNumber = (v: any) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const formatTime = (sec: number) => {
  const h = Math.floor(sec / 3600).toString().padStart(2, '0')
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0')
  const s = Math.floor(sec % 60).toString().padStart(2, '0')
  return `${h}:${m}:${s}`
}

export default function App() {
  const [operators, setOperators] = useState<Operator[]>([])
  const [orders, setOrders] = useState<OrderItem[]>([])
  const [dateFilter, setDateFilter] = useState<string>('')
  const [showAdmin, setShowAdmin] = useState(false)
  const [timers, setTimers] = useState<Record<string, { running: boolean; startedAt: number | null; elapsed: number }>>({})

  // load data
  useEffect(() => {
    (async () => {
      await ensureAnonAuth()
      const opsSnap = await getDocs(query(collection(db, 'operators'), orderBy('name')))
      setOperators(opsSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as Operator[])
      const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')))
      setOrders(itemsSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as OrderItem[])
    })()
  }, [])

  const kpi = useMemo(() => {
    const byStatus = (st: OrderItem['status']) => orders.filter(o => o.status === st).length
    const piecesToday = orders.reduce((sum, o) => sum + (o.qty_done || 0), 0)
    return { da_iniziare: byStatus('da_iniziare'), in_esecuzione: byStatus('in_esecuzione'), eseguiti: byStatus('eseguito'), pezziOggi: piecesToday, tempoOggi: 0 }
  }, [orders])

  // IMPORT CSV
  const handleImportCSV = async (file: File) => {
    const parsed = await new Promise<RowIn[]>((resolve, reject) => {
      Papa.parse<RowIn>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res: ParseResult<RowIn>) => resolve(res.data as RowIn[]),
        error: reject,
      })
    });

    const batch = parsed
      .filter(r => r['numero ordine'])
      .map(r => ({
        order_number: String(r['numero ordine']),
        customer: r['Cliente'] || '',
        product_code: r['codice prodotto'] || '',
        ml: asNumber(r['ml'] ?? null),
        qty_requested: asNumber(r['Quantità inserita'] ?? null),
        qty_in_oven: asNumber(r['inforno'] ?? null),
        qty_done: 0,
        steps_count: Number(asNumber(r['Passaggi'] ?? 0)) || 0,
        status: 'da_iniziare',
        created_at: serverTimestamp(),
      }))

    for (const row of batch) {
      const id = `${row.order_number}__${row.product_code}`
      await setDoc(doc(db, 'order_items', id), row, { merge: true })
    }

    const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')))
    setOrders(itemsSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as OrderItem[])
    alert('Import completato: ' + batch.length + ' righe')
  }

  // IMPORT da Google Sheet
  const importFromSheet = async () => {
    const url = prompt('Link Google Sheet (condiviso “chiunque col link”):')
    if (!url) return
    try {
      const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
      if (!m) throw new Error('Link non valido')
      const gid = (url.match(/[?&]gid=(\d+)/)?.[1]) || '0'
      const csvUrl = `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv&gid=${gid}`
      const res = await fetch(csvUrl)
      const blob = await res.blob()
      const file = new File([blob], 'sheet.csv', { type: 'text/csv' })
      await handleImportCSV(file)
    } catch (e: any) { alert('Errore import: ' + e.message) }
  }

  // ADMIN → aggiungi operatore
  const addOperator = async () => {
    const name = prompt('Nome operatore:'); if (!name) return
    const ref = await addDoc(collection(db, 'operators'), { name, active: true, created_at: serverTimestamp() })
    setOperators([...(operators), { id: ref.id, name, active: true }])
  }

  // Inserimento manuale ordine
  const manualInsert = async () => {
    const order_number = prompt('Numero ordine:') || ''
    const customer = prompt('Cliente:') || ''
    const product_code = prompt('Codice prodotto:') || ''
    const steps_count = Number(prompt('Numero passaggi (es. 3):') || '0') || 0
    const id = `${order_number}__${product_code}`
    const row: OrderItem = { order_number, customer, product_code, steps_count, status: 'da_iniziare' }
    await setDoc(doc(db, 'order_items', id), { ...row, created_at: serverTimestamp() }, { merge: true })
    setOrders([{ id, ...row }, ...orders])
  }

  // Timer
  useEffect(() => {
    const id = setInterval(() =>
      setTimers(t => {
        const n = { ...t }, now = Date.now()
        for (const k of Object.keys(n)) {
          const tm = n[k]
          if (tm.running && tm.startedAt) n[k] = { ...tm, elapsed: Math.floor((now - tm.startedAt) / 1000) }
        }
        return n
      }), 250)
    return () => clearInterval(id)
  }, [])
  const startTimer = (id: string) => setTimers(t => ({ ...t, [id]: { running: true, startedAt: Date.now(), elapsed: t[id]?.elapsed || 0 } }))
  const pauseTimer = (id: string) => setTimers(t => ({ ...t, [id]: { ...(t[id] || { running: false, startedAt: null, elapsed: 0 }), running: false } }))

  const stopTimer = async (o: OrderItem) => {
    const tm = timers[o.id!] || { elapsed: 0 }
    const operator_name = prompt('Operatore (benny, fusia, andrea, ...):') || ''
    const pieces = Number(prompt('Numero pezzi eseguiti ora:') || '0') || 0
    const step = Number(prompt(`Quale passaggio hai eseguito? (1..${o.steps_count})`) || '1') || 1
    const notes = prompt('Note opzionali:') || ''
    const log: Partial<OrderLog> = {
      order_item_id: o.id!, operator_name, step_number: step, pieces_done: pieces, notes, duration_seconds: tm.elapsed, created_at: new Date().toISOString()
    }
    await addDoc(collection(db, 'order_logs'), log as any)
    const newDone = (o.qty_done || 0) + pieces
    const status: OrderItem['status'] = newDone >= (o.qty_requested || 0 || newDone) ? 'eseguito' : 'in_esecuzione'
    await updateDoc(doc(db, 'order_items', o.id!), { qty_done: newDone, status })
    setOrders(orders.map(x => x.id === o.id ? { ...x, qty_done: newDone, status } : x))
    setTimers(t => ({ ...t, [o.id!]: { running: false, startedAt: null, elapsed: 0 } }))
    if (pieces > 0) {
      const next = prompt('Quale stato vuoi eseguire? (essiccazione / imballaggio / consegna)')
      if (next) {
        const st = next.toLowerCase().includes('imball') ? 'in_imballaggio' : next.toLowerCase().includes('conse') ? 'pronti_consegna' : 'in_essiccazione'
        await updateDoc(doc(db, 'order_items', o.id!), { status: st })
        if (st === 'in_imballaggio') {
          const n = Number(prompt('Quanti pezzi hai imballato ora?') || '0') || 0
          const by = prompt('Tuo nome per attestazione:') || ''
          await fetch('/.netlify/functions/send-email', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ order: o, pieces: n, operator: by })
          }).catch(() => { })
          alert('Email richiesta per imballo inviata (se configurata)')
        }
      }
    }
  }

  // Export Excel
  const exportExcel = () => {
    const rows = orders.map(o => ({
      'Cliente': o.customer, 'Numero Ordine': o.order_number, 'Codice Prodotto': o.product_code,
      'Q.ta Richiesta': o.qty_requested || '', 'Q.ta In Forno': o.qty_in_oven || '',
      'Q.ta Eseguita': o.qty_done || '', 'Passaggi': o.steps_count, 'Stato': o.status
    }))
    const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Riepilogo'); XLSX.writeFile(wb, 'riepilogo_ordini.xlsx')
  }

  const filtered = orders // (filtro per data potrà essere aggiunto)

  return (
    <div className="container">
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <label>Ordini dal... <input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)} /></label>
        <input type="file" accept=".csv" onChange={e => e.target.files && handleImportCSV(e.target.files[0])} />
        <button className="btn btn-secondary" onClick={importFromSheet}>IMPORT DOC (Google Sheet)</button>
        <button className="btn btn-secondary" onClick={() => setShowAdmin(true)}>ADMIN (Operatori)</button>
        <button className="btn btn-primary" onClick={manualInsert}>INSERISCI ORDINE</button>
      </div>

      <div className="row">
        {/* Sinistra - Cruscotto */}
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

        {/* Destra - Ordini */}
        <div className="card">
          <h2>Ordini</h2>
          <div className="orders">
            {filtered.map(o => {
              const tm = timers[o.id!] || { running: false, elapsed: 0 }
              return (
                <div key={o.id || o.order_number + o.product_code} className="card order-card">
                  <h3>{o.customer}</h3>
                  <div className="muted">Ordine {o.order_number}</div>
                  <div className="fieldrow">
                    <div><label>Codice prodotto</label><div>{o.product_code}</div></div>
                    <div><label>Q.ta richiesta</label><div>{o.qty_requested ?? '-'}</div></div>
                    <div><label>Q.ta in forno</label><div>{o.qty_in_oven ?? '-'}</div></div>
                  </div>
                  <div className="fieldrow">
                    <div><label>Q.ta eseguita</label><div className="pill">{o.qty_done ?? 0}</div></div>
                    <div><label>Passaggi</label><div>{o.steps_count}</div></div>
                    <div><label>Stato</label><div className="pill">{o.status}</div></div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                    <div className="timer">{formatTime(tm.elapsed)}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {!tm.running && <button className="btn btn-primary" onClick={() => startTimer(o.id! || o.order_number)}>Start</button>}
                      {tm.running && <button className="btn btn-secondary" onClick={() => pauseTimer(o.id! || o.order_number)}>Pausa</button>}
                      <button className="btn btn-danger" onClick={() => stopTimer(o)}>Stop</button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Admin Operatori */}
      <dialog open={showAdmin} onClose={() => setShowAdmin(false)}>
        <h3>Operatori</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
          {operators.map(op => (<span key={op.id} className={"pill " + (op.active ? 'done' : '')}>{op.name}</span>))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={addOperator}>Aggiungi operatore</button>
          <button className="btn btn-secondary" onClick={() => setShowAdmin(false)}>Chiudi</button>
        </div>
      </dialog>
    </div>
  )
}
