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
  qty_requested?: number | null;  // quantità richiesta totale (per passaggio)
  qty_in_oven?: number | null;

  /**
   * Pezzi COMPLETAMENTE finiti, cioè quelli passati
   * da TUTTI i passaggi (min(P1, P2, ..., Pn)).
   * Lo ricalcoliamo a ogni STOP in App.tsx.
   */
  qty_done?: number | null;

  /**
   * Numero totale di passaggi (da 1 a N).
   */
  steps_count: number;

  /**
   * Avanzamento per passaggio.
   * Esempio: { 1: 80, 2: 60 } significa
   *  - Passaggio 1: 80 pezzi eseguiti
   *  - Passaggio 2: 60 pezzi eseguiti
   */
  steps_progress?: Record<string | number, number>;

  /**
   * Stato dell'ordine.
   * Va in 'eseguito' SOLO quando tutti i passaggi
   * hanno raggiunto almeno qty_requested.
   */
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
