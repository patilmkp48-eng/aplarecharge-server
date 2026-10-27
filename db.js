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
  const defaults = { mobile: [3.0, 1.0], dth: [3.5, 1.5], electricity: [0.5, 0.0] };
  const out = {};
  for (const [service, list] of Object.entries(OPERATORS)) {
    for (const op of list) {
      const [api, user] = defaults[service];
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
      services: { mobile: true, dth: true, electricity: true },
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
        provider: 'UPIGateway', // UPIGateway, IMB, Razorpay, Cashfree
        mode: 'sandbox', // 'sandbox' or 'live'
        merchantKey: '',
        createOrderUrl: 'https://api.ekqr.in/api/create_order',
        checkStatusUrl: 'https://api.ekqr.in/api/check_order_status',
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

export function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // Add any operators/settings introduced after the DB was first created
    const fresh = defaultData();
    data.settings = { ...fresh.settings, ...data.settings };
    data.settings.services = { ...fresh.settings.services, ...data.settings.services };
    data.settings.api = { ...fresh.settings.api, ...data.settings.api };
    data.settings.paymentGateway = { ...fresh.settings.paymentGateway, ...(data.settings.paymentGateway || {}) };
    data.settings.planApi = { ...fresh.settings.planApi, ...(data.settings.planApi || {}) };
    data.commissions = { ...fresh.commissions, ...data.commissions };
    for (const key of Object.keys(fresh)) if (data[key] === undefined) data[key] = fresh[key];
  } else {
    data = defaultData();
    save();
  }
  return data;
}

export function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
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
