export type Operator = {
  id?: string;
  name: string;
  active: boolean;
};

export type OrderNote = {
  ts: string;
  operator: string | null;
  text: string;
  step?: number;
  pieces?: number;
};

export type OrderItem = {
  id?: string;

  // Base ordine
  order_number: string;
  customer: string;
  product_code: string;

  // Dati opzionali
  ml?: number | null;
  qty_requested?: number | null;
  qty_in_oven?: number | null;

  // Progressi per passaggio
  steps_count: number;
  steps_progress?: Record<number, number>;
  steps_time?: Record<number, number>;

  // Pezzi completamente finiti (min tra i passaggi)
  qty_done?: number | null;

  // Stato lavorazione riga
  status:
    | 'da_iniziare'
    | 'in_esecuzione'
    | 'pausato'
    | 'eseguito'
    | 'in_essiccazione'
    | 'in_imballaggio'
    | 'pronti_consegna';

  // Timer/state salvati su Firestore
  elapsed_sec?: number | null;
  timer_start?: number | null;

  // Ultimo STOP registrato
  last_operator?: string | null;
  last_notes?: string | null;
  last_step?: number | null;
  last_pieces?: number | null;
  last_duration_sec?: number | null;

  // Storico note
  notes_log?: OrderNote[];

  // Imballaggio
  packed_qty?: number | null;

  // Timestamps Firestore
  created_at?: any;
  last_done_at?: any;
  status_changed_at?: any; // <— NUOVO: quando passo a essiccazione/imballaggio/pronti
};
