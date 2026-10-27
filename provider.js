// Recharge provider layer.
// DEMO mode: no real money moves, results are simulated.
// LIVE mode: calls your recharge API company using the URL template set in Admin Panel -> API Settings.
//
// Most Indian recharge API companies use a simple GET URL such as:
//   https://api.example.com/recharge?apikey={apikey}&number={number}&operator={operator}&amount={amount}&reqid={reqid}
// Paste the exact URL from your provider's documentation into the admin panel, using these placeholders.
// If your provider uses POST/JSON or signatures, adapt liveRecharge() below to match their docs.

function demoHash(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

export function demoFetchBill(operatorName, consumerNumber) {
  const h = demoHash(consumerNumber);
  const amount = 200 + (h % 2800);
  const due = new Date(Date.now() + ((h % 15) + 3) * 86400000);
  return {
    customerName: 'Demo ग्राहक ' + String(consumerNumber).slice(-4),
    billAmount: amount,
    dueDate: due.toISOString().slice(0, 10),
    billNumber: 'BILL' + (h % 1000000),
    operator: operatorName,
    note: 'Demo Mode: हे खरे बिल नाही.',
  };
}

async function demoRecharge({ number }) {
  await new Promise((r) => setTimeout(r, 1200));
  // Numbers ending in 0000 fail on purpose so you can test refunds in demo mode.
  if (String(number).endsWith('0000')) {
    return { status: 'failed', apiRef: null, message: 'Demo: ऑपरेटरने रिचार्ज नाकारला (टेस्ट नंबर)' };
  }
  return { status: 'success', apiRef: 'DEMO' + Date.now(), message: 'Demo रिचार्ज यशस्वी' };
}

async function liveRecharge({ number, apiCode, amount, reqId }, api) {
  if (!api.rechargeUrl || !api.apiKey) {
    return { status: 'failed', apiRef: null, message: 'Live API सेट केलेला नाही. Admin Panel मध्ये API Settings भरा.' };
  }
  const url = api.rechargeUrl
    .replaceAll('{apikey}', encodeURIComponent(api.apiKey))
    .replaceAll('{number}', encodeURIComponent(number))
    .replaceAll('{operator}', encodeURIComponent(apiCode))
    .replaceAll('{amount}', encodeURIComponent(amount))
    .replaceAll('{reqid}', encodeURIComponent(reqId));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const text = await res.text();
    const lower = text.toLowerCase();

    // Try to pull an operator/transaction reference out of a JSON response
    let apiRef = null;
    try {
      const j = JSON.parse(text);
      apiRef = j.txid || j.opid || j.operator_ref || j.txnid || j.orderid || j.ref || null;
    } catch (_) {}

    if (lower.includes(String(api.successKeyword).toLowerCase())) {
      return { status: 'success', apiRef, message: 'रिचार्ज यशस्वी', raw: text.slice(0, 500) };
    }
    if (lower.includes(String(api.pendingKeyword).toLowerCase())) {
      return { status: 'pending', apiRef, message: 'रिचार्ज प्रक्रियेत आहे', raw: text.slice(0, 500) };
    }
    return { status: 'failed', apiRef, message: 'API ने रिचार्ज नाकारला', raw: text.slice(0, 500) };
  } catch (e) {
    // Network error/timeout: we don't know the result, so keep it pending for admin to check.
    return { status: 'pending', apiRef: null, message: 'API कडून उत्तर आले नाही: ' + e.message };
  }
}

export async function doRecharge(params, settings) {
  if (settings.mode === 'live') return liveRecharge(params, settings.api);
  return demoRecharge(params);
}
