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
  steps_count: number;                     // es. 0..9
  steps_progress?: Record<number, number>; // { passaggio: pezzi }
  steps_time?: Record<number, number>;     // { passaggio: secondi }

  // Pezzi completamente finiti (min tra i passaggi)
  qty_done?: number | null;

  // Stato lavorazione riga
  // >>> Aggiunto 'pausato'
  status:
    | 'da_iniziare'
    | 'in_esecuzione'
    | 'pausato'
    | 'eseguito'
    | 'in_essiccazione'
    | 'in_imballaggio'
    | 'pronti_consegna';

  // Timer/state salvati su Firestore
  elapsed_sec?: number | null;        // secondi accumulati quando NON sta girando (pausa o fermo)
  timer_start?: number | null;        // epoch ms quando parte l'u_
