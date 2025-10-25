export type Operator = { id?: string; name: string; active: boolean }

export type OrderItem = {
  id?: string;
  order_number: string;
  customer: string;
  product_code: string;
  ml?: number | null;
  qty_requested?: number | null;
  qty_in_oven?: number | null;
  qty_done?: number | null;
  steps_count: number;
  status:
    | 'da_iniziare'
    | 'in_esecuzione'
    | 'eseguito'
    | 'in_essiccazione'
    | 'in_imballaggio'
    | 'pronti_consegna';
  created_at?: string;
}

export type OrderLog = {
  id?: string;
  order_item_id: string;
  operator_name: string;
  step_number: number;
  pieces_done: number;
  notes?: string | null;
  started_at?: string | null;
  stopped_at?: string | null;
  duration_seconds?: number | null;
  created_at?: string;
}
