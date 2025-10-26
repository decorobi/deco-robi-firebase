import React, { useEffect, useMemo, useState } from 'react'
import Papa, { ParseResult } from 'papaparse'
import * as XLSX from 'xlsx'
import type { Operator, OrderItem, OrderLog } from './types'
import { db, ensureAnonAuth } from './lib/firebaseClient'
import {
  collection, addDoc, getDocs, doc, setDoc, updateDoc, serverTimestamp, query, orderBy
} from 'firebase/firestore'

type RowIn = Record<string, any>

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

// crea un ID documento sicuro per Firestore (evita "/" e "\")
const toDocId = (order: string | number, code: string) =>
  `${String(order)}__${String(code)}`
    .trim()
    .replace(/[\/\\]/g, '_')
    .replace(/\s+/g, ' ')

// normalizza stringa intestazione (per confronti robusti)
const normalize = (s: string) =>
  String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

// ritorna il valore di una colonna cercando tra alias (case/accents insensitive)
const pick = (row: Record<string, any>, aliases: string[]) => {
  const nk = Object.keys(row).map(k => [k, normalize(k)] as const)
  const want = aliases.map(normalize)
  const hit = nk.find(([_, n]) => want.includes(n))
  return hit ? row[hit[0]] : undefined
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

  // IMPORT CSV (robusto + diagnostica)
  const handleImportCSV = async (file: File) => {
    try {
      // assicurati di essere autenticato prima di scrivere su Firestore
      await ensureAnonAuth();

      const parsed = await new Promise<RowIn[]>((resolve, reject) => {
        Papa.parse<RowIn>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (res: ParseResult<RowIn>) => resolve(res.data as RowIn[]),
          error: reject,
        })
      })

      if (!parsed || parsed.length === 0) {
        throw new Error('Il file CSV sembra vuoto o senza intestazioni.')
      }

      // diagnostica: mostra intestazioni e sample righe
      const headers = Object.keys(parsed[0] || {})
      console.log('[IMPORT] Headers trovati:', headers)
      console.log('[IMPORT] Sample 2 righe:', parsed.slice(0, 2))

      const batch = parsed
        .map((r) => {
          const order_number = pick(r, ['numero ordine', 'n ordine', 'ordine', 'num ordine'])
          const customer = pick(r, ['cliente'])
          const product_code = pick(r, ['codice prodotto', 'codice', 'prodotto', 'codice prod'])
          const mlVal = pick(r, ['ml'])
          const qty_requested = pick(r, ['quantita inserita', 'quantità inserita', 'quantita', 'qty richiesta', 'qta richiesta'])
          const qty_in_oven = pick(r, ['inforno', 'in forno'])
          const steps = pick(r, ['passaggi', 'n passaggi', 'passi'])

          if (!order_number || !product_code) return null

          return {
            order_number: String(order_number),
            customer: customer ? String(customer) : '',
            product_code: String(product_code),
            ml: asNumber(mlVal ?? null),
            qty_requested: asNumber(qty_requested ?? null),
            qty_in_oven: asNumber(qty_in_oven ?? null),
            qty_done: 0,
            steps_count: Number(asNumber(steps ?? 0)) || 0,
            status: 'da_iniziare' as const,
            created_at: serverTimestamp(),
          }
        })
        .filter(Boolean) as Array<{
          order_number: string
          customer: string
          product_code: string
          ml: number | null
          qty_requested: number | null
          qty_in_oven: number | null
          qty_done: number
          steps_count: number
          status: 'da_iniziare'
          created_at: any
        }>

      if (batch.length === 0) {
        throw new Error('Nessuna riga valida trovata. Intestazioni viste: ' + headers.join(' | '))
      }

      for (const row of batch) {
        const id = toDocId(row.order_number, row.product_code)
        await setDoc(doc(db, 'order_items', id), row, { merge: true })
      }

      const itemsSnap = await getDocs(query(collection(db, 'order_items'), orderBy('created_at', 'desc')))
      setOrders(itemsSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as OrderItem[])
      alert('Import completato: ' + batch.length + ' righe')
    } catch (e: any) {
      console.error('Errore durante import CSV', e)
      alert('Errore import: ' + (e?.message || String(e)))
    }
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
      const f = new File([blob], 'sheet.csv', { type: 'text/csv' })
      await handleImportCSV(f)
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
    const id = toDocId(order_number, product_code)
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
    if (pieces > 0
