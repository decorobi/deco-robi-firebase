export type Operator = {
  id?: string;
  name: string;
  active: boolean;
};

export type OrderItem = {
  id?: string;

  // Dati base ordine
  order_number: string;
  customer: string;
  product_code: string;

  // Dati opzionali
  ml?: number | null;
  qty_requested?: number | null;  // quantità richiesta per passaggio
  qty_in_oven?: number | null;

  /**
   * Pezzi COMPLETAMENTE finiti (passati da tutti i passaggi).
   * È il min(P1..Pn). Lo ricalcoliamo a ogni STOP in App.tsx.
   */
  qty_done?: number | null;

  /** Numero di passaggi dichiarato in import */
  steps_count: number;

  /** Avanzamento per passaggio: { 1: 80, 2: 60, ... } */
  steps_progress?: Record<string | number, number>;

  /** Tempo cumulativo per passaggio in secondi: { 1: 320, 2: 170, ... } */
  steps_time?: Record<string | number, number>;

  /** Totale pezzi imballati (opzionale) */
  packed_qty?: number | null;

  /** Stato generale */
  status:
    | 'da_iniziare'
    | 'in_esecuzione'
    | 'eseguito'
    | 'in_essiccazione'
    | 'in_imballaggio'
    | 'pronti_consegna';

  created_at?: string;
};

export type OrderLog = {
  id?: string;

  // A quale OrderItem si riferisce il log
  order_item_id: string;

  // Chi ha eseguito
  operator_name: string;

  // Quale passaggio (1..N)
  step_number: number;

  // Quanti pezzi registrati in questo stop
  pieces_done: number;

  // Info aggiuntive
  notes?: string | null;

  // Tempi
  started_at?: string | null;
  stopped_at?: string | null;
  duration_seconds?: number | null;

  created_at?: string;
};
