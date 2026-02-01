import React, { useMemo, useState } from "react";

type Props = {
  children: React.ReactNode;
};

const STORAGE_KEY = "deco_robi_pin_ok";

export default function PinGate({ children }: Props) {
  const expectedPin = useMemo(() => import.meta.env.VITE_APP_PIN as string | undefined, []);
  const [ok, setOk] = useState(() => localStorage.getItem(STORAGE_KEY) === "true");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Se non hai configurato VITE_APP_PIN, lasciamo passare (evita di bloccare per errore)
  if (!expectedPin) return <>{children}</>;

  if (ok) return <>{children}</>;

  const submit = () => {
    if (pin === expectedPin) {
      localStorage.setItem(STORAGE_KEY, "true");
      setOk(true);
      setErr(null);
    } else {
      setErr("PIN errato");
      setPin("");
    }
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h2 style={styles.title}>Accesso</h2>
        <p style={styles.p}>Inserisci il PIN per entrare</p>

        <input
          style={styles.input}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          inputMode="numeric"
          autoFocus
          placeholder="PIN"
        />

        {err && <div style={styles.err}>{err}</div>}

        <button style={styles.btn} onClick={submit}>
          Entra
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0b1220",
    padding: 16,
  },
  card: {
    width: 360,
    maxWidth: "100%",
    background: "#111a2e",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 12,
    padding: 18,
    color: "white",
  },
  title: { margin: "0 0 8px 0" },
  p: { margin: "0 0 14px 0", opacity: 0.85 },
  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.15)",
    background: "#0b1220",
    color: "white",
    outline: "none",
    marginBottom: 10,
  },
  err: { color: "#ff6b6b", marginBottom: 10 },
  btn: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "0",
    background: "#2d6cdf",
    color: "white",
    cursor: "pointer",
    fontWeight: 700,
  },
};
