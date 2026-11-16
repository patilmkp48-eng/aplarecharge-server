// Simple JSON-file database. Good enough for a single-server small business setup.
// All data lives in data/db.json. Writes are atomic (write temp file, then rename).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { OPERATORS } from './catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(DATA_DIR, 'seed_snapshot.json');

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function defaultCommissions() {
  // apiCommission  = % the recharge API company gives you
  // userCashback   = % you give back to your customer
  // apiCode        = operator code expected by your API company (see their docs)
  const defaults = {
    mobile: [3.0, 1.0],
    postpaid: [1.2, 0.5],
    broadband: [1.5, 0.5],
    dth: [3.5, 1.5],
    electricity: [0.5, 0.2],
    fastag: [0.8, 0.3],
  };
  const out = {};
  for (const [service, list] of Object.entries(OPERATORS)) {
    for (const op of list) {
      const [api, user] = defaults[service] || [1.0, 0.5];
      out[op.code] = { apiCommission: api, userCashback: user, apiCode: op.code, enabled: true };
    }
  }
  return out;
}

function defaultData() {
  return {
    settings: {
      appName: 'AplaRecharge',
      admin: { username: 'admin', passwordHash: hashPassword('admin123'), mustChangePassword: true },
      mode: 'demo', // 'demo' or 'live'
      demoOtp: '123456',
      services: { mobile: true, postpaid: true, broadband: true, dth: true, electricity: true, fastag: true },
      api: {
        providerName: '',
        // URL template. Placeholders: {apikey} {number} {operator} {amount} {reqid}
        rechargeUrl: '',
        apiKey: '',
        successKeyword: 'success',
        pendingKeyword: 'pending',
      },
      upiId: 'aplarecharge@ybl',
      upiName: 'AplaRecharge',
      minAddMoney: 10,
      paymentGateway: {
        provider: 'Cashfree', // Cashfree, UPIGateway, IMB, Razorpay
        mode: 'live', // 'sandbox' or 'live'
        merchantKey: '',
        appId: '1526434e9286ec7f60012b5cfb64346251',
        createOrderUrl: 'https://api.cashfree.com/pg/links',
        checkStatusUrl: 'https://api.cashfree.com/pg/links',
      },
      planApi: {
        mode: 'smart', // 'smart' (in-built) or 'live' (real API)
        providerName: 'Mplan / KwikAPI / PlanAPI',
        apiKey: '',
        rOfferUrl: 'https://api.mplan.in/api/Plans.php?apikey={apikey}&offer=roffer&tel={number}&operator={operator}',
        regularPlansUrl: 'https://api.mplan.in/api/Plans.php?apikey={apikey}&cricle=Maharashtra&operator={operator}',
      },
      notice: 'AplaRecharge मध्ये आपले स्वागत आहे! प्रत्येक रिचार्जवर कॅशबॅक मिळवा.',
      banners: [],
    },
    commissions: defaultCommissions(),
    users: [],
    sessions: {},
    adminSessions: {},
    otps: {},
    transactions: [],
    addMoneyRequests: [],
    paymentOrders: [],
    apiWalletBalance: 0,
  };
}

let data;
let cloudSyncTimer = null;

export function isGenericUserName(name, phone = '') {
  const s = String(name || '').trim();
  if (!s) return true;
  if (s.includes('?')) return true;
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  if (cleanPhone && (s === cleanPhone || s === `ग्राहक ${cleanPhone}` || s === `ग्राहक ${cleanPhone.slice(-4)}`)) {
    return true;
  }
  if (/^ग्राहक(\s+\d+)?$/.test(s) || /^ग्राहक\s*\(Demo/i.test(s) || /^User\s*\d*$/i.test(s)) {
    return true;
  }
  return false;
}

export function unifyAccountsByPhone(target = data) {
  if (!target || typeof target !== 'object') return false;
  let changed = false;

  if (!Array.isArray(target.users)) target.users = [];
  if (!Array.isArray(target.transactions)) target.transactions = [];
  if (!Array.isArray(target.addMoneyRequests)) target.addMoneyRequests = [];
  if (!Array.isArray(target.paymentOrders)) target.paymentOrders = [];

  const byPhone = new Map();

  // 1. Deduplicate users strictly by 10-digit mobile number
  for (const rawU of target.users) {
    if (!rawU) continue;
    const cleanPhone = String(rawU.phone || '').replace(/\D/g, '');
    if (cleanPhone.length !== 10) continue;
    const canonicalId = `USR_${cleanPhone}`;

    if (!byPhone.has(cleanPhone)) {
      const copy = {
        ...rawU,
        id: canonicalId,
        phone: cleanPhone,
        name: String(rawU.name || `ग्राहक ${cleanPhone.slice(-4)}`).trim(),
        walletBalance: Number(rawU.walletBalance || 0),
        totalCashback: Number(rawU.totalCashback || 0),
        manualDebit: Number(rawU.manualDebit || 0),
        blocked: Boolean(rawU.blocked),
      };
      if (rawU.id !== canonicalId || rawU.phone !== cleanPhone) changed = true;
      byPhone.set(cleanPhone, copy);
    } else {
      // Merge duplicate user entry for the same mobile number into the single canonical account
      const primary = byPhone.get(cleanPhone);
      if (isGenericUserName(primary.name, cleanPhone) && !isGenericUserName(rawU.name, cleanPhone)) {
        primary.name = String(rawU.name).trim();
      }
      primary.manualDebit = Math.max(Number(primary.manualDebit || 0), Number(rawU.manualDebit || 0));
      if (!primary.avatar && rawU.avatar) primary.avatar = rawU.avatar;
      if (rawU.blocked) primary.blocked = true;
      if (rawU.createdAt && (!primary.createdAt || rawU.createdAt < primary.createdAt)) {
        primary.createdAt = rawU.createdAt;
      }
      changed = true;
    }
  }

  // 2. Ensure any phone present in transactions or addMoneyRequests also has its single canonical user account
  for (const item of [...target.addMoneyRequests, ...target.transactions]) {
    if (!item) continue;
    const cleanPhone = String(item.userPhone || '').replace(/\D/g, '');
    if (cleanPhone.length !== 10) continue;
    if (!byPhone.has(cleanPhone)) {
      byPhone.set(cleanPhone, {
        id: `USR_${cleanPhone}`,
        phone: cleanPhone,
        name: String(item.userName || `ग्राहक ${cleanPhone.slice(-4)}`).trim(),
        walletBalance: 0,
        totalCashback: 0,
        manualDebit: 0,
        avatar: '',
        blocked: false,
        createdAt: item.createdAt || new Date().toISOString(),
      });
      changed = true;
    } else {
      const u = byPhone.get(cleanPhone);
      if (isGenericUserName(u.name, cleanPhone) && !isGenericUserName(item.userName, cleanPhone)) {
        u.name = String(item.userName).trim();
        changed = true;
      }
    }
  }

  target.users = Array.from(byPhone.values());

  // 3. Propagate each phone's canonical userId and current userName to all transactions, addMoneyRequests & paymentOrders
  for (const r of target.addMoneyRequests) {
    const cleanPhone = String(r.userPhone || '').replace(/\D/g, '');
    const u = byPhone.get(cleanPhone);
    if (u) {
      if (r.userPhone !== cleanPhone) { r.userPhone = cleanPhone; changed = true; }
      if (r.userId !== u.id) { r.userId = u.id; changed = true; }
      if (r.userName !== u.name) { r.userName = u.name; changed = true; }
    }
  }

  for (const t of target.transactions) {
    const cleanPhone = String(t.userPhone || '').replace(/\D/g, '');
    const u = byPhone.get(cleanPhone);
    if (u) {
      if (t.userPhone !== cleanPhone) { t.userPhone = cleanPhone; changed = true; }
      if (t.userId !== u.id) { t.userId = u.id; changed = true; }
      if (t.userName !== u.name) { t.userName = u.name; changed = true; }
      if ((t.service === 'debit' || t.operatorCode === 'ADMIN_DEBIT') && t.customerName !== u.name) {
        t.customerName = u.name;
        changed = true;
      }
    }
  }

  for (const o of target.paymentOrders) {
    const cleanPhone = String(o.userPhone || '').replace(/\D/g, '');
    const u = byPhone.get(cleanPhone);
    if (u) {
      if (o.userPhone !== cleanPhone) { o.userPhone = cleanPhone; changed = true; }
      if (o.userId !== u.id) { o.userId = u.id; changed = true; }
      if (o.userName !== u.name) { o.userName = u.name; changed = true; }
    }
  }

  return changed;
}

function applyDefaults(target) {
  const fresh = defaultData();
  target.settings = { ...fresh.settings, ...(target.settings || {}) };
  target.settings.services = { ...fresh.settings.services, ...(target.settings.services || {}) };
  if (target.settings.services.postpaid === undefined) target.settings.services.postpaid = true;
  if (target.settings.services.broadband === undefined) target.settings.services.broadband = true;
  target.settings.api = { ...fresh.settings.api, ...(target.settings.api || {}) };
  target.settings.paymentGateway = { ...fresh.settings.paymentGateway, ...(target.settings.paymentGateway || {}) };
  target.settings.planApi = { ...fresh.settings.planApi, ...(target.settings.planApi || {}) };
  target.commissions = { ...fresh.commissions, ...(target.commissions || {}) };
  for (const key of Object.keys(fresh)) {
    if (target[key] === undefined) target[key] = fresh[key];
  }
  return target;
}

export function mergeDatabaseState(incoming) {
  if (!incoming || typeof incoming !== 'object') return false;
  if (!data) load();
  let changed = false;

  // Merge settings (non-destructive)
  if (incoming.settings && typeof incoming.settings === 'object') {
    const incS = incoming.settings;
    if (incS.mode) { data.settings.mode = incS.mode; changed = true; }
    if (incS.notice) { data.settings.notice = incS.notice; changed = true; }
    if (incS.upiId !== undefined && incS.upiId !== '') { data.settings.upiId = incS.upiId; changed = true; }
    if (incS.upiName) { data.settings.upiName = incS.upiName; changed = true; }
    if (incS.minAddMoney !== undefined) { data.settings.minAddMoney = Number(incS.minAddMoney) || 10; changed = true; }
    if (incS.services && typeof incS.services === 'object') {
      data.settings.services = { ...data.settings.services, ...incS.services };
      changed = true;
    }
    if (incS.api && typeof incS.api === 'object') {
      for (const [k, v] of Object.entries(incS.api)) {
        if (v !== undefined && v !== '' && v !== '••••••••') data.settings.api[k] = v;
      }
      changed = true;
    }
    if (incS.paymentGateway && typeof incS.paymentGateway === 'object') {
      for (const [k, v] of Object.entries(incS.paymentGateway)) {
        if (v !== undefined && v !== '' && v !== '••••••••') data.settings.paymentGateway[k] = v;
      }
      changed = true;
    }
    if (incS.planApi && typeof incS.planApi === 'object') {
      for (const [k, v] of Object.entries(incS.planApi)) {
        if (v !== undefined && v !== '' && v !== '••••••••') data.settings.planApi[k] = v;
      }
      changed = true;
    }
  }

  // Merge commissions
  if (incoming.commissions && typeof incoming.commissions === 'object') {
    for (const [code, comm] of Object.entries(incoming.commissions)) {
      if (comm && typeof comm === 'object') {
        data.commissions[code] = { ...(data.commissions[code] || {}), ...comm };
        changed = true;
      }
    }
  }

  // Merge users by phone (strictly 1 account per 10-digit mobile number)
  if (Array.isArray(incoming.users)) {
    if (!Array.isArray(data.users)) data.users = [];
    for (const u of incoming.users) {
      if (!u || !u.phone) continue;
      const cleanPhone = String(u.phone).replace(/\D/g, '');
      if (cleanPhone.length !== 10) continue;
      const canonicalId = `USR_${cleanPhone}`;
      const existing = data.users.find((x) => x.phone === cleanPhone);
      if (!existing) {
        data.users.push({
          id: canonicalId,
          phone: cleanPhone,
          name: String(u.name || ('ग्राहक ' + cleanPhone.slice(-4))).trim(),
          walletBalance: Number(u.walletBalance || 0),
          totalCashback: Number(u.totalCashback || 0),
          manualDebit: Number(u.manualDebit || 0),
          initialBalance: u.initialBalance !== undefined ? Number(u.initialBalance) : undefined,
          avatar: u.avatar || '',
          blocked: Boolean(u.blocked),
          createdAt: u.createdAt || new Date().toISOString(),
        });
        changed = true;
      } else {
        existing.id = canonicalId;
        if (u.name && !isGenericUserName(u.name, cleanPhone) && existing.name !== String(u.name).trim()) {
          existing.name = String(u.name).trim();
          changed = true;
        }
        if (u.manualDebit !== undefined && Number(u.manualDebit) > Number(existing.manualDebit || 0)) {
          existing.manualDebit = Number(u.manualDebit);
          changed = true;
        }
        if (u.initialBalance !== undefined && existing.initialBalance === undefined) {
          existing.initialBalance = Number(u.initialBalance);
          changed = true;
        }
        if (u.avatar && !existing.avatar) {
          existing.avatar = u.avatar;
          changed = true;
        }
      }
    }
  }

  // Merge addMoneyRequests by id
  if (Array.isArray(incoming.addMoneyRequests)) {
    if (!Array.isArray(data.addMoneyRequests)) data.addMoneyRequests = [];
    const existingIds = new Set(data.addMoneyRequests.map((r) => r.id));
    for (const r of incoming.addMoneyRequests) {
      if (!r || !r.id) continue;
      if (!existingIds.has(r.id)) {
        data.addMoneyRequests.push({ ...r });
        existingIds.add(r.id);
        changed = true;
      }
    }
    data.addMoneyRequests.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  // Merge transactions by id (including ADMIN_DEBIT)
  if (Array.isArray(incoming.transactions)) {
    if (!Array.isArray(data.transactions)) data.transactions = [];
    const existingIds = new Set(data.transactions.map((t) => t.id));
    for (const t of incoming.transactions) {
      if (!t || !t.id || t.id === 'TXN102938') continue;
      if (!existingIds.has(t.id)) {
        data.transactions.push({ ...t });
        existingIds.add(t.id);
        changed = true;
      }
    }
    data.transactions.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  // Merge paymentOrders by orderId
  if (Array.isArray(incoming.paymentOrders)) {
    if (!Array.isArray(data.paymentOrders)) data.paymentOrders = [];
    const existingIds = new Set(data.paymentOrders.map((o) => o.orderId));
    for (const o of incoming.paymentOrders) {
      if (!o || !o.orderId) continue;
      if (!existingIds.has(o.orderId)) {
        data.paymentOrders.push({ ...o });
        existingIds.add(o.orderId);
        changed = true;
      }
    }
    data.paymentOrders.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  if (incoming.apiWalletBalance !== undefined && Number(incoming.apiWalletBalance) > 0 && !data.apiWalletBalance) {
    data.apiWalletBalance = Number(incoming.apiWalletBalance);
    changed = true;
  }

  if (unifyAccountsByPhone(data)) {
    changed = true;
  }

  return changed;
}

async function pullFromCloudDbUrl() {
  const url = process.env.CLOUD_DB_URL || data?.settings?.cloudDbUrl;
  if (!url) return;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const remoteData = await res.json();
      if (remoteData && typeof remoteData === 'object') {
        if (mergeDatabaseState(remoteData)) {
          save(true);
        }
      }
    }
  } catch (_) {}
}

function pushToCloudDbUrl() {
  const url = process.env.CLOUD_DB_URL || data?.settings?.cloudDbUrl;
  if (!url || !data) return;
  if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(async () => {
    try {
      await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch (_) {}
  }, 500);
}

export function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    data = applyDefaults(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } else {
    data = defaultData();
  }
  unifyAccountsByPhone(data);
  // If db.json was freshly created or wiped on container restart, merge from seed_snapshot.json if available
  if (fs.existsSync(SEED_FILE)) {
    try {
      const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
      if (mergeDatabaseState(seed)) {
        save(true);
      }
    } catch (_) {}
  } else {
    save(true);
  }
  pullFromCloudDbUrl();
  return data;
}

export function save(skipCloudPush = false) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  unifyAccountsByPhone(data);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
  try {
    fs.writeFileSync(SEED_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
  if (!skipCloudPush) {
    pushToCloudDbUrl();
  }
}

export function db() {
  return data;
}

export function newId(prefix) {
  return `${prefix}${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
