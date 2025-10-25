import type { Handler } from "@netlify/functions";

export const handler: Handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { order, pieces, operator } = body;

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: false, message: "RESEND_API_KEY non configurata – email non inviata" }),
      };
    }

    const subject = `IMBALLO COMPLETATO – Ordine ${order?.order_number}`;
    const html = `
      <p>Operatore: <b>${operator || "-"}</b></p>
      <p>Cliente: <b>${order?.customer || "-"}</b></p>
      <p>Prodotto: <b>${order?.product_code || "-"}</b></p>
      <p>Pezzi imballati ora: <b>${pieces || 0}</b></p>
    `;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Deco Robi <noreply@decorobi.it>",
        to: ["info@decorobi.it"],
        subject,
        html,
      }),
    });

    const data = await res.json();
    return { statusCode: 200, body: JSON.stringify({ ok: true, data }) };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, message: e.message }) };
  }
};
