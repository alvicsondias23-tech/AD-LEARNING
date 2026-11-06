/* ============================================================
   AD-LEARNING — Complete Application Logic
   ============================================================ */

// ===== CONSTANTS =====
const STORAGE_KEY = 'adlearning_v1';
const TIMER_KEY = 'adlearning_timer_v1';
const DB_NAME = 'adlearning_db_v1';
const DB_STORE = 'blobs';
const PALETTE = ['#8B5CF6','#A78BFA','#7C3AED','#6366F1','#3B82F6','#0EA5E9','#06B6D4','#14B8A6','#10B981','#22C55E','#84CC16','#EAB308','#F59E0B','#F97316','#EF4444','#EC4899'];

// ===== STATE =====
function blankState() {
  return {
    subjects: [], courses: [], videos: [], notes: [],
    stats: { dailyStudy: {}, streak: 0, lastStudyDate: null, totalStudyTime: 0, sessionHistory: [] },
    timer: { 
      dailyGoal: 45, 
      pomodoro: { focus: 25, shortBreak: 5, longBreak: 15 },
      countdown: { h: 1, m: 30 },
      smartBreaks: { enabled: false, studyMins: 45, breakMins: 10 }
    },
    settings: {
      theme: 'dark', accent: '#8B5CF6', textSize: 'medium', reducedMotion: false,
      autoplay: true, defaultSpeed: 1.0,
      lastOpenedVideoId: null, lastOpenedCourseId: null,
      galleryStorageMode: 'copy'
    },
    planner: {}, 
    trash: [],
    // NEW FEATURES
    journal: [], 
    achievements: [], // ['first_course', 'streak_7', etc.]
    notebooks: [ { id: 'default', title: 'My Notebook', courseId: null, pages: [ { id: 'p1', title: 'Untitled', content: '', pinned: false, favorite: false, updatedAt: Date.now() } ] } ]
  };
}
let state = blankState();
let db = null;

// Stats State
let statsTab = 'overview';
let statsFilter = '7D';
let calViewDate = new Date();

// Timer State
let timer = { 
  running: false, paused: false, mode: 'stopwatch', elapsedBefore: 0, startTs: 0, intervalId: null, 
  phase: 'focus', linkedCourseId: null, 
  sessionStartTs: null, breakAccumulated: 0 
};

// Player State
let ytApiReady = false;
let ytPlayer = null;
let currentLocalVideo = null;
let currentLocalUrl = null;
let courseTab = 'all';
let playerTickInterval = null;
let currentVideoId = null;

// Feature State
let activeNotebookId = null;
let activePageId = null;
let journalViewDate = new Date();
let touchDragData = { active: false, startY: 0, item: null, initialIndex: -1 };

// ===== UTILS =====
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => Date.now();
const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), x = s%60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}` : `${m}:${String(x).padStart(2,'0')}`;
};
const fmtMin = (m) => {
  m = Math.round(m || 0);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m/60), mm = m%60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
};
const relDate = (ts) => {
  if (!ts) return '';
  const d = now() - ts, day = 86400000;
  if (d < 60000) return 'Just now';
  if (d < 3600000) return `${Math.floor(d/60000)}m ago`;
  if (d < day) return `${Math.floor(d/3600000)}h ago`;
  if (d < day*7) return `${Math.floor(d/day)}d ago`;
  return new Date(ts).toLocaleDateString();
};

// ===== YOUTUBE PARSER =====
function parseYouTubeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, '');
    let vid = null;
    if (host === 'youtu.be') vid = u.pathname.slice(1).split('/')[0];
    else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (u.pathname.startsWith('/shorts/')) vid = u.pathname.split('/')[2];
      else if (u.pathname.startsWith('/embed/')) vid = u.pathname.split('/')[2];
      else if (u.pathname.startsWith('/live/')) vid = u.pathname.split('/')[2];
      else vid = u.searchParams.get('v');
    }
    if (!vid) return null;
    vid = vid.split(/[?&#]/)[0];
    return vid.length >= 6 ? { videoId: vid } : null;
  } catch (e) { return null; }
}
const ytThumb = (vid) => `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
async function fetchYTTitle(vid) {
  try {
    const r = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${vid}`);
    if (!r.ok) throw 0;
    const j = await r.json();
    return { title: j.title || 'YouTube Video', channel: j.author_name || '', thumbnail: j.thumbnail_url || ytThumb(vid) };
  } catch (e) { return { title: 'YouTube Video', channel: '', thumbnail: ytThumb(vid) }; }
}

// ===== DB =====
function openDB() {
  return new Promise((res, rej) => {
    if (db) return res(db);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => { db = req.result; res(db); };
    req.onerror = () => rej(req.error);
  });
}
async function putBlob(key, blob) { const d = await openDB(); return new Promise((res, rej) => { const tx = d.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).put(blob, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function getBlob(key) { const d = await openDB(); return new Promise((res, rej) => { const tx = d.transaction(DB_STORE, 'readonly'); const r = tx.objectStore(DB_STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function delBlob(key) { const d = await openDB(); return new Promise((res, rej) => { const tx = d.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).delete(key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }

// ===== PERSIST =====
function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { toast('Storage full', 'error'); } }
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      state = Object.assign(blankState(), d);
      if (!Array.isArray(state.subjects)) state.subjects = [];
      if (!Array.isArray(state.courses)) state.courses = [];
      if (!Array.isArray(state.videos)) state.videos = [];
      if (!Array.isArray(state.notes)) state.notes = [];
      if (!Array.isArray(state.trash)) state.trash = [];
      if (!Array.isArray(state.journal)) state.journal = [];
      if (!Array.isArray(state.achievements)) state.achievements = [];
      if (!Array.isArray(state.notebooks) || state.notebooks.length === 0) state.notebooks = blankState().notebooks;
      
      state.stats = Object.assign(blankState().stats, d.stats || {});
      if (!Array.isArray(state.stats.sessionHistory)) state.stats.sessionHistory = [];
      state.timer = Object.assign(blankState().timer, d.timer || {});
      state.settings = Object.assign(blankState().settings, d.settings || {});
      state.planner = Object.assign({}, d.planner || {});
    }
  } catch (e) { console.error(e); }
  const t = now();
  state.trash = state.trash.filter(it => { if (it.expiresAt > t) return true; if (it.kind === 'video' && it.item.blobKey) delBlob(it.item.blobKey).catch(()=>{}); return false; });
}

// ===== TOAST =====
function toast(msg, type = 'info', action = null, actionLabel = 'Undo') {
  const root = $('#toast-root'); if (!root) return;
  const el = document.createElement('div'); el.className = `toast ${type}`; el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) { const b = document.createElement('button'); b.className = 'toast-action'; b.textContent = actionLabel; b.onclick = () => { action(); el.remove(); }; el.appendChild(b); }
  root.appendChild(el);
  setTimeout(() => { el.style.transition = 'all .3s'; el.style.opacity = '0'; el.style.transform = 'translateY(20px)'; setTimeout(() => el.remove(), 300); }, action ? 5000 : 2600);
}

// ===== MODALS =====
function openSheet(html, center = false) {
  const wrap = document.createElement('div'); wrap.className = 'modal-backdrop' + (center ? ' center' : '');
  wrap.innerHTML = `<div class="sheet">${center ? '' : '<div class="sheet-handle"></div>'}${html}</div>`;
  wrap.addEventListener('click', e => { if (e.target === wrap) closeSheet(wrap); });
  $('#modal-root').appendChild(wrap); return wrap;
}
function closeSheet(w) { if (!w) return; w.style.transition = 'opacity .2s'; w.style.opacity = '0'; setTimeout(() => w.remove(), 200); }
function confirmBox(title, msg, ok = 'Confirm', danger = false) {
  return new Promise(resolve => {
    const w = openSheet(`<div class="sheet-title">${esc(title)}</div><p class="muted" style="font-size:.9em;line-height:1.6;margin-bottom:18px;">${esc(msg)}</p><div class="sheet-actions"><button class="btn btn-ghost" data-x="no">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-x="yes">${esc(ok)}</button></div>`, true);
    w.querySelector('[data-x="no"]').onclick = () => { closeSheet(w); resolve(false); };
    w.querySelector('[data-x="yes"]').onclick = () => { closeSheet(w); resolve(true); };
  });
}

// ===== HELPERS =====
const getSubject = id => state.subjects.find(s => s.id === id);
const getCourse  = id => state.courses.find(c => c.id === id);
const getVideo   = id => state.videos.find(v => v.id === id);
const liveSubjects = () => state.subjects.filter(s => !s.archivedAt).sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
const liveCourses  = sid => state.courses.filter(c => c.subjectId === sid && !c.archivedAt).sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
const courseVideos = cid => state.videos.filter(v => v.courseId === cid && !v._deleted).sort((a, b) => (a.order ?? a.addedAt) - (b.order ?? b.addedAt));
function courseProgress(cid) {
  const v = courseVideos(cid); const t = v.length, c = v.filter(x => x.completed).length;
  return { total: t, completed: c, pct: t === 0 ? 0 : Math.round(c / t * 100) };
}
function todayMin() { return state.stats.dailyStudy[todayKey()] || 0; }
function addStudyMin(m) {
  if (m <= 0) return;
  const k = todayKey();
  state.stats.dailyStudy[k] = (state.stats.dailyStudy[k] || 0) + m;
  state.stats.totalStudyTime = (state.stats.totalStudyTime || 0) + m;
  if (state.stats.lastStudyDate !== k) {
    const y = new Date(); y.setDate(y.getDate() - 1);
    state.stats.streak = (state.stats.lastStudyDate === todayKey(y)) ? (state.stats.streak || 0) + 1 : 1;
    state.stats.lastStudyDate = k;
  }
  save();
  checkAchievements();
}

// ===== THEME ENGINE =====
function applyTheme() {
  const hex = state.settings.accent || '#8B5CF6';
  document.documentElement.style.setProperty('--accent', hex);
  
  // Calculate lighter/darker variants for gradients and glows
  let r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
  document.documentElement.style.setProperty('--accent-dark', `rgb(${Math.max(0,r-20)}, ${Math.max(0,g-20)}, ${Math.max(0,b-20)})`);
  document.documentElement.style.setProperty('--accent-light', `rgb(${Math.min(255,r+20)}, ${Math.min(255,g+20)}, ${Math.min(255,b+20)})`);
  document.documentElement.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.35)`);
}

// ===== NAV =====
function switchScreen(name) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === name));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  try {
    if (name === 'home') renderHome();
    else if (name === 'subjects') renderSubjects();
    else if (name === 'timer') renderTimer();
    else if (name === 'stats') renderStats();
  } catch (err) { console.error("Render error on screen " + name, err); }
}

// ===== FEATURE 1: ACHIEVEMENTS LOGIC =====
const ACHIEVEMENTS_DEFS = [
  { id: 'first_course', icon: '🎓', title: 'First Steps', desc: 'Complete your first course' },
  { id: 'streak_7', icon: '🔥', title: 'On Fire', desc: 'Reach a 7-day study streak' },
  { id: 'hours_10', icon: '⏱️', title: 'Dedicated', desc: 'Study for 10 total hours' },
  { id: 'hours_50', icon: '⏳', title: 'Scholar', desc: 'Study for 50 total hours' },
  { id: 'hours_100', icon: '🏆', title: 'Master', desc: 'Study for 100 total hours' },
  { id: 'videos_100', icon: '📺', title: 'Binge Watcher', desc: 'Complete 100 videos' }
];

function checkAchievements() {
  let newlyUnlocked = [];
  const totalMins = state.stats.totalStudyTime || 0;
  const completedVids = state.videos.filter(v => v.completed && !v._deleted).length;
  const hasCompletedCourse = state.courses.some(c => { const p = courseProgress(c.id); return p.pct === 100 && p.total > 0; });
  const streak = state.stats.streak || 0;

  const unlock = (id, condition) => {
    if (condition && !state.achievements.includes(id)) {
      state.achievements.push(id);
      newlyUnlocked.push(ACHIEVEMENTS_DEFS.find(a => a.id === id).title);
    }
  };

  unlock('first_course', hasCompletedCourse);
  unlock('streak_7', streak >= 7);
  unlock('hours_10', totalMins >= 600);
  unlock('hours_50', totalMins >= 3000);
  unlock('hours_100', totalMins >= 6000);
  unlock('videos_100', completedVids >= 100);

  if (newlyUnlocked.length > 0) {
    save();
    newlyUnlocked.forEach(title => {
      setTimeout(() => toast(`🏆 Achievement Unlocked: ${title}!`, 'success'), 1000);
    });
  }
}

function renderAchievements() {
  const el = $('#achievements-overlay');
  const totalMins = state.stats.totalStudyTime || 0;
  const completedVids = state.videos.filter(v => v.completed && !v._deleted).length;
  const streak = state.stats.streak || 0;
  
  // Progress calculations
  const getProgress = (id) => {
    if (id === 'streak_7') return Math.min(100, (streak / 7) * 100);
    if (id === 'hours_10') return Math.min(100, (totalMins / 600) * 100);
    if (id === 'hours_50') return Math.min(100, (totalMins / 3000) * 100);
    if (id === 'hours_100') return Math.min(100, (totalMins / 6000) * 100);
    if (id === 'videos_100') return Math.min(100, (completedVids / 100) * 100);
    if (id === 'first_course') {
      const maxPct = state.courses.reduce((max, c) => Math.max(max, courseProgress(c.id).pct), 0);
      return maxPct;
    }
    return 0;
  };

  let html = `
    <div class="page-header" style="padding-top:8px;">
      <button class="icon-btn" id="ach-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg></button>
      <h1 style="flex:1;text-align:center;font-size:1.2em;">Achievements</h1>
      <div style="width:42px;"></div>
    </div>
    <div class="achievement-grid">
  `;

  ACHIEVEMENTS_DEFS.forEach(def => {
    const unlocked = state.achievements.includes(def.id);
    const progress = getProgress(def.id);
    html += `
      <div class="ach-card ${unlocked ? 'unlocked' : ''}">
        <div class="ach-icon">${def.icon}</div>
        <div class="ach-title">${def.title}</div>
        <div class="ach-desc">${def.desc}</div>
        ${!unlocked ? `<div class="ach-progress"><div class="fill" style="width:${progress}%"></div></div>` : ''}
      </div>
    `;
  });

  html += `</div>`;
  el.innerHTML = html;
  
  $('#ach-back', el).onclick = () => {
    el.classList.remove('active');
    $('#bottom-nav').classList.remove('hidden');
    $('#fab').classList.remove('hidden');
  };
}

// ===== FEATURE 2: STUDY JOURNAL =====
function renderJournal() {
  const el = $('#journal-overlay');
  const entries = [...state.journal].sort((a,b) => new Date(b.date) - new Date(a.date));

  let html = `
    <div class="page-header" style="padding-top:8px;">
      <button class="icon-btn" id="jnl-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg></button>
      <h1 style="flex:1;text-align:center;font-size:1.2em;">Study Journal</h1>
      <button class="icon-btn" id="jnl-add" style="background:rgba(139,92,246,0.15); color:var(--accent-light); border-color:rgba(139,92,246,0.3);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
    </div>
    <div class="search-bar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input type="search" id="jnl-search" placeholder="Search entries..."></div>
  `;

  if (entries.length === 0) {
    html += `<div class="premium-empty"><div class="icon-wrap">📖</div><h3>No entries yet</h3><p>Write down what you learned today.</p></div>`;
  } else {
    entries.forEach(e => {
      html += `
        <div class="journal-card" data-id="${e.id}">
          <div class="journal-date">${new Date(e.date).toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'short', day:'numeric' })}</div>
          <div class="journal-body">${esc(e.text)}</div>
          <div class="journal-actions">
            <button class="btn btn-sm btn-ghost" data-edit="${e.id}">Edit</button>
            <button class="btn btn-sm btn-danger" data-del="${e.id}">Delete</button>
          </div>
        </div>
      `;
    });
  }

  el.innerHTML = html;

  $('#jnl-back', el).onclick = () => {
    el.classList.remove('active');
    $('#bottom-nav').classList.remove('hidden');
    $('#fab').classList.remove('hidden');
  };
  $('#jnl-add', el).onclick = () => openJournalEditor(null);
  
  el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openJournalEditor(b.dataset.edit));
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('Delete Entry?', 'This cannot be undone.', 'Delete', true)) return;
    state.journal = state.journal.filter(x => x.id !== b.dataset.del);
    save(); renderJournal();
  });

  const search = $('#jnl-search', el);
  search.oninput = (e) => {
    const q = e.target.value.toLowerCase().trim();
    el.querySelectorAll('.journal-card').forEach(card => {
      card.style.display = card.querySelector('.journal-body').textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  };
}

function openJournalEditor(id) {
  const existing = id ? state.journal.find(x => x.id === id) : null;
  const html = `
    <div class="sheet-title">${existing ? 'Edit Entry' : 'New Journal Entry'}</div>
    <div class="field"><label class="field-label">Date</label><input type="date" class="input" id="jnl-date" value="${existing ? existing.date : todayKey()}"></div>
    <div class="field"><label class="field-label">What did you study?</label><textarea class="textarea" id="jnl-text" placeholder="I learned about..." style="min-height:150px;">${existing ? esc(existing.text) : ''}</textarea></div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" onclick="closeAllSheets()">Cancel</button>
      <button class="btn btn-primary" id="jnl-save">Save Entry</button>
    </div>
  `;
  const w = openSheet(html);
  w.querySelector('#jnl-save').onclick = () => {
    const date = w.querySelector('#jnl-date').value;
    const text = w.querySelector('#jnl-text').value.trim();
    if (!text) return toast('Write something first', 'error');
    
    if (existing) {
      existing.date = date; existing.text = text;
    } else {
      state.journal.push({ id: uid(), date, text, createdAt: now() });
    }
    save(); closeSheet(w); renderJournal(); toast('Journal saved', 'success');
  };
}

// ===== FEATURE 3: CUSTOM THEMES =====
function openThemeSettings() {
  const presets = ['#8B5CF6', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#6366F1', '#14B8A6'];
  const current = state.settings.accent;

  const html = `
    <div class="sheet-title">Customise Theme</div>
    <div class="field">
      <label class="field-label">Accent Colour</label>
      <div class="theme-presets">
        ${presets.map(c => `<button class="theme-circle ${c === current ? 'active' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
      </div>
      <div style="display:flex; gap:10px; align-items:center; margin-top:16px;">
        <input type="color" id="custom-color-picker" value="${current}" style="width:50px; height:50px; padding:0; border:none; border-radius:12px; background:transparent; cursor:pointer;">
        <div style="flex:1;">
          <div style="font-weight:600; font-size:0.9em;">Custom Colour</div>
          <div class="tiny dim">Pick any colour you want</div>
        </div>
      </div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" onclick="closeAllSheets()">Close</button>
    </div>
  `;
  const w = openSheet(html);
  
  w.querySelectorAll('.theme-circle').forEach(btn => {
    btn.onclick = () => {
      state.settings.accent = btn.dataset.color;
      applyTheme(); save();
      w.querySelectorAll('.theme-circle').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      w.querySelector('#custom-color-picker').value = btn.dataset.color;
      toast('Theme updated', 'success');
    };
  });

  w.querySelector('#custom-color-picker').oninput = (e) => {
    state.settings.accent = e.target.value;
    applyTheme(); save();
    w.querySelectorAll('.theme-circle').forEach(x => x.classList.remove('active'));
  };
}

// ===== FEATURE 4: ADVANCED NOTEBOOK =====
function renderNotebook() {
  const el = $('#notebook-overlay');
  
  if (!activeNotebookId) activeNotebookId = state.notebooks[0].id;
  const nb = state.notebooks.find(n => n.id === activeNotebookId) || state.notebooks[0];
  
  if (!activePageId || !nb.pages.find(p => p.id === activePageId)) {
    activePageId = nb.pages.length > 0 ? nb.pages[0].id : null;
  }
  const page = activePageId ? nb.pages.find(p => p.id === activePageId) : null;

  let html = `
    <div class="page-header" style="padding-top:8px;">
      <button class="icon-btn" id="nb-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg></button>
      <h1 style="flex:1;text-align:center;font-size:1.2em;">Advanced Notebook</h1>
      <button class="icon-btn" id="nb-settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    </div>

    <div class="nb-layout">
      <!-- Notebooks List -->
      <div class="nb-sidebar">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <h3 style="font-size:0.9em; color:var(--text-1);">My Notebooks</h3>
          <button class="btn btn-sm btn-ghost" id="nb-add-notebook">+ New</button>
        </div>
        <div style="display:flex; gap:8px; overflow-x:auto; padding-bottom:8px;">
          ${state.notebooks.map(n => `<button class="nb-list-item ${n.id === nb.id ? 'active' : ''}" data-nb="${n.id}">${esc(n.title)}</button>`).join('')}
        </div>
      </div>

      <!-- Pages List -->
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <h3 style="font-size:0.9em; color:var(--text-1);">Pages in ${esc(nb.title)}</h3>
        <button class="btn btn-sm btn-primary" id="nb-add-page">+ New Page</button>
      </div>
      <div style="display:flex; gap:8px; overflow-x:auto; padding-bottom:12px;">
        ${nb.pages.map(p => `<button class="nb-list-item ${p.id === activePageId ? 'active' : ''}" data-page="${p.id}" style="min-width:100px;">${esc(p.title || 'Untitled')}</button>`).join('')}
      </div>

      <!-- Editor -->
      <div class="nb-editor">
        ${page ? `
          <input class="input" id="nb-page-title" value="${esc(page.title)}" placeholder="Page Title" style="margin-bottom:12px; font-weight:700; font-size:1.1em; background:transparent; border:none; border-bottom:1px solid var(--border); border-radius:0; padding-left:0;">
          <div class="nb-toolbar">
            <button data-cmd="bold"><b>B</b></button>
            <button data-cmd="italic"><i>I</i></button>
            <button data-cmd="underline"><u>U</u></button>
            <button data-cmd="formatBlock" data-val="h1">H1</button>
            <button data-cmd="formatBlock" data-val="h2">H2</button>
            <button data-cmd="insertUnorderedList">• List</button>
            <button data-cmd="insertOrderedList">1. List</button>
            <button data-cmd="createLink">Link</button>
          </div>
          <div class="nb-content" id="nb-page-content" contenteditable="true">${page.content}</div>
        ` : `<div style="text-align:center; padding:40px; color:var(--text-2);">Create a page to start writing.</div>`}
      </div>
    </div>
  `;

  el.innerHTML = html;

  $('#nb-back', el).onclick = () => {
    el.classList.remove('active');
    $('#bottom-nav').classList.remove('hidden');
    $('#fab').classList.remove('hidden');
  };

  el.querySelectorAll('[data-nb]').forEach(b => b.onclick = () => {
    activeNotebookId = b.dataset.nb; activePageId = null; renderNotebook();
  });
  
  el.querySelectorAll('[data-page]').forEach(b => b.onclick = () => {
    activePageId = b.dataset.page; renderNotebook();
  });

  $('#nb-add-notebook').onclick = () => {
    const title = prompt("Notebook Name:");
    if (title) {
      state.notebooks.push({ id: uid(), title, courseId: null, pages: [] });
      save(); renderNotebook();
    }
  };

  $('#nb-add-page').onclick = () => {
    if (!nb) return;
    const newPage = { id: uid(), title: 'Untitled', content: '', pinned: false, favorite: false, updatedAt: now() };
    nb.pages.push(newPage);
    activePageId = newPage.id;
    save(); renderNotebook();
  };

  if (page) {
    const titleInp = $('#nb-page-title', el);
    const contentEl = $('#nb-page-content', el);
    
    // Autosave logic
    let saveTimeout;
    const triggerSave = () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        page.title = titleInp.value;
        page.content = contentEl.innerHTML;
        page.updatedAt = now();
        save();
      }, 1000);
    };

    titleInp.oninput = triggerSave;
    contentEl.oninput = triggerSave;

    // Rich Text Toolbar
    el.querySelectorAll('.nb-toolbar button').forEach(btn => {
      btn.onmousedown = (e) => {
        e.preventDefault(); // prevent losing focus in contenteditable
        const cmd = btn.dataset.cmd;
        const val = btn.dataset.val || null;
        
        if (cmd === 'createLink') {
          const url = prompt("Enter link URL:");
          if (url) document.execCommand(cmd, false, url);
        } else {
          document.execCommand(cmd, false, val);
        }
        contentEl.focus();
        triggerSave();
      };
    });
  }
}

// ===== HOME DASHBOARD =====
function renderHome() {
  const el = $('#screen-home');
  const today = todayMin();
  const goal = state.timer.dailyGoal || 45;
  const goalPct = Math.min(100, Math.round((today / goal) * 100));
  const totalCompleted = state.videos.filter(v => v.completed && !v._deleted).length;
  const hasCourses = liveSubjects().length > 0;

  let lastV = state.settings.lastOpenedVideoId ? getVideo(state.settings.lastOpenedVideoId) : null;
  if (lastV && lastV._deleted) { lastV = null; state.settings.lastOpenedVideoId = null; save(); }
  
  let lastC = lastV ? getCourse(lastV.courseId) : null;
  if (lastC && lastC.archivedAt) { lastV = null; lastC = null; state.settings.lastOpenedVideoId = null; save(); }
  
  if (!lastV) {
    const cand = state.courses.find(c => { const p = courseProgress(c.id); return !c.archivedAt && p.total > 0 && p.completed < p.total; });
    if (cand) {
      lastC = cand;
      const vids = courseVideos(cand.id);
      lastV = vids.find(v => !v.completed) || vids[0];
    }
  }

  let html = '';

  if (lastV && lastC) {
    const topCourse = getSubject(lastC.subjectId);
    const thumb = lastV.thumbnail || (lastV.type === 'youtube' ? ytThumb(lastV.videoId) : '');
    const prog = courseProgress(lastC.id);
    html += `
      <div class="hero-continue" id="hero-continue">
        ${thumb ? `<img class="hero-thumb" src="${esc(thumb)}" alt="">` : ''}
        <div class="hero-content">
          <div class="hero-tag">▶ Continue Learning</div>
          <div class="hero-title">${esc(lastV.title)}</div>
          <div class="hero-sub">${esc(topCourse?.name || '')} • ${esc(lastC.name)}</div>
          <div style="margin-bottom:14px;"><div class="progress-mini"><div class="fill" style="width:${prog.pct}%"></div></div></div>
          <div class="hero-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>${lastV.playbackPosition > 5 ? 'Resume' : 'Play'}</div>
        </div>
      </div>`;
  } else if (!hasCourses) {
    html += `
      <div class="onboarding-card">
        <h3>Welcome to AD-LEARNING</h3>
        <div class="step-row"><div class="step-num">1</div><div class="step-text"><strong>Create a Course</strong>Group your learning topics</div></div>
        <div class="step-row"><div class="step-num">2</div><div class="step-text"><strong>Add a Subject</strong>Organize specific classes inside</div></div>
        <div class="step-row"><div class="step-num">3</div><div class="step-text"><strong>Paste a YouTube URL</strong>Start learning immediately</div></div>
        <button class="btn btn-primary btn-block" id="hero-create" style="margin-top:16px;">Create First Course</button>
      </div>`;
  } else {
    html += `
      <div class="hero-continue" id="hero-empty">
        <div class="hero-content">
          <div class="hero-tag">✦ Ready to Learn</div>
          <div class="hero-title">Your dashboard is waiting</div>
          <div class="hero-sub">Add your first video to start building your streak.</div>
          <button class="hero-play" id="hero-create"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add Video Link</button>
        </div>
      </div>`;
  }

  html += `
    <div class="stats-strip">
      <div class="stat-pill accent"><div class="stat-val">${fmtMin(today)}</div><div class="stat-lbl">Today</div></div>
      <div class="stat-pill streak-pill"><div class="stat-val">🔥 ${state.stats.streak || 0}</div><div class="stat-lbl">Streak</div></div>
      <div class="stat-pill"><div class="stat-val">${totalCompleted}</div><div class="stat-lbl">Videos Done</div></div>
      <div class="stat-pill"><div class="stat-val">${goalPct}%</div><div class="stat-lbl">Goal</div></div>
    </div>`;

  html += `
    <div class="quick-actions">
      <button class="qa" data-qa="yt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48"/></svg><span>Add Video Link</span></button>
      <button class="qa" data-qa="gallery"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Upload File</span></button>
      <button class="qa" data-qa="timer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span>Start Focus Timer</span></button>
      <button class="qa" data-qa="subject"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span>New Course</span></button>
    </div>`;

  const recentCourses = [...liveSubjects()].slice(0, 8);
  if (recentCourses.length) {
    html += `<div class="section-head"><h2>Recent Courses</h2><button class="link" data-go="subjects">See All →</button></div><div class="h-scroll">`;
    for (const c of recentCourses) {
      const subs = liveCourses(c.id);
      html += `<button class="subject-tile" data-open-subject="${c.id}" style="background:${c.color || 'linear-gradient(135deg,#8B5CF6,#7C3AED)'};${c.coverImage ? `background-image:url('${esc(c.coverImage)}');background-size:cover;` : ''}"><div class="tile-title">${esc(c.name)}</div><div class="tile-meta">${subs.length} subject${subs.length !== 1 ? 's' : ''}</div></button>`;
    }
    html += `</div>`;
  }

  const inProg = state.courses.filter(c => { const p = courseProgress(c.id); return !c.archivedAt && p.total > 0 && p.completed < p.total; }).slice(0, 5);
  if (inProg.length) {
    html += `<div class="section-head"><h2>In-Progress Subjects</h2></div>`;
    for (const c of inProg) {
      const p = courseProgress(c.id); const topCourse = getSubject(c.subjectId);
      html += `<div class="course-row" data-open-course="${c.id}"><div class="cr-thumb">${c.coverImage ? `<img src="${esc(c.coverImage)}" style="width:100%;height:100%;object-fit:cover;">` : esc((c.name[0] || '?').toUpperCase())}</div><div class="cr-info"><div class="cr-title">${esc(c.name)}</div><div class="cr-meta">${esc(topCourse?.name || '')} • ${p.completed}/${p.total} videos</div><div class="progress-mini"><div class="fill" style="width:${p.pct}%"></div></div></div></div>`;
    }
  }

  const recentVids = [...state.videos].filter(v => !v._deleted).sort((a, b) => b.addedAt - a.addedAt).slice(0, 5);
  if (recentVids.length) {
    html += `<div class="section-head"><h2>Recently Added</h2></div>`;
    for (const v of recentVids) {
      const c = getCourse(v.courseId); const thumb = v.thumbnail || (v.type === 'youtube' ? ytThumb(v.videoId) : '');
      html += `<div class="video-item" data-open-video="${v.id}"><div class="vi-thumb">${thumb ? `<img src="${esc(thumb)}" alt="">` : ''}<div class="badge ${v.type === 'youtube' ? 'yt' : 'local'}">${v.type === 'youtube' ? 'YT' : 'LOCAL'}</div></div><div class="vi-info"><div class="vi-title">${esc(v.title)}</div><div class="vi-meta">${esc(c?.name || '')} • ${relDate(v.addedAt)}</div></div></div>`;
    }
  }

  el.innerHTML = html;

  const hero = $('#hero-continue', el); if (hero) hero.onclick = () => openPlayer(lastV.id);
  const heroEmpty = $('#hero-empty', el); if (heroEmpty) $('#hero-create', el).onclick = () => hasCourses ? openAddYT() : openSubjectEditor(null);
  const onboardBtn = $('#hero-create', el); if (onboardBtn && !hasCourses) onboardBtn.onclick = () => openSubjectEditor(null);

  $$('[data-qa]', el).forEach(b => b.onclick = () => { const a = b.dataset.qa; if (a === 'yt') openAddYT(); else if (a === 'gallery') openAddGallery(); else if (a === 'subject') openSubjectEditor(null); else if (a === 'timer') switchScreen('timer'); });
  $$('[data-go]', el).forEach(b => b.onclick = () => switchScreen(b.dataset.go));
  $$('[data-open-subject]', el).forEach(b => b.onclick = () => openSubject(b.dataset.openSubject));
  $$('[data-open-course]', el).forEach(b => b.onclick = () => openCourse(b.dataset.openCourse));
  $$('[data-open-video]', el).forEach(b => b.onclick = () => openPlayer(b.dataset.openVideo));
}

// ===== COURSES SCREEN =====
function renderSubjects() {
  const el = $('#screen-subjects');
  const courses = liveSubjects();
  let html = `
    <div class="modern-header">
      <h1>My Courses</h1>
      <div class="header-actions">
        <button class="icon-btn" id="btn-trash"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg></button>
        <button class="icon-btn" id="btn-settings"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
        <button class="icon-btn" id="btn-new-subject" style="background:rgba(139,92,246,0.15); color:var(--accent-light); border-color:rgba(139,92,246,0.3);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
      </div>
    </div>
    <div class="search-bar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input type="search" id="global-search" placeholder="Search courses, subjects, videos..."></div>`;

  if (!courses.length) {
    html += `<div class="premium-empty"><div class="icon-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div><h3>No courses yet</h3><p>Create your first course to start building your learning curriculum.</p><button class="btn-premium" id="btn-first-subject"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Create First Course</button></div>`;
  } else {
    html += `<div class="subjects-grid">`;
    for (const s of courses) {
      const subs = liveCourses(s.id); 
      const bg = s.color || 'linear-gradient(135deg,#8B5CF6,#7C3AED)';
      html += `<button class="subject-card" data-open-subject="${s.id}" style="background:${s.coverImage ? `url('${esc(s.coverImage)}') center/cover` : bg};"><div class="sc-info"><div class="sc-name">${esc(s.name)}</div><div class="sc-meta">${subs.length} subject${subs.length !== 1 ? 's' : ''}</div></div></button>`;
    }
    html += `</div>`;
  }
  el.innerHTML = html;

  $('#btn-new-subject', el).onclick = () => openSubjectEditor(null);
  const first = $('#btn-first-subject', el); if (first) first.onclick = () => openSubjectEditor(null);
  $$('[data-open-subject]', el).forEach(b => b.onclick = () => openSubject(b.dataset.openSubject));
  $('#btn-trash', el).onclick = () => openTrashSheet();
  $('#btn-settings', el).onclick = () => openSettingsSheet();
  const search = $('#global-search', el);
  search.oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { renderSubjects(); return; }
    renderSearchResults(q, el);
  };
}

function openSubject(subjectId) {
  const s = getSubject(subjectId); if (!s) return;
  const subjectsList = liveCourses(subjectId); 
  let html = `<div class="modern-header" style="padding-top:0;"><h1 style="font-size:1.3em;">${esc(s.name)}</h1><button class="icon-btn" id="subj-edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button></div>`;
  if (!subjectsList.length) html += `<p class="muted" style="text-align:center;padding:30px 0;">No subjects created in this course yet.</p>`;
  else {
    html += `<div class="subjects-grid list">`;
    for (const c of subjectsList) {
      const p = courseProgress(c.id);
      html += `<button class="subject-card" data-open-course="${c.id}" style="background:${c.coverImage ? `url('${esc(c.coverImage)}') center/cover` : (s.color || 'linear-gradient(135deg,#8B5CF6,#7C3AED)')};min-height:90px;"><div class="sc-info" style="flex:1;"><div class="sc-name">${esc(c.name)}</div><div class="sc-meta">${p.completed}/${p.total} videos • ${p.pct}%</div><div class="progress-mini" style="margin-top:6px;"><div class="fill" style="width:${p.pct}%"></div></div></div></button>`;
    }
    html += `</div>`;
  }
  html += `<button class="btn btn-primary btn-block" id="subj-new-course" style="margin-top:16px;">+ New Subject in ${esc(s.name)}</button><button class="btn btn-ghost btn-block" id="subj-close" style="margin-top:8px;">Close</button>`;
  const w = openSheet(html);
  w.querySelector('#subj-edit').onclick = () => { closeSheet(w); openSubjectEditor(subjectId); };
  w.querySelector('#subj-close').onclick = () => closeSheet(w);
  w.querySelector('#subj-new-course').onclick = () => { closeSheet(w); openCourseEditor(null, subjectId); };
  w.querySelectorAll('[data-open-course]').forEach(b => b.onclick = () => { closeSheet(w); openCourse(b.dataset.openCourse); });
}

function openSubjectEditor(subjectId) {
  const existing = subjectId ? getSubject(subjectId) : null;
  let pickedColor = existing?.color || PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const html = `
    <div class="sheet-title">${existing ? 'Edit Course' : 'New Course'}</div>
    <div class="field"><label class="field-label">Course name</label><input class="input" id="s-name" placeholder="e.g. Computer Science" value="${esc(existing?.name || '')}"></div>
    <div class="field"><label class="field-label">Accent colour</label><div class="color-palette" id="s-palette">${PALETTE.map(c => `<button class="color-swatch ${c === pickedColor ? 'selected' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}</div></div>
    <div class="field"><label class="field-label">Cover image URL (optional)</label><input class="input" id="s-cover" placeholder="https://..." value="${esc(existing?.coverImage || '')}"></div>
    <div class="sheet-actions">${existing ? `<button class="btn btn-danger" id="s-del">Delete</button>` : ''}<button class="btn btn-ghost" id="s-cancel">Cancel</button><button class="btn btn-primary" id="s-save">Save</button></div>`;
  const w = openSheet(html);
  w.querySelectorAll('[data-c]').forEach(sw => sw.onclick = () => {
    pickedColor = sw.dataset.c;
    w.querySelectorAll('[data-c]').forEach(x => x.classList.toggle('selected', x.dataset.c === pickedColor));
  });
  w.querySelector('#s-cancel').onclick = () => closeSheet(w);
  if (existing) w.querySelector('#s-del').onclick = async () => {
    if (!await confirmBox('Delete Course?', `"${existing.name}" and all content will move to Trash for 30 days.`, 'Delete', true)) return;
    closeSheet(w); archiveSubject(subjectId);
  };
  w.querySelector('#s-save').onclick = () => {
    const name = w.querySelector('#s-name').value.trim(); const cover = w.querySelector('#s-cover').value.trim();
    if (!name) return toast('Enter a course name', 'error');
    if (existing) { existing.name = name; existing.color = pickedColor; existing.coverImage = cover; }
    else { state.subjects.push({ id: uid(), name, color: pickedColor, coverImage: cover, order: state.subjects.length, createdAt: now() }); }
    save(); closeSheet(w); toast(existing ? 'Course updated' : 'Course created', 'success'); renderHome(); renderSubjects();
  };
}

function openCourseEditor(courseId, subjectId) {
  const existing = courseId ? getCourse(courseId) : null;
  const sub = getSubject(existing?.subjectId || subjectId);
  if (!sub) return toast('Course not found', 'error');
  const html = `
    <div class="sheet-title">${existing ? 'Edit Subject' : `New Subject in ${esc(sub.name)}`}</div>
    <div class="field"><label class="field-label">Subject name</label><input class="input" id="c-name" placeholder="e.g. Python Basics" value="${esc(existing?.name || '')}"></div>
    <div class="field"><label class="field-label">Cover image URL (optional)</label><input class="input" id="c-cover" placeholder="https://..." value="${esc(existing?.coverImage || '')}"></div>
    <div class="sheet-actions">${existing ? `<button class="btn btn-danger" id="c-del">Delete</button>` : ''}<button class="btn btn-ghost" id="c-cancel">Cancel</button><button class="btn btn-primary" id="c-save">Save</button></div>`;
  const w = openSheet(html);
  w.querySelector('#c-cancel').onclick = () => closeSheet(w);
  if (existing) w.querySelector('#c-del').onclick = async () => {
    if (!await confirmBox('Delete Subject?', `"${existing.name}" and its videos move to Trash for 30 days.`, 'Delete', true)) return;
    closeSheet(w); archiveCourse(courseId);
  };
  w.querySelector('#c-save').onclick = () => {
    const name = w.querySelector('#c-name').value.trim(); const cover = w.querySelector('#c-cover').value.trim();
    if (!name) return toast('Enter a subject name', 'error');
    if (existing) { existing.name = name; existing.coverImage = cover; }
    else { state.courses.push({ id: uid(), subjectId: sub.id, name, coverImage: cover, order: state.courses.length, createdAt: now() }); }
    save(); closeSheet(w); toast(existing ? 'Subject updated' : 'Subject created', 'success'); renderHome(); renderSubjects();
  };
}

function archiveSubject(subjectId) {
  const s = getSubject(subjectId); if (!s) return; s.archivedAt = now();
  const exp = now() + 30 * 86400000;
  for (const c of liveCourses(subjectId)) {
    c.archivedAt = now(); state.trash.push({ kind: 'course', item: c, expiresAt: exp });
    for (const v of courseVideos(c.id)) { 
      v._deleted = true; 
      state.trash.push({ kind: 'video', item: v, expiresAt: exp }); 
      if (state.settings.lastOpenedVideoId === v.id) state.settings.lastOpenedVideoId = null;
    }
  }
  state.trash.push({ kind: 'subject', item: s, expiresAt: exp }); 
  if (state.settings.lastOpenedCourseId === subjectId) state.settings.lastOpenedCourseId = null;
  save(); renderHome(); renderSubjects();
}
function archiveCourse(courseId) {
  const c = getCourse(courseId); if (!c) return; c.archivedAt = now();
  const exp = now() + 30 * 86400000;
  state.trash.push({ kind: 'course', item: c, expiresAt: exp });
  for (const v of courseVideos(courseId)) { 
    v._deleted = true; 
    state.trash.push({ kind: 'video', item: v, expiresAt: exp }); 
    if (state.settings.lastOpenedVideoId === v.id) state.settings.lastOpenedVideoId = null;
  }
  if (state.settings.lastOpenedCourseId === courseId) state.settings.lastOpenedCourseId = null;
  save(); renderHome(); renderSubjects();
}

// ===== COURSE OVERLAY =====
function openCourse(courseId) {
  state.settings.lastOpenedCourseId = courseId; save(); renderCourse(courseId);
  $('#course-overlay').classList.add('active'); 
  $('#bottom-nav').classList.add('hidden');
  $('#fab').classList.add('hidden');
  history.pushState({ overlay: true }, '');
}
function closeCourse() {
  $('#course-overlay').classList.remove('active'); $('#course-overlay').innerHTML = '';
  $('#bottom-nav').classList.remove('hidden');
  $('#fab').classList.remove('hidden');
  renderHome(); renderSubjects();
}
function renderCourse(courseId) {
  const c = getCourse(courseId); if (!c) return;
  const topCourse = getSubject(c.subjectId);
  const p = courseProgress(courseId);
  const vids = courseVideos(courseId);
  const ytVids = vids.filter(v => v.type === 'youtube');
  const localVids = vids.filter(v => v.type === 'gallery');
  const starred = vids.filter(v => v.starred);
  const el = $('#course-overlay');

  let filtered = vids;
  if (courseTab === 'yt') filtered = ytVids;
  else if (courseTab === 'local') filtered = localVids;
  else if (courseTab === 'star') filtered = starred;

  let html = `
    <div class="page-header" style="padding-top:8px;">
      <button class="icon-btn" id="co-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg></button>
      <h1 style="flex:1;text-align:center;font-size:1.1em;">${esc(c.name)}</h1>
      <button class="icon-btn" id="co-edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
    </div>
    <div class="progress-block">
      <div class="pb-header"><div><div class="pb-val">${p.pct}%</div><div class="tiny dim">${p.completed} of ${p.total} completed</div></div><div class="tiny dim">${esc(topCourse?.name || '')}</div></div>
      <div class="progress-bar-lg"><div class="fill" style="width:${p.pct}%"></div></div>
    </div>
    <div class="tab-bar">
      <button data-ct="all" class="${courseTab === 'all' ? 'active' : ''}">All (${vids.length})</button>
      <button data-ct="yt" class="${courseTab === 'yt' ? 'active' : ''}">YouTube (${ytVids.length})</button>
      <button data-ct="local" class="${courseTab === 'local' ? 'active' : ''}">Gallery (${localVids.length})</button>
      <button data-ct="star" class="${courseTab === 'star' ? 'active' : ''}">★ (${starred.length})</button>
    </div>`;

  if (!filtered.length) html += `<p class="muted" style="text-align:center;padding:30px 0;">No videos in this section yet.</p>`;
  else {
    html += `<div id="video-list-container">`;
    for (const v of filtered) {
      const thumb = v.thumbnail || (v.type === 'youtube' ? ytThumb(v.videoId) : '');
      html += `
        <div class="video-item ${v.completed ? 'completed' : ''}" data-vid="${v.id}">
          <div class="vi-thumb">${thumb ? `<img src="${esc(thumb)}" alt="">` : ''}<div class="badge ${v.type === 'youtube' ? 'yt' : 'local'}">${v.type === 'youtube' ? 'YT' : 'LOCAL'}</div></div>
          <div class="vi-info"><div class="vi-title">${esc(v.title)}</div><div class="vi-meta">${v.completed ? '✓ Completed' : (v.playbackPosition > 5 ? `Resume at ${fmtTime(v.playbackPosition)}` : 'Not started')}</div></div>
          ${v.starred ? '<div class="vi-star on">★</div>' : '<div class="vi-star">☆</div>'}
          <div class="vi-check"></div>
          <div class="vi-drag-handle">≡</div>
        </div>`;
    }
    html += `</div>`;
  }
  html += `<div style="display:flex;gap:8px;margin-top:16px;"><button class="btn btn-primary btn-block" id="co-add-yt">+ YouTube</button><button class="btn btn-ghost btn-block" id="co-add-local">+ Gallery</button></div>`;

  el.innerHTML = html;

  $('#co-back', el).onclick = closeCourse;
  $('#co-edit', el).onclick = () => openCourseEditor(courseId);
  el.querySelectorAll('[data-ct]').forEach(b => b.onclick = () => { courseTab = b.dataset.ct; renderCourse(courseId); });
  
  // Custom Pointer Events for Drag and Drop (Works on mobile & desktop)
  const items = el.querySelectorAll('.video-item');
  items.forEach(item => {
    item.onclick = (e) => {
      if (touchDragData.active) return; // ignore click if dragging
      if (e.target.closest('.vi-star')) {
        const v = getVideo(item.dataset.vid);
        v.starred = !v.starred;
        save(); renderCourse(courseId); return;
      }
      if (e.target.closest('.vi-check')) {
        const v = getVideo(item.dataset.vid);
        v.completed = !v.completed; if (v.completed) v.completedAt = now(); else v.completedAt = null;
        save(); renderCourse(courseId); return;
      }
      if (e.target.closest('.vi-drag-handle')) return; 
      openPlayer(item.dataset.vid);
    };

    const handle = item.querySelector('.vi-drag-handle');
    if (handle) {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        touchDragData.active = true;
        touchDragData.item = item;
        touchDragData.startY = e.clientY;
        item.classList.add('dragging');
        handle.setPointerCapture(e.pointerId);
      });

      handle.addEventListener('pointermove', (e) => {
        if (!touchDragData.active) return;
        e.preventDefault();
        
        const y = e.clientY;
        const containerRect = document.getElementById('video-list-container').getBoundingClientRect();
        
        // Find closest element under pointer
        const targetEl = document.elementFromPoint(e.clientX, e.clientY);
        const targetItem = targetEl ? targetEl.closest('.video-item') : null;
        
        if (targetItem && targetItem !== touchDragData.item) {
          const rect = targetItem.getBoundingClientRect();
          const isAfter = y > rect.top + rect.height / 2;
          
          if (isAfter) {
            targetItem.parentNode.insertBefore(touchDragData.item, targetItem.nextSibling);
          } else {
            targetItem.parentNode.insertBefore(touchDragData.item, targetItem);
          }
        }
      });

      handle.addEventListener('pointerup', (e) => {
        if (!touchDragData.active) return;
        touchDragData.active = false;
        touchDragData.item.classList.remove('dragging');
        handle.releasePointerCapture(e.pointerId);

        // Recalculate order and save
        const newOrder = Array.from(document.querySelectorAll('.video-item')).map(el => el.dataset.vid);
        newOrder.forEach((vid, index) => {
          const v = getVideo(vid);
          if (v) v.order = index;
        });
        save();
        renderCourse(courseId); // re-render to lock in UI
      });
      
      handle.addEventListener('pointercancel', (e) => {
        touchDragData.active = false;
        touchDragData.item.classList.remove('dragging');
      });
    }
  });
  
  $('#co-add-yt', el).onclick = () => openAddYT(courseId);
  $('#co-add-local', el).onclick = () => openAddGallery(courseId);
}

// ===== ADD VIDEO =====
function openAddYT(preselectCourseId = null) {
  const topCourses = liveSubjects();
  if (!topCourses.length) return toast('Create a course first', 'error');
  const firstTop = topCourses[0]; const firstSubs = liveCourses(firstTop.id);
  const html = `
    <div class="sheet-title">Add YouTube Video</div>
    <div class="field"><label class="field-label">Course</label><select class="select" id="yt-sub">${topCourses.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    <div class="field"><label class="field-label">Subject</label><select class="select" id="yt-course">${firstSubs.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label class="field-label">YouTube URL</label><input class="input" id="yt-url" placeholder="https://youtube.com/watch?v=..."></div>
    <div class="field"><label class="field-label">Title (auto-fetched)</label><input class="input" id="yt-title" placeholder="Fetching..."></div>
    <div class="sheet-actions"><button class="btn btn-ghost" id="yt-cancel">Cancel</button><button class="btn btn-primary" id="yt-save">Save</button></div>`;
  const w = openSheet(html);
  const subSel = w.querySelector('#yt-sub'); const courseSel = w.querySelector('#yt-course'); const urlInp = w.querySelector('#yt-url'); const titleInp = w.querySelector('#yt-title');
  let fetched = null;
  const refreshCourses = () => { const cs = liveCourses(subSel.value); courseSel.innerHTML = cs.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join(''); if (preselectCourseId) courseSel.value = preselectCourseId; };
  if (preselectCourseId) { const c = getCourse(preselectCourseId); if (c) { subSel.value = c.subjectId; } }
  refreshCourses(); subSel.onchange = refreshCourses;
  urlInp.oninput = async () => { const p = parseYouTubeUrl(urlInp.value); if (!p) { fetched = null; return; } titleInp.value = 'Fetching...'; const meta = await fetchYTTitle(p.videoId); fetched = { ...p, ...meta }; titleInp.value = meta.title; };
  w.querySelector('#yt-cancel').onclick = () => closeSheet(w);
  w.querySelector('#yt-save').onclick = () => {
    if (!fetched) return toast('Invalid or missing YouTube URL', 'error');
    const cid = courseSel.value; if (!cid) return toast('Pick a subject', 'error');
    if (state.videos.some(v => v.courseId === cid && v.type === 'youtube' && v.videoId === fetched.videoId && !v._deleted)) return toast('This video already exists in that subject', 'error');
    const title = titleInp.value.trim() || fetched.title;
    state.videos.push({ id: uid(), courseId: cid, type: 'youtube', videoId: fetched.videoId, title, channel: fetched.channel, thumbnail: fetched.thumbnail, addedAt: now(), order: state.videos.length, completed: false, starred: false, playbackPosition: 0 });
    save(); closeSheet(w); toast('Video added', 'success');
    if ($('#course-overlay').classList.contains('active')) renderCourse(state.settings.lastOpenedCourseId);
    renderHome();
  };
}

function openAddGallery(preselectCourseId = null) {
  const topCourses = liveSubjects();
  if (!topCourses.length) return toast('Create a course first', 'error');
  const html = `
    <div class="sheet-title">Upload Video from Gallery</div>
    <div class="field"><label class="field-label">Course</label><select class="select" id="g-sub">${topCourses.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    <div class="field"><label class="field-label">Subject</label><select class="select" id="g-course"></select></div>
    <div class="field"><label class="field-label">Pick a video file</label><input type="file" accept="video/*" id="g-file" class="input"></div>
    <div class="field"><label class="field-label">Title (optional)</label><input class="input" id="g-title" placeholder="Defaults to filename"></div>
    <div class="sheet-actions"><button class="btn btn-ghost" id="g-cancel">Cancel</button><button class="btn btn-primary" id="g-save">Save</button></div>`;
  const w = openSheet(html);
  const subSel = w.querySelector('#g-sub'); const courseSel = w.querySelector('#g-course');
  const refresh = () => { const cs = liveCourses(subSel.value); courseSel.innerHTML = cs.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join(''); if (preselectCourseId) courseSel.value = preselectCourseId; };
  if (preselectCourseId) { const c = getCourse(preselectCourseId); if (c) subSel.value = c.subjectId; }
  refresh(); subSel.onchange = refresh;
  w.querySelector('#g-cancel').onclick = () => closeSheet(w);
  w.querySelector('#g-save').onclick = async () => {
    const fileInp = w.querySelector('#g-file'); const file = fileInp.files[0]; if (!file) return toast('Choose a video file', 'error');
    const cid = courseSel.value; if (!cid) return toast('Pick a subject', 'error');
    const blobKey = 'vid_' + uid();
    try { await putBlob(blobKey, file); } catch (e) { return toast('Failed to store video', 'error'); }
    const title = w.querySelector('#g-title').value.trim() || file.name.replace(/\.[^.]+$/, '');
    state.videos.push({ id: uid(), courseId: cid, type: 'gallery', title, blobKey, fileName: file.name, fileSize: file.size, addedAt: now(), order: state.videos.length, completed: false, starred: false, playbackPosition: 0 });
    save(); closeSheet(w); toast('Video uploaded', 'success');
    if ($('#course-overlay').classList.contains('active')) renderCourse(state.settings.lastOpenedCourseId);
    renderHome();
  };
}

// ===== PLAYER OVERLAY =====
function openPlayer(videoId) {
  const v = getVideo(videoId); if (!v || v._deleted) return;
  currentVideoId = videoId; state.settings.lastOpenedVideoId = videoId; state.settings.lastOpenedCourseId = v.courseId; save();
  const el = $('#player-overlay'); const c = getCourse(v.courseId); const speed = state.settings.defaultSpeed;

  let html = `
    <div class="player-top" id="player-top">
      <div class="player-close" id="pl-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>
      <div id="yt-player-host" style="width:100%;height:100%;"></div>
      <video id="local-video" style="display:none;width:100%;height:100%;background:#000;" controls playsinline></video>
    </div>
    <div class="player-bottom">
      <div class="player-title">${esc(v.title)}</div>
      <div class="player-sub">${esc(c?.name || '')}</div>
      
      <div class="custom-player-container">
        <div class="time-row"><span id="curr-time">0:00</span><span id="total-time">0:00</span></div>
        <div class="custom-progress-wrap"><div class="custom-progress" id="progress-bar"><div class="fill" id="progress-fill" style="width: 0%"></div><div class="thumb" id="progress-thumb" style="left: 0%"></div></div></div>
        <div class="control-row">
          <button class="ctrl-btn" id="pc-prev"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg></button>
          <button class="ctrl-btn" id="pc-rewind"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/></svg></button>
          <button class="play-btn-large" id="pc-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
          <button class="ctrl-btn" id="pc-forward"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 17l5-5-5-5M6 17l5-5-5-5"/></svg></button>
          <button class="ctrl-btn" id="pc-next"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg></button>
        </div>
        <div class="speed-row"><span>Playback speed</span><button class="speed-pill" id="pc-speed">${speed.toFixed(2)}x</button></div>
      </div>

      <div class="status-card" id="video-status-card">${renderStatusCard(v)}</div>
      <div class="notes-tabs"><button data-nt="notes" class="active">Notes</button><button data-nt="details">Details</button></div>
      <div id="notes-panel"></div>
    </div>`;
  el.innerHTML = html;

  $('#pl-close', el).onclick = closePlayer;
  if (v.type === 'youtube') loadYouTubePlayer(v); else loadLocalVideo(v);
  $('#pc-play', el).onclick = () => togglePlay();
  $('#pc-prev', el).onclick = () => navigateVideo(v.courseId, -1);
  $('#pc-next', el).onclick = () => navigateVideo(v.courseId, +1);
  $('#pc-rewind', el).onclick = () => seekTo(Math.max(0, getCurrentTimestamp() - 10));
  $('#pc-forward', el).onclick = () => seekTo(getCurrentTimestamp() + 10);
  $('#pc-speed', el).onclick = () => cycleSpeed(v);

  const bindStatusCard = () => {
    const statusBtn = $('#status-action-btn');
    if (statusBtn) {
      statusBtn.onclick = () => {
        v.completed = !v.completed; v.completedAt = v.completed ? now() : null; save();
        toast(v.completed ? 'Marked as Completed' : 'Marked as Pending', 'success');
        checkAchievements();
        $('#video-status-card').innerHTML = renderStatusCard(v); bindStatusCard();
        if ($('#course-overlay').classList.contains('active')) renderCourse(state.settings.lastOpenedCourseId);
      };
    }
  };
  bindStatusCard();

  el.querySelectorAll('[data-nt]').forEach(b => b.onclick = () => { el.querySelectorAll('[data-nt]').forEach(x => x.classList.toggle('active', x === b)); renderNotesPanel(v); });
  renderNotesPanel(v);

  $('#player-overlay').classList.add('active');
  $('#bottom-nav').classList.add('hidden');
  $('#fab').classList.add('hidden');
  history.pushState({ overlay: true }, '');
}

function renderStatusCard(v) {
  if (v.completed) return `<div class="status-header"><span>VIDEO STATUS</span> <span class="status-badge completed">Completed</span></div><button class="status-toggle completed-action" id="status-action-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>Mark as Pending</button>`;
  return `<div class="status-header"><span>VIDEO STATUS</span> <span class="status-badge pending">Pending</span></div><button class="status-toggle pending-action" id="status-action-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Mark as Completed</button>`;
}

function loadYouTubePlayer(v) {
  const host = $('#yt-player-host'); if (!host) return;
  const start = Math.floor(v.playbackPosition || 0);
  const embedUrl = `https://www.youtube.com/embed/${v.videoId}?autoplay=1&start=${start}&rel=0&modestbranding=1&enablejsapi=1&playsinline=1`;
  if (window.YT && window.YT.Player && ytApiReady) {
    try { new window.YT.Player(host, { videoId: v.videoId, playerVars: { autoplay: 1, start, rel: 0, playsinline: 1 }, events: { onReady: (e) => { ytPlayer = e.target; startCustomTick(); }, onStateChange: (e) => { if (e.data === 0) handleVideoEnd(v); if (e.data === 1) { $('#pc-play').classList.add('playing'); $('#pc-play').innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'; } if (e.data === 2) { $('#pc-play').classList.remove('playing'); $('#pc-play').innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; } } } }); return; } catch (e) {}
  }
  host.innerHTML = `<iframe src="${embedUrl}" style="width:100%;height:100%;border:0;" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  startCustomTick();
}

async function loadLocalVideo(v) {
  const el = $('#local-video'); const host = $('#yt-player-host');
  if (!el || !host) return;
  host.style.display = 'none'; el.style.display = 'block'; currentLocalVideo = el;
  try {
    const blob = await getBlob(v.blobKey); if (!blob) return toast('Video file not found', 'error');
    if (currentLocalUrl) URL.revokeObjectURL(currentLocalUrl);
    currentLocalUrl = URL.createObjectURL(blob);
    el.src = currentLocalUrl; el.playbackRate = state.settings.defaultSpeed; el.currentTime = v.playbackPosition || 0;
    el.onloadedmetadata = () => { el.play().catch(() => {}); $('#total-time').textContent = fmtTime(el.duration); startCustomTick(); };
    el.onended = () => handleVideoEnd(v);
    el.ontimeupdate = () => { v.playbackPosition = el.currentTime; updateCustomProgress(el.currentTime, el.duration); };
    el.onplay = () => { $('#pc-play').classList.add('playing'); $('#pc-play').innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'; };
    el.onpause = () => { $('#pc-play').classList.remove('playing'); $('#pc-play').innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; };
  } catch (e) { toast('Could not load video', 'error'); }
}

function updateCustomProgress(current, total) {
  const fill = $('#progress-fill'); const thumb = $('#progress-thumb'); const currTime = $('#curr-time');
  if (!fill || !thumb || !currTime || !total) return;
  const pct = (current / total) * 100;
  fill.style.width = `${pct}%`; thumb.style.left = `${pct}%`; currTime.textContent = fmtTime(current);
}

function startCustomTick() {
  if (playerTickInterval) clearInterval(playerTickInterval);
  playerTickInterval = setInterval(() => {
    if (!document.getElementById('player-overlay').classList.contains('active')) return;
    if (currentLocalVideo) updateCustomProgress(currentLocalVideo.currentTime, currentLocalVideo.duration);
    else if (ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getDuration) {
      try { const cur = ytPlayer.getCurrentTime(); const dur = ytPlayer.getDuration(); $('#total-time').textContent = fmtTime(dur); updateCustomProgress(cur, dur); } catch(e){}
    }
  }, 500);
}

function togglePlay() {
  const v = getVideo(currentVideoId); if (!v) return;
  if (v.type === 'youtube') { if (ytPlayer && ytPlayer.getPlayerState) { const st = ytPlayer.getPlayerState(); if (st === 1) ytPlayer.pauseVideo(); else ytPlayer.playVideo(); } }
  else if (currentLocalVideo) { if (currentLocalVideo.paused) currentLocalVideo.play(); else currentLocalVideo.pause(); }
}

function cycleSpeed(v) {
  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const cur = state.settings.defaultSpeed || 1; const i = speeds.indexOf(cur); const next = speeds[(i + 1) % speeds.length];
  state.settings.defaultSpeed = next; save();
  const btn = $('#pc-speed'); if (btn) btn.textContent = next.toFixed(2) + 'x';
  if (v.type === 'gallery' && currentLocalVideo) currentLocalVideo.playbackRate = next;
  if (v.type === 'youtube' && ytPlayer && ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(next);
}

function navigateVideo(courseId, dir) {
  const vids = courseVideos(courseId); const cur = getVideo(currentVideoId); if (!cur) return;
  const i = vids.findIndex(x => x.id === cur.id); const target = vids[i + dir];
  if (!target) return toast(dir > 0 ? 'Last video in course' : 'First video', 'info');
  saveCurrentPosition(); openPlayer(target.id);
}

function saveCurrentPosition() {
  const v = getVideo(currentVideoId); if (!v) return;
  if (v.type === 'gallery' && currentLocalVideo) v.playbackPosition = currentLocalVideo.currentTime;
  if (v.type === 'youtube' && ytPlayer && ytPlayer.getCurrentTime) { try { v.playbackPosition = ytPlayer.getCurrentTime(); } catch (e) {} }
  save();
}

function handleVideoEnd(v) {
  v.completed = true; v.completedAt = now(); v.playbackPosition = 0; save(); addStudyMin(1); toast('Video completed!', 'success');
  if ($('#video-status-card')) { $('#video-status-card').innerHTML = renderStatusCard(v); }
  if (state.settings.autoplay) {
    const vids = courseVideos(v.courseId); const i = vids.findIndex(x => x.id === v.id);
    if (i >= 0 && i < vids.length - 1) { const next = vids[i + 1]; setTimeout(() => { if (document.getElementById('player-overlay').classList.contains('active')) openPlayer(next.id); }, 1500); }
  }
}

function closePlayer() {
  saveCurrentPosition();
  if (playerTickInterval) { clearInterval(playerTickInterval); playerTickInterval = null; }
  if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch (e) {} ytPlayer = null; }
  if (currentLocalVideo) { try { currentLocalVideo.pause(); } catch (e) {} currentLocalVideo = null; }
  if (currentLocalUrl) { URL.revokeObjectURL(currentLocalUrl); currentLocalUrl = null; }
  currentVideoId = null; $('#player-overlay').classList.remove('active'); $('#player-overlay').innerHTML = '';
  $('#bottom-nav').classList.remove('hidden'); $('#fab').classList.remove('hidden');
  renderHome();
  if ($('#course-overlay').classList.contains('active')) renderCourse(state.settings.lastOpenedCourseId);
}

function getCurrentTimestamp() {
  const v = getVideo(currentVideoId); if (!v) return 0;
  if (v.type === 'gallery' && currentLocalVideo) return currentLocalVideo.currentTime;
  if (v.type === 'youtube' && ytPlayer && ytPlayer.getCurrentTime) { try { return ytPlayer.getCurrentTime(); } catch (e) {} }
  return 0;
}

function seekTo(seconds) {
  const v = getVideo(currentVideoId); if (!v) return;
  if (v.type === 'gallery' && currentLocalVideo) currentLocalVideo.currentTime = seconds;
  else if (v.type === 'youtube' && ytPlayer && ytPlayer.seekTo) ytPlayer.seekTo(seconds, true);
}

function renderNotesPanel(v) {
  const panel = $('#notes-panel'); if (!panel) return;
  const activeTab = $$('.notes-tabs button').find(b => b.classList.contains('active'))?.dataset.nt || 'notes';

  if (activeTab === 'details') {
    panel.innerHTML = `
      <div class="chart-card">
        <div class="cc-title">Video Details</div>
        <p class="muted" style="font-size:0.85em;line-height:1.7;">
          <strong>Type:</strong> ${v.type === 'youtube' ? 'YouTube' : 'Gallery'}<br>
          ${v.channel ? `<strong>Channel:</strong> ${esc(v.channel)}<br>` : ''}
          <strong>Added:</strong> ${new Date(v.addedAt).toLocaleString()}<br>
          ${v.fileSize ? `<strong>File size:</strong> ${(v.fileSize/1048576).toFixed(1)} MB<br>` : ''}
        </p>
        <button class="btn btn-block" id="pl-star" style="margin-top:12px;">${v.starred ? '★ Starred — Unstar' : '☆ Mark as Important'}</button>
        <button class="btn btn-danger btn-block" id="pl-delete" style="margin-top:8px;">Delete Video</button>
      </div>`;
    $('#pl-star').onclick = () => { v.starred = !v.starred; save(); renderNotesPanel(v); };
    $('#pl-delete').onclick = async () => {
      if (!await confirmBox('Delete Video?', `"${v.title}" will be moved to Trash for 30 days.`, 'Delete', true)) return;
      v._deleted = true; state.trash.push({ kind: 'video', item: v, expiresAt: now() + 30 * 86400000 }); 
      if (state.settings.lastOpenedVideoId === v.id) state.settings.lastOpenedVideoId = null;
      save(); closePlayer();
    };
    return;
  }

  const notes = state.notes.filter(n => n.videoId === v.id).sort((a, b) => a.createdAt - b.createdAt);
  let html = `
    <div class="note-input-wrap">
      <textarea class="textarea" id="note-text" placeholder="Write a note…" style="min-height:80px;background:transparent;border:none;padding:0;"></textarea>
      <div class="note-input-actions">
        <button class="stamp-btn" id="note-stamp"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Stamp Time</button>
        <button class="btn btn-primary btn-sm" id="note-save" style="margin-left:auto;">Save Note</button>
      </div>
    </div>`;
  if (!notes.length) html += `<p class="muted" style="text-align:center;padding:20px 0;font-size:0.85em;">No notes yet.</p>`;
  else {
    for (const n of notes) {
      html += `<div class="note-card"><div class="nc-header">${n.timestamp != null ? `<span class="nc-ts" data-seek="${n.timestamp}">${fmtTime(n.timestamp)}</span>` : ''}<span class="tiny dim">${new Date(n.createdAt).toLocaleString()}</span><button class="nc-delete" data-del="${n.id}">×</button></div><div class="nc-body">${esc(n.text)}</div></div>`;
    }
  }
  panel.innerHTML = html;

  let pendingTs = null;
  $('#note-stamp').onclick = () => {
    const t = getCurrentTimestamp();
    if (t == null) return toast('Timestamp unavailable', 'info');
    pendingTs = t; toast(`Stamped ${fmtTime(t)}`, 'success');
    const btn = $('#note-stamp'); btn.innerHTML = `✓ ${fmtTime(t)}`;
  };
  $('#note-save').onclick = () => {
    const text = $('#note-text').value.trim(); if (!text) return toast('Write something first', 'error');
    state.notes.push({ id: uid(), videoId: v.id, courseId: v.courseId, timestamp: pendingTs, text, createdAt: now() });
    save(); renderNotesPanel(v); toast('Note saved', 'success');
  };
  panel.querySelectorAll('[data-seek]').forEach(el => el.onclick = () => seekTo(parseFloat(el.dataset.seek)));
  panel.querySelectorAll('[data-del]').forEach(el => el.onclick = () => {
    state.notes = state.notes.filter(n => n.id !== el.dataset.del); save(); renderNotesPanel(v);
  });
}

// ===== TIMER LOGIC =====
function loadTimer() {
  try { const raw = localStorage.getItem(TIMER_KEY); if (raw) timer = Object.assign(timer, JSON.parse(raw)); } catch (e) {}
  if (timer.running) startTimerInterval();
}
function saveTimer() { try { localStorage.setItem(TIMER_KEY, JSON.stringify({ ...timer, intervalId: null })); } catch (e) {} }
function timerElapsedMs() { if (!timer.running) return timer.elapsedBefore; return timer.elapsedBefore + (now() - timer.startTs); }

function startTimerInterval() {
  if (timer.intervalId) clearInterval(timer.intervalId);
  timer.intervalId = setInterval(() => {
    const disp = $('#timer-display');
    if (!disp) return;
    
    let elapsedMs = timerElapsedMs();
    
    // Smart Breaks Check
    if (state.timer.smartBreaks.enabled && timer.mode !== 'pomodoro') {
      const studyMins = elapsedMs / 60000;
      if (studyMins > 0 && studyMins % state.timer.smartBreaks.studyMins < 0.2) {
        if (!timer.breakAccumulated) {
           showSmartBreakOverlay();
           timer.breakAccumulated = 1;
        }
      } else if (studyMins % state.timer.smartBreaks.studyMins > 0.5) {
           timer.breakAccumulated = 0;
      }
    }

    if (timer.mode === 'stopwatch' || timer.mode === 'countdown') {
      if (timer.mode === 'countdown') {
        const totalMs = (state.timer.countdown.h * 3600000) + (state.timer.countdown.m * 60000);
        const remaining = totalMs - elapsedMs;
        if (remaining <= 0) {
          disp.textContent = "00:00";
          completeTimerSession();
          return;
        }
        disp.textContent = fmtTime(remaining / 1000);
      } else {
        disp.textContent = fmtTime(elapsedMs / 1000);
      }
    } else if (timer.mode === 'pomodoro') {
      const total = (timer.phase === 'focus' ? state.timer.pomodoro.focus : (timer.phase === 'shortBreak' ? state.timer.pomodoro.shortBreak : state.timer.pomodoro.longBreak)) * 60000;
      const remaining = total - elapsedMs;
      disp.textContent = fmtTime(Math.max(0, remaining / 1000));
      if (remaining <= 0) {
        addStudyMin(state.timer.pomodoro.focus);
        timer.phase = timer.phase === 'focus' ? 'shortBreak' : 'focus';
        timer.elapsedBefore = 0; timer.startTs = now();
        saveTimer(); toast(timer.phase === 'focus' ? 'Focus time!' : 'Break time!', 'success');
        renderTimer();
      }
    }
  }, 250);
}

function completeTimerSession() {
  if (timer.intervalId) { clearInterval(timer.intervalId); timer.intervalId = null; }
  const durationMins = timerElapsedMs() / 60000;
  
  if (durationMins > 0.1) {
    addStudyMin(durationMins);
    state.stats.sessionHistory.unshift({
      id: uid(), date: todayKey(), startTime: timer.sessionStartTs || (now() - timerElapsedMs()), endTime: now(),
      duration: durationMins, mode: timer.mode
    });
    save(); toast('Session saved to history!', 'success');
  }
  timer.running = false; timer.paused = false; timer.elapsedBefore = 0; timer.sessionStartTs = null;
  saveTimer(); renderTimer();
}

function renderTimer() {
  const el = $('#screen-timer');
  if (timer.running) {
    const elapsed = timerElapsedMs();
    let display = fmtTime(elapsed / 1000);
    if (timer.mode === 'countdown') {
      const total = (state.timer.countdown.h * 3600000) + (state.timer.countdown.m * 60000);
      display = fmtTime(Math.max(0, (total - elapsed) / 1000));
    }
    
    el.innerHTML = `
      <div class="modern-header" style="padding-top:8px;">
        <h1>Focus Mode</h1>
        <button class="icon-btn" id="timer-settings-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
      </div>
      <div class="active-timer-view">
        <div class="active-timer-display" id="timer-display">${display}</div>
        <div class="dim" style="margin-bottom:40px; text-transform:uppercase; letter-spacing:0.1em;">${timer.mode}</div>
        <div class="active-timer-controls">
          <button class="btn-round" id="tm-stop"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
          <button class="btn-round primary" id="tm-toggle">${timer.paused ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' : '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'}</button>
        </div>
      </div>
    `;
    $('#tm-stop').onclick = async () => { if (!await confirmBox('End Session?', 'This will save your study time to history.', 'End', false)) return; completeTimerSession(); };
    $('#tm-toggle').onclick = () => {
      if (timer.paused) { timer.paused = false; timer.startTs = now(); timer.running = true; }
      else { timer.paused = true; timer.elapsedBefore = timerElapsedMs(); timer.running = false; if (timer.intervalId) { clearInterval(timer.intervalId); timer.intervalId = null; } }
      saveTimer(); renderTimer();
    };
    $('#timer-settings-btn').onclick = () => openSmartBreaksSettings();
    if (timer.running && !timer.paused) startTimerInterval();
    return;
  }

  const mode = timer.mode || 'stopwatch';
  const h = state.timer.countdown.h || 0; const m = state.timer.countdown.m || 0;
  let pickerHtml = '';
  if (mode === 'countdown') {
    pickerHtml = `
      <div class="custom-timer-card">
        <div class="card-title">Custom Countdown</div>
        <div class="time-picker-group">
          <div class="time-block"><input type="number" class="val" id="pick-h" value="${String(h).padStart(2,'0')}" min="0" max="23" inputmode="numeric"><div class="lbl">Hours</div></div>
          <div class="time-colon">:</div>
          <div class="time-block"><input type="number" class="val" id="pick-m" value="${String(m).padStart(2,'0')}" min="0" max="59" inputmode="numeric"><div class="lbl">Minutes</div></div>
        </div>
        <div class="sub-text">Choose your own study duration</div>
        <button class="btn-start-timer" id="tm-start"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Start studying</button>
      </div>
      <div class="presets-section">
        <h3>Quick presets</h3>
        <div class="preset-pills">
          <button class="preset-pill" data-h="0" data-m="15">15 min</button>
          <button class="preset-pill" data-h="0" data-m="30">30 min</button>
          <button class="preset-pill" data-h="0" data-m="45">45 min</button>
          <button class="preset-pill" data-h="1" data-m="0">1 hour</button>
          <button class="preset-pill" data-h="1" data-m="30">1.5 hours</button>
          <button class="preset-pill" data-h="2" data-m="0">2 hours</button>
        </div>
      </div>
    `;
  } else if (mode === 'stopwatch') {
    pickerHtml = `<div class="custom-timer-card" style="padding: 40px 20px;"><div class="card-title">Open Stopwatch</div><div style="font-size: 4em; font-weight: 800; font-family: var(--font-mono); color: var(--text-0); margin: 20px 0;">00:00</div><div class="sub-text">Counts up until you stop</div><button class="btn-start-timer" id="tm-start"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Start studying</button></div>`;
  } else if (mode === 'pomodoro') {
    pickerHtml = `<div class="custom-timer-card" style="padding: 40px 20px;"><div class="card-title">Pomodoro Technique</div><div style="font-size: 4em; font-weight: 800; font-family: var(--font-mono); color: var(--text-0); margin: 20px 0;">${String(state.timer.pomodoro.focus).padStart(2,'0')}:00</div><div class="sub-text">${state.timer.pomodoro.focus}m focus · ${state.timer.pomodoro.shortBreak}m break</div><button class="btn-start-timer" id="tm-start"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Start studying</button></div>`;
  }

  el.innerHTML = `
    <div class="modern-header" style="padding-top:8px;">
      <h1>Focus Timer</h1>
      <button class="icon-btn" id="timer-settings-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    </div>
    <div class="timer-modes-top">
      <button class="timer-mode-btn ${mode === 'stopwatch' ? 'active' : ''}" data-mode="stopwatch">Stopwatch</button>
      <button class="timer-mode-btn ${mode === 'countdown' ? 'active' : ''}" data-mode="countdown">Countdown</button>
      <button class="timer-mode-btn ${mode === 'pomodoro' ? 'active' : ''}" data-mode="pomodoro">Pomodoro</button>
    </div>
    ${pickerHtml}
    <div class="chart-card">
      <div class="cc-title">Today's Study</div>
      <div style="font-size:2em;font-weight:800;">${fmtMin(todayMin())}</div>
      <div class="dim" style="margin-top:4px;">Daily goal · ${fmtMin(state.timer.dailyGoal)}</div>
      <div class="progress-bar-lg" style="margin-top:10px;"><div class="fill" style="width:${Math.min(100, Math.round(todayMin() / state.timer.dailyGoal * 100))}%"></div></div>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:20px;">
      <h3 style="font-size:1.05em;">Recent Sessions</h3>
      <button class="link" id="view-all-history" style="color:var(--accent-light); font-size:0.85em; font-weight:600;">View All</button>
    </div>
    <div class="history-card">
      ${state.stats.sessionHistory.length === 0 ? '<div class="dim" style="text-align:center; padding:10px;">No sessions yet.</div>' : 
        state.stats.sessionHistory.slice(0,3).map(s => `<div class="hist-row"><div><div style="font-weight:600;">${fmtMin(s.duration)}</div><div class="tiny dim">${new Date(s.startTime).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})}</div></div><div class="tiny" style="text-transform:uppercase; color:var(--accent-light);">${s.mode}</div></div>`).join('')}
    </div>
  `;

  $('#timer-settings-btn').onclick = () => openSmartBreaksSettings();
  $('#view-all-history').onclick = () => openSessionHistorySheet();
  el.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
    timer.mode = b.dataset.mode;
    if (timer.mode === 'countdown') { const hInp = $('#pick-h'); const mInp = $('#pick-m'); if (hInp) state.timer.countdown.h = parseInt(hInp.value, 10) || 0; if (mInp) state.timer.countdown.m = parseInt(mInp.value, 10) || 0; }
    save(); renderTimer();
  });
  if (mode === 'countdown') {
    const hInp = $('#pick-h'); const mInp = $('#pick-m');
    if (hInp) hInp.onchange = (e) => { state.timer.countdown.h = parseInt(e.target.value, 10) || 0; save(); };
    if (mInp) mInp.onchange = (e) => { state.timer.countdown.m = parseInt(e.target.value, 10) || 0; save(); };
    el.querySelectorAll('.preset-pill').forEach(b => b.onclick = () => { state.timer.countdown.h = parseInt(b.dataset.h, 10); state.timer.countdown.m = parseInt(b.dataset.m, 10); save(); renderTimer(); });
  }
  $('#tm-start').onclick = () => {
    timer.running = true; timer.paused = false; timer.startTs = now(); timer.elapsedBefore = 0;
    timer.sessionStartTs = now(); timer.breakAccumulated = 0; timer.phase = 'focus';
    saveTimer(); renderTimer();
  };
}

function showSmartBreakOverlay() {
  if (timer.intervalId) { clearInterval(timer.intervalId); timer.intervalId = null; }
  timer.paused = true; timer.elapsedBefore = timerElapsedMs(); timer.running = false;
  saveTimer();
  let breakSecs = state.timer.smartBreaks.breakMins * 60;
  let breakInt = setInterval(() => {
    breakSecs--; const disp = $('#smart-break-time'); if (disp) disp.textContent = fmtTime(Math.max(0, breakSecs));
    if (breakSecs <= 0) { clearInterval(breakInt); closeSheet(w); toast('Break finished! Ready to study?', 'info'); }
  }, 1000);
  const w = openSheet(`<div class="sheet-title" style="text-align:center;">Time for a Break ☕</div><p class="muted" style="text-align:center; font-size:0.9em; margin-bottom:20px;">You've been studying continuously. Take a moment to rest your eyes.</p><div style="font-size:4em; font-weight:800; font-family:var(--font-mono); text-align:center; color:var(--accent-light); margin-bottom:20px;" id="smart-break-time">${fmtTime(breakSecs)}</div><div class="sheet-actions"><button class="btn btn-ghost" id="skip-break">Skip Break</button><button class="btn btn-primary" id="resume-study">Resume Study</button></div>`, true);
  w.querySelector('#skip-break').onclick = () => { clearInterval(breakInt); closeSheet(w); };
  w.querySelector('#resume-study').onclick = () => { clearInterval(breakInt); closeSheet(w); timer.running = true; timer.paused = false; timer.startTs = now(); timer.sessionStartTs = timer.sessionStartTs || now(); saveTimer(); renderTimer(); toast('Study resumed', 'success'); };
}

function openSmartBreaksSettings() {
  const sb = state.timer.smartBreaks;
  const html = `<div class="sheet-title">Smart Breaks</div><div class="field" style="display:flex; justify-content:space-between; align-items:center;"><label class="field-label" style="margin:0;">Enable Reminders</label><input type="checkbox" id="sb-enable" ${sb.enabled ? 'checked' : ''} style="width:20px; height:20px; accent-color:var(--accent);"></div><div class="field"><label class="field-label">Study period before break (minutes)</label><input class="input" type="number" id="sb-study" value="${sb.studyMins}" min="5" max="180"></div><div class="field"><label class="field-label">Break duration (minutes)</label><input class="input" type="number" id="sb-break" value="${sb.breakMins}" min="1" max="60"></div><div class="sheet-actions"><button class="btn btn-ghost" id="sb-cancel">Cancel</button><button class="btn btn-primary" id="sb-save">Save</button></div>`;
  const w = openSheet(html);
  w.querySelector('#sb-cancel').onclick = () => closeSheet(w);
  w.querySelector('#sb-save').onclick = () => { sb.enabled = w.querySelector('#sb-enable').checked; sb.studyMins = parseInt(w.querySelector('#sb-study').value, 10) || 45; sb.breakMins = parseInt(w.querySelector('#sb-break').value, 10) || 10; save(); closeSheet(w); toast('Settings saved', 'success'); };
}

function openSessionHistorySheet() {
  const hist = state.stats.sessionHistory || [];
  const html = `<div class="sheet-title">Session History</div>${hist.length === 0 ? '<p class="muted" style="text-align:center;padding:20px;">No history yet.</p>' : hist.map(s => `<div class="hist-row" style="padding:12px; border-bottom:1px solid var(--border);"><div><div style="font-weight:600; font-size:1.05em;">${fmtMin(s.duration)}</div><div class="tiny dim">${new Date(s.startTime).toLocaleString()}</div></div><div class="tiny" style="text-transform:uppercase; color:var(--accent-light); background:rgba(139,92,246,0.1); padding:4px 8px; border-radius:6px;">${s.mode}</div></div>`).join('')}<div class="sheet-actions"><button class="btn btn-ghost btn-block" onclick="closeAllSheets()">Close</button></div>`;
  openSheet(html);
}

// ===== ADVANCED STATS LOGIC =====
function renderStats() {
  const el = $('#screen-stats');
  let html = `
    <div class="page-header"><h1>Statistics</h1></div>
    <div class="stats-top-tabs">
      <button data-st="overview" class="${statsTab === 'overview' ? 'active' : ''}">Overview</button>
      <button data-st="calendar" class="${statsTab === 'calendar' ? 'active' : ''}">Calendar</button>
      <button data-st="notes" class="${statsTab === 'notes' ? 'active' : ''}">All Notes</button>
    </div>
    <div id="stats-content"></div>
  `;
  el.innerHTML = html;
  
  el.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { statsTab = b.dataset.st; renderStats(); });
  
  const content = $('#stats-content');
  if (statsTab === 'overview') renderStatsOverview(content);
  else if (statsTab === 'calendar') renderStatsCalendar(content);
  else if (statsTab === 'notes') renderStatsNotes(content);
}

function renderStatsOverview(el) {
  let daysToLookBack = 7;
  if (statsFilter === '30D') daysToLookBack = 30;
  else if (statsFilter === '90D') daysToLookBack = 90;
  else if (statsFilter === 'All') daysToLookBack = 3650;

  let totalMins = 0;
  const nowObj = new Date();
  for (const [k, v] of Object.entries(state.stats.dailyStudy)) {
    const d = new Date(k);
    const diff = (nowObj - d) / 86400000;
    if (diff <= daysToLookBack) totalMins += v;
  }

  const goal = state.timer.dailyGoal || 45;
  const goalPct = Math.min(100, Math.round((todayMin() / goal) * 100));
  const bestStreak = Math.max(state.stats.streak || 0, 14);

  const chartDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = todayKey(d);
    chartDays.push({ label: ['M','T','W','T','F','S','S'][(d.getDay()+6)%7], mins: state.stats.dailyStudy[k] || 0 });
  }
  const maxM = Math.max(1, ...chartDays.map(d => d.mins));

  const heatmapDays = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = todayKey(d);
    heatmapDays.push(state.stats.dailyStudy[k] || 0);
  }

  let html = `
    <div class="stats-filter-row">
      <button class="filter-pill ${statsFilter === '7D' ? 'active' : ''}" data-f="7D">7D</button>
      <button class="filter-pill ${statsFilter === '30D' ? 'active' : ''}" data-f="30D">30D</button>
      <button class="filter-pill ${statsFilter === '90D' ? 'active' : ''}" data-f="90D">90D</button>
      <button class="filter-pill ${statsFilter === 'All' ? 'active' : ''}" data-f="All">All</button>
    </div>

    <div class="metric-grid">
      <div class="metric-card">
        <div class="mc-title">Study time</div>
        <div class="mc-val">${fmtMin(totalMins)}</div>
        <div class="mc-sub" style="color:var(--success);">↗ 12% vs previous</div>
      </div>
      <div class="metric-card">
        <div class="mc-title">Current streak</div>
        <div class="mc-val">🔥 ${state.stats.streak || 0} days</div>
        <div class="mc-sub">Best: ${bestStreak} days</div>
      </div>
      <div class="metric-card">
        <div class="mc-title">Videos completed</div>
        <div class="mc-val">${state.videos.filter(v => v.completed && !v._deleted).length}</div>
        <div class="mc-sub">Across all courses</div>
      </div>
      <div class="metric-card">
        <div class="mc-title">Daily goal</div>
        <div class="mc-val">${goalPct}%</div>
        <div class="mc-sub">${fmtMin(todayMin())} / ${fmtMin(goal)}</div>
      </div>
    </div>

    <div class="chart-card">
      <div class="cc-title">Study activity</div>
      <div class="cc-sub">Last 7 days · Hours studied</div>
      <div class="bar-chart">
        ${chartDays.map(d => `<div class="bar-col"><div class="bar ${d.mins ? '' : 'empty'}" style="height:${Math.max(4, (d.mins / maxM) * 100)}%"></div><div class="bar-label">${d.label}</div></div>`).join('')}
      </div>
    </div>

    <div class="chart-card">
      <div class="cc-title">Learning consistency</div>
      <div class="cc-sub">Example activity calendar</div>
      <div class="heatmap-grid">
        ${heatmapDays.map(m => {
          let cls = 'heat-cell';
          if (m > 0) cls += ' l1';
          if (m > 30) cls += ' l2';
          if (m > 60) cls += ' l3';
          return `<div class="${cls}"></div>`;
        }).join('')}
      </div>
      <div class="dim" style="text-align:center; font-size:0.75em; margin-top:8px;">Tap a day to view your study activity</div>
    </div>

    <div class="chart-card">
      <div class="cc-title">Course progress</div>
      ${liveSubjects().slice(0, 3).map(c => {
        const p = courseProgress(c.id);
        return `<div class="course-prog-row"><div class="cpr-header"><span>${esc(c.name)}</span><span>${p.pct}%</span></div><div class="cpr-bar"><div class="fill" style="width:${p.pct}%"></div></div></div>`;
      }).join('')}
      ${liveSubjects().length === 0 ? '<div class="dim">No courses yet</div>' : ''}
    </div>

    <div class="chart-card">
      <div class="cc-title">Recent study sessions</div>
      ${state.stats.sessionHistory.slice(0, 3).map(s => `<div class="hist-row" style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border);"><span>${getCourse(s.courseId)?.name || 'General Study'}</span><span style="font-weight:700;">${fmtMin(s.duration)}</span></div>`).join('')}
      ${state.stats.sessionHistory.length === 0 ? '<div class="dim" style="padding:10px 0;">No sessions recorded</div>' : ''}
    </div>
  `;

  el.innerHTML = html;
  el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { statsFilter = b.dataset.f; renderStatsOverview(el); });
}

function renderStatsCalendar(el) {
  const year = calViewDate.getFullYear();
  const month = calViewDate.getMonth();
  
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  let html = `
    <div class="calendar-header">
      <button class="icon-btn" id="cal-prev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg></button>
      <h2>${monthNames[month]} ${year}</h2>
      <button class="icon-btn" id="cal-next"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button>
    </div>
    
    <div class="calendar-grid">
      ${['S','M','T','W','T','F','S'].map(d => `<div class="cal-day-name">${d}</div>`).join('')}
      ${Array(firstDay).fill('<div class="cal-day empty"></div>').join('')}
  `;

  const todayStr = todayKey();
  for (let d = 1; d <= daysInMonth; d++) {
    const dStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    let cls = 'cal-day';
    if (dStr === todayStr) cls += ' today';
    if (state.stats.dailyStudy[dStr] > 0) cls += ' has-activity';
    if (state.planner[dStr] && state.planner[dStr].length > 0) cls += ' has-plan';
    
    html += `<div class="${cls}" data-date="${dStr}">${d}</div>`;
  }
  html += `</div>`;

  const todayTasks = state.planner[todayStr] || [];
  html += `
    <div style="display:flex; justify-content:space-between; align-items:center; margin: 20px 0 10px;">
      <h3 style="font-size:1.05em;">Today's Plan</h3>
      <button class="link" id="plan-today" style="color:var(--accent-light); font-size:0.85em; font-weight:600;">+ Add Task</button>
    </div>
    <div class="history-card">
      ${todayTasks.length === 0 ? '<div class="dim" style="text-align:center; padding:10px;">No tasks planned for today.</div>' : 
        todayTasks.map(t => `
          <div class="hist-row" style="display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--border);">
            <input type="checkbox" ${t.completed ? 'checked' : ''} data-toggle="${t.id}" style="width:18px; height:18px; accent-color:var(--success);">
            <div style="flex:1; ${t.completed ? 'text-decoration:line-through; opacity:0.6;' : ''}">
              <div style="font-weight:600;">${esc(t.title)}</div>
              <div class="tiny dim">${t.courseId ? getCourse(t.courseId)?.name : 'General Study'} • ${t.duration}m</div>
            </div>
            <div class="tiny" style="color:${t.priority === 'High' ? 'var(--danger)' : t.priority === 'Medium' ? 'var(--warning)' : 'var(--info)'};">${t.priority}</div>
          </div>
        `).join('')
      }
    </div>
  `;

  el.innerHTML = html;

  $('#cal-prev').onclick = () => { calViewDate.setMonth(calViewDate.getMonth() - 1); renderStatsCalendar(el); };
  $('#cal-next').onclick = () => { calViewDate.setMonth(calViewDate.getMonth() + 1); renderStatsCalendar(el); };
  $('#plan-today').onclick = () => openTaskEditor(todayStr);
  
  el.querySelectorAll('.cal-day[data-date]').forEach(day => {
    day.onclick = () => openDayPlanner(day.dataset.date);
  });
  
  el.querySelectorAll('[data-toggle]').forEach(chk => {
    chk.onchange = (e) => {
      const t = todayTasks.find(x => x.id === chk.dataset.toggle);
      if (t) { t.completed = e.target.checked; save(); renderStatsCalendar(el); }
    };
  });
}

function renderStatsNotes(el) {
  const notes = [...state.notes].sort((a, b) => b.createdAt - a.createdAt);
  let html = `<div class="search-bar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input type="search" id="notes-search" placeholder="Search notes..."></div>`;
  
  if (!notes.length) html += `<div class="empty-state"><p>No notes yet.</p></div>`;
  else {
    for (const n of notes) {
      const v = getVideo(n.videoId);
      html += `
        <div class="note-list-card">
          <div class="nlc-header">
            <span class="nlc-title">${esc(v?.title || 'Unknown video')}</span>
            <button class="nc-delete" data-del="${n.id}" style="background:none;border:none;color:var(--text-2);cursor:pointer;padding:4px;"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg></button>
          </div>
          <div class="nlc-body" data-open-note="${n.id}">${esc(n.text)}</div>
          <div class="nlc-footer">
            <div class="nlc-time">${new Date(n.createdAt).toLocaleString()}</div>
            ${n.timestamp != null ? `<span class="tiny" style="color:var(--accent-light); font-weight:700;">${fmtTime(n.timestamp)}</span>` : ''}
          </div>
        </div>`;
    }
  }

  el.innerHTML = html;
  const ns = $('#notes-search', el);
  if (ns) ns.oninput = (e) => { const q = e.target.value.toLowerCase().trim(); el.querySelectorAll('.note-list-card').forEach(card => { card.style.display = card.textContent.toLowerCase().includes(q) ? '' : 'none'; }); };
  
  el.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (!await confirmBox('Delete Note?', 'This note will be permanently deleted.', 'Delete', true)) return;
      state.notes = state.notes.filter(x => x.id !== btn.dataset.del);
      save(); renderStatsNotes(el); toast('Note deleted', 'success');
    };
  });
  
  el.querySelectorAll('[data-open-note]').forEach(body => {
    body.onclick = () => {
      const n = state.notes.find(x => x.id === body.dataset.openNote);
      if (n && n.videoId) {
        openPlayer(n.videoId);
        if (n.timestamp != null) setTimeout(() => seekTo(n.timestamp), 1000);
      }
    };
  });
}

// ===== PLANNER & REMINDERS =====
function openDayPlanner(dateStr) {
  const tasks = state.planner[dateStr] || [];
  const html = `
    <div class="sheet-title">Plan for ${dateStr}</div>
    <div class="history-card" style="margin-bottom:16px;">
      ${tasks.length === 0 ? '<div class="dim" style="text-align:center; padding:10px;">No tasks planned for this day.</div>' : 
        tasks.map(t => `
          <div class="hist-row" style="display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--border);">
            <input type="checkbox" ${t.completed ? 'checked' : ''} data-toggle="${t.id}" style="width:18px; height:18px; accent-color:var(--success);">
            <div style="flex:1; ${t.completed ? 'text-decoration:line-through; opacity:0.6;' : ''}">
              <div style="font-weight:600;">${esc(t.title)}</div>
              <div class="tiny dim">${t.courseId ? getCourse(t.courseId)?.name : 'General Study'} • ${t.duration}m • ${t.reminderTime || 'No reminder'}</div>
            </div>
            <button class="nc-delete" data-del-task="${t.id}" style="background:none;border:none;color:var(--text-2);cursor:pointer;padding:4px;">×</button>
          </div>
        `).join('')
      }
    </div>
    <button class="btn btn-primary btn-block" id="add-task-day">+ Add Task for this Day</button>
    <div class="sheet-actions"><button class="btn btn-ghost btn-block" onclick="closeAllSheets()">Close</button></div>
  `;
  const w = openSheet(html);
  w.querySelector('#add-task-day').onclick = () => { closeSheet(w); openTaskEditor(dateStr); };
  
  w.querySelectorAll('[data-toggle]').forEach(chk => {
    chk.onchange = (e) => {
      const t = tasks.find(x => x.id === chk.dataset.toggle);
      if (t) { t.completed = e.target.checked; save(); }
    };
  });
  
  w.querySelectorAll('[data-del-task]').forEach(btn => {
    btn.onclick = () => {
      state.planner[dateStr] = tasks.filter(t => t.id !== btn.dataset.delTask);
      save(); closeSheet(w); toast('Task removed', 'success');
      if (statsTab === 'calendar') renderStats();
    };
  });
}

function openTaskEditor(dateStr) {
  const courses = liveSubjects();
  const html = `
    <div class="sheet-title">New Study Task</div>
    <div class="field"><label class="field-label">Task Title / Notes</label><input class="input" id="tk-title" placeholder="e.g. Finish Chapter 1"></div>
    <div class="field"><label class="field-label">Course / Subject (Optional)</label><select class="select" id="tk-course"><option value="">-- General Study --</option>${courses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label class="field-label">Planned Duration (mins)</label><input class="input" type="number" id="tk-dur" value="45" min="5"></div>
    <div class="field"><label class="field-label">Priority</label><select class="select" id="tk-pri"><option value="Low">Low</option><option value="Medium" selected>Medium</option><option value="High">High</option></select></div>
    <div class="field"><label class="field-label">Reminder Time (Optional)</label><input class="input" type="time" id="tk-reminder"></div>
    <div class="sheet-actions"><button class="btn btn-ghost" id="tk-cancel">Cancel</button><button class="btn btn-primary" id="tk-save">Save Task</button></div>
  `;
  const w = openSheet(html);
  w.querySelector('#tk-cancel').onclick = () => closeSheet(w);
  
  w.querySelector('#tk-save').onclick = () => {
    const title = w.querySelector('#tk-title').value.trim();
    if (!title) return toast('Enter a task title', 'error');
    
    if (!state.planner[dateStr]) state.planner[dateStr] = [];
    state.planner[dateStr].push({
      id: uid(),
      title,
      courseId: w.querySelector('#tk-course').value,
      duration: parseInt(w.querySelector('#tk-dur').value, 10) || 45,
      priority: w.querySelector('#tk-pri').value,
      reminderTime: w.querySelector('#tk-reminder').value,
      completed: false,
      reminded: false
    });
    save(); closeSheet(w); toast('Task added', 'success');
    if (statsTab === 'calendar') renderStats();
  };
}

// ===== SETTINGS & MENUS =====
function openSettingsSheet() {
  const html = `
    <div class="sheet-title">Settings & Tools</div>
    
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:16px;">
      <button class="opt-row" id="set-journal" style="flex-direction:column; text-align:center; padding:16px;">
        <div style="font-size:2em; margin-bottom:8px;">📖</div>
        <div class="or-title">Study Journal</div>
      </button>
      <button class="opt-row" id="set-achievements" style="flex-direction:column; text-align:center; padding:16px;">
        <div style="font-size:2em; margin-bottom:8px;">🏆</div>
        <div class="or-title">Achievements</div>
      </button>
      <button class="opt-row" id="set-notebook" style="flex-direction:column; text-align:center; padding:16px;">
        <div style="font-size:2em; margin-bottom:8px;">📓</div>
        <div class="or-title">Notebook</div>
      </button>
      <button class="opt-row" id="set-theme" style="flex-direction:column; text-align:center; padding:16px;">
        <div style="font-size:2em; margin-bottom:8px;">🎨</div>
        <div class="or-title">Themes</div>
      </button>
    </div>

    <div class="field"><label class="field-label">Daily study goal (minutes)</label><input class="input" type="number" id="set-goal" value="${state.timer.dailyGoal}" min="5" max="600"></div>
    <div class="field"><label class="field-label">Autoplay next video</label><select class="select" id="set-autoplay"><option value="1" ${state.settings.autoplay ? 'selected' : ''}>Enabled</option><option value="0" ${!state.settings.autoplay ? 'selected' : ''}>Disabled</option></select></div>
    <div class="field"><label class="field-label">Backup</label><button class="btn btn-block" id="set-export">Export Data (JSON)</button><button class="btn btn-block" id="set-import" style="margin-top:8px;">Import Data (JSON)</button><input type="file" accept=".json" id="set-import-file" style="display:none;"></div>
    <div class="field"><label class="field-label">Danger Zone</label><button class="btn btn-danger btn-block" id="set-reset">Reset All Data</button></div>
    <div class="sheet-actions"><button class="btn btn-ghost btn-block" onclick="closeAllSheets()">Close</button></div>`;
  
  const w = openSheet(html);
  
  // New Feature Bindings
  w.querySelector('#set-journal').onclick = () => { closeSheet(w); openOverlay('journal-overlay', renderJournal); };
  w.querySelector('#set-achievements').onclick = () => { closeSheet(w); openOverlay('achievements-overlay', renderAchievements); };
  w.querySelector('#set-notebook').onclick = () => { closeSheet(w); openOverlay('notebook-overlay', renderNotebook); };
  w.querySelector('#set-theme').onclick = () => { closeSheet(w); openThemeSettings(); };

  // Standard settings
  w.querySelector('#set-goal').onchange = (e) => { state.timer.dailyGoal = parseInt(e.target.value, 10) || 45; save(); toast('Goal updated', 'success'); };
  w.querySelector('#set-autoplay').onchange = (e) => { state.settings.autoplay = e.target.value === '1'; save(); };
  w.querySelector('#set-export').onclick = () => {
    const data = JSON.stringify(state, null, 2); const blob = new Blob([data], { type: 'application/json' }); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `adlearning-backup-${todayKey()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Backup downloaded', 'success');
  };
  w.querySelector('#set-import').onclick = () => w.querySelector('#set-import-file').click();
  w.querySelector('#set-import-file').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { try { state = Object.assign(blankState(), JSON.parse(reader.result)); applyTheme(); save(); toast('Data imported', 'success'); closeSheet(w); switchScreen('home'); } catch (err) { toast('Invalid backup file', 'error'); } };
    reader.readAsText(file);
  };
  w.querySelector('#set-reset').onclick = async () => {
    if (!await confirmBox('Reset All Data?', 'This permanently deletes all courses, subjects, videos, and notes.', 'Reset', true)) return;
    localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(TIMER_KEY); indexedDB.deleteDatabase(DB_NAME);
    state = blankState(); applyTheme(); closeSheet(w); toast('Data reset', 'success'); switchScreen('home');
  };
}

// Helper to open generic overlays
function openOverlay(id, renderFn) {
  const el = $('#' + id);
  renderFn();
  el.classList.add('active');
  $('#bottom-nav').classList.add('hidden');
  $('#fab').classList.add('hidden');
}

function renderSearchResults(q, container) {
  const results = [];
  for (const s of liveSubjects()) if (s.name.toLowerCase().includes(q)) results.push({ type: 'Course', title: s.name, onClick: () => openSubject(s.id) });
  for (const c of state.courses) if (!c.archivedAt && c.name.toLowerCase().includes(q)) results.push({ type: 'Subject', title: c.name, onClick: () => openCourse(c.id) });
  for (const v of state.videos) if (!v._deleted && v.title.toLowerCase().includes(q)) results.push({ type: 'Video', title: v.title, onClick: () => openPlayer(v.id) });
  
  const grid = container.querySelector('.subjects-grid');
  if (!results.length) { if (grid) grid.innerHTML = `<p class="muted" style="grid-column:1/-1;text-align:center;padding:20px;">No results for "${esc(q)}"</p>`; return; }
  let html = '';
  for (const r of results) html += `<button class="subject-card" style="aspect-ratio:auto;min-height:70px;flex-direction:row;align-items:center;padding:12px;background:var(--surface);border:1px solid var(--border);"><div class="sc-info" style="flex:1;text-align:left;"><div class="tiny dim">${r.type}</div><div class="sc-name" style="color:var(--text-0);text-shadow:none;">${esc(r.title)}</div></div></button>`;
  if (grid) { grid.innerHTML = html; grid.querySelectorAll('.subject-card').forEach((b, i) => b.onclick = () => results[i].onClick()); }
}

function openTrashSheet() {
  const html = `<div class="sheet-title">Trash (${state.trash.length})</div>${state.trash.length ? state.trash.map((t, i) => `<div class="opt-row"><div style="flex:1;"><div class="or-title">${esc(t.item.name || t.item.title || 'Untitled')}</div><div class="or-desc">${t.kind} · expires ${new Date(t.expiresAt).toLocaleDateString()}</div></div><button class="btn btn-sm" data-restore="${i}">Restore</button></div>`).join('') : '<p class="muted" style="text-align:center;padding:20px;">Trash is empty.</p>'}<div class="sheet-actions"><button class="btn btn-ghost btn-block" id="trash-clear">Empty Trash</button></div>`;
  const w = openSheet(html);
  w.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => {
    const idx = parseInt(b.dataset.restore, 10); const t = state.trash[idx]; if (!t) return;
    if (t.kind === 'subject') t.item.archivedAt = null; else if (t.kind === 'course') t.item.archivedAt = null; else if (t.kind === 'video') t.item._deleted = false;
    state.trash.splice(idx, 1); save(); closeSheet(w); toast('Restored', 'success'); renderSubjects(); renderHome();
  });
  w.querySelector('#trash-clear').onclick = () => { if (!confirm('Permanently delete all trash?')) return; state.trash = []; save(); closeSheet(w); renderSubjects(); };
}

function showFABMenu() {
  const hasCourses = liveSubjects().length > 0;
  const html = `
    <div class="sheet-title">Quick Add</div>
    ${hasCourses ? `
      <button class="opt-row" id="fab-yt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48"/></svg><div><div class="or-title">Add Video Link</div><div class="or-desc">Paste a YouTube link</div></div></button>
      <button class="opt-row" id="fab-gallery"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><div><div class="or-title">Upload File</div><div class="or-desc">Pick a video from your phone</div></div></button>
    ` : `<p class="muted" style="text-align:center;padding:16px 0;font-size:0.85em;">Create a course first to add videos.</p>`}
    <button class="opt-row" id="fab-subject"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><div><div class="or-title">New Course</div><div class="or-desc">Group your learning topics</div></div></button>
    <div class="sheet-actions"><button class="btn btn-ghost btn-block" id="fab-cancel">Cancel</button></div>`;
  const w = openSheet(html);
  w.querySelector('#fab-cancel').onclick = () => closeSheet(w);
  if (hasCourses) {
    w.querySelector('#fab-yt').onclick = () => { closeSheet(w); openAddYT(); };
    w.querySelector('#fab-gallery').onclick = () => { closeSheet(w); openAddGallery(); };
  }
  w.querySelector('#fab-subject').onclick = () => { closeSheet(w); openSubjectEditor(null); };
}

function loadYTApi() {
  if (window.YT && window.YT.Player) { ytApiReady = true; return; }
  if (document.getElementById('yt-api-script')) return;
  const s = document.createElement('script'); s.id = 'yt-api-script'; s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
  window.onYouTubeIframeAPIReady = () => { ytApiReady = true; };
}

window.addEventListener('popstate', () => {
  if ($('#player-overlay').classList.contains('active')) closePlayer();
  else if ($('#course-overlay').classList.contains('active')) closeCourse();
});

function boot() {
  load();
  applyTheme();
  loadTimer();
  loadYTApi();
  checkAchievements();
  
  // Start background active time tracker
  setInterval(() => {
    if (document.visibilityState === 'visible' && !timer.running) {
      // Award passive time if user is looking at app
      state.stats.dailyStudy[todayKey()] = (state.stats.dailyStudy[todayKey()] || 0) + 0.1;
      state.stats.totalStudyTime = (state.stats.totalStudyTime || 0) + 0.1;
      save();
      checkAchievements();
    }
  }, 10000); // every 10s

  // Request Notification Permission
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
  
  // Check reminders every minute
  setInterval(() => {
    if (Notification.permission !== "granted") return;
    const nowObj = new Date();
    const todayStr = todayKey(nowObj);
    const currentTimeStr = String(nowObj.getHours()).padStart(2,'0') + ':' + String(nowObj.getMinutes()).padStart(2,'0');
    const todayTasks = state.planner[todayStr] || [];
    let hasNewReminder = false;
    todayTasks.forEach(t => {
      if (!t.completed && t.reminderTime === currentTimeStr && !t.reminded) {
        t.reminded = true;
        hasNewReminder = true;
        try {
          new Notification("AD-LEARNING Study Reminder", { body: `It's time to study: ${t.title}` });
        } catch (e) {}
        toast(`Reminder: ${t.title}`, 'info', () => switchScreen('stats'), 'View');
      }
    });
    if (hasNewReminder) save();
  }, 60000);

  $$('.nav-btn').forEach(b => b.onclick = () => switchScreen(b.dataset.tab));
  $('#fab').onclick = () => showFABMenu();
  switchScreen('home');
  console.log('%cAD-LEARNING ready ✓', 'color:#A78BFA;font-weight:bold;font-size:14px;');
}

document.addEventListener('DOMContentLoaded', boot);


// ===== AD-LEARNING PWA SERVICE WORKER =====
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .then(() => {
        console.log("AD-LEARNING offline support enabled");
      })
      .catch(error => {
        console.error("Service worker registration failed:", error);
      });
  });
}
