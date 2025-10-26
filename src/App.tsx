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

const asNumber = (v:any)=>{
  if(v===null||v===undefined||v==='') return null;
  const n = Number(String(v).replace(',','.'))
  return Number.isFinite(n) ? n : null
}
const formatTime = (sec:number)=>{
  const h = Math.floor(sec/3600).toString().padStart(2,'0')
  const m = Math.floor((sec%3600)/60).toString().padStart(2,'0')
  const s = Math.floor(sec%60).toString().padStart(2,'0')
  return `${h}:${m}:${s}`
}

export default function App(){
  const [operators,setOperators] = useState<Operator[]>([])
  const [orders,setOrders] = useState<OrderItem[]>([])
  const [dateFilter,setDateFilter] = useState<string>('')
  const [showAdmin,setShowAdmin] = useState(false)
  const [timers,setTimers] = useState<Record<string,{running:boolean; startedAt:number|null; elapsed:number}>>({})

  // load data
  useEffect(()=>{
    (async()=>{
      await ensureAnonAuth()
      const opsSnap = await getDocs(query(collection(db,'operators'), orderBy('name')))
      setOperators(opsSnap.docs.map(d=>({ id:d.id, ...(d.data() as any) })) as Operator[])
      const itemsSnap = await getDocs(query(collection(db,'order_items'), orderBy('created_at','desc')))
      setOrders(itemsSnap.docs.map(d=>({ id:d.id, ...(d.data() as any) })) as OrderItem[])
    })()
  },[])

  const kpi = useMemo(()=>{
    const byStatus = (st:OrderItem['status']) => orders.filter(o=>o.status===st).length
    const piecesToday = orders.reduce((sum,o)=>sum+(o.qty_done||0),0)
    return { da_iniziare:byStatus('da_iniziare'), in_esecuzione:byStatus('in_esecuzione'), eseguiti:byStatus('eseguito'), pezziOggi:piecesToday, tempoOggi:0 }
  },[orders])

  // IMPORT CSV
  const handleImportCSV = async (file: File)=>{
    const parsed = await new Promise<RowIn[]>((resolve,reject)=>{
      Papa.parse<RowIn>(file, {
        header:true,
        skipEmptyLines:true,
        complete: (res: ParseResult<RowIn>) => resolve(res.data as RowIn[]),
        error: reject
      })
    })
    const batch = parsed.filter(r=>r['numero ordine']).map(r=> ({
      order_number: String(r['numero ordine']),
      customer: r['Cliente']||'',
      product_code: r['codice prodotto']||'',
      ml: asNumber(r['ml']??null),
      qty_requested: asNumber(r['Quantità inserita']??null),
      qty_in_oven: asNumber(r['inforno']??null),
      qty_done: 0,
      steps_count: Number(asNumber(r['Passaggi']??0))||0,
      status: 'da_iniziare',
      created_at: serverTimestamp()
    }))
    for(const row of batch){
      const id = `${row.order_number}__${row.product_code}`
      await setDoc(doc(db,'order_items', id), row, { merge: true })
    }
    const itemsSnap = await getDocs(query(collection(db,'order_items'), orderBy('created_at','desc')))
    setOrders(itemsSnap.docs.map(d=>({ id:d.id, ...(d.data() as any) })) as OrderItem[])
    alert('Import completato: '+batch.length+' righe')
  }

  // IMPORT da Google Sheet
  const importFromSheet = async ()=>{
