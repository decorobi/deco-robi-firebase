export type Operator = {
  id?: string;
  name: string;
  active: boolean;
};

export type OrderNote = {
  ts: string;                 // ISO date string
  operator: string | null;    // nome operatore (opzionale)
  text: string;               // testo nota
  step?: number;              // passaggio a cui si riferisce (opzionale)
  pieces?: number;            // pezzi registrati nello stop (opzionale)
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
  steps_count: number;                     // es. 0..9
  steps_progress?: Record<number, number>; // { passaggio: pezzi }
  steps_time?: Record<number, number>;     // { passaggio: secondi }

  // Pezzi completamente finiti (min tra i passaggi)
  qty_done?: number | null;

  // Stato lavorazione riga
  //  aggiunto 'pausato'
  status:
    | 'da_iniziare'
    | 'in_esecuzione'
    | 'pausato'
    | 'eseguito'
    | 'in_essiccazione'
    | 'in_imballaggio'
    | 'pronti_consegna';

  // Timer/state salvati su Firestore
  elapsed_sec?: number | null;        // secondi accumulati quando NON sta girando
  timer_start?: number | null;        // epoch ms quando parte l'ultimo giro del timer, null se pausato

  // Ultimo STOP registrato (comodo per report e KPI giornalieri)
  last_operator?: string | null;
  last_notes?: string | null;
  last_step?: number | null;
  last_pieces?: number | null;
  last_duration_sec?: number | null;  // <— aggiunto

  // Storico note (per "Vedi note")
  notes_log?: OrderNote[];            // <— aggiunto

  // Imballaggio (opzionale)
  packed_qty?: number | null;

  // Timestamps Firestore
  created_at?: any;                   // serverTimestamp
  last_done_at?: any;                 // serverTimestamp
};
