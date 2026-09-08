'use strict';

/* ================= 平衡性配置 ================= */
const DIFFS = {
  easy:      { label: '休闲', chaseSpeed: 3.5 },
  normal:    { label: '标准', chaseSpeed: 4.2 },
  nightmare: { label: '梦魇', chaseSpeed: 4.7 },
};
const FEAR_RADIUS = 36;    // 恐惧半径（米），进入即触发追击
const ESCAPE_DIST = 60;    // 逃脱判定：拉开到此距离
const STALK_CLOSE = 3.0;   // 游荡期监管者拉近相对距离的速度（米/秒）
const CATCH_RADIUS = 2;    // 被追上的判定距离（米）
const HIT_STUN = 2.5;      // 击中后的僵直时间（秒）
const HEAR_RANGE = 160;    // 能听到心跳的最远距离
const RADAR_RANGE = 200;   // 雷达显示范围
const ESCAPE_HOLD = 3;     // 逃脱判定：拉开距离后需保持的秒数
const EARTH_R = 6371000;

/* ================= 工具 ================= */
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

function bearingTo(lat1, lng1, lat2, lng2) {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return Math.atan2(y, x); // 弧度，0 = 正北
}

function moveAlong(lat, lng, bearing, distM) {
  const d = distM / EARTH_R;
  const lat1 = toRad(lat), lng1 = toRad(lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lng: toDeg(lng2) };
}

function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function fmtPace(spd) {
  if (spd < 0.3) return `--'--"`;
  const t = Math.round(1000 / spd);
  return `${Math.floor(t / 60)}'${String(t % 60).padStart(2, '0')}"`;
}

/* ================= 音频（全部程序合成，无音频文件） ================= */
const Snd = {
  ctx: null, master: null, droneNodes: null,
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  thump(t, vol, f0) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.6, t + 0.22);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.3);
  },
  heartbeat(vol) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.thump(t, vol, 60);
    this.thump(t + 0.16, vol * 0.65, 52);
  },
  sting() { // 追击触发警报音
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [330, 349].forEach(f => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f / 2, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.7);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 1);
    });
  },
  hit() { // 受击重音
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.4);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.5);
  },
  escape() { // 逃脱提示音
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [440, 587].forEach((f, i) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      const t0 = t + i * 0.15;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      o.connect(g); g.connect(this.master);
      o.start(t0); o.stop(t0 + 0.6);
    });
  },
  startDrone() { // 追击中的低频压迫感底噪
    if (!this.ctx || this.droneNodes) return;
    const o = this.ctx.createOscillator(), o2 = this.ctx.createOscillator();
    const g = this.ctx.createGain(), fl = this.ctx.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.value = 55;
    o2.type = 'sawtooth'; o2.frequency.value = 55.8;
    fl.type = 'lowpass'; fl.frequency.value = 220;
    g.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.09, this.ctx.currentTime + 1.5);
    o.connect(fl); o2.connect(fl); fl.connect(g); g.connect(this.master);
    o.start(); o2.start();
    this.droneNodes = { o, o2, g };
  },
  stopDrone() {
    if (!this.droneNodes) return;
    const { o, o2, g } = this.droneNodes, t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    o.stop(t + 1); o2.stop(t + 1);
    this.droneNodes = null;
  }
};

/* ================= 游戏状态 ================= */
const G = {
  running: false, mode: 'gps', diffKey: 'normal',
  duration: 1200, timeLeft: 1200,
  player: { lat: 0, lng: 0, speed: 0, dist: 0, hasFix: false, t: 0 },
  hunter: { lat: 0, lng: 0, mode: 'stalk', hold: 0, phase: Math.random() * 10 },
  health: 2,
  stats: { chases: 0, escapes: 0, hits: 0, chaseTime: 0, maxSpeed: 0 },
  demo: { speed: 1.5, heading: Math.random() * Math.PI * 2 },
  nextBeat: 0, beatPulse: 0, downed: false, lastT: 0,
};
let watchId = null, wakeLock = null, rafId = null;
const diff = () => DIFFS[G.diffKey];

/* ================= 界面切换与选项 ================= */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('#screen-' + name).classList.add('active');
}

function wireSeg(id, cb) {
  const el = $(id);
  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    el.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    cb(b.dataset.v);
  });
}
wireSeg('#seg-duration', v => G.duration = +v);
wireSeg('#seg-diff', v => G.diffKey = v);
wireSeg('#seg-mode', v => G.mode = v);

function setState(text) { $('#hud-state').textContent = text; }
function flashRed() {
  const f = $('#flash');
  f.classList.remove('on');
  void f.offsetWidth;
  f.classList.add('on');
}

async function lockScreen() {
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 不支持则忽略 */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && G.running) { lockScreen(); Snd.resume(); }
});

/* ================= 开局 ================= */
function startRun() {
  Snd.init(); Snd.resume();
  G.running = true; G.downed = false;
  G.timeLeft = G.duration; G.health = 2;
  G.stats = { chases: 0, escapes: 0, hits: 0, chaseTime: 0, maxSpeed: 0 };
  G.player.speed = 0; G.player.dist = 0; G.player.hasFix = false;
  G.hunter.mode = 'stalk'; G.hunter.hold = 0;
  G.nextBeat = 0; G.beatPulse = 0;
  document.body.classList.remove('injured', 'chase');
  $('#demo-ctl').hidden = G.mode !== 'demo';
  setState('监管者正在附近游荡……');
  showScreen('run');
  resizeRadar();
  lockScreen();

  if (G.mode === 'demo') {
    begin(31.2304, 121.4737); // 演示模式：任意起点
  } else {
    setState('正在获取定位……');
    watchId = navigator.geolocation.watchPosition(p => {
      if (!G.player.hasFix) begin(p.coords.latitude, p.coords.longitude);
      onPos(p);
    }, onPosErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }
}

function begin(lat, lng) {
  G.player.lat = lat; G.player.lng = lng; G.player.hasFix = true;
  // 初始距离：随机方向、60~80 米随机距离
  const p = moveAlong(lat, lng, Math.random() * Math.PI * 2, 60 + Math.random() * 20);
  G.hunter.lat = p.lat; G.hunter.lng = p.lng;
  G.lastT = performance.now();
  setState('监管者正在附近游荡……');
  rafId = requestAnimationFrame(tick);
}

function onPos(p) {
  if (!G.running || G.mode !== 'gps' || !G.player.hasFix) return;
  const { latitude: lat, longitude: lng, accuracy, speed } = p.coords;
  if (accuracy && accuracy > 50) return; // 精度太差直接丢弃
  const t = p.timestamp;
  const d = haversine(G.player.lat, G.player.lng, lat, lng);
  const dt = Math.max(0.5, (t - (G.player.t || t)) / 1000);
  if (d < 100) { // 过滤定位跳变
    let spd = (speed != null && speed >= 0) ? speed : d / dt;
    spd = clamp(spd, 0, 12);
    G.player.speed = G.player.speed * 0.5 + spd * 0.5;
    G.player.dist += d;
    G.stats.maxSpeed = Math.max(G.stats.maxSpeed, G.player.speed);
  }
  G.player.lat = lat; G.player.lng = lng;
  G.player.t = t;
}

function onPosErr(e) {
  setState('定位失败：请检查定位权限，或改用演示模式');
}

/* ================= 主循环 ================= */
function tick(now) {
  if (!G.running) return;
  const dt = Math.min(0.2, (now - G.lastT) / 1000);
  G.lastT = now;

  if (G.mode === 'demo') {
    G.demo.heading += (Math.random() - 0.5) * 0.15;
    const spd = G.demo.speed;
    G.player.speed = G.player.speed * 0.7 + spd * 0.3;
    const p = moveAlong(G.player.lat, G.player.lng, G.demo.heading, spd * dt);
    G.player.dist += spd * dt;
    G.player.lat = p.lat; G.player.lng = p.lng;
    G.stats.maxSpeed = Math.max(G.stats.maxSpeed, G.player.speed);
  }

  updateHunter(dt);
  G.timeLeft -= dt;
  if (G.hunter.mode === 'chase') G.stats.chaseTime += dt;

  updateAudioVisuals();
  renderRadar();
  updateHud();

  if (G.timeLeft <= 0) { endRun(false); return; }
  rafId = requestAnimationFrame(tick);
}

/* ================= 监管者 AI ================= */
function updateHunter(dt) {
  const D = diff(), H = G.hunter, P = G.player;
  const d = haversine(P.lat, P.lng, H.lat, H.lng);
  const brg = bearingTo(H.lat, H.lng, P.lat, P.lng);
  H.phase += dt;

  if (H.mode === 'stalk') {
    // 以恒定速度拉近相对距离，叠加游荡摆动
    const spd = P.speed + STALK_CLOSE;
    const wander = Math.sin(H.phase * 0.7) * 0.5;
    const p = moveAlong(H.lat, H.lng, brg + wander, spd * dt);
    H.lat = p.lat; H.lng = p.lng;
    if (d < FEAR_RADIUS) startChase();
  } else if (H.mode === 'chase') {
    const p = moveAlong(H.lat, H.lng, brg, D.chaseSpeed * dt);
    H.lat = p.lat; H.lng = p.lng;
    if (d < CATCH_RADIUS) onHit();
    else if (d > ESCAPE_DIST) {
      H.hold += dt;
      if (H.hold >= ESCAPE_HOLD) onEscape();
    } else H.hold = 0;
  } else if (H.mode === 'stun') {
    // 击中后的僵直：原地不动，结束后从当前距离直接继续追击
    H.stunT -= dt;
    if (H.stunT <= 0) {
      H.mode = 'chase';
      H.hold = 0;
      document.body.classList.add('chase');
      Snd.startDrone();
      setState('监管者恢复行动，继续追你！');
    }
  }
}

function startChase() {
  G.hunter.mode = 'chase';
  G.hunter.hold = 0;
  G.stats.chases++;
  document.body.classList.add('chase');
  Snd.sting(); Snd.startDrone();
  setState('监管者发现你了，快跑！！');
}

function onEscape() {
  // 逃脱成功：不撤退，原地转入游荡（3.0 m/s 相对速度重新逼近）
  G.hunter.mode = 'stalk';
  G.stats.escapes++;
  document.body.classList.remove('chase');
  Snd.stopDrone(); Snd.escape();
  setState('成功逃脱……它正重新逼近');
}

function onHit() {
  G.stats.hits++;
  G.health--;
  Snd.hit(); Snd.stopDrone();
  document.body.classList.remove('chase');
  flashRed();
  if (G.health <= 0) { G.downed = true; endRun(true); return; }
  document.body.classList.add('injured');
  G.hunter.mode = 'stun';
  G.hunter.stunT = HIT_STUN;
  setState('你受到了攻击！它僵直了，快跑！');
}

/* ================= 心跳与红光 ================= */
function updateAudioVisuals() {
  const d = haversine(G.player.lat, G.player.lng, G.hunter.lat, G.hunter.lng);
  const t = clamp(d / HEAR_RANGE, 0, 1);
  let base = lerp(0.55, 0.05, t);
  if (G.health === 1) base += 0.1; // 受伤后红光常驻加深
  $('#vignette').style.opacity = clamp(base + G.beatPulse * 0.4, 0, 1);
  G.beatPulse *= 0.9;

  if (d < HEAR_RANGE && Snd.ctx) {
    let interval = lerp(0.32, 1.15, t);
    if (G.hunter.mode === 'chase') interval *= 0.8;
    if (G.health === 1) interval *= 0.9;
    if (Snd.ctx.currentTime >= G.nextBeat) {
      Snd.heartbeat(lerp(0.9, 0.12, t));
      G.beatPulse = 1;
      G.nextBeat = Snd.ctx.currentTime + interval;
    }
  }
}

/* ================= 雷达绘制 ================= */
const radar = $('#radar'), rctx = radar.getContext('2d');
function resizeRadar() {
  const size = Math.min(window.innerWidth - 24, window.innerHeight * 0.52);
  const dpr = window.devicePixelRatio || 1;
  radar.width = size * dpr;
  radar.height = size * dpr;
  radar.style.width = radar.style.height = size + 'px';
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeRadar);

function renderRadar() {
  const dpr = window.devicePixelRatio || 1;
  const w = radar.width / dpr, c = w / 2;
  const scale = (c - 16) / RADAR_RANGE;
  rctx.clearRect(0, 0, w, w);

  rctx.strokeStyle = 'rgba(120,170,140,0.22)';
  rctx.fillStyle = 'rgba(120,170,140,0.45)';
  rctx.font = '10px monospace';
  rctx.lineWidth = 1;
  for (let r = 50; r <= RADAR_RANGE; r += 50) {
    rctx.beginPath(); rctx.arc(c, c, r * scale, 0, Math.PI * 2); rctx.stroke();
    rctx.fillText(r + 'm', c + 4, c - r * scale + 12);
  }
  rctx.strokeStyle = 'rgba(120,170,140,0.12)';
  rctx.beginPath(); rctx.moveTo(c, 8); rctx.lineTo(c, w - 8); rctx.stroke();
  rctx.beginPath(); rctx.moveTo(8, c); rctx.lineTo(w - 8, c); rctx.stroke();

  // 玩家（中心）
  rctx.fillStyle = '#7ef9c6';
  rctx.beginPath(); rctx.arc(c, c, 5, 0, Math.PI * 2); rctx.fill();

  // 监管者
  const d = haversine(G.player.lat, G.player.lng, G.hunter.lat, G.hunter.lng);
  const brg = bearingTo(G.player.lat, G.player.lng, G.hunter.lat, G.hunter.lng);
  const rd = Math.min(d, RADAR_RANGE - 12) * scale;
  const x = c + Math.sin(brg) * rd, y = c - Math.cos(brg) * rd;
  const pulse = 10 + G.beatPulse * 12 + (G.hunter.mode === 'chase' ? 5 : 0);
  const grad = rctx.createRadialGradient(x, y, 0, x, y, pulse * 2);
  grad.addColorStop(0, 'rgba(255,43,62,0.85)');
  grad.addColorStop(1, 'rgba(255,43,62,0)');
  rctx.fillStyle = grad;
  rctx.beginPath(); rctx.arc(x, y, pulse * 2, 0, Math.PI * 2); rctx.fill();
  rctx.fillStyle = '#ff2b3e';
  rctx.beginPath(); rctx.arc(x, y, 5, 0, Math.PI * 2); rctx.fill();
  rctx.fillStyle = 'rgba(255,90,100,0.95)';
  rctx.font = '12px monospace';
  rctx.fillText(Math.round(d) + 'm', x + 10, y + 4);
}

/* ================= HUD ================= */
function updateHud() {
  $('#hud-time').textContent = fmtTime(G.timeLeft);
  const hearts = document.querySelectorAll('#hud-hearts .heart');
  hearts.forEach((h, i) => h.classList.toggle('lost', i >= G.health));
  $('#hud-speed').textContent = (G.player.speed * 3.6).toFixed(1);
  $('#hud-pace').textContent = fmtPace(G.player.speed);
  $('#hud-dist').textContent = (G.player.dist / 1000).toFixed(2);
}

/* ================= 结算与历史 ================= */
function endRun(downed) {
  G.running = false;
  cancelAnimationFrame(rafId);
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  Snd.stopDrone();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  document.body.classList.remove('chase');
  $('#vignette').style.opacity = 0;

  const rec = {
    date: new Date().toISOString(),
    minutes: Math.round((G.duration - Math.max(0, G.timeLeft)) / 6) / 10,
    distance: Math.round(G.player.dist),
    chases: G.stats.chases,
    escapes: G.stats.escapes,
    hits: G.stats.hits,
    chaseTime: Math.round(G.stats.chaseTime),
    maxSpeed: Math.round(G.stats.maxSpeed * 3.6 * 10) / 10,
    diff: diff().label,
    downed,
  };
  saveRecord(rec);
  renderEnd(rec);
  showScreen('end');
}

function renderEnd(rec) {
  $('#end-title').textContent = rec.downed ? '你倒下了……' : '存活到最后！';
  const rows = [
    ['难度', rec.diff],
    ['实际用时', rec.minutes + ' 分钟'],
    ['总距离', (rec.distance / 1000).toFixed(2) + ' km'],
    ['遭遇追击', rec.chases + ' 次'],
    ['成功逃脱', rec.escapes + ' 次'],
    ['受击', rec.hits + ' 次', true],
    ['追击时间（高强度）', fmtTime(rec.chaseTime)],
    ['最高速度', rec.maxSpeed + ' km/h'],
  ];
  $('#end-stats').innerHTML = rows.map(([k, v, hl]) =>
    `<div class="row${hl ? ' hl' : ''}"><span>${k}</span><b>${v}</b></div>`).join('');
}

function saveRecord(rec) {
  try {
    const list = JSON.parse(localStorage.getItem('idv_history') || '[]');
    list.unshift(rec);
    localStorage.setItem('idv_history', JSON.stringify(list.slice(0, 30)));
  } catch (e) { /* 存储不可用时忽略 */ }
}

function renderHistory() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem('idv_history') || '[]'); } catch (e) {}
  if (!list.length) { $('#history').innerHTML = ''; return; }
  $('#history').innerHTML = '<h2>最近战绩</h2>' + list.slice(0, 8).map(r => {
    const d = new Date(r.date);
    const ds = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const res = r.downed ? '<span class="downed">倒地</span>' : '存活';
    return `<div class="rec"><span>${ds} · ${r.diff}</span><span>${(r.distance / 1000).toFixed(2)}km · 逃脱${r.escapes} · ${res}</span></div>`;
  }).join('');
}

/* ================= 事件绑定 ================= */
$('#btn-start').addEventListener('click', startRun);
$('#btn-end').addEventListener('click', () => {
  if (confirm('确定结束本局吗？')) endRun(false);
});
$('#btn-again').addEventListener('click', startRun);
$('#btn-home').addEventListener('click', () => { renderHistory(); showScreen('start'); });
$('#demo-speed').addEventListener('input', e => {
  G.demo.speed = +e.target.value;
  $('#demo-speed-val').textContent = (+e.target.value).toFixed(1);
});

/* ================= 初始化 ================= */
renderHistory();
resizeRadar();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
