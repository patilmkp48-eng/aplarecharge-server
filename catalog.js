// Operators and demo plans.
// NOTE: Plans below are SAMPLE data for demo mode only. Real plans/prices change often;
// in live mode use your API company's "browse plans" API instead.

export const OPERATORS = {
  mobile: [
    { code: 'JIO', name: 'Jio', color: '#0A3D91' },
    { code: 'AIRTEL', name: 'Airtel', color: '#E40000' },
    { code: 'VI', name: 'Vi (Vodafone Idea)', color: '#ED1C24' },
    { code: 'BSNL', name: 'BSNL', color: '#1E88E5' },
  ],
  dth: [
    { code: 'TATAPLAY', name: 'Tata Play', color: '#8E24AA' },
    { code: 'AIRTELDTH', name: 'Airtel Digital TV', color: '#E40000' },
    { code: 'DISHTV', name: 'Dish TV', color: '#F57C00' },
    { code: 'D2H', name: 'Videocon d2h', color: '#C62828' },
    { code: 'SUNDIRECT', name: 'Sun Direct', color: '#FBC02D' },
  ],
  electricity: [
    { code: 'MSEDCL', name: 'महावितरण (MSEDCL)', color: '#1565C0' },
    { code: 'ADANIMUM', name: 'Adani Electricity Mumbai', color: '#00897B' },
    { code: 'TATAPOWERMUM', name: 'Tata Power Mumbai', color: '#283593' },
    { code: 'BEST', name: 'BEST Mumbai', color: '#B71C1C' },
    { code: 'TORRENTPOWER', name: 'Torrent Power', color: '#EF6C00' },
  ],
};

const MOBILE_PLANS = [
  { amount: 199, validity: '28 दिवस', data: '1.5 GB/दिवस', desc: 'Unlimited कॉल + 100 SMS/दिवस', category: 'Unlimited' },
  { amount: 299, validity: '28 दिवस', data: '2 GB/दिवस', desc: 'Unlimited कॉल + 100 SMS/दिवस', category: 'Unlimited' },
  { amount: 479, validity: '56 दिवस', data: '1.5 GB/दिवस', desc: 'Unlimited कॉल + 100 SMS/दिवस', category: 'Unlimited' },
  { amount: 719, validity: '84 दिवस', data: '2 GB/दिवस', desc: 'Unlimited कॉल + 100 SMS/दिवस', category: 'Unlimited' },
  { amount: 19, validity: 'सध्याचा प्लॅन', data: '1 GB', desc: 'डेटा पॅक', category: 'Data' },
  { amount: 58, validity: 'सध्याचा प्लॅन', data: '2 GB/दिवस अतिरिक्त', desc: 'डेटा बूस्टर', category: 'Data' },
  { amount: 10, validity: 'Unlimited', data: '-', desc: '₹7.47 टॉकटाइम', category: 'Talktime' },
  { amount: 100, validity: 'Unlimited', data: '-', desc: '₹81.75 टॉकटाइम', category: 'Talktime' },
];

const DTH_PLANS = [
  { amount: 153, validity: '30 दिवस', desc: 'Basic Pack (NCF)' },
  { amount: 250, validity: '30 दिवस', desc: 'Hindi Value Pack' },
  { amount: 350, validity: '30 दिवस', desc: 'Marathi Family Pack' },
  { amount: 499, validity: '30 दिवस', desc: 'HD Mega Pack' },
];

export function plansFor(service, operatorCode) {
  if (service === 'mobile') {
    // Small per-operator variation so the demo doesn't look identical for every operator
    const bump = { JIO: 0, AIRTEL: 0, VI: 0, BSNL: -20 }[operatorCode] ?? 0;
    return MOBILE_PLANS.map((p) => ({ ...p, amount: Math.max(10, p.amount + (p.category === 'Unlimited' ? bump : 0)) }));
  }
  if (service === 'dth') return DTH_PLANS;
  return [];
}

export function findOperator(code) {
  for (const [service, list] of Object.entries(OPERATORS)) {
    const op = list.find((o) => o.code === code);
    if (op) return { ...op, service };
  }
  return null;
}
