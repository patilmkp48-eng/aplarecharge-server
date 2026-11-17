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

import crypto from 'crypto';

// Map internal operator codes to ZuelPay operator codes when ZuelPay is used
const ZUELPAY_OPERATOR_MAP = {
  JIO: 'RJP',
  AIRTEL: 'ATP',
  VI: 'IDP',
  BSNL: 'BGP',
  MTNL: 'MTNL',
  TATAPLAY: 'TTV',
  AIRTELDTH: 'ATV',
  DISHTV: 'DTV',
  VIDEOCOND2H: 'VTV',
  SUNDIRECT: 'STV',
};

// Map internal operator codes to Pay2All provider_id codes when Pay2All is used
const PAY2ALL_OPERATOR_MAP = {
  AIRTEL: 1,
  JIO: 2,
  VI: 3,
  BSNL: 4,
  MTNL: 4,
  TATAPLAY: 5,
  AIRTELDTH: 6,
  DISHTV: 7,
  VIDEOCOND2H: 8,
  D2H: 8,
  SUNDIRECT: 9,
};

async function liveRecharge({ number, apiCode, amount, reqId }, api) {
  if (!api.rechargeUrl || !api.apiKey) {
    return { status: 'failed', apiRef: null, message: 'Live API सेट केलेला नाही. Admin Panel मध्ये API Settings भरा.' };
  }

  const rawUrl = String(api.rechargeUrl).trim();
  const rawKey = String(api.apiKey).trim();

  // Universal Pay2All v1 POST Adapter (triggered automatically when URL has pay2all.in)
  if (rawUrl.toLowerCase().includes('pay2all.in')) {
    const p2aProviderId = PAY2ALL_OPERATOR_MAP[String(apiCode).toUpperCase()] || Number(apiCode) || 2;
    const isUat = rawKey.toUpperCase().endsWith('|UAT') || rawUrl.toLowerCase().includes('mode=uat');
    const cleanToken = rawKey.split('|')[0].trim();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      const res = await fetch('https://pay2all.in/api/v1/recharge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${cleanToken}`,
        },
        body: JSON.stringify({
          client_id: String(reqId || ('P2A_' + Date.now())),
          provider_id: p2aProviderId,
          number: String(number).trim(),
          amount: Number(amount),
          mode: isUat ? 'UAT' : 'LIVE',
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let j = {};
      try {
        j = JSON.parse(text);
      } catch (_) {}

      const dataObj = j.data || {};
      const apiRef = dataObj.utr || dataObj.txn_id || dataObj.order_id || j.utr || j.txid || null;
      const statusId = Number(j.status_id);

      if (statusId === 1 || String(j.status).toLowerCase() === 'success') {
        return {
          status: 'success',
          apiRef: apiRef || ('P2A' + Date.now()),
          message: j.message || 'रिचार्ज यशस्वी (Pay2All)',
          raw: text.slice(0, 500),
        };
      }
      if (statusId === 3 || String(j.status).toLowerCase() === 'pending') {
        return {
          status: 'pending',
          apiRef,
          message: j.message || 'रिचार्ज प्रक्रियेत आहे',
          raw: text.slice(0, 500),
        };
      }
      return {
        status: 'failed',
        apiRef,
        message: j.message || j.error || 'Pay2All कडून रिचार्ज असफल',
        raw: text.slice(0, 500),
      };
    } catch (e) {
      return { status: 'pending', apiRef: null, message: 'Pay2All सर्व्हरकडून उत्तर आले नाही: ' + e.message };
    }
  }

  // Universal ZuelPay POST Adapter (triggered automatically when URL has zuelpay.in / zuelpay.com)
  if (rawUrl.toLowerCase().includes('zuelpay')) {
    // Supports apiKey formats:
    //   1) "TOKEN|CHECKSUM"
    //   2) "TOKEN|MOBILE|PASSWORD" (auto-computes HMAC-SHA256 checkSum)
    //   3) "TOKEN"
    const parts = rawKey.split('|').map((s) => s.trim());
    const token = parts[0] || '';
    let checkSum = parts[1] || '';
    if (parts.length >= 3) {
      const mobile = parts[1];
      const password = parts.slice(2).join('|');
      checkSum = crypto.createHmac('sha256', password).update(`${token}:${mobile}`).digest('hex');
    }

    const zuelOpCode = ZUELPAY_OPERATOR_MAP[String(apiCode).toUpperCase()] || apiCode;
    const zuelAgentId = String(reqId || ('ZLP' + Date.now())).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(rawUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Token: token,
          checkSum: checkSum,
        },
        body: JSON.stringify({
          code: zuelOpCode,
          number: String(number).trim(),
          agent_id: zuelAgentId,
          amount: String(amount),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let j = {};
      try {
        j = JSON.parse(text);
      } catch (_) {}

      const apiRef = j.utr || j.tlid || j.txid || null;
      const cbStatus = String(j.callback_status || j.status || '').toUpperCase();
      if (cbStatus === 'SUCCESS' || (String(j.status).toLowerCase() === 'success' && cbStatus !== 'PENDING' && j.result === 0)) {
        return { status: 'success', apiRef, message: j.msg || 'रिचार्ज यशस्वी', raw: text.slice(0, 500) };
      }
      if (cbStatus === 'PENDING') {
        return { status: 'pending', apiRef, message: j.msg || 'रिचार्ज प्रक्रियेत आहे', raw: text.slice(0, 500) };
      }
      return { status: 'failed', apiRef, message: j.error || j.msg || 'ZuelPay ने रिचार्ज नाकारला', raw: text.slice(0, 500) };
    } catch (e) {
      return { status: 'pending', apiRef: null, message: 'ZuelPay कडून उत्तर आले नाही: ' + e.message };
    }
  }

  const url = rawUrl
    .replaceAll('{apikey}', encodeURIComponent(rawKey))
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
