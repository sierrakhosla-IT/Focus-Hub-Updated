'use strict';

const STORAGE_KEY = 'ops_dem_v2';
const LEGACY_KEY  = 'ops_ngc_v1';

const CAPS = {
  targets: 2, tasks: 6,
  b1DoNow: 2, b1QuickHits: 3,
  b2DoNow: 2, b2QuickHits: 3,
  followUps: 3, stuck: 4,
  tomorrowFollowUps: 3, tickets: 8
};

const LANES = {
  'b1-donow':    { block: 'block1', lane: 'donow',    max: CAPS.b1DoNow },
  'b1-quickhits': { block: 'block1', lane: 'quickhits', max: CAPS.b1QuickHits },
  'b2-donow':    { block: 'block2', lane: 'donow',    max: CAPS.b2DoNow },
  'b2-quickhits': { block: 'block2', lane: 'quickhits', max: CAPS.b2QuickHits },
  'b3-items':    { block: 'block3', lane: 'items',    max: 6 }
};

const EXEC = {
  STALE_MS:     48 * 60 * 60 * 1000,
  RECENT_MS:    24 * 60 * 60 * 1000,
  UP_NEXT_MAX:  5,
  DONE_FADE_MS: 72 * 60 * 60 * 1000
};

// ── Auto-router classification engine ──────────────────────────────────────
const ROUTER_RULES = [
  // System type
  { tag: 'SNOW',       cls: 'intake-tag-snow',       test: /\b(ritm|inc|snow|servicenow|ticket|incident|request)\b/i },
  { tag: 'UNITY',      cls: 'intake-tag-unity',       test: /\bunity\b/i },
  // Work category
  { tag: 'Onboarding', cls: 'intake-tag-onboarding',  test: /\b(onboard|new hire|new user|activate|provision)\b/i },
  { tag: 'Shipping',   cls: 'intake-tag-shipping',    test: /\b(ship|fedex|ups|mail|send phone|send laptop|send device|hardware)\b/i },
  { tag: 'Waiting',    cls: 'intake-tag-waiting',     test: /\b(waiting|callback|follow.?up|pending reply|no response|chase|remind)\b/i },
  // Block routing hints
  { tag: 'B1 → Do Now',      cls: 'intake-tag-block', test: /\b(urgent|critical|today|asap|must|priority|deadline|due)\b/i },
  { tag: 'B1 → Quick Hits',  cls: 'intake-tag-block', test: /\b(update|reply|respond|email|call|check|verify|confirm|note|remind|close|cancel)\b/i },
  { tag: 'B2 → Do Now',      cls: 'intake-tag-block', test: /\b(draft|build|create|write|prepare|review|plan|research|analyze|document)\b/i },
  { tag: 'B3 → Close',       cls: 'intake-tag-block', test: /\b(close|resolve|finish|complete|wrap|done|finalize|submit)\b/i },
];

function classifyInput(text) {
  const t = (text || '').trim();
  if (!t) return [];
  return ROUTER_RULES.filter(r => r.test.test(t));
}

function suggestLane(text, matches) {
  const tags = matches.map(m => m.tag);

  // Count current active tasks per lane
  const b1dn  = (state.blocks.block1.donow    ||[]).filter(t=>(t.text||'').trim()).length;
  const b1qh  = (state.blocks.block1.quickhits||[]).filter(t=>(t.text||'').trim()).length;
  const b2dn  = (state.blocks.block2.donow    ||[]).filter(t=>(t.text||'').trim()).length;
  const b2qh  = (state.blocks.block2.quickhits||[]).filter(t=>(t.text||'').trim()).length;

  // Explicit block routing tags take priority
  if (tags.includes('B3 → Close'))      return 'b3-items';
  if (tags.includes('B2 → Do Now'))     return b2dn < CAPS.b2DoNow   ? 'b2-donow'    : 'b3-items';
  if (tags.includes('B1 → Quick Hits')) return b1qh < CAPS.b1QuickHits ? 'b1-quickhits' : (b2qh < CAPS.b2QuickHits ? 'b2-quickhits' : 'b3-items');
  if (tags.includes('B1 → Do Now'))     return b1dn < CAPS.b1DoNow   ? 'b1-donow'    : (b2dn < CAPS.b2DoNow ? 'b2-donow' : 'b3-items');

  // Category-based routing
  if (tags.includes('Waiting'))   return b1qh < CAPS.b1QuickHits ? 'b1-quickhits' : (b2qh < CAPS.b2QuickHits ? 'b2-quickhits' : 'b3-items');
  if (tags.includes('Shipping'))  return b1dn < CAPS.b1DoNow ? 'b1-donow' : (b2dn < CAPS.b2DoNow ? 'b2-donow' : 'b3-items');
  if (tags.includes('Onboarding'))return b1dn < CAPS.b1DoNow ? 'b1-donow' : (b2dn < CAPS.b2DoNow ? 'b2-donow' : 'b3-items');
  if (tags.includes('SNOW'))      return b1qh < CAPS.b1QuickHits ? 'b1-quickhits' : (b2qh < CAPS.b2QuickHits ? 'b2-quickhits' : 'b3-items');

  // Default: distribute across blocks intelligently
  // Prefer filling B1 Do Now first, then B2 Do Now, then quick hits, then B3
  if (b1dn < CAPS.b1DoNow)          return 'b1-donow';
  if (b1qh < CAPS.b1QuickHits)      return 'b1-quickhits';
  if (b2dn < CAPS.b2DoNow)          return 'b2-donow';
  if (b2qh < CAPS.b2QuickHits)      return 'b2-quickhits';
  return 'b3-items';
}

// Pending intake queue (routed but not yet confirmed)
let intakeQueue = [];

// ── State ──────────────────────────────────────────────────────────────────
let state = emptyState();
let saveTimer = null;
let isEditingTask = false;

function emptyState() {
  return {
    version: 2,
    dateKey: todayKey(),
    lastDay: '',
    targets: [
      { id: uid(), text: '', done: false },
      { id: uid(), text: '', done: false }
    ],
    start: { targetsLocked: false, workNotes: '' },
    blocks: {
      block1: { donow: [], quickhits: [] },
      block2: { donow: [], quickhits: [] },
      reset:  { scan: '' },
      block3: { items: [] }
    },
    followUps: [],
    eod: { closedToday: '', stillStuck: [], tomorrowT1: '', tomorrowT2: '', tomorrowFollowUps: [] },
    parked: [],
    tickets: [],
    recentDays: [],
    focusId: null,
    doneLane: [],
    interruptions: 0,
    focusStartedAt: null,
    quickCapture: []
  };
}

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2,9) + Math.random().toString(36).slice(2,9);
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

function setSaveStatus(s) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.className = 'save-pill ' + s;
  el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved' : s === 'failed' ? 'Save failed' : 'Ready';
}

function save() {
  setSaveStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setSaveStatus('saved');
    } catch(e) { setSaveStatus('failed'); }
  }, 400);
}

function nowMs() { return Date.now(); }

function makeTask(text, done, extra) {
  const ts = nowMs();
  return { id: uid(), text: text||'', done: !!done, createdAt: ts, updatedAt: ts,
    completedAt: done ? ts : null, linkedTarget: null, pendingAction: false, dueAt: null, status: null, ...(extra||{}) };
}

function ensureTask(task) {
  const ts = nowMs();
  if (!task.id) task.id = uid();
  if (!task.createdAt) task.createdAt = ts;
  if (!task.updatedAt) task.updatedAt = task.createdAt;
  if (task.completedAt === undefined) task.completedAt = task.done ? task.updatedAt : null;
  if (task.linkedTarget === undefined) task.linkedTarget = null;
  if (task.pendingAction === undefined) task.pendingAction = false;
  if (task.dueAt === undefined) task.dueAt = null;
  return task;
}

function touchTask(task) { ensureTask(task); task.updatedAt = nowMs(); }

function targetText(idx) { return (state.targets[idx]?.text||'').trim().toLowerCase(); }

function autoLinkTarget(task) {
  ensureTask(task);
  const text = (task.text||'').trim().toLowerCase();
  if (!text) return null;
  const t1 = targetText(0), t2 = targetText(1);
  if (t1 && (text===t1||text.includes(t1)||t1.includes(text))) return 't1';
  if (t2 && (text===t2||text.includes(t2)||t2.includes(text))) return 't2';
  return task.linkedTarget;
}

function isT1Task(task) {
  ensureTask(task);
  if (task.done) return false;
  if (task.linkedTarget==='t1') return true;
  return autoLinkTarget(task)==='t1';
}

function isStale(task) {
  ensureTask(task);
  if (task.done||!(task.text||'').trim()) return false;
  return nowMs()-task.updatedAt >= EXEC.STALE_MS;
}

function isRecent(task) { ensureTask(task); return nowMs()-task.createdAt <= EXEC.RECENT_MS; }
function isDueSoon(task) {
  ensureTask(task);
  if (!task.dueAt) return false;
  const due = new Date(task.dueAt).getTime();
  return !Number.isNaN(due) && due-nowMs() <= EXEC.RECENT_MS;
}

function iterActiveTasks(fn) {
  Object.keys(LANES).forEach(listId => {
    (getTaskArray(listId)||[]).forEach((task, idx) => {
      if (!(task.text||'').trim() || task.done) return;
      fn(task, listId, idx);
    });
  });
}

function findTaskById(taskId) {
  if (!taskId) return null;
  for (const listId of Object.keys(LANES)) {
    const arr = getTaskArray(listId)||[];
    const idx = arr.findIndex(t => t.id===taskId);
    if (idx>=0) return { task: arr[idx], listId, idx };
  }
  return null;
}

function getFocusTask() {
  const hit = findTaskById(state.focusId);
  if (!hit||hit.task.done||!(hit.task.text||'').trim()) return null;
  return hit.task;
}

function setFocus(taskId) {
  if (!taskId) { state.focusId=null; state.focusStartedAt=null; stopFocusTimer(); return; }
  const hit = findTaskById(taskId);
  if (!hit||hit.task.done||!(hit.task.text||'').trim()) { state.focusId=null; state.focusStartedAt=null; stopFocusTimer(); return; }
  if (state.focusId !== taskId) { state.focusStartedAt = Date.now(); }
  state.focusId = taskId;
  startFocusTimer();
}

function clearFocusIf(taskId) { if (state.focusId===taskId) state.focusId=null; }
function reconcileFocusId() { if (state.focusId&&!getFocusTask()) { state.focusId=null; stopFocusTimer(); } }
function validateFocusId() { reconcileFocusId(); }

function urgencyScore(task, listId) {
  ensureTask(task);
  let score = 0;
  if (isT1Task(task)) score += 100;
  if (isRecent(task)) score += 50;
  if (task.pendingAction) score += 40;
  if (listId&&(listId.includes('quickhits')||listId==='b3-items')) score += 35;
  if (isDueSoon(task)) score += 60;
  if (isStale(task)) score += 35;
  if (state.focusId===task.id) score += 120;
  score += Math.max(0, 20-Math.floor((nowMs()-task.updatedAt)/3600000));
  return score;
}

function computeUpNext() {
  const items = [];
  iterActiveTasks((task, listId) => {
    items.push({ task, score: urgencyScore(task, listId), label: (task.text||'').trim() });
  });
  items.sort((a,b) => b.score-a.score || b.task.updatedAt-a.task.updatedAt);
  return items;
}

const UI_STATE = { focus: null, selectionActive: false, selectionHighlightId: null, upNextQueue: [], mode: 'idle' };

function syncExecutionState() {
  reconcileFocusId();
  const focusTask = getFocusTask();
  const ranked = computeUpNext();
  const selectionItems = ranked.filter(item => item.task.id!==state.focusId);
  UI_STATE.focus = focusTask ? focusTask.id : null;
  UI_STATE.upNextQueue = selectionItems.slice(0, EXEC.UP_NEXT_MAX);
  UI_STATE.selectionActive = selectionItems.length > 0;
  UI_STATE.selectionHighlightId = !UI_STATE.focus && UI_STATE.upNextQueue[0] ? UI_STATE.upNextQueue[0].task.id : null;
  UI_STATE.mode = UI_STATE.focus ? 'focus' : UI_STATE.selectionActive ? 'selection' : 'idle';
  document.body.classList.remove('state-focus-active','state-selection-active','state-idle');
  document.body.classList.add('state-'+(UI_STATE.mode==='focus'?'focus-active':UI_STATE.mode==='selection'?'selection-active':'idle'));
  document.body.dataset.executionState = UI_STATE.mode;
}

function laneActiveCount(arr) { return (arr||[]).filter(t=>(t.text||'').trim()&&!t.done).length; }

function getLaneState(listId, arr) {
  const active = (arr||[]).filter(t=>(t.text||'').trim()&&!t.done);
  if (!active.length) return 'clean';
  if (active.some(isT1Task)||active.some(isStale)) return 'critical';
  if (active.length > 3) return 'overloaded';
  return 'active';
}

function sortTasksForDisplay(arr) {
  return arr.map((task,idx)=>({task,idx})).sort((a,b)=>{
    const aA=(a.task.text||'').trim()&&!a.task.done;
    const bA=(b.task.text||'').trim()&&!b.task.done;
    if (!aA&&bA) return 1;
    if (aA&&!bA) return -1;
    if (aA&&bA) {
      const aS=isStale(a.task)?1:0, bS=isStale(b.task)?1:0;
      if (aS!==bS) return bS-aS;
      const aT=isT1Task(a.task)?1:0, bT=isT1Task(b.task)?1:0;
      if (aT!==bT) return bT-aT;
      if (state.focusId===a.task.id) return -1;
      if (state.focusId===b.task.id) return 1;
    }
    return a.idx-b.idx;
  }).map(x=>x.task);
}

function doneFadeStyle(task) {
  ensureTask(task);
  if (!task.completedAt) return '';
  const age = nowMs()-task.completedAt;
  const t = Math.min(1, age/EXEC.DONE_FADE_MS);
  return `opacity:${(1-t*0.45).toFixed(2)};filter:saturate(${(1-t*0.55).toFixed(2)})`;
}

function appendClosedToday(text) {
  const line = (text||'').trim();
  if (!line) return;
  const lines = (state.eod.closedToday||'').split('\n').map(s=>s.trim()).filter(Boolean);
  if (!lines.includes(line)) { lines.push(line); state.eod.closedToday = lines.join('\n'); }
}

function completeTask(listId, idx) {
  const arr = getTaskArray(listId);
  if (!arr||!arr[idx]) return;
  const task = ensureTask(arr[idx]);
  const text = (task.text||'').trim();
  task.done = true; task.completedAt = nowMs(); touchTask(task);
  clearFocusIf(task.id);
  if (text) {
    syncTargetCompletionFromTask(text);
    const removed = arr.splice(idx,1)[0];
    state.doneLane = state.doneLane||[];
    state.doneLane.unshift(ensureTask(removed));
    if (state.doneLane.length>24) state.doneLane = state.doneLane.slice(0,24);
    appendClosedToday(text);
  } else {
    task.done = !task.done;
    task.completedAt = task.done ? nowMs() : null;
    clearFocusIf(task.id);
  }
  renderAll(); save();
}


function moveTask(fromListId, fromIdx, toListId) {
  const fromArr = getTaskArray(fromListId);
  const toArr = getTaskArray(toListId);
  if (!fromArr || !toArr) return;
  const task = fromArr[fromIdx];
  if (!task || !(task.text||'').trim()) return;

  const toCfg = LANES[toListId];
  const toActive = toArr.filter(t=>(t.text||'').trim()).length;
  if (toActive >= toCfg.max && !toListId.startsWith('b3')) {
    toast('Lane full — pick another'); return;
  }

  fromArr.splice(fromIdx, 1);
  toArr.push(task);
  clearFocusIf(task.id);
  renderAll(); save();
  toast('Moved to ' + laneLabel(toListId));
}

function showMoveMenu(taskId, listId, idx, anchorEl) {
  // Remove any existing move menu
  document.querySelectorAll('.move-menu').forEach(m => m.remove());

  const laneOptions = LANE_OPTIONS.filter(o => o.id !== listId);

  const menu = document.createElement('div');
  menu.className = 'move-menu';
  menu.innerHTML = `
    <div class="move-menu-label">Move to</div>
    ${laneOptions.map(o=>`<button class="move-menu-item" data-move-to="${o.id}" data-from-list="${listId}" data-from-idx="${idx}">${esc(o.label)}</button>`).join('')}
  `;

  const rect = anchorEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = rect.left + 'px';
  menu.style.zIndex = '500';
  document.body.appendChild(menu);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closeFn(e) {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', closeFn); }
    });
  }, 10);
}

function countMeaningfulTasks() {
  const b = state.blocks;
  return [...(b.block1?.donow||[]),...(b.block1?.quickhits||[]),...(b.block2?.donow||[]),...(b.block2?.quickhits||[])]
    .filter(t=>(t.text||'').trim()).length;
}

function canAddTask() { return countMeaningfulTasks() < CAPS.tasks; }

function makeFollowUp(snow,sent,reply) { return {id:uid(),snow:snow||'',sent:sent||'',reply:reply||''}; }

// ── Load/Save ──────────────────────────────────────────────────────────────
function prioritizeLaneTasks(arr) {
  return arr.map((task,idx)=>({task,idx}))
    .sort((a,b)=>{
      const aA=(a.task.text||'').trim()&&!a.task.done;
      const bA=(b.task.text||'').trim()&&!b.task.done;
      if (aA&&!bA) return -1; if (!aA&&bA) return 1; return a.idx-b.idx;
    }).map(x=>x.task);
}

function normalize(s) {
  const base = emptyState();
  const merged = {...base,...s, start:{...base.start,...(s.start||{})}};
  merged.blocks = {
    block1:{donow:[],quickhits:[],...(s.blocks?.block1||{})},
    block2:{donow:[],quickhits:[],...(s.blocks?.block2||{})},
    reset: {scan:'',...(s.blocks?.reset||{})},
    block3:{items:[],...(s.blocks?.block3||{})}
  };
  merged.eod = {...base.eod,...(s.eod||{})};
  merged.parked = (s.parked||[]).slice(0,5);
  merged.targets = (s.targets||[]).slice(0,CAPS.targets);
  while (merged.targets.length<CAPS.targets) merged.targets.push({id:uid(),text:'',done:false});
  merged.followUps = (merged.followUps||[]).slice(0,CAPS.followUps);
  merged.eod.stillStuck = (merged.eod.stillStuck||[]).slice(0,CAPS.stuck);
  merged.eod.tomorrowFollowUps = (merged.eod.tomorrowFollowUps||[]).slice(0,CAPS.tomorrowFollowUps);
  merged.tickets = (merged.tickets||[]).slice(0,CAPS.tickets);
  merged.recentDays = (merged.recentDays||[]).slice(0,7);
  merged.focusId = s.focusId||null;
  merged.interruptions = s.interruptions||0;
  merged.focusStartedAt = s.focusStartedAt||null;
  merged.quickCapture = (s.quickCapture||[]).slice(0,10);
  merged.doneLane = (merged.doneLane||[]).map(ensureTask).slice(0,24);
  Object.keys(LANES).forEach(listId=>{
    const cfg=LANES[listId];
    const raw=(merged.blocks[cfg.block][cfg.lane]||[]).map(ensureTask);
    merged.blocks[cfg.block][cfg.lane]=prioritizeLaneTasks(raw).slice(0,cfg.max);
  });
  return merged;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed&&parsed.version===2) { state=normalize(parsed); validateFocusId(); return; }
    }
  } catch(e){}
  state = emptyState();
}

// ── Render ─────────────────────────────────────────────────────────────────

function makeParked(snow, sent, reply) {
  return { id: uid(), snow: snow||'', sent: sent||'', reply: reply||'' };
}

function renderParked() {
  const list = document.getElementById('rail-parked-list');
  const btn = document.getElementById('btn-add-parked');
  if (!list) return;
  if (!(state.parked||[]).length) {
    list.innerHTML = '<span class="rail-parked-empty">Nothing parked</span>';
  } else {
    list.innerHTML = (state.parked||[]).map((p,i) => `
      <div class="rail-parked-row">
        <button type="button" class="rail-parked-del" data-parked-del="${i}">✕</button>
        ${p.snow ? `<span class="rail-parked-snow">${esc(p.snow)}</span>` : ''}
        <span class="rail-parked-sent">${esc(p.sent||'')}</span>
        ${p.reply ? `<span class="rail-parked-reply">Waiting: ${esc(p.reply)}</span>` : ''}
      </div>`).join('');
  }
  if (btn) btn.disabled = (state.parked||[]).length >= 5;
}

function renderAll() {
  syncExecutionState();
  renderRail();
  renderParked();
  renderInterruptions();
  renderQuickCapture();
  renderTargets();
  renderStart();
  if (!isEditingTask) renderBlocks();
  else { setFieldValueIfIdle(document.getElementById('reset-scan'), state.blocks.reset?.scan||''); updateTaskCounter(); }
  renderFollowUps();
  renderTickets();
  renderProgressWave();
  fitAllTaskInputs();
}

// Rail render
function renderRail() {
  // Date
  const rd = document.getElementById('rail-date');
  if (rd) rd.textContent = fmtDate(new Date());
  // Update subtitle if present
  const sub = document.getElementById('rail-subtitle');
  if (sub) sub.textContent = 'Where Action Happens';

  // Focus
  const focusTask = getFocusTask();
  const ft = document.getElementById('rail-focus-text');
  const fc = document.getElementById('rail-focus-clear');
  const card = document.getElementById('rail-focus-card');
  if (ft) {
    if (focusTask) {
      ft.textContent = focusTask.text;
      ft.classList.remove('empty');
      if (fc) { fc.hidden=false; fc.dataset.focusClear=focusTask.id; }
      if (card) card.classList.add('has-focus');
    } else {
      ft.textContent = 'No focus set';
      ft.classList.add('empty');
      if (fc) fc.hidden=true;
      if (card) card.classList.remove('has-focus');
    }
  }

  // Targets
  const rt = document.getElementById('rail-targets');
  if (rt) {
    rt.innerHTML = state.targets.map((t,i)=>`
      <div class="rail-target-row">
        <span class="rail-target-tag">T${i+1}</span>
        <span class="rail-target-text${!(t.text||'').trim()?' empty':''}${t.done?' done':''}">${esc((t.text||'').trim()||'Not set')}</span>
      </div>`).join('');
  }

  // Up Next
  const ru = document.getElementById('rail-upnext');
  if (ru) {
    const queue = UI_STATE.upNextQueue;
    if (!queue.length) {
      ru.innerHTML = '<span class="rail-upnext-empty">Add tasks to see queue</span>';
    } else {
      ru.innerHTML = queue.map((item,i)=>`
        <div class="rail-upnext-item${i===0?' is-top-item':''}" data-set-focus="${esc(item.task.id)}">
          <span class="rail-upnext-rank">${i+1}</span>
          <span class="rail-upnext-text">${esc(item.label)}</span>
        </div>`).join('');
    }
  }
}

function renderTargets() {
  const list = document.getElementById('targets-list');
  if (!list) return;
  const active = document.activeElement;
  if (active?.classList.contains('target-input')&&list.contains(active)) return;
  const locked = !!state.start.targetsLocked;
  list.innerHTML = state.targets.map((t,i)=>{
    const hasText = !!(t.text||'').trim();
    return `
    <div class="target-row${t.done?' done':''}${locked?' locked':''}${hasText?' target-t'+(i+1):''}">
      <span class="target-tag">T${i+1}</span>
      <input type="text" class="target-input" data-idx="${i}" value="${esc(t.text)}"
        placeholder="Target ${i+1} — what must move today?" maxlength="120"${locked?' readonly':''}>
      <button type="button" class="task-check${t.done?' checked':''}" data-target-done="${i}" aria-label="Toggle">✓</button>
    </div>`;
  }).join('');
}

function renderStart() {
  const tl = document.getElementById('chk-targets-locked');
  if (tl) tl.checked = !!state.start.targetsLocked;
  setFieldValueIfIdle(document.getElementById('work-notes'), state.start.workNotes||'');
}

function setFieldValueIfIdle(el, value) {
  if (!el||document.activeElement===el) return;
  el.value = value??'';
}

function fitTaskInput(el) {
  if (!el||el.tagName!=='TEXTAREA') return;
  el.style.height='auto'; el.style.height=el.scrollHeight+'px';
}

function fitAllTaskInputs(root=document) { root.querySelectorAll('textarea').forEach(fitTaskInput); }

function taskRowHTML(task, listId, idx) {
  ensureTask(task);
  const isFocus = UI_STATE.focus===task.id;
  const active = (task.text||'').trim()&&!task.done;
  const classes = ['task-row','priority-queue'];
  if (task.done) classes.push('priority-done','layer-0');
  else if (UI_STATE.mode==='focus') {
    if (isFocus) classes.push('is-focus','priority-focus');
    else if (active) classes.push('priority-passive','is-suppressed');
  } else if (active) {
    classes.push('priority-passive');
    if (isStale(task)) classes.push('is-stale');
    if (UI_STATE.mode==='selection'&&UI_STATE.selectionHighlightId===task.id) classes.push('is-selection-pick');
  }
  const showBadges = UI_STATE.mode==='idle';
  const badges=[];
  if (showBadges&&isT1Task(task)) badges.push('T1');
  if (showBadges&&isStale(task)) badges.push('stale');
  return `
    <div class="${classes.join(' ')}" data-task-id="${esc(task.id)}">
      <button type="button" class="task-check${task.done?' checked':''}" data-list="${listId}" data-idx="${idx}">✓</button>
      <textarea class="task-input" rows="1" spellcheck="true" data-list="${listId}" data-idx="${idx}" data-last-rendered="${esc(task.text)}" placeholder="Task…" maxlength="120">${esc(task.text)}</textarea>
      ${active?`<button type="button" class="task-focus-btn row-action${isFocus?' is-active':''}" data-set-focus="${esc(task.id)}" title="Set Focus">Focus</button>`:''}
      ${active?`<button type="button" class="task-move-btn row-action" data-move-btn="${esc(task.id)}" data-list="${listId}" data-idx="${idx}" title="Move to another block">↕</button>`:''}
      ${(task.status&&!task.done)?`<button type="button" class="task-status-btn" data-status-cycle="${listId}" data-idx="${idx}" title="Cycle status">${esc(task.status)}</button>`:''}
      ${(!task.status&&active)?`<button type="button" class="task-status-btn task-status-empty row-action" data-status-cycle="${listId}" data-idx="${idx}" title="Set status">···</button>`:''}
      ${badges.length?`<span class="lane-cap" style="opacity:.55;font-size:.56rem">${badges.join(' · ')}</span>`:''}
      <button type="button" class="task-del" data-list="${listId}" data-idx="${idx}" aria-label="Remove">✕</button>
    </div>`;
}

function renderTaskList(listId) {
  const el = document.getElementById(listId);
  if (!el) return;
  const active = document.activeElement;
  if (active?.classList.contains('task-input')&&active.dataset.list===listId&&el.contains(active)) return;
  const cfg = LANES[listId];
  if (!cfg) return;
  const arr = state.blocks[cfg.block][cfg.lane]||[];
  const sorted = sortTasksForDisplay(arr);
  el.innerHTML = sorted.map(t=>{
    const idx=arr.indexOf(t); return taskRowHTML(t,listId,idx);
  }).join('');
  if (sorted.length === 0) {
    const emptyMsg = listId.includes('donow') ? 'No work assigned'
                   : listId === 'b3-items'    ? 'Nothing to close out'
                   : 'Ready for next task';
    el.insertAdjacentHTML('afterbegin', `<span class="lane-empty">${emptyMsg}</span>`);
  }
  fitAllTaskInputs(el);
  const laneEl = el.closest('.task-lane');
  if (laneEl) {
    const ls = getLaneState(listId,arr);
    laneEl.classList.remove('lane-clean','lane-active','lane-critical','lane-overloaded');
    laneEl.classList.add('lane-'+ls);
  }
  const atLaneMax = arr.length>=cfg.max;
  const atGlobalCap = countMeaningfulTasks()>=CAPS.tasks;
  const canAdd = !atLaneMax&&(listId.startsWith('b3')||!atGlobalCap||arr.some(t=>!(t.text||'').trim()));
  el.insertAdjacentHTML('beforeend',`<button type="button" class="slot-add" data-add="${listId}"${canAdd?'':' disabled'}>+ add</button>`);
}

function renderDoneLane() {
  let wrap = document.getElementById('exec-done-lane');
  const section = document.getElementById('section-blocks');
  if (!section) return;
  if (!wrap) {
    wrap=document.createElement('div'); wrap.id='exec-done-lane'; wrap.className='exec-done-lane';
    section.appendChild(wrap);
  }
  const done=(state.doneLane||[]).filter(t=>(t.text||'').trim());
  if (!done.length) { wrap.innerHTML=''; wrap.hidden=true; return; }
  wrap.hidden=false;
  wrap.innerHTML=`<div class="lane-label" style="margin-bottom:6px">Done <span class="lane-cap">${done.length}</span></div>
    ${done.map((task,i)=>`<div class="exec-done-row" style="${doneFadeStyle(task)}">
      <span class="task-check checked" style="font-size:.55rem;width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:rgba(153,205,216,0.3);border:1px solid rgba(153,205,216,0.5);color:#fff;flex-shrink:0;margin-top:1px">✓</span>
      <span class="task-input" style="font-size:.70rem;color:rgba(229,231,235,0.5);flex:1">${esc(task.text)}</span>
      <button type="button" class="task-del" data-done-del="${i}" aria-label="Remove">✕</button>
    </div>`).join('')}`;
}

function renderProgressWave() {
  const fill = document.getElementById('progress-fill');
  if (!fill) return;
  const active = countMeaningfulTasks();
  const done = (state.doneLane||[]).filter(t => (t.text||'').trim()).length;
  const total = active + done;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  fill.style.width = Math.min(100, pct) + '%';
}

function updateTaskCounter() {
  const el = document.getElementById('task-counter');
  if (!el) return;
  const n = countMeaningfulTasks();
  el.textContent = n+' tasks';
  el.classList.toggle('at-cap', n>=CAPS.tasks);
}

function renderBlocks() {
  Object.keys(LANES).forEach(renderTaskList);
  // Reset block removed
  renderDoneLane();
}

function followUpRowHTML(fu, listType, idx) {
  return `<div class="followup-row">
    <input type="text" class="clay-input" data-fu="${listType}" data-field="snow" data-idx="${idx}" value="${esc(fu.snow)}" placeholder="RITM / ref">
    <input type="text" class="clay-input" data-fu="${listType}" data-field="sent" data-idx="${idx}" value="${esc(fu.sent)}" placeholder="Sent to">
    <input type="text" class="clay-input" data-fu="${listType}" data-field="reply" data-idx="${idx}" value="${esc(fu.reply)}" placeholder="Reply needed">
    <button type="button" class="task-del" data-fu-del="${listType}" data-idx="${idx}" aria-label="Remove">✕</button>
  </div>`;
}

function renderFollowUps() {
  const list=document.getElementById('followups-list');
  const btn=document.getElementById('btn-add-followup');
  if (!list) return;
  list.innerHTML = state.followUps.map((f,i)=>followUpRowHTML(f,'mid',i)).join('');
  if (btn) btn.disabled = state.followUps.length>=CAPS.followUps;
}

function renderTickets() {
  const list=document.getElementById('tickets-list');
  if (!list) return;
  const active=document.activeElement;
  if (active?.dataset.ticket!==undefined&&list.contains(active)) return;
  if (!state.tickets.length) { list.innerHTML='<p class="recent-empty">No active tickets</p>'; return; }
  list.innerHTML = state.tickets.map((t,i)=>`
    <div class="ticket-card">
      <button type="button" class="ticket-del" data-ticket-del="${i}">✕</button>
      <input type="text" data-ticket="${i}" data-field="number" value="${esc(t.number)}" placeholder="RITM / INC number">
      <input type="text" data-ticket="${i}" data-field="user" value="${esc(t.user)}" placeholder="User">
      <input type="text" data-ticket="${i}" data-field="nextMove" value="${esc(t.nextMove)}" placeholder="Next move">
      <select data-ticket="${i}" data-field="status">
        ${['Pending','Waiting User','Waiting Vendor','In Progress','Ready To Close','Closed']
          .map(st=>`<option value="${st}"${t.status===st?' selected':''}>${st}</option>`).join('')}
      </select>
    </div>`).join('');
}

// ── Intake / Brain Dump ────────────────────────────────────────────────────
const LANE_OPTIONS = [
  { id: 'b1-donow',    label: 'B1 · Do Now' },
  { id: 'b1-quickhits',label: 'B1 · Quick Hits' },
  { id: 'b2-donow',    label: 'B2 · Do Now' },
  { id: 'b2-quickhits',label: 'B2 · Quick Hits' },
  { id: 'b3-items',    label: 'Block 3' },
];

function renderIntakeQueue() {
  const el = document.getElementById('intake-queue');
  if (!el) return;
  if (!intakeQueue.length) { el.innerHTML=''; return; }
  el.innerHTML = intakeQueue.map((item,i)=>`
    <div class="intake-item" data-intake-idx="${i}">
      <span class="intake-item-text">${esc(item.text)}</span>
      <div class="intake-item-tags">
        ${item.matches.filter(m=>!m.tag.startsWith('B')).map(m=>`<span class="intake-tag ${m.cls}">${esc(m.tag)}</span>`).join('')}
      </div>
      <div class="intake-lane-picker">
        ${LANE_OPTIONS.map(opt=>`
          <button type="button" class="lane-pick-btn${item.lane===opt.id?' selected':''}"
            data-intake-lane="${i}" data-lane-id="${opt.id}">${esc(opt.label)}</button>`).join('')}
      </div>
      <button type="button" class="intake-item-confirm" data-intake-confirm="${i}">Add →</button>
      <button type="button" class="intake-item-dismiss" data-intake-dismiss="${i}">✕</button>
    </div>`).join('');
}

function laneLabel(listId) {
  const map = {
    'b1-donow':'Block 1 · Do Now','b1-quickhits':'Block 1 · Quick Hits',
    'b2-donow':'Block 2 · Do Now','b2-quickhits':'Block 2 · Quick Hits',
    'b3-items':'Block 3'
  };
  return map[listId]||listId;
}

function handleIntakeRoute() {
  const inp = document.getElementById('intake-input');
  if (!inp) return;
  const raw = inp.value.trim();
  if (!raw) return;

  // Split on newlines — route each line separately
  const lines = raw.split('\n').map(l=>l.trim()).filter(Boolean);
  lines.forEach(line=>{
    const matches = classifyInput(line);
    const lane = suggestLane(line, matches);
    intakeQueue.push({ text: line, matches, lane });
  });

  inp.value='';
  updateIntakePreview('');
  renderIntakeQueue();
}

function confirmIntakeItem(idx) {
  const item = intakeQueue[idx];
  if (!item) return;

  const arr = getTaskArray(item.lane);
  if (!arr) { toast('Could not route to lane'); return; }

  const cfg = LANES[item.lane];
  const atLaneCap = arr.filter(t=>(t.text||'').trim()).length >= cfg.max;
  // Find empty slot or push
  const emptyIdx = arr.findIndex(t=>!(t.text||'').trim());
  if (emptyIdx>=0 && !atLaneCap) {
    arr[emptyIdx] = makeTask(item.text);
  } else if (!atLaneCap) {
    arr.push(makeTask(item.text));
  } else {
    // Overflow to b3
    const b3 = state.blocks.block3.items;
    b3.push(makeTask(item.text));
    toast('Lane full — routed to Block 3');
  }

  intakeQueue.splice(idx,1);
  renderIntakeQueue();
  renderAll();
  save();
  toast('Added: '+item.text.slice(0,40));
}

function dismissIntakeItem(idx) {
  intakeQueue.splice(idx,1);
  renderIntakeQueue();
}

function updateIntakePreview(text) {
  const el = document.getElementById('intake-preview');
  if (!el) return;
  if (!text.trim()) { el.innerHTML=''; return; }
  const matches = classifyInput(text);
  if (!matches.length) { el.innerHTML=''; return; }
  el.innerHTML = matches.slice(0,4).map(m=>`<span class="intake-tag ${m.cls}">${esc(m.tag)}</span>`).join('');
}

// ── EOD Panel ──────────────────────────────────────────────────────────────
function openEod() {
  document.getElementById('eod-panel').classList.add('open');
  document.getElementById('eod-overlay').hidden=false;
  renderEod();
}

function closeEod() {
  document.getElementById('eod-panel').classList.remove('open');
  document.getElementById('eod-overlay').hidden=true;
}

function renderEod() {
  setFieldValueIfIdle(document.getElementById('eod-closed'), state.eod.closedToday||'');
  setFieldValueIfIdle(document.getElementById('eod-t1'), state.eod.tomorrowT1||'');
  setFieldValueIfIdle(document.getElementById('eod-t2'), state.eod.tomorrowT2||'');

  const stuckList=document.getElementById('eod-stuck-list');
  if (stuckList) stuckList.innerHTML=(state.eod.stillStuck||[]).map((s,i)=>`
    <div class="followup-row" style="grid-template-columns:1fr 28px;margin-bottom:4px">
      <input type="text" class="clay-input" data-stuck="${i}" value="${esc(s.text)}" placeholder="Still stuck…" maxlength="120">
      <button type="button" class="task-del" data-stuck-del="${i}">✕</button>
    </div>`).join('');

  const addStuck=document.getElementById('btn-add-stuck');
  if (addStuck) addStuck.disabled=(state.eod.stillStuck||[]).length>=CAPS.stuck;

  const eodFu=document.getElementById('eod-followups-list');
  if (eodFu) eodFu.innerHTML=(state.eod.tomorrowFollowUps||[]).map((f,i)=>followUpRowHTML(f,'tomorrow',i)).join('');
  const addFu=document.getElementById('btn-add-eod-followup');
  if (addFu) addFu.disabled=(state.eod.tomorrowFollowUps||[]).length>=CAPS.tomorrowFollowUps;
}

// ── Tickets drawer ─────────────────────────────────────────────────────────
function openTickets() { toast('Add tickets through Brain Dump'); }
function closeTickets() {}

// ── Day management ─────────────────────────────────────────────────────────
function archiveDay() {
  const targets=state.targets.map(t=>(t.text||'').trim()).filter(Boolean);
  const closed=(state.eod.closedToday||'').split('\n').map(s=>s.trim()).filter(Boolean);
  const stuck=(state.eod.stillStuck||[]).map(s=>(s.text||'').trim()).filter(Boolean);
  if (!targets.length&&!closed.length&&!stuck.length) return;
  const rec={date:todayKey(),targets,closed,stuck};
  state.recentDays=(state.recentDays||[]).filter(d=>d.date!==rec.date);
  state.recentDays.unshift(rec);
  if (state.recentDays.length>7) state.recentDays=state.recentDays.slice(0,7);
}

function newDay() {
  if (!confirm('Start a new day?\n\nToday archives. Blocks reset. Tomorrow targets become today\'s T1/T2.')) return;
  archiveDay();
  const t1=(state.eod.tomorrowT1||'').trim(), t2=(state.eod.tomorrowT2||'').trim();
  state.lastDay=todayKey(); state.dateKey=todayKey();
  state.targets=[{id:uid(),text:t1,done:false},{id:uid(),text:t2,done:false}];
  state.start={targetsLocked:false,workNotes:state.start.workNotes||''};
  state.blocks={block1:{donow:[],quickhits:[]},block2:{donow:[],quickhits:[]},reset:{scan:''},block3:{items:[]}};
  state.followUps=(state.eod.tomorrowFollowUps||[]).map(f=>makeFollowUp(f.snow,f.sent,f.reply)).slice(0,CAPS.followUps);
  state.eod={closedToday:'',stillStuck:[],tomorrowT1:'',tomorrowT2:'',tomorrowFollowUps:[]};
  setFocus(null); state.doneLane=[]; intakeQueue=[]; state.interruptions=0; state.focusStartedAt=null; state.quickCapture=[];
  renderAll(); save(); toast('New day started');
}

function cleanSession() {
  if (!confirm('Clean session?\n\nClears targets, blocks, follow-ups, and EOD. Keeps notes, tickets, and recent days.')) return;
  state.targets=[{id:uid(),text:'',done:false},{id:uid(),text:'',done:false}];
  state.start.targetsLocked=false;
  state.blocks={block1:{donow:[],quickhits:[]},block2:{donow:[],quickhits:[]},reset:{scan:''},block3:{items:[]}};
  state.followUps=[];
  state.eod={closedToday:'',stillStuck:[],tomorrowT1:'',tomorrowT2:'',tomorrowFollowUps:[]};
  setFocus(null); state.doneLane=[]; intakeQueue=[]; state.interruptions=0; state.focusStartedAt=null; state.quickCapture=[];
  renderAll(); save(); toast('Clean session');
}

function getTaskArray(listId) {
  const cfg=LANES[listId]; if (!cfg) return null;
  return state.blocks[cfg.block][cfg.lane];
}

function addTask(listId) {
  const cfg=LANES[listId]; if (!cfg) return;
  const arr=getTaskArray(listId);
  if (!arr) return;
  arr.push(makeTask(''));
  renderAll(); save();
  setTimeout(()=>{
    const inputs=document.querySelectorAll(`#${listId} .task-input`);
    const last=inputs[inputs.length-1];
    if (last) last.focus();
  }, 30);
}


// ── AI Priority Assistant ──────────────────────────────────────────────────
const AI_KEY_STORAGE = 'focus_hub_ai_key';

function getStoredApiKey() {
  return localStorage.getItem(AI_KEY_STORAGE) || '';
}

function promptForApiKey() {
  const existing = getStoredApiKey();
  const key = prompt(
    'Enter your Anthropic API key to enable AI prioritization.\n\n' +
    'Get one free at console.anthropic.com → API Keys\n\n' +
    'Your key is stored only on this device and never sent anywhere except Anthropic.',
    existing
  );
  if (key && key.trim().startsWith('sk-ant-')) {
    localStorage.setItem(AI_KEY_STORAGE, key.trim());
    toast('API key saved — try Prioritize again');
    return key.trim();
  } else if (key !== null) {
    toast('Invalid key — must start with sk-ant-');
  }
  return null;
}

async function runAIPriority() {
  const btn = document.getElementById('btn-ai-priority');
  const output = document.getElementById('ai-priority-output');
  if (!btn || !output) return;

  // Get or prompt for API key
  let apiKey = getStoredApiKey();
  if (!apiKey) {
    apiKey = promptForApiKey();
    if (!apiKey) return;
  }

  const tasks = [];
  Object.keys(LANES).forEach(listId => {
    (getTaskArray(listId)||[]).forEach(t => {
      if ((t.text||'').trim()) tasks.push({ text: t.text.trim(), lane: laneLabel(listId), done: t.done });
    });
  });
  const intakeText = (document.getElementById('intake-input')?.value||'').trim();
  const t1 = (state.targets[0]?.text||'').trim();
  const t2 = (state.targets[1]?.text||'').trim();
  const notes = (state.start?.workNotes||'').trim();

  if (!tasks.length && !intakeText) {
    toast('Add some tasks first, then ask for prioritization');
    return;
  }

  btn.textContent = '✦ Thinking…';
  btn.disabled = true;
  output.hidden = false;
  output.innerHTML = '<div class="ai-priority-loading">Analyzing your tasks…</div>';

  const taskLines = tasks.map(t => '- [' + t.lane + ']' + (t.done ? ' (done)' : '') + ' ' + t.text).join('\n');
  const dumpLine = intakeText ? ('Brain dump (not yet routed):\n' + intakeText) : '';
  const notesLine = notes ? ('Work notes: ' + notes) : '';

  const prompt = 'You are a senior IT operations advisor helping Sierra, a Senior IT Deskside Support Analyst and Mobility Administrator at Repsol North America.\n\n'
    + 'Her current targets:\n'
    + 'T1: ' + (t1 || 'Not set') + '\n'
    + 'T2: ' + (t2 || 'Not set') + '\n\n'
    + 'Her current tasks:\n' + (taskLines || 'None yet') + '\n\n'
    + (dumpLine ? dumpLine + '\n\n' : '')
    + (notesLine ? notesLine + '\n\n' : '')
    + 'Based on this, give her:\n'
    + '1. PRIORITY CALL: What is the single most important thing she should be working on RIGHT NOW and why (2 sentences max)\n'
    + '2. SUGGESTED T1: What should her T1 target be today (one line)\n'
    + '3. SUGGESTED T2: What should her T2 target be today (one line)\n'
    + '4. TOP 3 TASKS: Ranked list with one-line reason each\n'
    + '5. WHAT TO IGNORE TODAY: Anything that can wait\n\n'
    + 'Be direct, specific, no fluff. Use her actual task names. Format with clear section headers.';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (response.status === 401) {
      localStorage.removeItem(AI_KEY_STORAGE);
      output.innerHTML = '<div class="ai-priority-error">API key invalid — click Prioritize again to enter a new key.</div>';
      setTimeout(() => { output.hidden = true; }, 5000);
      btn.textContent = '✦ Prioritize for me';
      btn.disabled = false;
      return;
    }
    if (response.status === 403) {
      output.innerHTML = '<div class="ai-priority-error">Access denied (403) — make sure your API key has credits at console.anthropic.com</div>';
      setTimeout(() => { output.hidden = true; }, 8000);
      btn.textContent = '✦ Prioritize for me';
      btn.disabled = false;
      return;
    }
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      output.innerHTML = '<div class="ai-priority-error">API error ' + response.status + ': ' + (errData.error?.message || 'Unknown') + '</div>';
      setTimeout(() => { output.hidden = true; }, 8000);
      btn.textContent = '✦ Prioritize for me';
      btn.disabled = false;
      return;
    }

    const data = await response.json();
    const text = (data.content||[]).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!text) throw new Error('No response');

    const formatted = text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
      .replace(/\n/g,'<br>');

    output.innerHTML = '<div class="ai-priority-result">'
      + '<div class="ai-priority-header">'
      + '<span class="ai-priority-icon">✦</span>'
      + '<span class="ai-priority-title">AI Priority Analysis</span>'
      + '<button type="button" class="ai-priority-close" id="btn-ai-close">✕</button>'
      + '</div>'
      + '<div class="ai-priority-body">' + formatted + '</div>'
      + '</div>';

    document.getElementById('btn-ai-close')?.addEventListener('click', () => { output.hidden = true; });

  } catch(err) {
    const errMsg = err && err.message ? err.message : 'Unknown error';
    // Clear stored key if it might be bad
    const currentKey = getStoredApiKey();
    if (currentKey) {
      output.innerHTML = '<div class="ai-priority-error">AI error: ' + errMsg + '<br><small>If this keeps happening, click Prioritize again to re-enter your key.</small></div>';
    } else {
      output.innerHTML = '<div class="ai-priority-error">No API key set. Click Prioritize for me to enter your key.</div>';
    }
    setTimeout(() => { output.hidden = true; }, 8000);
  } finally {
    btn.textContent = '✦ Prioritize for me';
    btn.disabled = false;
  }
}



// ── Focus Timer ──────────────────────────────────────────────────────────────
let focusTimerInterval = null;

function startFocusTimer() {
  clearInterval(focusTimerInterval);
  if (!state.focusId || !state.focusStartedAt) return;
  focusTimerInterval = setInterval(updateFocusTimerDisplay, 30000);
  updateFocusTimerDisplay();
}

function updateFocusTimerDisplay() {
  const el = document.getElementById('rail-focus-timer');
  if (!el) return;
  if (!state.focusId || !state.focusStartedAt) { el.classList.remove('visible'); return; }
  const elapsed = Math.floor((Date.now() - state.focusStartedAt) / 60000);
  el.classList.add('visible');
  if (elapsed >= 60) {
    el.className = 'rail-focus-timer visible over';
    el.textContent = Math.floor(elapsed/60) + 'h ' + (elapsed%60) + 'm on this task';
  } else if (elapsed >= 35) {
    el.className = 'rail-focus-timer visible warn';
    el.textContent = elapsed + ' min — consider wrapping up';
  } else {
    el.className = 'rail-focus-timer visible';
    el.textContent = elapsed + ' min on focus';
  }
}

function stopFocusTimer() {
  clearInterval(focusTimerInterval);
  const el = document.getElementById('rail-focus-timer');
  if (el) el.classList.remove('visible');
}

// ── Interruption Counter ─────────────────────────────────────────────────────
function renderInterruptions() {
  const el = document.getElementById('rail-interrupt-count');
  if (el) el.textContent = state.interruptions || 0;
}

// ── One-tap EOD Pre-fill ─────────────────────────────────────────────────────
function prefillEOD() {
  // Pre-fill closed today from done lane
  const done = (state.doneLane||[]).map(t=>(t.text||'').trim()).filter(Boolean);
  if (done.length && !(state.eod.closedToday||'').trim()) {
    state.eod.closedToday = done.join('\n');
  }

  // Pre-fill stuck from stale tasks
  const stuck = [];
  Object.keys(LANES).forEach(listId => {
    (getTaskArray(listId)||[]).forEach(t => {
      if ((t.text||'').trim() && !t.done && isStale(t)) {
        stuck.push({ id: uid(), text: (t.text||'').trim() });
      }
    });
  });
  if (stuck.length && !(state.eod.stillStuck||[]).length) {
    state.eod.stillStuck = stuck.slice(0, CAPS.stuck);
  }

  // Pre-fill parked as tomorrow blockers
  if ((state.parked||[]).length && !(state.eod.tomorrowFollowUps||[]).length) {
    state.eod.tomorrowFollowUps = (state.parked||[]).map(p => makeFollowUp(p.snow||'', p.sent||'', p.reply||'')).slice(0, CAPS.tomorrowFollowUps);
  }

  save();
  openEod();
  toast('EOD pre-filled from today\'s activity');
}


// ── Task Status Cycling ───────────────────────────────────────────────────────
const STATUS_CYCLE = [null, 'Pending', 'In Progress', 'Waiting', 'Done'];

function cycleStatus(listId, idx) {
  const arr = getTaskArray(listId);
  if (!arr || !arr[idx]) return;
  const task = ensureTask(arr[idx]);
  const current = task.status || null;
  const currentIdx = STATUS_CYCLE.indexOf(current);
  const next = STATUS_CYCLE[(currentIdx + 1) % STATUS_CYCLE.length];
  task.status = next;
  touchTask(task);
  // If cycled to Done — complete it
  if (next === 'Done') { completeTask(listId, idx); return; }
  renderAll(); save();
}

// ── Target ↔ Task Sync ────────────────────────────────────────────────────────
function syncTargetCompletionFromTask(taskText) {
  if (!taskText) return;
  const lower = taskText.trim().toLowerCase();
  state.targets.forEach((t, i) => {
    const tLower = (t.text||'').trim().toLowerCase();
    if (!tLower) return;
    if (lower.includes(tLower) || tLower.includes(lower)) {
      state.targets[i].done = true;
    }
  });
}

function syncTaskCompletionFromTarget(targetIdx) {
  const tText = (state.targets[targetIdx]?.text||'').trim().toLowerCase();
  if (!tText) return;
  Object.keys(LANES).forEach(listId => {
    const arr = getTaskArray(listId)||[];
    arr.forEach(task => {
      const taskLower = (task.text||'').trim().toLowerCase();
      if (taskLower.includes(tText) || tText.includes(taskLower)) {
        task.done = true;
        task.completedAt = Date.now();
      }
    });
  });
}

// ── Quick Capture ─────────────────────────────────────────────────────────────
function renderQuickCapture() {
  const list = document.getElementById('rail-capture-list');
  if (!list) return;
  const items = state.quickCapture || [];
  if (!items.length) { list.innerHTML = ''; return; }
  list.innerHTML = items.map((item, i) => `
    <div class="rail-capture-item">
      <span class="rail-capture-text">${esc(item.text)}</span>
      <button type="button" class="rail-capture-route" data-capture-route="${i}" title="Route to Brain Dump">→</button>
      <button type="button" class="rail-capture-del" data-capture-del="${i}">✕</button>
    </div>`).join('');
}

function addQuickCapture(text) {
  if (!text.trim()) return;
  if (!state.quickCapture) state.quickCapture = [];
  state.quickCapture.unshift({ id: uid(), text: text.trim(), capturedAt: Date.now() });
  if (state.quickCapture.length > 10) state.quickCapture = state.quickCapture.slice(0, 10);
  renderQuickCapture(); save();
  toast('Captured — process it after this block');
}

// ── Events ─────────────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('btn-new-day').addEventListener('click', newDay);

  // Quick Capture
  const captureInput = document.getElementById('rail-capture-input');
  document.getElementById('btn-rail-capture')?.addEventListener('click', () => {
    if (captureInput?.value.trim()) { addQuickCapture(captureInput.value); captureInput.value = ''; }
  });
  captureInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (captureInput.value.trim()) { addQuickCapture(captureInput.value); captureInput.value = ''; } }
  });
  document.getElementById('btn-add-interrupt')?.addEventListener('click', () => {
    state.interruptions = (state.interruptions||0) + 1;
    renderInterruptions(); save();
    toast('Interruption logged — ' + state.interruptions + ' today');
  });
  document.getElementById('btn-reset-interrupt')?.addEventListener('click', () => {
    state.interruptions = 0; renderInterruptions(); save();
  });
  document.getElementById('btn-add-parked')?.addEventListener('click', () => {
    if ((state.parked||[]).length >= 5) { toast('Max 5 parked items'); return; }
    const snow = prompt('SNOW / Reference number (optional):') || '';
    const sent = prompt('Waiting on who / what?') || '';
    const reply = prompt('What reply are you waiting for?') || '';
    if (!sent && !snow) return;
    if (!state.parked) state.parked = [];
    state.parked.push(makeParked(snow, sent, reply));
    renderParked(); save(); toast('Added to Parked');
  });
  document.getElementById('btn-ai-priority')?.addEventListener('click', runAIPriority);
  document.getElementById('btn-clean').addEventListener('click', cleanSession);
  document.getElementById('drawer-backdrop')?.addEventListener('click', closeTickets);
  document.getElementById('btn-eod-panel').addEventListener('click', prefillEOD);
  document.getElementById('btn-eod-close').addEventListener('click', closeEod);
  document.getElementById('eod-overlay').addEventListener('click', closeEod);
  document.getElementById('btn-intake-route').addEventListener('click', handleIntakeRoute);
  document.getElementById('btn-add-followup').addEventListener('click', ()=>{
    if (state.followUps.length>=CAPS.followUps) { toast('Max '+CAPS.followUps+' blockers'); return; }
    state.followUps.push(makeFollowUp('','','')); renderAll(); save();
  });
  document.getElementById('btn-add-stuck').addEventListener('click', ()=>{
    if ((state.eod.stillStuck||[]).length>=CAPS.stuck) { toast('Max '+CAPS.stuck); return; }
    state.eod.stillStuck.push({id:uid(),text:''}); renderEod(); save();
  });
  document.getElementById('btn-add-eod-followup').addEventListener('click', ()=>{
    if ((state.eod.tomorrowFollowUps||[]).length>=CAPS.tomorrowFollowUps) { toast('Max '+CAPS.tomorrowFollowUps); return; }
    state.eod.tomorrowFollowUps.push(makeFollowUp('','','')); renderEod(); save();
  });
  document.getElementById('btn-add-ticket')?.addEventListener('click', ()=>{
    if (state.tickets.length>=CAPS.tickets) { toast('Max '+CAPS.tickets+' tickets'); return; }
    state.tickets.push({id:uid(),number:'',user:'',nextMove:'',url:'',status:'Pending'}); renderAll(); save();
  });

  // Intake textarea — live preview + Enter to route
  const intakeInput = document.getElementById('intake-input');
  if (intakeInput) {
    intakeInput.addEventListener('input', e => updateIntakePreview(e.target.value));
    intakeInput.addEventListener('keydown', e => {
      if (e.key==='Enter'&&(e.ctrlKey||e.metaKey)) { e.preventDefault(); handleIntakeRoute(); }
    });
  }

  // Global delegated events
  document.addEventListener('input', e => {
    const t=e.target;
    if (t.classList.contains('target-input')) {
      if (state.start.targetsLocked) return;
      state.targets[+t.dataset.idx].text=t.value; save(); return;
    }
    if (t.classList.contains('task-input')) {
      const arr=getTaskArray(t.dataset.list); if (!arr) return;
      const task=ensureTask(arr[+t.dataset.idx]);
      const prev=(task.text||'').trim();
      task.text=t.value; fitTaskInput(t); touchTask(task);
      const now=(t.value||'').trim();
      // No global cap
      validateFocusId(); updateTaskCounter(); save(); return;
    }
    if (t.dataset.fu) {
      const list=t.dataset.fu==='mid'?state.followUps:state.eod.tomorrowFollowUps;
      list[+t.dataset.idx][t.dataset.field]=t.value; save(); return;
    }
    if (t.dataset.stuck!==undefined) { state.eod.stillStuck[+t.dataset.stuck].text=t.value; save(); return; }
    if (t.dataset.ticket!==undefined) { state.tickets[+t.dataset.ticket][t.dataset.field]=t.value; save(); return; }
    if (t.id==='eod-closed') { state.eod.closedToday=t.value; fitTaskInput(t); save(); }
    else if (t.id==='eod-t1') { state.eod.tomorrowT1=t.value; save(); }
    else if (t.id==='eod-t2') { state.eod.tomorrowT2=t.value; save(); }
    else if (t.id==='work-notes') { state.start.workNotes=t.value; fitTaskInput(t); save(); }
    else if (t.id==='reset-scan') { state.blocks.reset.scan=t.value; fitTaskInput(t); save(); }
  });

  document.addEventListener('focus', e => {
    if (e.target.classList.contains('task-input')) isEditingTask=true;
  }, true);

  document.addEventListener('blur', e => {
    const t=e.target;
    if (t.classList.contains('task-input')) {
      isEditingTask=false;
      const arr=getTaskArray(t.dataset.list);
      const task=arr?.[+t.dataset.idx];
      const currentText=task?(task.text||''):'';
      const renderedText=t.getAttribute('data-last-rendered')||'';
      if (currentText!==renderedText) renderAll();
      return;
    }
    if (t.classList.contains('target-input')) {
      const i=+t.dataset.idx;
      if (t.value!==(state.targets[i]?.text||'')) renderAll();
    }
  }, true);

  document.addEventListener('change', e => {
    const t=e.target;
    if (t.dataset.ticket!==undefined&&t.dataset.field==='status') {
      state.tickets[+t.dataset.ticket].status=t.value; save();
    }
    if (t.id==='chk-targets-locked') { state.start.targetsLocked=t.checked; renderAll(); save(); }

  });

  document.addEventListener('click', e => {
    const t=e.target;

    // Intake actions
    if (t.dataset.intakeConfirm!==undefined) { confirmIntakeItem(+t.dataset.intakeConfirm); return; }
    if (t.dataset.intakeDismiss!==undefined) { dismissIntakeItem(+t.dataset.intakeDismiss); return; }
    if (t.dataset.intakeLane!==undefined) {
      const idx = +t.dataset.intakeLane;
      if (intakeQueue[idx]) { intakeQueue[idx].lane = t.dataset.laneId; renderIntakeQueue(); }
      return;
    }

    // Rail up next — clicking item sets focus
    const upnextItem = t.closest('.rail-upnext-item');
    if (upnextItem?.dataset.setFocus) { setFocus(upnextItem.dataset.setFocus); renderAll(); save(); return; }

    if (t.dataset.targetDone!==undefined) {
      const i=+t.dataset.targetDone;
      state.targets[i].done=!state.targets[i].done;
      if (state.targets[i].done) syncTaskCompletionFromTarget(i);
      renderAll(); save(); return;
    }
    if (t.dataset.setFocus) { setFocus(t.dataset.setFocus); renderAll(); save(); return; }
    if (t.dataset.focusClear!==undefined) { setFocus(null); renderAll(); save(); return; }
    if (t.dataset.list&&t.classList.contains('task-check')) { completeTask(t.dataset.list,+t.dataset.idx); return; }
    if (t.dataset.moveBtn!==undefined) { showMoveMenu(t.dataset.moveBtn, t.dataset.list, +t.dataset.idx, t); return; }
    if (t.dataset.moveTo) { moveTask(t.dataset.fromList, +t.dataset.fromIdx, t.dataset.moveTo); document.querySelectorAll('.move-menu').forEach(m=>m.remove()); return; }
    if (t.dataset.add) { addTask(t.dataset.add); return; }
    if (t.dataset.list&&t.classList.contains('task-del')) {
      const arr=getTaskArray(t.dataset.list);
      const task=arr?.[+t.dataset.idx]; if (task) clearFocusIf(task.id);
      arr?.splice(+t.dataset.idx,1); renderAll(); save(); return;
    }
    if (t.dataset.doneDel!==undefined) { state.doneLane.splice(+t.dataset.doneDel,1); renderAll(); save(); return; }
    if (t.dataset.statusCycle!==undefined) { cycleStatus(t.dataset.statusCycle, +t.dataset.idx); return; }
    if (t.dataset.captureRoute!==undefined) {
      const idx = +t.dataset.captureRoute;
      const item = (state.quickCapture||[])[idx];
      if (item) {
        const inp = document.getElementById('intake-input');
        if (inp) { inp.value = item.text; updateIntakePreview(item.text); inp.focus(); }
        state.quickCapture.splice(idx, 1);
        renderQuickCapture(); save();
      }
      return;
    }
    if (t.dataset.captureDel!==undefined) {
      (state.quickCapture||[]).splice(+t.dataset.captureDel, 1);
      renderQuickCapture(); save(); return;
    }
    if (t.dataset.parkedDel!==undefined) { (state.parked||[]).splice(+t.dataset.parkedDel,1); renderParked(); save(); return; }
    if (t.dataset.fuDel) {
      const list=t.dataset.fuDel==='mid'?state.followUps:state.eod.tomorrowFollowUps;
      list.splice(+t.dataset.idx,1); renderAll(); save(); return;
    }
    if (t.dataset.stuckDel!==undefined) { state.eod.stillStuck.splice(+t.dataset.stuckDel,1); renderEod(); save(); return; }
    if (t.dataset.ticketDel!==undefined) { state.tickets.splice(+t.dataset.ticketDel,1); renderAll(); save(); }
  });

  document.addEventListener('keydown', e => {
    if (e.key==='Escape') { closeTickets(); closeEod(); }
  });

  let resizeTimer=null;
  window.addEventListener('resize', ()=>{
    clearTimeout(resizeTimer); resizeTimer=setTimeout(fitAllTaskInputs, 80);
  });
}

// ── Init ───────────────────────────────────────────────────────────────────
function init() {
  loadState();
  bindEvents();
  // Always hide AI output on load
  const aiOut = document.getElementById('ai-priority-output');
  if (aiOut) aiOut.hidden = true;
  renderAll();
  if (state.lastDay&&state.lastDay!==todayKey()) toast('New calendar day — use New Day when ready');
}

init();
