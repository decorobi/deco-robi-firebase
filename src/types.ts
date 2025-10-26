export type Operator = {
  id?: string;
  name: string;
  active: boolean;
};

export type OrderItem = {
  id?: string;

  // Base ordine
  order_number: string;
  customer: string;
  product_code: string;

  // Dati opzionali
  ml?: number | null;
  qty_requested?: number | null;      // quantità richiesta per riga
  qty_in_oven?: number | null;

  // Progressi per passaggio
  steps_count: number;                // es. 0..9
  steps_progress?: Record<number, number>; // { passaggio: pezzi }
  steps_time?: Record<number, number>;     // { passaggio: secondi }

  // Pezzi completamente finiti (min tra i passaggi)
  qty_done?: number | null;

  // Stato lavorazione riga
  status:
    | 'da_iniziare'
    | 'in_esecuzione'
    | 'eseguito'
    | 'in_essiccazione'
    | 'in_imballaggio'
    | 'pronti_consegna';

  // Timer/state locali salvati su Firestore
  elapsed_sec?: number | null;        // secondi accumulati quando in pausa
  timer_start?: number | null;        // epoch ms quando parte il timer

  // Ultimo STOP registrato (comodo per report)
  last_operator?: string | null;
  last_notes?: string | null;
  last_step?: number | null;
  last_pieces?: number | null;

  // Imballaggio (opzionale)
  packed_qty?: number | null;

  // Timestamps Firestore
  created_at?: any;                   // serverTimestamp
  last_done_at?: any;                 // serverTimestamp
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
