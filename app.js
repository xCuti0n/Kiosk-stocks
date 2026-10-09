'use strict';
// ---------- Database (tables: users, items, sales) ----------
// Cloud mode: one Firestore document shared by all devices (needs firebase-config.js).
// Local mode: browser localStorage only (used when no Firebase config is set).
const KEY = 'tindahan_db_v1';
const DEFAULT_DB = {
  users: [
    { id: 1, role: 'owner', pin: '1234' },
    { id: 2, role: 'keeper', pin: '0000' }
  ],
  items: [],   // {id, name, price, stock, reorder}
  sales: [],   // {id, itemId, qty, price, ts, userId}  (last 30 days kept)
  restocks: [], // {id, itemId, qty, vendor, cost, ts, userId}  (last 365 days kept)
  seq: 1
};
const KEEP_MS = 30 * 864e5, KEEP_RESTOCK_MS = 365 * 864e5;
const CLOUD = !!(window.FIREBASE_CONFIG && window.firebase);
let db = CLOUD ? structuredClone(DEFAULT_DB)
               : (JSON.parse(localStorage.getItem(KEY) || 'null') || structuredClone(DEFAULT_DB));
db.restocks ||= [];
let ready = !CLOUD, ref = null;
const nid = d => d.seq++;

if (CLOUD) {
  firebase.initializeApp(window.FIREBASE_CONFIG);
  const fs = firebase.firestore();
  ref = fs.doc('stores/main');
  ref.onSnapshot(snap => {
    if (!snap.exists) { ref.set(DEFAULT_DB); return; }
    db = snap.data(); db.restocks ||= []; ready = true;
    const a = document.activeElement;
    if (me && !(a && a.tagName === 'INPUT' && a.value)) render();   // don't wipe half-typed input
  }, err => toast('Cloud error: ' + err.message));
}

// Apply a change to the latest data. fn(d) mutates d and may throw Error(msg) to cancel.
async function mutate(fn) {
  try {
    if (CLOUD) {
      await firebase.firestore().runTransaction(async tx => {
        const snap = await tx.get(ref);
        const d = snap.exists ? snap.data() : structuredClone(DEFAULT_DB);
        d.restocks ||= [];
        fn(d);
        d.sales = d.sales.filter(s => s.ts >= Date.now() - KEEP_MS);
        d.restocks = d.restocks.filter(r => r.ts >= Date.now() - KEEP_RESTOCK_MS);
        tx.set(ref, d);
      });
    } else {
      fn(db); localStorage.setItem(KEY, JSON.stringify(db));
    }
    return true;
  } catch (e) { toast(e.message || 'Could not save'); return false; }
}

// ---------- Business logic ----------
const WINDOW_DAYS = 14;
function stats() {
  const since = Date.now() - WINDOW_DAYS * 864e5;
  const sold = Object.fromEntries(db.items.map(i => [i.id, 0]));
  db.sales.filter(s => s.ts >= since).forEach(s => { if (s.itemId in sold) sold[s.itemId] += s.qty; });
  const ranked = Object.values(sold).filter(v => v > 0).sort((a, b) => b - a);
  const cutoff = ranked.length ? ranked[Math.max(0, Math.ceil(ranked.length / 3) - 1)] : Infinity;
  const out = {};
  db.items.forEach(i => {
    const u = sold[i.id];
    out[i.id] = {
      units: u,
      speed: u === 0 ? 'slow' : (u >= cutoff && ranked.length >= 3) || (ranked.length < 3 && u === ranked[0]) ? 'fast' : 'normal',
      daysLeft: u ? Math.floor(i.stock / (u / WINDOW_DAYS)) : null
    };
  });
  return out;
}
const isLow = i => i.stock <= i.reorder;

async function sell(itemId, qty) {
  if (!(qty >= 1)) return toast('Invalid quantity');
  let name;
  const ok = await mutate(d => {
    const it = d.items.find(i => i.id === itemId);
    if (!it) throw new Error('Item no longer exists');
    if (qty > it.stock) throw new Error(`Only ${it.stock} left`);
    it.stock -= qty;                       // real-time stock update
    name = it.name;
    d.sales.push({ id: nid(d), itemId, qty, price: it.price, ts: Date.now(), userId: me.id });
  });
  if (ok) { toast(`Sold ${qty} × ${name}`); render(); }
}

// ---------- UI ----------
let me = null, tab = 'sell', pendingRole = null;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const peso = n => '₱' + Number(n).toFixed(2);
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; setTimeout(() => t.hidden = true, 1800); }

document.querySelectorAll('[data-role]').forEach(b => b.onclick = () => {
  pendingRole = b.dataset.role; $('#pinForm').hidden = false; $('#pin').value = ''; $('#pin').focus();
  $('#pinHint').textContent = 'Default PIN — owner 1234, shop keeper 0000 (owner can change them in Stock tab).';
});
$('#pinForm').onsubmit = e => {
  e.preventDefault();
  if (!ready) return toast('Connecting to cloud… try again');
  const u = db.users.find(u => u.role === pendingRole && u.pin === $('#pin').value);
  if (!u) return toast('Wrong PIN');
  me = u; $('#login').hidden = true; $('#app').hidden = false;
  $('#who').textContent = u.role === 'owner' ? 'Owner' : 'Shop keeper'; render();
};
$('#logout').onclick = () => { me = null; $('#app').hidden = true; $('#login').hidden = false; $('#pinForm').hidden = true; };
document.querySelectorAll('nav [data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });

function render() {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const low = db.items.filter(isLow);
  $('#alerts').innerHTML = low.map(i => `<div class="warn">⚠️ <b>${esc(i.name)}</b> is low: ${i.stock} left (restock at ${i.reorder})</div>`).join('');
  $('#view').innerHTML = { sell: viewSell, inventory: viewInventory, report: viewReport }[tab]();
}

function viewSell() {
  if (!db.items.length) return '<p>No items yet. Ask the owner to add items in the Stock tab.</p>';
  return `<input placeholder="Search item…" oninput="filterSell(this.value)">` +
    db.items.map(i => `<div class="card sellrow" data-n="${esc(i.name.toLowerCase())}">
      <div class="row"><div><b>${esc(i.name)}</b><br><small>${peso(i.price)} · stock ${i.stock}</small></div>
      <div class="qty"><input id="q${i.id}" type="number" min="1" value="1" inputmode="numeric">
      <button onclick="sell(${i.id}, +document.getElementById('q${i.id}').value)" ${i.stock ? '' : 'disabled'}>Sell</button></div></div></div>`).join('');
}
window.filterSell = v => document.querySelectorAll('.sellrow').forEach(r => r.hidden = !r.dataset.n.includes(v.toLowerCase()));

function viewInventory() {
  const st = stats(), owner = me.role === 'owner';
  const add = owner ? `<form class="card" onsubmit="addItem(event)"><b>Add item</b>
    <input name="name" placeholder="Name" required>
    <input name="price" type="number" step="0.01" min="0" placeholder="Price" required>
    <input name="stock" type="number" min="0" placeholder="Starting stock" required>
    <input name="reorder" type="number" min="0" placeholder="Alert when stock is at or below" required>
    <button>Add</button></form>` : '';
  const list = db.items.map(i => {
    const s = st[i.id];
    return `<div class="card"><div class="row"><b>${esc(i.name)}</b>
      <span>${isLow(i) ? '<span class="tag low">LOW</span> ' : ''}<span class="tag ${s.speed}">${s.speed}</span></span></div>
      <small>${peso(i.price)} · stock <b>${i.stock}</b> · sold ${s.units} in ${WINDOW_DAYS}d${s.daysLeft !== null ? ` · ~${s.daysLeft}d left` : ''}</small>
      ${owner ? `<div class="row" style="margin-top:8px"><span></span>
        <button class="small danger" onclick="removeItem(${i.id})">Remove</button></div>` : ''}</div>`;
  }).join('') || '<p>No items yet.</p>';
  const pins = owner ? `<form class="card" onsubmit="setPins(event)"><b>Change PINs</b>
    <input name="o" type="password" inputmode="numeric" placeholder="New owner PIN (blank = keep)">
    <input name="k" type="password" inputmode="numeric" placeholder="New shop keeper PIN (blank = keep)">
    <button class="small">Save PINs</button></form>` : '<small>View only — the owner manages stock.</small>';
  const vendors = [...new Set(db.restocks.map(x => x.vendor).filter(Boolean))];
  const none = !db.items.length;
  const res = owner ? `<form class="card" onsubmit="resupply(event)"><b>Record resupply (vendor delivery)</b>
    ${none ? '<br><small>Add an item above first, then you can record deliveries here.</small>' : ''}
    <select name="item" ${none ? 'disabled' : ''}>${db.items.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('') || '<option>No items yet</option>'}</select>
    <input name="qty" type="number" min="1" placeholder="Quantity received" inputmode="numeric" required ${none ? 'disabled' : ''}>
    <input name="vendor" list="vendors" placeholder="Vendor / supplier" ${none ? 'disabled' : ''}>
    <datalist id="vendors">${vendors.map(v => `<option value="${esc(v)}">`).join('')}</datalist>
    <input name="cost" type="number" step="0.01" min="0" placeholder="Unit cost (optional)" ${none ? 'disabled' : ''}>
    <input name="date" type="date" value="${new Date().toLocaleDateString('en-CA')}" max="${new Date().toLocaleDateString('en-CA')}" ${none ? 'disabled' : ''}>
    <button ${none ? 'disabled' : ''}>Save resupply</button></form>` : '';
  return add + res + list + pins;
}
window.addItem = async e => {
  e.preventDefault(); const f = new FormData(e.target);
  const it = { name: f.get('name').trim(), price: +f.get('price'), stock: +f.get('stock'), reorder: +f.get('reorder') };
  if (await mutate(d => d.items.push({ id: nid(d), ...it }))) { toast('Item added'); render(); }
};
window.resupply = async e => {
  e.preventDefault(); const form = e.target, f = new FormData(form);
  const itemId = +f.get('item'), qty = +f.get('qty'), vendor = f.get('vendor').trim(), cost = +f.get('cost') || 0;
  if (!(qty > 0)) return toast('Enter a quantity');
  const day = f.get('date'), todayStr = new Date().toLocaleDateString('en-CA');
  const ts = !day || day === todayStr ? Date.now() : new Date(day + 'T12:00').getTime();
  if (ts > Date.now()) return toast('Date cannot be in the future');
  if (await mutate(d => {
    const i = d.items.find(i => i.id === itemId); if (!i) throw new Error('Pick an item');
    i.stock += qty;
    d.restocks.push({ id: nid(d), itemId, qty, vendor, cost, ts, userId: me.id });
  })) { toast('Resupply recorded'); render(); }
};
window.removeItem = async id => {
  if (!confirm('Remove this item? Past sales records are kept.')) return;
  if (await mutate(d => { d.items = d.items.filter(i => i.id !== id); })) render();
};
window.setPins = async e => {
  e.preventDefault(); const f = new FormData(e.target), o = f.get('o'), k = f.get('k');
  if (await mutate(d => {
    if (o) d.users.find(u => u.role === 'owner').pin = o;
    if (k) d.users.find(u => u.role === 'keeper').pin = k;
  })) { toast('PINs saved'); render(); }
};

let rsDays = 30;
window.setRsDays = v => { rsDays = +v; render(); };
function resupplyReport() {
  const nameOf = id => (db.items.find(i => i.id === id) || { name: '(removed item)' }).name;
  const since = Date.now() - rsDays * 864e5;
  const r = db.restocks.filter(x => x.ts >= since);
  const units = r.reduce((a, x) => a + x.qty, 0);
  const cost = r.reduce((a, x) => a + x.qty * (x.cost || 0), 0);
  const group = keyFn => {
    const m = {}; r.forEach(x => { const k = keyFn(x); m[k] = m[k] || { n: 0, q: 0 }; m[k].n++; m[k].q += x.qty; });
    return Object.entries(m).sort((a, b) => b[1].q - a[1].q);
  };
  const rows = g => g.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><small>${v.q} units · ${v.n} deliveries</small></div>`).join('') || '<small>None</small>';
  return `<div class="card"><div class="row"><b>Resupply</b>
      <select onchange="setRsDays(this.value)" style="width:auto">${[7, 30, 90, 365].map(d => `<option value="${d}" ${d === rsDays ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select></div>
      ${r.length} deliveries · <b>${units}</b> units${cost ? ` · ${peso(cost)} spent` : ''}</div>
    <div class="card"><b>By vendor</b><br>${rows(group(x => x.vendor || '(no vendor)'))}</div>
    <div class="card"><b>By item</b><br>${rows(group(x => nameOf(x.itemId)))}</div>
    <div class="card"><b>Delivery log</b>${r.slice().sort((a, b) => b.ts - a.ts).slice(0, 30).map(x =>
      `<div class="row"><span>${esc(nameOf(x.itemId))} × ${x.qty}<br><small>${esc(x.vendor || '(no vendor)')}${x.cost ? ' · ' + peso(x.cost) + ' each' : ''}</small></span><small>${new Date(x.ts).toLocaleDateString()}</small></div>`).join('') || '<br><small>No deliveries recorded in this period</small>'}</div>`;
}

function viewReport() {
  const st = stats(), today = new Date().setHours(0, 0, 0, 0);
  const t = db.sales.filter(s => s.ts >= today);
  const total = t.reduce((a, s) => a + s.qty * s.price, 0);
  const rank = db.items.slice().sort((a, b) => st[b.id].units - st[a.id].units);
  const name = id => (db.items.find(i => i.id === id) || { name: '(removed item)' }).name;
  return `<div class="card"><b>Today</b><br>${t.length} sales · ${peso(total)}</div>
    <div class="card"><b>Fast &amp; slow movers (last ${WINDOW_DAYS} days)</b>${rank.map(i =>
      `<div class="row"><span>${esc(i.name)}</span><span><small>${st[i.id].units} sold</small> <span class="tag ${st[i.id].speed}">${st[i.id].speed}</span></span></div>`).join('') || '<br><small>No data yet</small>'}</div>
    ${resupplyReport()}
    <div class="card"><b>Recent sales</b>${db.sales.slice(-15).reverse().map(s =>
      `<div class="row"><span>${esc(name(s.itemId))} × ${s.qty}</span><small>${new Date(s.ts).toLocaleString()}</small></div>`).join('') || '<br><small>None yet</small>'}</div>`;
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
