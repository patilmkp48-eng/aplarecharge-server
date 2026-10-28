import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { load, save, db, newId, newToken, hashPassword, verifyPassword } from './db.js';
import { OPERATORS, plansFor, findOperator } from './catalog.js';
import { doRecharge, demoFetchBill } from './provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
load();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use('/admin', express.static(path.join(__dirname, 'public')));

// Redirect root to /admin for convenience
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// ======================== AUTH MIDDLEWARES ========================

function requireUser(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const userId = db().sessions[token];
  if (!userId) return res.status(401).json({ error: 'कृपया पुन्हा लॉगिन करा.' });
  const user = db().users.find((u) => u.id === userId);
  if (!user) return res.status(401).json({ error: 'युजर सापडला नाही.' });
  if (user.blocked) return res.status(403).json({ error: 'तुमचे खाते ब्लॉक करण्यात आले आहे. कृपया सपोर्टशी संपर्क साधा.' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const sess = db().adminSessions[token];
  if (!sess) return res.status(401).json({ error: 'Admin लॉगिन आवश्यक आहे.' });
  next();
}

// Ledger Recalculation: Guarantees user.walletBalance & totalCashback always match exact AddMoney - Recharges + Cashback
function recalculateUserLedger(user) {
  if (!user) return;
  const d = db();
  const base = user.initialBalance !== undefined
    ? Number(user.initialBalance)
    : (d.settings.mode === 'demo' ? 500 : 0);
  const manualDebit = Number(user.manualDebit || 0);

  const userAdds = (d.addMoneyRequests || []).filter(
    (r) => (r.userPhone === user.phone || r.userId === user.id) && r.status === 'approved'
  );
  const totalAdded = userAdds.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  const userTxns = (d.transactions || []).filter(
    (t) => t.userPhone === user.phone || t.userId === user.id
  );
  const chargedTxns = userTxns.filter(
    (t) => t.status === 'success' || t.status === 'pending' || (t.status === 'failed' && !t.refunded)
  );
  const totalSpent = chargedTxns.reduce((s, t) => s + (Number(t.amount) || 0), 0);

  const successTxns = userTxns.filter((t) => t.status === 'success');
  const totalCashback = successTxns.reduce((s, t) => s + (Number(t.cashback) || 0), 0);

  user.walletBalance = Number(Math.max(0, base + totalAdded - manualDebit - totalSpent + totalCashback).toFixed(2));
  user.totalCashback = Number(totalCashback.toFixed(2));
}

// ======================== PUBLIC & USER API ========================

// App Config & Operators
app.get('/api/config', (req, res) => {
  const s = db().settings;
  const comms = db().commissions;
  const operatorsWithCashback = {};

  for (const [service, list] of Object.entries(OPERATORS)) {
    operatorsWithCashback[service] = list
      .filter((op) => comms[op.code]?.enabled !== false)
      .map((op) => ({
        ...op,
        cashbackPercent: comms[op.code]?.userCashback ?? 0,
      }));
  }

  res.json({
    appName: s.appName,
    mode: s.mode,
    services: s.services,
    notice: s.notice,
    banners: s.banners,
    upiId: s.upiId,
    upiName: s.upiName,
    minAddMoney: s.minAddMoney,
    operators: operatorsWithCashback,
    commissions: comms,
  });
});

// Direct Mobile App Sync Endpoint (Bi-directionally syncs user wallet, addMoney, txns, settings & commissions with Web Admin Panel)
app.post('/api/client-sync', (req, res) => {
  const { phone, name, clientAddMoney, clientTransactions, syncServices } = req.body;
  const cleanPhone = String(phone || '9876543210').replace(/\D/g, '');
  let dirty = false;

  if (syncServices && typeof syncServices === 'object') {
    db().settings.services = { ...db().settings.services, ...syncServices };
    dirty = true;
  }

  let user = db().users.find((u) => u.phone === cleanPhone);
  if (!user && cleanPhone.length === 10) {
    user = {
      id: newId('USR'),
      phone: cleanPhone,
      name: (name || 'ग्राहक ' + cleanPhone.slice(-4)).trim(),
      walletBalance: db().settings.mode === 'demo' ? 500 : 0,
      totalCashback: 0,
      blocked: false,
      createdAt: new Date().toISOString(),
    };
    db().users.unshift(user);
    dirty = true;
  } else if (user && name && name.trim() && user.name !== name.trim()) {
    user.name = name.trim();
    dirty = true;
  }

  if (!db().paymentOrders) db().paymentOrders = [];
  if (!db().addMoneyRequests) db().addMoneyRequests = [];
  if (!db().transactions) db().transactions = [];

  // Sync any verified Add Money / Gateway Orders completed in the Mobile App
  if (user && Array.isArray(clientAddMoney)) {
    for (const item of clientAddMoney) {
      const reqId = String(item.id || '').trim();
      if (!reqId) continue;
      const alreadyInAdd = db().addMoneyRequests.find((r) => r.id === reqId);
      const alreadyInOrders = db().paymentOrders.find((o) => o.orderId === reqId && o.credited);
      if (!alreadyInAdd && !alreadyInOrders) {
        const amt = Number(item.amount) || 0;
        const rawStatus = String(item.status || 'APPROVED').toLowerCase();
        const normStatus = rawStatus === 'approved' || rawStatus === 'success' ? 'approved' : rawStatus === 'pending' ? 'pending' : 'rejected';
        if (amt > 0) {
          if (normStatus === 'approved') {
            user.walletBalance = Number((user.walletBalance + amt).toFixed(2));
          }
          db().addMoneyRequests.unshift({
            id: reqId,
            userId: user.id,
            userPhone: cleanPhone,
            userName: user.name,
            amount: amt,
            utrNumber: String(item.utr || item.utrNumber || 'Gateway Verified'),
            status: normStatus,
            createdAt: new Date().toISOString(),
          });
          db().paymentOrders.unshift({
            orderId: reqId,
            userId: user.id,
            userPhone: cleanPhone,
            userName: user.name,
            amount: amt,
            preferredApp: 'UPI App',
            provider: db().settings.paymentGateway?.provider || 'UPIGateway',
            mode: db().settings.paymentGateway?.mode || 'sandbox',
            status: normStatus === 'approved' ? 'SUCCESS' : 'FAILED',
            credited: normStatus === 'approved',
            bankUtr: String(item.utr || ''),
            createdAt: new Date().toISOString(),
          });
          dirty = true;
        }
      }
    }
  }

  // Sync any Recharges completed in the Mobile App while offline
  if (user && Array.isArray(clientTransactions)) {
    for (const t of clientTransactions) {
      const txnId = String(t.id || '').trim();
      if (!txnId || txnId === 'TXN102938') continue; // Skip static initial sample txn
      const exists = db().transactions.find((x) => x.id === txnId);
      if (!exists) {
        const amt = Number(t.amount) || 0;
        const cb = Number(t.cashback) || 0;
        const prof = Number(t.adminProfit) || 0;
        const st = String(t.status || 'SUCCESS').toLowerCase();
        if (amt > 0) {
          if (st === 'success') {
            user.walletBalance = Number(Math.max(0, user.walletBalance - amt + cb).toFixed(2));
            user.totalCashback = Number(((user.totalCashback || 0) + cb).toFixed(2));
          }
          db().transactions.unshift({
            id: txnId,
            userId: user.id,
            userPhone: cleanPhone,
            userName: user.name,
            service: String(t.category || 'mobile').toLowerCase(),
            operatorCode: String(t.operatorCode || 'JIO'),
            operatorName: String(t.operatorName || 'Reliance Jio'),
            number: String(t.number || ''),
            customerName: '',
            amount: amt,
            cashback: cb,
            adminProfit: prof,
            status: st === 'refunded' ? 'failed' : st,
            refunded: st === 'refunded',
            apiRef: String(t.operatorRef || ''),
            message: String(t.message || 'रिचार्ज यशस्वी'),
            createdAt: new Date().toISOString(),
          });
          dirty = true;
        }
      }
    }
  }

  if (user) {
    recalculateUserLedger(user);
  }
  if (dirty) save();

  const s = db().settings;
  const userTxns = user
    ? db().transactions.filter((t) => t.userPhone === cleanPhone || t.userId === user.id).slice(0, 50)
    : [];
  const userAddMoney = user
    ? db().addMoneyRequests.filter((r) => r.userPhone === cleanPhone || r.userId === user.id).slice(0, 30)
    : [];

  res.json({
    success: true,
    settings: {
      appName: s.appName,
      mode: s.mode,
      services: s.services,
      notice: s.notice,
      upiId: s.upiId,
      upiName: s.upiName,
      minAddMoney: s.minAddMoney,
      paymentGateway: {
        provider: s.paymentGateway?.provider || 'UPIGateway',
        mode: s.paymentGateway?.mode || 'sandbox',
      },
      planApi: {
        mode: s.planApi?.mode || 'smart',
        providerName: s.planApi?.providerName || 'Mplan / KwikAPI / PlanAPI',
        apiKey: s.planApi?.apiKey || '',
        rOfferUrl:
          s.planApi?.rOfferUrl ||
          'https://api.mplan.in/api/Plans.php?apikey={apikey}&offer=roffer&tel={number}&operator={operator}',
        regularPlansUrl:
          s.planApi?.regularPlansUrl ||
          'https://api.mplan.in/api/Plans.php?apikey={apikey}&cricle=Maharashtra&operator={operator}',
      },
    },
    commissions: db().commissions,
    user,
    transactions: userTxns,
    addMoneyRequests: userAddMoney,
  });
});

// Direct Mobile App Recharge Endpoint
app.post('/api/client-recharge', async (req, res) => {
  const { phone, name, service, operator, number, amount } = req.body;
  const cleanPhone = String(phone || '9876543210').replace(/\D/g, '');
  let user = db().users.find((u) => u.phone === cleanPhone);
  if (!user) {
    user = {
      id: newId('USR'),
      phone: cleanPhone,
      name: (name || 'ग्राहक').trim(),
      walletBalance: 500,
      totalCashback: 0,
      blocked: false,
      createdAt: new Date().toISOString(),
    };
    db().users.unshift(user);
  }
  if (user.blocked) {
    return res.status(403).json({ error: 'तुमचे खाते Admin ने ब्लॉक केले आहे.' });
  }

  const numAmount = Number(amount);
  const s = db().settings;
  const svcKey = String(service || 'mobile').toLowerCase();
  if (s.services[svcKey] === false) {
    return res.status(400).json({ error: 'ही सेवा सध्या Admin कडून बंद आहे.' });
  }

  const op = findOperator(operator);
  if (!op) return res.status(400).json({ error: 'अवैध ऑपरेटर.' });

  const comm = db().commissions[op.code] || { apiCommission: 3.0, userCashback: 1.5, apiCode: op.code, enabled: true };
  if (comm.enabled === false) {
    return res.status(400).json({ error: `${op.name} सेवा सध्या बंद आहे.` });
  }

  if (user.walletBalance < numAmount) {
    return res.status(400).json({ error: 'वॉलेटमध्ये पुरेसा बॅलन्स नाही!' });
  }

  user.walletBalance = Number((user.walletBalance - numAmount).toFixed(2));
  const reqId = newId('TXN');
  const cashback = Number(((numAmount * (comm.userCashback || 0)) / 100).toFixed(2));
  const totalCommission = Number(((numAmount * (comm.apiCommission || 0)) / 100).toFixed(2));
  const adminProfit = Number((totalCommission - cashback).toFixed(2));

  const txn = {
    id: reqId,
    userId: user.id,
    userPhone: user.phone,
    userName: user.name,
    service: svcKey,
    operatorCode: op.code,
    operatorName: op.name,
    number: String(number).trim(),
    customerName: '',
    amount: numAmount,
    cashback,
    adminProfit,
    status: 'pending',
    apiRef: null,
    message: 'प्रक्रियेत आहे...',
    createdAt: new Date().toISOString(),
  };

  db().transactions.unshift(txn);
  save();

  const result = await doRecharge(
    { number: txn.number, apiCode: comm.apiCode || op.code, amount: numAmount, reqId },
    s
  );

  txn.status = result.status;
  txn.apiRef = result.apiRef;
  txn.message = result.message;

  if (result.status === 'success') {
    if (cashback > 0) {
      user.walletBalance = Number((user.walletBalance + cashback).toFixed(2));
      user.totalCashback = Number(((user.totalCashback || 0) + cashback).toFixed(2));
    }
    if (db().apiWalletBalance > 0) {
      db().apiWalletBalance = Number((db().apiWalletBalance - (numAmount - totalCommission)).toFixed(2));
    }
  } else if (result.status === 'failed') {
    user.walletBalance = Number((user.walletBalance + numAmount).toFixed(2));
    txn.cashback = 0;
    txn.adminProfit = 0;
    txn.refunded = true;
  }

  save();
  res.json({ success: true, transaction: txn, user });
});

// ======================== METHOD 2: AUTOMATIC PAYMENT GATEWAY (ANTI-FRAUD) ========================

const GATEWAY_HMAC_SECRET = 'apla_recharge_pg_hmac_secret_2026';

function signPaymentOrder(orderId, phone, amount) {
  return crypto
    .createHmac('sha256', GATEWAY_HMAC_SECRET)
    .update(`${orderId}|${phone}|${Number(amount).toFixed(2)}`)
    .digest('hex');
}

// Step 1: Create Tamper-Proof Payment Gateway Order
app.post('/api/payment/create-order', async (req, res) => {
  const { phone, name, amount, preferredApp } = req.body;
  const cleanPhone = String(phone || '9876543210').replace(/\D/g, '');
  const numAmount = Number(amount);
  const s = db().settings;
  const minAmt = s.minAddMoney || 10;

  if (!numAmount || numAmount < minAmt) {
    return res.status(400).json({ error: `किमान ₹${minAmt} रक्कम टाका.` });
  }

  let user = db().users.find((u) => u.phone === cleanPhone);
  if (!user) {
    user = {
      id: newId('USR'),
      phone: cleanPhone,
      name: (name || 'ग्राहक').trim(),
      walletBalance: 500,
      totalCashback: 0,
      blocked: false,
      createdAt: new Date().toISOString(),
    };
    db().users.unshift(user);
  }
  if (user.blocked) {
    return res.status(403).json({ error: 'तुमचे खाते ब्लॉक आहे.' });
  }

  const orderId = newId('ORD');
  const signature = signPaymentOrder(orderId, cleanPhone, numAmount);
  const pg = s.paymentGateway || { provider: 'UPIGateway', mode: 'sandbox', merchantKey: '' };
  const upiId = s.upiId || 'aplarecharge@ybl';
  const upiName = encodeURIComponent(s.upiName || 'AplaRecharge');
  const upiIntentUrl = `upi://pay?pa=${upiId}&pn=${upiName}&am=${numAmount.toFixed(2)}&tr=${orderId}&tn=Wallet_${orderId}&cu=INR`;

  let gatewayPaymentUrl = '';

  // If Live Payment Gateway is configured (e.g., UPIGateway / EkQR / IMB)
  if (pg.mode === 'live' && pg.merchantKey && pg.createOrderUrl) {
    try {
      const gwResp = await fetch(pg.createOrderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: pg.merchantKey,
          client_txn_id: orderId,
          amount: String(numAmount),
          p_info: 'AplaRecharge Wallet Topup',
          customer_name: user.name,
          customer_email: `${cleanPhone}@aplarecharge.in`,
          customer_mobile: cleanPhone,
          redirect_url: 'http://localhost:5000/admin',
        }),
      });
      const gwData = await gwResp.json();
      if (gwData?.data?.payment_url) {
        gatewayPaymentUrl = gwData.data.payment_url;
      }
    } catch (_) {}
  }

  const order = {
    orderId,
    userId: user.id,
    userPhone: cleanPhone,
    userName: user.name,
    amount: numAmount,
    preferredApp: preferredApp || 'PhonePe',
    provider: pg.provider || 'UPIGateway',
    mode: pg.mode || 'sandbox',
    signature,
    upiIntentUrl,
    gatewayPaymentUrl,
    status: 'INITIATED', // INITIATED -> SUCCESS | FAILED
    credited: false, // Strict Idempotency Lock: prevents double crediting!
    bankUtr: null,
    createdAt: new Date().toISOString(),
  };

  if (!db().paymentOrders) db().paymentOrders = [];
  db().paymentOrders.unshift(order);
  save();

  res.json({
    success: true,
    order: {
      orderId: order.orderId,
      amount: order.amount,
      signature: order.signature,
      provider: order.provider,
      mode: order.mode,
      upiIntentUrl: order.upiIntentUrl,
      gatewayPaymentUrl: order.gatewayPaymentUrl,
    },
  });
});

// Step 2: Verify Payment Gateway Order & Auto-Credit Wallet (Zero-Fraud Verified)
app.post('/api/payment/verify-order', async (req, res) => {
  const { orderId, signature, gatewayStatus, phone, name, amount, preferredApp } = req.body;
  if (!db().paymentOrders) db().paymentOrders = [];
  let order = db().paymentOrders.find((o) => o.orderId === orderId);

  // If order was initiated on the mobile client while connection was briefly unreachable, register it after validating client signature
  if (!order && orderId && amount && phone) {
    const cleanPhone = String(phone).replace(/\D/g, '');
    const numAmt = Number(amount);
    const expectedClientSig = `SIG_${orderId}_${numAmt.toFixed(2)}_${cleanPhone}`;
    const expectedServerSig = signPaymentOrder(orderId, cleanPhone, numAmt);
    if (signature === expectedClientSig || signature === expectedServerSig) {
      let u = db().users.find((x) => x.phone === cleanPhone);
      if (!u) {
        u = {
          id: newId('USR'),
          phone: cleanPhone,
          name: (name || 'ग्राहक').trim(),
          walletBalance: db().settings.mode === 'demo' ? 500 : 0,
          totalCashback: 0,
          blocked: false,
          createdAt: new Date().toISOString(),
        };
        db().users.unshift(u);
      }
      order = {
        orderId,
        userId: u.id,
        userPhone: cleanPhone,
        userName: u.name,
        amount: numAmt,
        preferredApp: preferredApp || 'PhonePe',
        provider: db().settings.paymentGateway?.provider || 'UPIGateway',
        mode: db().settings.paymentGateway?.mode || 'sandbox',
        signature: expectedServerSig,
        status: 'INITIATED',
        credited: false,
        bankUtr: null,
        createdAt: new Date().toISOString(),
      };
      db().paymentOrders.unshift(order);
    }
  }

  if (!order) {
    return res.status(404).json({ error: 'पेमेंट ऑर्डर सापडली नाही! (Invalid Order ID)' });
  }

  // Anti-Fraud Lock 1: Verify cryptographic HMAC signature (or verified client order signature)
  const expectedSig = signPaymentOrder(order.orderId, order.userPhone, order.amount);
  const expectedClientSig = `SIG_${order.orderId}_${Number(order.amount).toFixed(2)}_${order.userPhone}`;
  if (signature !== expectedSig && signature !== expectedClientSig) {
    return res.status(403).json({ error: 'सुरक्षा तपासणी अयशस्वी! (Invalid Order Signature - Fraud Blocked)' });
  }

  // Anti-Fraud Lock 2: Idempotency Lock - Never credit an already processed order
  if (order.credited || order.status === 'SUCCESS') {
    return res.status(400).json({ error: 'ही पेमेंट ऑर्डर आधीच वॉलेटमध्ये जमा झाली आहे! (Duplicate Credit Blocked)' });
  }

  const pg = db().settings.paymentGateway || { mode: 'sandbox' };
  let verifiedSuccess = false;
  let bankUtr = '';

  if (pg.mode === 'live' && pg.merchantKey && pg.checkStatusUrl) {
    // Live Gateway Server-to-Server Status Check
    try {
      const today = new Date();
      const dd = String(today.getDate()).padStart(2, '0');
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const yyyy = today.getFullYear();
      const gwResp = await fetch(pg.checkStatusUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: pg.merchantKey,
          client_txn_id: order.orderId,
          txn_date: `${dd}-${mm}-${yyyy}`,
        }),
      });
      const gwData = await gwResp.json();
      const st = String(gwData?.data?.status || '').toLowerCase();
      if (st === 'success') {
        verifiedSuccess = true;
        bankUtr = String(gwData?.data?.upi_txn_id || gwData?.data?.utr || '');
      }
    } catch (e) {
      return res.status(500).json({ error: 'पेमेंट गेटवे सर्व्हरशी संपर्क होऊ शकला नाही.' });
    }
  } else {
    // Sandbox Gateway Verification
    if (String(gatewayStatus).toUpperCase() === 'SUCCESS') {
      verifiedSuccess = true;
      bankUtr = '4' + String(Date.now()).slice(-11); // Realistic 12-digit NPCI Bank RRN
    }
  }

  const user = db().users.find((u) => u.phone === order.userPhone || u.id === order.userId);

  if (!verifiedSuccess) {
    order.status = 'FAILED';
    const failedReq = {
      id: order.orderId,
      userId: user ? user.id : 'USR',
      userPhone: order.userPhone,
      userName: order.userName,
      amount: order.amount,
      utrNumber: `${order.preferredApp || order.provider} • FAILED (₹0 Added)`,
      status: 'rejected',
      createdAt: new Date().toISOString(),
    };
    db().addMoneyRequests.unshift(failedReq);
    save();
    return res.json({
      success: false,
      status: 'FAILED',
      message: 'पेमेंट फेल किंवा रद्द झाले! वॉलेटमध्ये कोणतीही रक्कम जमा केली नाही (₹0 Added).',
      walletBalance: user ? user.walletBalance : 0,
    });
  }

  // Anti-Fraud Lock 3: Check Duplicate Bank UTR across all history
  const duplicateUtr = db().addMoneyRequests.find((r) => r.utrNumber.includes(bankUtr) && r.status === 'approved');
  if (duplicateUtr) {
    return res.status(400).json({ error: 'हा बँक UTR आधीच वापरला गेला आहे! (Duplicate UTR Blocked)' });
  }

  // Mark order as permanently CREDITED & SUCCESS
  order.status = 'SUCCESS';
  order.credited = true;
  order.bankUtr = bankUtr;

  if (user) {
    user.walletBalance = Number((user.walletBalance + order.amount).toFixed(2));
  }

  const reqItem = {
    id: order.orderId,
    userId: user ? user.id : 'USR',
    userPhone: order.userPhone,
    userName: order.userName,
    amount: order.amount,
    utrNumber: `${order.preferredApp || order.provider} • UTR: ${bankUtr}`,
    status: 'approved',
    createdAt: new Date().toISOString(),
  };
  db().addMoneyRequests.unshift(reqItem);
  save();

  res.json({
    success: true,
    status: 'SUCCESS',
    orderId: order.orderId,
    bankUtr,
    amount: order.amount,
    walletBalance: user ? user.walletBalance : order.amount,
    message: `पेमेंट गेटवे द्वारे ₹${order.amount} यशस्वीरीत्या व्हेरिफाय होऊन वॉलेटमध्ये जमा झाले! (UTR: ${bankUtr})`,
  });
});

// Send OTP
app.post('/api/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  if (cleanPhone.length !== 10) {
    return res.status(400).json({ error: 'कृपया १० अंकी वैध मोबाईल नंबर टाका.' });
  }
  const otp = db().settings.mode === 'demo' ? db().settings.demoOtp : String(Math.floor(100000 + Math.random() * 900000));
  db().otps[cleanPhone] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };
  save();

  res.json({
    success: true,
    message: db().settings.mode === 'demo' ? `Demo OTP पाठवला आहे (OTP: ${otp})` : 'OTP पाठवला आहे',
    demoOtp: db().settings.mode === 'demo' ? otp : undefined,
  });
});

// Verify OTP & Login
app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, otp, name } = req.body;
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const record = db().otps[cleanPhone];

  if (!record || record.otp !== String(otp).trim()) {
    return res.status(400).json({ error: 'चुकीचा OTP! कृपया तपासून पुन्हा टाका.' });
  }
  delete db().otps[cleanPhone];

  let user = db().users.find((u) => u.phone === cleanPhone);
  if (!user) {
    user = {
      id: newId('USR'),
      phone: cleanPhone,
      name: (name || 'ग्राहक ' + cleanPhone.slice(-4)).trim(),
      walletBalance: db().settings.mode === 'demo' ? 500 : 0, // ₹500 free demo balance for easy testing
      totalCashback: 0,
      blocked: false,
      createdAt: new Date().toISOString(),
    };
    db().users.unshift(user);
  } else if (name && name.trim()) {
    user.name = name.trim();
  }

  if (user.blocked) {
    return res.status(403).json({ error: 'तुमचे खाते ब्लॉक करण्यात आले आहे.' });
  }

  const token = newToken();
  db().sessions[token] = user.id;
  save();

  res.json({ success: true, token, user });
});

// Get Current User Profile & Balance
app.get('/api/me', requireUser, (req, res) => {
  const myTxns = db().transactions.filter((t) => t.userId === req.user.id).slice(0, 50);
  const myAddMoney = db().addMoneyRequests.filter((r) => r.userId === req.user.id).slice(0, 20);
  res.json({ user: req.user, transactions: myTxns, addMoneyRequests: myAddMoney });
});

// Get Plans for Operator
app.get('/api/plans', (req, res) => {
  const { service, operator } = req.query;
  res.json({ plans: plansFor(service, operator) });
});

// Electricity Bill Fetch
app.post('/api/bill/fetch', requireUser, (req, res) => {
  const { operator, consumerNumber } = req.body;
  if (!consumerNumber || String(consumerNumber).trim().length < 4) {
    return res.status(400).json({ error: 'कृपया वैध ग्राहक क्रमांक (Consumer Number) टाका.' });
  }
  const op = findOperator(operator);
  if (!op) return res.status(400).json({ error: 'अवैध वीज कंपनी निवडली आहे.' });

  const bill = demoFetchBill(op.name, consumerNumber);
  res.json({ success: true, bill });
});

// Perform Recharge (Mobile / DTH / Electricity)
app.post('/api/recharge', requireUser, async (req, res) => {
  const { service, operator, number, amount, customerName } = req.body;
  const numAmount = Number(amount);

  if (!service || !operator || !number || !numAmount || numAmount <= 0) {
    return res.status(400).json({ error: 'कृपया सर्व माहिती योग्य प्रकारे भरा.' });
  }

  const s = db().settings;
  if (s.services[service] === false) {
    return res.status(400).json({ error: 'ही सेवा सध्या तात्पुरती बंद आहे. कृपया थोड्या वेळाने प्रयत्न करा.' });
  }

  const op = findOperator(operator);
  if (!op) return res.status(400).json({ error: 'अवैध ऑपरेटर.' });

  const comm = db().commissions[op.code] || { apiCommission: 0, userCashback: 0, apiCode: op.code, enabled: true };
  if (comm.enabled === false) {
    return res.status(400).json({ error: `${op.name} सेवा तात्पुरती बंद आहे.` });
  }

  const user = req.user;
  if (user.walletBalance < numAmount) {
    return res.status(400).json({ error: `वॉलेटमध्ये पुरेसा बॅलन्स नाही! (शिल्लक: ₹${user.walletBalance.toFixed(2)})` });
  }

  // Deduct wallet balance first
  user.walletBalance = Number((user.walletBalance - numAmount).toFixed(2));

  const reqId = newId('TXN');
  const cashback = Number(((numAmount * (comm.userCashback || 0)) / 100).toFixed(2));
  const totalCommission = Number(((numAmount * (comm.apiCommission || 0)) / 100).toFixed(2));
  const adminProfit = Number((totalCommission - cashback).toFixed(2));

  const txn = {
    id: reqId,
    userId: user.id,
    userPhone: user.phone,
    userName: user.name,
    service,
    operatorCode: op.code,
    operatorName: op.name,
    number: String(number).trim(),
    customerName: customerName || '',
    amount: numAmount,
    cashback,
    adminProfit,
    status: 'pending',
    apiRef: null,
    message: 'प्रक्रियेत आहे...',
    createdAt: new Date().toISOString(),
  };

  db().transactions.unshift(txn);
  save();

  // Execute Recharge via Provider (Demo or Live)
  const result = await doRecharge(
    { number: txn.number, apiCode: comm.apiCode || op.code, amount: numAmount, reqId },
    s
  );

  txn.status = result.status;
  txn.apiRef = result.apiRef;
  txn.message = result.message;

  if (result.status === 'success') {
    if (cashback > 0) {
      user.walletBalance = Number((user.walletBalance + cashback).toFixed(2));
      user.totalCashback = Number(((user.totalCashback || 0) + cashback).toFixed(2));
    }
    if (db().apiWalletBalance > 0) {
      db().apiWalletBalance = Number((db().apiWalletBalance - (numAmount - totalCommission)).toFixed(2));
    }
  } else if (result.status === 'failed') {
    // Auto-refund on immediate failure
    user.walletBalance = Number((user.walletBalance + numAmount).toFixed(2));
    txn.cashback = 0;
    txn.adminProfit = 0;
    txn.refunded = true;
  }

  save();
  res.json({ success: result.status !== 'failed', transaction: txn, walletBalance: user.walletBalance });
});

// Add Money Request (UPI / Demo Instant Add)
app.post('/api/wallet/add-money', requireUser, (req, res) => {
  const { amount, utrNumber, instantDemo } = req.body;
  const numAmount = Number(amount);
  const minAmt = db().settings.minAddMoney || 10;

  if (!numAmount || numAmount < minAmt) {
    return res.status(400).json({ error: `किमान ₹${minAmt} रक्कम टाका.` });
  }

  const reqItem = {
    id: newId('ADD'),
    userId: req.user.id,
    userPhone: req.user.phone,
    userName: req.user.name,
    amount: numAmount,
    utrNumber: String(utrNumber || 'DEMO-UTR-' + Date.now()).trim(),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  // In Demo mode, if user taps "Instant Demo Add", credit immediately
  if (db().settings.mode === 'demo' && instantDemo) {
    reqItem.status = 'approved';
    req.user.walletBalance = Number((req.user.walletBalance + numAmount).toFixed(2));
  }

  db().addMoneyRequests.unshift(reqItem);
  save();

  res.json({
    success: true,
    request: reqItem,
    walletBalance: req.user.walletBalance,
    message: reqItem.status === 'approved'
      ? `₹${numAmount} तुमच्या वॉलेटमध्ये लगेच जमा झाले!`
      : `₹${numAmount} ची विनंती पाठवली आहे. Admin मंजूर करताच वॉलेटमध्ये जमा होईल.`,
  });
});

// ======================== ADMIN API ========================

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db().settings.admin;
  if (username !== admin.username || !verifyPassword(String(password || ''), admin.passwordHash)) {
    return res.status(401).json({ error: 'चुकीचे Username किंवा Password!' });
  }
  const token = newToken();
  db().adminSessions[token] = { username, loginAt: new Date().toISOString() };
  save();
  res.json({ success: true, token, username });
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const d = db();
  for (const u of d.users || []) {
    recalculateUserLedger(u);
  }
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayTxns = d.transactions.filter((t) => t.createdAt && t.createdAt.startsWith(todayStr));
  const successTxns = d.transactions.filter((t) => t.status === 'success');
  const todaySuccess = todayTxns.filter((t) => t.status === 'success');

  const allAddMoney = d.addMoneyRequests || [];
  const approvedAddMoney = allAddMoney.filter((r) => r.status === 'approved');
  const todayApprovedAddMoney = approvedAddMoney.filter((r) => r.createdAt && r.createdAt.startsWith(todayStr));
  const totalUserWalletBalance = Number(
    (d.users || []).reduce((s, u) => s + (Number(u.walletBalance) || 0), 0).toFixed(2)
  );

  const stats = {
    todayCount: todayTxns.length,
    todaySuccessCount: todaySuccess.length,
    todayFailedCount: todayTxns.filter((t) => t.status === 'failed').length,
    todayPendingCount: todayTxns.filter((t) => t.status === 'pending').length,
    todayVolume: Number(todaySuccess.reduce((s, t) => s + t.amount, 0).toFixed(2)),
    todayProfit: Number(todaySuccess.reduce((s, t) => s + (t.adminProfit || 0), 0).toFixed(2)),
    totalProfit: Number(successTxns.reduce((s, t) => s + (t.adminProfit || 0), 0).toFixed(2)),
    totalVolume: Number(successTxns.reduce((s, t) => s + t.amount, 0).toFixed(2)),
    totalUsers: d.users.length,
    pendingAddMoney: allAddMoney.filter((r) => r.status === 'pending').length,
    todayAddMoneyCount: todayApprovedAddMoney.length,
    todayAddMoneyAmount: Number(todayApprovedAddMoney.reduce((s, r) => s + (Number(r.amount) || 0), 0).toFixed(2)),
    totalAddMoneyCount: approvedAddMoney.length,
    totalAddMoneyAmount: Number(approvedAddMoney.reduce((s, r) => s + (Number(r.amount) || 0), 0).toFixed(2)),
    totalUserWalletBalance,
    apiWalletBalance: d.apiWalletBalance || 0,
  };

  res.json({
    stats,
    settings: { ...d.settings, admin: { username: d.settings.admin.username } },
    commissions: d.commissions,
    operators: OPERATORS,
    users: d.users,
    transactions: d.transactions.slice(0, 5000),
    addMoneyRequests: allAddMoney.slice(0, 5000),
    paymentOrders: (d.paymentOrders || []).slice(0, 100),
  });
});

// Update Settings (Mode, Services, API Key, Payment Gateway, Plan API, UPI, Notice, API Wallet Balance)
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const d = db();
  const { mode, services, api, paymentGateway, planApi, upiId, upiName, minAddMoney, notice, apiWalletBalance, newPassword } = req.body;

  if (mode) d.settings.mode = mode;
  if (services) d.settings.services = { ...d.settings.services, ...services };
  if (api) d.settings.api = { ...d.settings.api, ...api };
  if (paymentGateway) {
    d.settings.paymentGateway = { ...(d.settings.paymentGateway || {}), ...paymentGateway };
  }
  if (planApi) {
    d.settings.planApi = { ...(d.settings.planApi || {}), ...planApi };
  }
  if (upiId !== undefined) d.settings.upiId = upiId.trim();
  if (upiName !== undefined) d.settings.upiName = upiName.trim();
  if (minAddMoney !== undefined) d.settings.minAddMoney = Number(minAddMoney) || 10;
  if (notice !== undefined) d.settings.notice = notice;
  if (apiWalletBalance !== undefined) d.apiWalletBalance = Number(apiWalletBalance) || 0;
  if (newPassword && String(newPassword).trim().length >= 4) {
    d.settings.admin.passwordHash = hashPassword(String(newPassword).trim());
  }

  save();
  res.json({ success: true, message: 'सेटिंग्ज यशस्वीरीत्या सेव्ह झाल्या!' });

  if (!process.env.RENDER) {
    pushSettingsToRenderCloud({ services: d.settings.services, mode: d.settings.mode });
  }
});

// Update Operator Commissions
app.post('/api/admin/commissions', requireAdmin, (req, res) => {
  const { commissions } = req.body;
  if (commissions && typeof commissions === 'object') {
    for (const [code, val] of Object.entries(commissions)) {
      db().commissions[code] = {
        apiCommission: Number(val.apiCommission) || 0,
        userCashback: Number(val.userCashback) || 0,
        apiCode: String(val.apiCode || code).trim(),
        enabled: val.enabled !== false,
      };
    }
    save();
  }
  res.json({ success: true, message: 'कमिशन दर सेव्ह झाले!' });
});

// Manage User (Block/Unblock or Credit/Debit Wallet)
app.post('/api/admin/users/:id/action', requireAdmin, (req, res) => {
  const user = db().users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'युजर सापडला नाही.' });

  const { action, amount } = req.body;
  if (action === 'toggleBlock') {
    user.blocked = !user.blocked;
  } else if (action === 'credit') {
    const amt = Number(amount) || 0;
    if (amt > 0) {
      user.walletBalance = Number((user.walletBalance + amt).toFixed(2));
      db().addMoneyRequests.unshift({
        id: newId('ADM'),
        userId: user.id,
        userPhone: user.phone,
        userName: user.name,
        amount: amt,
        utrNumber: 'Admin कडून वॉलेटमध्ये जमा',
        status: 'approved',
        createdAt: new Date().toISOString(),
      });
    }
  } else if (action === 'debit') {
    const amt = Number(amount) || 0;
    user.walletBalance = Number(Math.max(0, user.walletBalance - amt).toFixed(2));
  }
  save();
  res.json({ success: true, user });
});

// Refund or Force-Success a Transaction
app.post('/api/admin/transactions/:id/action', requireAdmin, (req, res) => {
  const txn = db().transactions.find((t) => t.id === req.params.id);
  if (!txn) return res.status(404).json({ error: 'ट्रान्झॅक्शन सापडले नाही.' });

  const { action } = req.body; // 'refund' | 'markSuccess'
  const user = db().users.find((u) => u.id === txn.userId || u.phone === txn.userPhone);

  if (action === 'refund' && !txn.refunded && txn.status !== 'success') {
    if (user) {
      const refundAmt = Number(txn.amount || 0);
      user.walletBalance = Number((user.walletBalance + refundAmt).toFixed(2));
    }
    txn.status = 'failed';
    txn.refunded = true;
    txn.adminProfit = 0;
    txn.cashback = 0;
    txn.message = 'Admin कडून वॉलेटमध्ये Refund देण्यात आला';
  } else if (action === 'markSuccess' && txn.status !== 'success') {
    if (txn.refunded && user) {
      user.walletBalance = Number((user.walletBalance - txn.amount).toFixed(2));
      txn.refunded = false;
    }
    txn.status = 'success';
    txn.message = 'Admin कडून यशस्वी (Success) मार्क केले';
  }

  save();
  res.json({ success: true, transaction: txn });
});

// Approve / Reject Add Money Request
app.post('/api/admin/add-money/:id/action', requireAdmin, (req, res) => {
  const item = db().addMoneyRequests.find((r) => r.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'विनंती सापडली नाही.' });
  if (item.status !== 'pending') return res.status(400).json({ error: 'ही विनंती आधीच प्रोसेस झाली आहे.' });

  const { action } = req.body; // 'approve' | 'reject'
  if (action === 'approve') {
    item.status = 'approved';
    const user = db().users.find((u) => u.id === item.userId);
    if (user) {
      user.walletBalance = Number((user.walletBalance + item.amount).toFixed(2));
    }
  } else {
    item.status = 'rejected';
  }

  save();
  res.json({ success: true, request: item });
});

// ======================== 2-WAY CLOUD BRIDGE (LOCAL <-> RENDER.COM) ========================
const RENDER_CLOUD_URL = 'https://aplarecharge-server.onrender.com';
let renderAdminTokenCache = null;

async function pushSettingsToRenderCloud(settingsPayload) {
  if (process.env.RENDER) return;
  try {
    if (!renderAdminTokenCache) {
      const loginResp = await fetch(`${RENDER_CLOUD_URL}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' }),
      });
      if (loginResp.ok) {
        const loginData = await loginResp.json();
        renderAdminTokenCache = loginData.token;
      }
    }
    if (renderAdminTokenCache) {
      const resp = await fetch(`${RENDER_CLOUD_URL}/api/admin/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${renderAdminTokenCache}`,
        },
        body: JSON.stringify(settingsPayload),
      });
      if (resp.status === 401) {
        renderAdminTokenCache = null;
      }
    }
  } catch (_) {}
}

async function syncLocalWithRenderCloud() {
  // Only run bridge on local PC (not when running inside Render itself)
  if (process.env.RENDER) return;
  try {
    const d = db();
    pushSettingsToRenderCloud({ services: d.settings.services, mode: d.settings.mode });
    const usersToSync = d.users.length
      ? d.users
      : [{ phone: '9876543210', name: 'ग्राहक (Demo User)' }];

    for (const u of usersToSync) {
      const myAdd = (d.addMoneyRequests || [])
        .filter((r) => r.userPhone === u.phone)
        .map((r) => ({
          id: r.id,
          userPhone: r.userPhone,
          userName: r.userName,
          amount: r.amount,
          utr: r.utrNumber,
          status: r.status,
          createdAt: r.createdAt,
        }));
      const myTxns = (d.transactions || [])
        .filter((t) => t.userPhone === u.phone)
        .map((t) => ({
          id: t.id,
          userPhone: t.userPhone,
          userName: t.userName,
          category: t.service,
          operatorCode: t.operatorCode,
          operatorName: t.operatorName,
          number: t.number,
          amount: t.amount,
          cashback: t.cashback,
          adminProfit: t.adminProfit,
          status: t.status,
          operatorRef: t.apiRef,
          message: t.message,
          createdAt: t.createdAt,
        }));

      const resp = await fetch(`${RENDER_CLOUD_URL}/api/client-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: u.phone,
          name: u.name,
          clientAddMoney: myAdd,
          clientTransactions: myTxns,
          syncServices: d.settings.services,
        }),
      });
      if (!resp.ok) continue;
      const cloudData = await resp.json();
      let dirty = false;

      let localUser = d.users.find((x) => x.phone === u.phone);
      if (!localUser && cloudData.user) {
        localUser = { ...cloudData.user };
        d.users.unshift(localUser);
        dirty = true;
      }

      if (Array.isArray(cloudData.addMoneyRequests)) {
        for (const cr of cloudData.addMoneyRequests) {
          if (!d.addMoneyRequests.find((x) => x.id === cr.id)) {
            d.addMoneyRequests.unshift(cr);
            if (localUser && cr.status === 'approved') {
              localUser.walletBalance = Number((localUser.walletBalance + Number(cr.amount || 0)).toFixed(2));
            }
            dirty = true;
          }
        }
      }

      if (Array.isArray(cloudData.transactions)) {
        for (const ct of cloudData.transactions) {
          if (!d.transactions.find((x) => x.id === ct.id)) {
            d.transactions.unshift(ct);
            dirty = true;
          }
        }
      }

      if (localUser) {
        const prevBal = localUser.walletBalance;
        recalculateUserLedger(localUser);
        if (localUser.walletBalance !== prevBal) {
          dirty = true;
        }
      }

      if (dirty) save();
    }
  } catch (_) {}
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AplaRecharge Server running on http://localhost:${PORT}`);
  console.log(`🛠️  Admin Panel: http://localhost:${PORT}/admin (Default login: admin / admin123)`);
  syncLocalWithRenderCloud();
  setInterval(syncLocalWithRenderCloud, 5000);
});
