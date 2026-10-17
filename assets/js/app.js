/* ============================================================
   app.js —— 界面逻辑（无依赖）
   ============================================================ */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const CHUNK = 2 * 1024 * 1024;      // 分片 2MB
  const THUMB_MAX_BYTES = 100 * 1024; // 缩略图上限 100KB（超出则自动降质/缩边）
  const LS_TOKEN = 'cd.token', LS_USER = 'cd.user', LS_VIEW = 'cd.view';

  const state = {
    folder: '/',            // 当前目录
    query: '',              // 搜索词
    scope: 'all',           // all | mine
    items: [],
    allItems: [],           // 全量（左侧计数/智能视图用），首屏渲染前是空数组
    view: localStorage.getItem(LS_VIEW) || 'grid',
    sort: 'mtime-desc',
    user: null,
    tags: [],               // 预设标签（服务端下发）
    groups: [],             // 标签分类（tag 文件夹，如「同学名字」）
    canEditTags: false,     // 只有管理员能改标签
    tag: [],                // 已选标签 id（可多选，空 = 不筛）
    group: null,            // 当前按哪个分类筛选（null = 不筛）
    opened: JSON.parse(localStorage.getItem('cd.tgopen') || '{}'),  // 分类文件夹「展开」状态（默认收起）
    // 搜索范围（标签 / 文件名 / 上传者），默认三个都搜
    sfields: (() => {
      try { const o = JSON.parse(localStorage.getItem('cd.sfields') || ''); if (o && typeof o === 'object') return o; } catch (e) {}
      return { tag: true, name: true, uploader: true };
    })(),
    // 文件多选状态
    selected: new Set(),    // 已选文件路径集合
    selMode: false,         // 是否处于选择模式
  };
  const SF_KEYS = ['tag', 'name', 'uploader'];
  const fieldsQ = () => {
    const on = SF_KEYS.filter((k) => state.sfields[k]);
    return on.length === SF_KEYS.length ? '' : '&fields=' + (on.length ? on.join(',') : 'none');
  };

  /* ---------------- 工具 ---------------- */
  function fmtSize(n) {
    if (n == null) return '—';
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
  }
  function fmtDate(ms) {
    const d = new Date(ms), n = new Date();
    const sameDay = d.toDateString() === n.toDateString();
    const p = (x) => String(x).padStart(2, '0');
    if (sameDay) return '今天 ' + p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }
  function fmtDur(s) {
    if (!isFinite(s) || s <= 0) return '';
    s = Math.round(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  /* 评论 / 留言的时间：刚刚 / N 分钟前 / N 小时前 / N 天前，再久就报日期 */
  function fmtWhen(ms) {
    if (!ms) return '';
    const d = Date.now() - ms;
    if (d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
    return fmtDate(ms);
  }
  /* 小头像：有头像用图，没有就用名字里的一两个字（跟侧栏头像一个写法） */
  function avatarHTML(name, uid, hasAvatar, cls) {
    const src = hasAvatar ? API.avatarUrl(uid) : null;
    if (src) return `<img class="${cls}" src="${esc(src)}" alt="">`;
    const n = String(name || '?');
    return `<span class="${cls} av-txt" aria-hidden="true">${esc(n.slice(-2, -1) || n[0] || '?')}</span>`;
  }
  let toastTimer;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2400);
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- 通用弹窗（代替浏览器 alert/confirm/prompt） ---------------- */
  let dlgResolve = null, dlgHasInput = false;
  function dlgFinish(result) {
    const done = dlgResolve; dlgResolve = null;
    $('#dlgModal').hidden = true;
    if (done) done(result);
  }
  function openDialog(o) {
    o = o || {};
    return new Promise((resolve) => {
      dlgResolve = resolve;
      dlgHasInput = !!o.input;
      $('#dlgTitle').textContent = o.title || '提示';
      const msg = $('#dlgMsg');
      if (o.message) { msg.textContent = o.message; msg.hidden = false; } else { msg.textContent = ''; msg.hidden = true; }
      const field = $('#dlgField');
      if (dlgHasInput) {
        field.hidden = false;
        $('#dlgLabel').textContent = o.label || '';
        const inp = $('#dlgInput');
        inp.value = o.value != null ? o.value : '';
        inp.placeholder = o.placeholder || '';
        inp.maxLength = o.maxlength || 255;
      } else {
        field.hidden = true;
      }
      $('#dlgErr').hidden = true;
      const ok = $('#dlgOk');
      ok.textContent = o.okText || '确定';
      ok.className = 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary');
      $('#dlgCancel').textContent = o.cancelText || '取消';
      $('#dlgModal').hidden = false;
      if (dlgHasInput) setTimeout(() => { const i = $('#dlgInput'); i.focus(); i.select(); }, 30);
    });
  }
  const uiConfirm = (o) => openDialog(Object.assign({ input: false, okText: '确定' }, o)).then((v) => v === true);
  const uiPrompt = (o) => openDialog(Object.assign({ input: true, okText: '确定' }, o)).then((v) => (v == null ? null : String(v)));
  $('#dlgOk').addEventListener('click', () => {
    if (dlgHasInput) {
      const v = $('#dlgInput').value;
      if (!v.trim()) { const el = $('#dlgErr'); el.textContent = '这里不能是空的'; el.hidden = false; return; }
      dlgFinish(v);
    } else dlgFinish(true);
  });
  $('#dlgCancel').addEventListener('click', () => dlgFinish(dlgHasInput ? null : false));
  $('#dlgClose').addEventListener('click', () => dlgFinish(dlgHasInput ? null : false));
  $('#dlgModal').addEventListener('click', (e) => { if (e.target === $('#dlgModal')) dlgFinish(dlgHasInput ? null : false); });
  $('#dlgInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#dlgOk').click(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dlgResolve) { e.stopPropagation(); dlgFinish(dlgHasInput ? null : false); }
  }, true);

  /* 标签排序：按拼音首字母 A→Z（浏览器中文排序就是拼音序），数字/英文排在前面 */
  const zhColl = (() => { try { return new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true }); } catch (e) { return null; } })();
  const byPinyin = (a, b) => (zhColl ? zhColl.compare(String(a), String(b))
    : String(a).localeCompare(String(b), 'zh', { numeric: true }));
  const sortTags = (arr) => arr.slice().sort((x, y) => byPinyin(x.name, y.name));
  const sortGroups = (arr) => arr.slice().sort((x, y) => byPinyin(x.name, y.name));

  const ICON = {
    folder: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 7a3 3 0 0 1 3-3h3.4a3 3 0 0 1 2.1.9l.9.9H17a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7Z" fill="currentColor" opacity=".85"/></svg>',
    image: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 5h16v14H4z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 16l3.6-4.3 2.7 3 2-2.2L17 16z" fill="currentColor"/><circle cx="9" cy="9.2" r="1.5" fill="currentColor"/></svg>',
    video: '<svg viewBox="0 0 24 24" width="26" height="26"><rect x="3" y="6" width="13" height="12" rx="2" fill="currentColor" opacity=".9"/><path d="M17 10.5 21 8v8l-4-2.5z" fill="currentColor"/></svg>',
    audio: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M9 18V7l10-2v11" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="7" cy="18" r="2.2" fill="currentColor"/><circle cx="17" cy="16" r="2.2" fill="currentColor"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="12" y="17" font-size="6.4" font-family="sans-serif" font-weight="700" fill="currentColor" text-anchor="middle">PDF</text></svg>',
    doc: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 11h6M9 14h6M9 17h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    sheet: '<svg viewBox="0 0 24 24" width="26" height="26"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 9.5h16M4 15h16M9.5 4v16M14.5 4v16" stroke="currentColor" stroke-width="1.3"/></svg>',
    slide: '<svg viewBox="0 0 24 24" width="26" height="26"><rect x="3" y="5" width="18" height="12" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 17v4M8 21h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    archive: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 4h14v16H5z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 4h2v3h-2zM11 9h2v3h-2z" fill="currentColor"/><rect x="10" y="14" width="4" height="4" rx="1" fill="currentColor"/></svg>',
    code: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M9 8 5 12l4 4M15 8l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    text: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M6 4h12v16H6z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 8h6M9 12h6M9 16h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    other: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    dl: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 4v11M7 11l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    del: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 7h14M10 7V5h4v2M8 7l1 12h6l1-12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
    tag: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M11.6 4H20v8.4l-8.3 8.3a1.6 1.6 0 0 1-2.3 0l-6.1-6.1a1.6 1.6 0 0 1 0-2.3L11.6 4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="16.2" cy="7.8" r="1.5" fill="currentColor"/></svg>',
    folderSm: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 7a3 3 0 0 1 3-3h3.4a3 3 0 0 1 2.1.9l.9.9H17a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7Z" fill="currentColor" opacity=".8"/></svg>',
    filter: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 5h16l-6.2 7.2V19l-3.6-2v-4.8L4 5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 11v5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="8" r="1.1" fill="currentColor"/></svg>',
    rename: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 20h16M14 4.5l5.5 5.5L9 20.5H3.5V15z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    move: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7a3 3 0 0 1 3-3h3a3 3 0 0 1 2.1.9l.9.9H17a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 10.6v4.2M10.2 13.4l1.8 1.8 1.8-1.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    empty: '<svg viewBox="0 0 24 24" width="54" height="54"><path d="M4 7a3 3 0 0 1 3-3h3.4a3 3 0 0 1 2.1.9l.9.9H17a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7Z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'
  };

  const SMART = [
    { key: 'all', label: '全部文件', icon: 'folder', to: '/' },
    { key: 'mine', label: '我上传的', icon: 'image', scope: 'mine' }
  ];
  let smart = 'all';

  /* ---------------- 登录 / 注册 ---------------- */
  let regMode = false;
  $('#switchMode').addEventListener('click', () => {
    regMode = !regMode;
    $$('.reg-only').forEach((e) => { e.hidden = !regMode; });
    $$('.login-only').forEach((e) => { e.hidden = regMode; });
    $('#loginBtn').textContent = regMode ? '注册并进入' : '进入';
    $('#switchMode').textContent = regMode ? '← 返回登录' : '没有账号？用班级口令注册';
    $('#passLabel').textContent = regMode ? '设置密码' : '密码';
    $('#passHint').hidden = !regMode;
    $('#loginErr').hidden = true;
    (regMode ? $('#regInvite') : $('#loginUser')).focus();
  });

  function avatarInnerHTML() {
    const u = state.user || {};
    const src = u.hasAvatar ? API.avatarUrl(u.id) : null;
    if (src) return `<img src="${esc(src)}" alt="">`;
    const n = u.name || '?';
    return esc(n.slice(-2, -1) || n[0] || '?');
  }
  function syncAvatarUI() {
    const html = avatarInnerHTML();
    const chip = $('#userAvatar'); if (chip) chip.innerHTML = html;
    const pv = $('#avatarPreview'); if (pv) pv.innerHTML = html;
    const clr = $('#avatarClear'); if (clr) clr.hidden = !(state.user && state.user.hasAvatar);
  }
  function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#userName').textContent = state.user.name;
    $('#userRole').textContent = state.user.role === 'admin' ? '管理员' : '同学';
    syncAvatarUI();
    load(state.folder);
    loadTree();
    applyBoardOpen();
    loadBoard();
    maybeShowNotice();
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn'), err = $('#loginErr');
    err.hidden = true;
    btn.disabled = true; btn.textContent = regMode ? '注册中…' : '登录中…';
    try {
      const user = $('#loginUser').value, pass = $('#loginPass').value;
      const r = regMode
        ? await API.register(user, pass, $('#regInvite').value.trim())
        : await API.login(user, pass);
      API.token = r.token; state.user = r.user;
      localStorage.setItem(LS_TOKEN, r.token);
      localStorage.setItem(LS_USER, JSON.stringify(r.user));
      if (state.user.mustChange) return askNewPassword(pass);   // 首登：改完密码才放行
      showApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = regMode ? '注册并进入' : '进入';
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await API.logout();
    localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER);
    location.reload();
  });

  /* ---------------- 首次登录：强制改密码 ---------------- */
  function askNewPassword(prefillOld) {
    $('#login').hidden = true;
    $('#pwScreen').hidden = false;
    $('#pwWho').textContent = (state.user && state.user.name ? state.user.name + '，' : '') +
      '第一次登录，请把初始密码改成你自己的';
    $('#pwErr').hidden = true;
    if (prefillOld) $('#pwOld').value = prefillOld;
    ($('#pwOld').value ? $('#pwNew') : $('#pwOld')).focus();
  }

  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#pwBtn'), err = $('#pwErr');
    err.hidden = true;
    const oldPw = $('#pwOld').value, n1 = $('#pwNew').value, n2 = $('#pwNew2').value;
    if (n1 !== n2) { err.textContent = '两次输入的新密码不一样'; err.hidden = false; return; }
    if (n1.length < 4) { err.textContent = '新密码至少 4 位'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await API.changePassword(oldPw, n1);
      state.user = r.user || Object.assign({}, state.user, { mustChange: false });
      localStorage.setItem(LS_USER, JSON.stringify(state.user));
      $('#pwOld').value = ''; $('#pwNew').value = ''; $('#pwNew2').value = '';
      $('#pwScreen').hidden = true;
      showApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = '保存并进入';
    }
  });

  $('#pwOut').addEventListener('click', async () => {
    await API.logout();
    localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER);
    location.reload();
  });

  /* ---------------- 目录树 ---------------- */
  async function loadTree() {
    const tree = $('#tree');
    const top = await API.list('/');
    const dirs = top.items.filter((i) => i.isDir);

    let html = '';
    for (const s of SMART) {
      const n = countFor(s);
      html += `<button class="tree-item ${smart === s.key ? 'is-on' : ''}" data-smart="${s.key}">
        ${ICON[s.icon]}<span>${s.label}</span><span class="ti-count">${n}</span></button>`;
    }
    html += `<div class="tree-sep">目录</div>`;
    for (const d of dirs) {
      html += `<button class="tree-item" data-go="${esc(d.path)}">${ICON.folder}<span>${esc(d.name)}</span></button>`;
    }
    // ---- 标签（预设，只有管理员能改；可选分类，如「同学名字」）----
    html += `<div class="tree-sep">标签${state.canEditTags ? `<button class="sep-btn" id="tagManageBtn" title="管理标签">管理</button>` : ''}</div>`;
    if (!state.tags.length && !state.groups.length) {
      html += `<div class="tree-empty">${state.canEditTags ? '还没有标签，点「管理」加一个' : '管理员还没有设置标签'}</div>`;
    } else {
      const tagItem = (t, nest) => `<button class="tree-item tg-item ${nest ? 'is-nest' : ''} ${(state.tag || []).includes(t.id) ? 'is-on' : ''}" data-tag="${t.id}">
          <span class="tg-dot" data-c="${esc(t.color)}"></span><span class="tg-name">${esc(t.name)}</span>
          <span class="ti-count">${t.count || 0}</span></button>`;
      // 分类 = 标签文件夹：默认收起，点文件夹展开/收起；右侧小按钮 = 只看这个分类的文件
      for (const g of sortGroups(state.groups)) {
        const inG = sortTags(state.tags.filter((t) => t.group === g.id));
        const open = !!state.opened[g.id];
        const active = String(state.group) === String(g.id);
        html += `<button class="tree-item tg-head ${active ? 'is-on' : ''}" data-gfold="${g.id}" title="${open ? '收起' : '展开'}「${esc(g.name)}」">
          <span class="caret${open ? '' : ' is-fold'}" data-fold="${g.id}"></span>
          <span class="tg-fico">${ICON.folderSm}</span>
          <span class="tg-gname">${esc(g.name)}</span>
          ${inG.length ? `<span class="tg-gfilter" data-gfilter="${g.id}" title="只看这个分类的文件">${ICON.filter}</span>` : ''}
          <span class="ti-count">${inG.length}</span></button>`;
        if (open) {
          html += inG.length ? inG.map((t) => tagItem(t, 1)).join('')
            : `<div class="tg-empty">这个分类还是空的</div>`;
        }
      }
      const loose = sortTags(state.tags.filter((t) => t.group == null));
      if (loose.length) {
        if (state.groups.length) html += `<div class="tg-sub">未分类</div>`;
        html += loose.map((t) => tagItem(t, 0)).join('');
      }
    }
    tree.innerHTML = html;
    tree.querySelectorAll('[data-smart]').forEach((b) => b.addEventListener('click', () => pickSmart(b.dataset.smart)));
    tree.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { closeDrawer(); go(b.dataset.go); }));
    tree.querySelectorAll('[data-tag]').forEach((b) => b.addEventListener('click', () => pickFilter('tag', Number(b.dataset.tag))));
    tree.querySelectorAll('[data-gfold]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.gfold;
      state.opened[id] = !state.opened[id];
      localStorage.setItem('cd.tgopen', JSON.stringify(state.opened));
      loadTree();
    }));
    tree.querySelectorAll('[data-gfilter]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      pickFilter('group', Number(b.dataset.gfilter));
    }));
    const mb = $('#tagManageBtn');
    if (mb) mb.addEventListener('click', (e) => { e.stopPropagation(); openTagModal(); });
  }
  function countFor(s) {
    const all = state.allItems || [];
    if (s.key === 'all') return all.length;
    if (s.scope === 'mine') return all.filter((i) => i.uploader === state.user.name).length;
    return all.filter((i) => s.kinds.includes(i.kind)).length;
  }

  /* ---------------- 标签 ---------------- */
  async function refreshTags() {
    try {
      const r = await API.tags();
      state.tags = r.tags || [];
      state.groups = r.groups || [];
      state.canEditTags = !!r.canEdit;
    } catch (e) {                       // 后端还是老版本 → 静默隐藏标签区
      state.tags = []; state.groups = []; state.canEditTags = false;
    }
  }

  /* 标签小片（卡片 / 列表共用；文件夹没有标签，不会调用）：最多 max 个，多的折成 +N */
  function tagChips(it, max) {
    const ts = it.tags || [];
    if (!ts.length) return '';
    const show = ts.slice(0, max || 3);
    return show.map((t) =>
      `<span class="tag" data-c="${esc(t.color)}">${esc(t.name)}</span>`).join('') +
      (ts.length > show.length ? `<span class="tag is-more">+${ts.length - show.length}</span>` : '');
  }
  const chipHTML = (ts) => (ts || []).map((t) =>
    `<span class="tag" data-c="${esc(t.color)}">${esc(t.name)}</span>`).join('');

  /* 点标签 = 筛该标签（可多选，再点取消）；点分类 = 筛这个「标签文件夹」下的全部文件 */
  async function applyTagFilter() {
    const ids = (state.tag || []).slice();
    const gid = state.group;
    let label = '标签';
    if (gid != null) {
      const g = state.groups.find((x) => x.id === gid);
      label = '标签分类：' + (g ? g.name : '');
    } else if (ids.length) {
      const ts = state.tags.filter((t) => ids.includes(t.id));
      label = '标签：' + ts.map((t) => t.name).join('、');
    }
    state.query = '';
    $('#searchInput').value = '';
    let items = [];
    try {
      items = (await API.search('', 'all', ids, gid)).items || [];
    } catch (e) {                        // 兜底：退化成客户端过滤
      items = state.allItems.filter((i) => (i.tags || []).some((t) =>
        gid != null ? t.group === gid : ids.includes(t.id)));
    }
    state.items = items;
    $('#crumbs').innerHTML = `<button data-go="/">全部文件</button><span class="sep">/</span><span class="cur">${esc(label)}</span>`;
    $('#crumbs').querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => load(b.dataset.go)));
    render(); loadTree(); closeDrawer();
  }

  async function pickFilter(kind, id) {
    if (kind === 'group') {
      state.tag = [];
      state.group = id;
      smart = 'tag';
      await applyTagFilter();
      return;
    }
    // tag：多选切换（再点一次取消）
    const arr = (state.tag || []).slice();
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1); else arr.push(id);
    state.tag = arr;
    state.group = null;
    if (!arr.length) {                   // 全部取消 → 回正常浏览
      smart = 'all';
      await load(state.folder);
      return;
    }
    smart = 'tag';
    await applyTagFilter();
  }
  const reapplyFilter = () => (smart === 'tag' ? applyTagFilter() : Promise.resolve());

  function syncItemTags(it) {
    [state.items, state.allItems].forEach((arr) => arr.forEach((x) => { if (x.path === it.path) x.tags = it.tags; }));
    if (!$('#viewer').hidden && $('#viewerName').textContent === it.name) $('#viewerTags').innerHTML = chipHTML(it.tags);
  }

  /* 给一张图片/视频挑标签的浮层 */
  let tagMenuEl = null;
  function closeTagMenu() { if (tagMenuEl) { tagMenuEl.remove(); tagMenuEl = null; } }
  function openTagMenu(it, anchor) {
    closeTagMenu();
    if (!state.tags.length) {
      toast(state.canEditTags ? '先在左侧「标签」里加一个' : '管理员还没有设置标签');
      if (state.canEditTags) openTagModal();
      return;
    }
    const has = (id) => (it.tags || []).some((t) => t.id === id);
    const m = document.createElement('div');
    m.className = 'tagmenu';
    const tmItem = (t) => `<button class="tm-item ${has(t.id) ? 'is-on' : ''}" data-tid="${t.id}">
        <span class="tg-dot" data-c="${esc(t.color)}"></span><span class="tm-name">${esc(t.name)}</span>
        <span class="tm-tick">✓</span></button>`;
    const OPEN = state.tgOpen || (state.tgOpen = JSON.parse(localStorage.getItem('cd.tgopen2') || '{}'));
    const bodyHTML = (kw) => {
      const k = (kw || '').trim().toLowerCase();
      const hit = (t) => !k || t.name.toLowerCase().includes(k);
      let out = '';
      if (state.groups.length) {
        for (const g of sortGroups(state.groups)) {
          const inG = sortTags(state.tags.filter((t) => t.group === g.id && hit(t)));
          if (!inG.length) continue;
          const open = !!k || !!OPEN[g.id];          // 已分类的默认折叠；搜标签时自动展开
          out += `<button type="button" class="tm-sep tm-fold" data-g="${g.id}">
            <span class="tm-ar">${open ? '▾' : '▸'}</span><span class="tm-gn">${esc(g.name)}</span>
            <span class="tm-n">${inG.length}</span></button>` + (open ? inG.map(tmItem).join('') : '');
        }
        const loose = sortTags(state.tags.filter((t) => t.group == null && hit(t)));
        if (loose.length) out += `<div class="tm-sep">未分类</div>` + loose.map(tmItem).join('');
      } else {
        out = sortTags(state.tags.filter(hit)).map(tmItem).join('');
      }
      return out || `<div class="tm-none">没有匹配的标签</div>`;
    };
    const needSearch = state.tags.length > 10;
    m.innerHTML = `<div class="tm-head" title="${esc(it.name)}">给「${esc(it.name)}」加标签</div>
      ${needSearch ? `<input class="tm-search" id="tmSearch" type="search" placeholder="搜标签（同学名字）…">` : ''}
      <div class="tm-body" id="tmBody">${bodyHTML('')}</div>
      ${state.canEditTags ? `<button class="tm-foot" id="tmManage">管理标签…</button>` : ''}`;
    document.body.appendChild(m);
    tagMenuEl = m;
    const r = anchor.getBoundingClientRect();
    const h = m.offsetHeight, w = m.offsetWidth;
    m.style.left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8)) + 'px';
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    m.style.top = top + 'px';

    const inp = m.querySelector('#tmSearch');
    if (inp) {
      inp.addEventListener('click', (e) => e.stopPropagation());
      inp.addEventListener('input', () => { m.querySelector('#tmBody').innerHTML = bodyHTML(inp.value); });
      inp.focus();
    }
    m.querySelector('#tmBody').addEventListener('click', async (e) => {
      const fb = e.target.closest('[data-g]');
      if (fb) {                                   // 展开 / 收起这个分类
        e.stopPropagation();
        const gid = fb.dataset.g;
        OPEN[gid] = !OPEN[gid];
        localStorage.setItem('cd.tgopen2', JSON.stringify(OPEN));
        m.querySelector('#tmBody').innerHTML = bodyHTML(inp ? inp.value : '');
        return;
      }
      const b = e.target.closest('[data-tid]');
      if (!b) return;
      e.stopPropagation();
      const id = Number(b.dataset.tid);
      const on = (it.tags || []).some((t) => t.id === id);
      b.disabled = true;
      try {
        const res = await API.tagSet(it.path, on ? [] : [id], on ? [id] : []);
        it.tags = res.tags || [];
        syncItemTags(it);
        await refreshTags();
        if (smart === 'tag') await reapplyFilter(); else { render(); loadTree(); }
        m.querySelector('#tmBody').innerHTML = bodyHTML(inp ? inp.value : '');
      } catch (err) { toast(err.message, 3600); }
      finally { b.disabled = false; }
    });
    const mg = m.querySelector('#tmManage');
    if (mg) mg.addEventListener('click', () => { closeTagMenu(); openTagModal(); });
    setTimeout(() => {
      const off = (ev) => { if (tagMenuEl && !tagMenuEl.contains(ev.target)) { closeTagMenu(); document.removeEventListener('click', off); } };
      document.addEventListener('click', off);
    }, 0);
  }

  /* 管理标签（只有管理员看得到入口） */
  let addColor = API.TAG_COLORS[0];
  function openTagModal() { $('#tagModal').hidden = false; renderTagModal(); }
  function closeTagModal() { $('#tagModal').hidden = true; }
  function groupOptions(sel) {
    return `<option value="">未分类</option>` + state.groups.map((g) =>
      `<option value="${g.id}"${String(sel) === String(g.id) ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
  }
  function renderTagModal() {
    /* --- 分类（tag 文件夹，例如「同学名字」） --- */
    const gl = $('#groupList');
    gl.innerHTML = state.groups.length ? state.groups.map((g) => `<li class="group-row" data-id="${g.id}">
        <span class="g-ico">📁</span>
        <input class="group-name" value="${esc(g.name)}" maxlength="16" aria-label="分类名">
        <span class="tag-count">${state.tags.filter((t) => t.group === g.id).length} 个标签</span>
        <button class="icon-btn danger" data-gdel="${g.id}" title="删除分类">${ICON.del}</button>
      </li>`).join('') : `<li class="tag-none">还没有分类。分类就是标签的文件夹，比如建一个「同学名字」把所有同学标签放进去</li>`;
    gl.querySelectorAll('.group-row').forEach((li) => {
      const id = Number(li.dataset.id);
      const input = li.querySelector('.group-name');
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      input.addEventListener('change', async () => {
        try { await API.tagGroupUpdate(id, input.value); await refreshTags(); renderTagModal(); render(); loadTree(); }
        catch (e) { toast(e.message, 3600); renderTagModal(); }
      });
      li.querySelector('[data-gdel]').addEventListener('click', async () => {
        const g = state.groups.find((x) => x.id === id) || { name: '' };
        const n = state.tags.filter((t) => t.group === id).length;
        const okd = await uiConfirm({
          title: '删除分类',
          message: `删除分类「${g.name}」？\n里面的 ${n} 个标签会变成「未分类」，不会删掉标签。`,
          okText: '删除', danger: true
        });
        if (!okd) return;
        try {
          await API.tagGroupDelete(id, false);
          await refreshTags(); syncAllTags();
          if (state.group === id) { state.group = null; await load(state.folder); }
          renderTagModal(); render(); loadTree();
          toast('分类已删除，里面的标签已挪到未分类');
        } catch (e) { toast(e.message, 3600); }
      });
    });

    /* --- 标签（按分类分段显示，多了还能搜） --- */
    const ul = $('#tagList');
    const kw = ($('#tagFilter') ? $('#tagFilter').value : '').trim().toLowerCase();
    const hit = (t) => !kw || t.name.toLowerCase().includes(kw);
    const rowOf = (t) => `<li class="tag-row" data-id="${t.id}">
        <span class="tg-dot" data-c="${esc(t.color)}"></span>
        <input class="tag-name" value="${esc(t.name)}" maxlength="12" aria-label="标签名">
        <select class="tag-group" aria-label="所属分类">${groupOptions(t.group)}</select>
        <span class="tag-count">${t.count || 0} 个文件</span>
        <span class="tag-pal">${API.TAG_COLORS.map((c) =>
          `<button class="pal-dot ${c === t.color ? 'is-on' : ''}" data-c="${c}" title="${API.TAG_COLOR_CN[c] || c}" aria-label="${c}"></button>`).join('')}</span>
        <button class="icon-btn danger" data-del="${t.id}" title="删除标签">${ICON.del}</button>
      </li>`;
    let rows = '';
    for (const g of sortGroups(state.groups)) {
      const inG = sortTags(state.tags.filter((t) => t.group === g.id && hit(t)));
      if (!inG.length) continue;
      rows += `<li class="tag-sec">${esc(g.name)}<span>${inG.length}</span></li>` + inG.map(rowOf).join('');
    }
    const loose = sortTags(state.tags.filter((t) => t.group == null && hit(t)));
    if (loose.length) {
      if (state.groups.length) rows += `<li class="tag-sec">未分类<span>${loose.length}</span></li>`;
      rows += loose.map(rowOf).join('');
    }
    ul.innerHTML = rows || (state.tags.length ? `<li class="tag-none">没有匹配的标签</li>`
      : `<li class="tag-none">还没有标签，先在下面加一个</li>`);

    ul.querySelectorAll('.tag-row').forEach((li) => {
      const id = Number(li.dataset.id);
      const input = li.querySelector('.tag-name');
      const cur = () => state.tags.find((x) => x.id === id) || {};
      const save = async (name, color, group) => {
        try {
          await API.tagUpdate(id, name, color, group);
          await refreshTags(); syncAllTags(); renderTagModal(); render(); loadTree();
          toast('标签已更新');
        } catch (e) { toast(e.message, 3600); renderTagModal(); }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      input.addEventListener('change', () => save(input.value, cur().color, undefined));
      li.querySelector('.tag-group').addEventListener('change', (e) =>
        save(undefined, undefined, e.target.value === '' ? null : Number(e.target.value)));
      li.querySelectorAll('.pal-dot').forEach((b) => b.addEventListener('click', () => save(undefined, b.dataset.c, undefined)));
      li.querySelector('[data-del]').addEventListener('click', async () => {
        const t = cur();
        const okd = await uiConfirm({
          title: '删除标签',
          message: `删除标签「${t.name || ''}」？\n挂在文件上的这个标签也会一起摘掉，文件本身不动。`,
          okText: '删除', danger: true
        });
        if (!okd) return;
        try {
          await API.tagDelete(id);
          await refreshTags(); syncAllTags();
          if ((state.tag || []).includes(id)) {
            state.tag = state.tag.filter((x) => x !== id);
            if (state.tag.length) await reapplyFilter(); else await load(state.folder);
          }
          renderTagModal(); render(); loadTree();
          toast('标签已删除');
        } catch (e) { toast(e.message, 3600); }
      });
    });

    $('#tagAddGroup').innerHTML = groupOptions(null);
    const pal = $('#tagPalette');
    pal.innerHTML = API.TAG_COLORS.map((c) =>
      `<button type="button" class="pal-dot ${c === addColor ? 'is-on' : ''}" data-c="${c}" title="${API.TAG_COLOR_CN[c] || c}" aria-label="${c}"></button>`).join('');
    pal.querySelectorAll('.pal-dot').forEach((b) => b.addEventListener('click', () => { addColor = b.dataset.c; renderTagModal(); }));
  }
  /* 标签改了名/换了色/换了分类/被删，列表里的标签也要跟着变 */
  function syncAllTags() {
    const byId = {};
    state.tags.forEach((t) => { byId[t.id] = t; });
    [state.items, state.allItems].forEach((arr) => arr.forEach((x) => {
      if (!x.tags) return;
      x.tags = x.tags.map((t) => (byId[t.id] ? { id: byId[t.id].id, name: byId[t.id].name, color: byId[t.id].color, group: byId[t.id].group } : null)).filter(Boolean);
    }));
  }
  $('#tagModalClose').addEventListener('click', closeTagModal);
  $('#tagModal').addEventListener('click', (e) => { if (e.target === $('#tagModal')) closeTagModal(); });
  $('#groupAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#groupAddName');
    try {
      await API.tagGroupCreate(inp.value);
      inp.value = '';
      await refreshTags(); renderTagModal(); render(); loadTree();
      toast('分类已添加');
    } catch (ex) { toast(ex.message, 3600); }
  });
  $('#tagAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#tagAddName');
    const g = $('#tagAddGroup').value;
    try {
      await API.tagCreate(inp.value, addColor, g === '' ? null : Number(g));
      inp.value = '';
      await refreshTags(); renderTagModal(); render(); loadTree();
      toast('标签已添加');
    } catch (ex) { toast(ex.message, 3600); }
  });
  let tagFilterTimer;
  $('#tagFilter').addEventListener('input', () => {
    clearTimeout(tagFilterTimer);
    tagFilterTimer = setTimeout(() => { const v = $('#tagFilter').value; renderTagModal(); $('#tagFilter').value = v; $('#tagFilter').focus(); }, 180);
  });


  /* ---------------- 取数 ---------------- */
  async function load(path) {
    state.folder = path; state.query = '';
    $('#searchInput').value = '';
    smart = 'all'; state.tag = []; state.group = null;
    const r = await API.list(path);
    state.items = r.items;
    // 全量（用于左侧计数和智能视图）：根目录下的文件 + 各子目录里的文件
    const root = await API.list('/');
    const acc = root.items.filter((i) => !i.isDir);
    async function walk(p, depth) {
      const rr = await API.list(p);
      for (const it of rr.items) {
        if (it.isDir) { if (depth < 2) await walk(it.path, depth + 1); }
        else acc.push(it);
      }
    }
    for (const d of root.items.filter((i) => i.isDir)) { await walk(d.path, 0); }
    state.allItems = acc;
    await refreshTags();
    render(); renderQuota(); loadTree();
  }

  async function renderQuota() {
    try {
      const d = await API.diskInfo();
      $('#quotaText').textContent = '剩 ' + fmtSize(d.free) + ' / ' + fmtSize(d.total);
      $('#quotaFill').style.width = Math.min(100, (1 - d.free / d.total) * 100).toFixed(1) + '%';
    } catch (e) {
      const total = state.allItems.reduce((a, i) => a + (i.size || 0), 0);
      $('#quotaText').textContent = fmtSize(total) + ' / —';
      $('#quotaFill').style.width = '0%';
    }
  }

  /* ---------------- 渲染 ---------------- */
  function sortItems(list) {
    const [k, dir] = state.sort.split('-');
    return list.slice().sort((a, b) => {
      let r = 0;
      if (k === 'name') r = a.name.localeCompare(b.name, 'zh');
      else if (k === 'size') r = (a.size || 0) - (b.size || 0);
      else if (k === 'uploader') r = String(a.uploader).localeCompare(String(b.uploader), 'zh');
      else r = (a.mtime || 0) - (b.mtime || 0);
      return dir === 'asc' ? r : -r;
    });
  }

  function render() {
    const box = $('#files');
    let list = state.items;
    if (state.query) list = list;
    if (smart === 'mine') list = list.filter((i) => i.uploader === state.user.name);
    else if (smart !== 'all' && smart !== 'tag') {   // 'tag' 的后端已经筛好了
      const s = SMART.find((x) => x.key === smart);
      list = list.filter((i) => i.isDir || s.kinds.includes(i.kind));
    }
    const dirs = sortItems(list.filter((i) => i.isDir));
    const filesL = sortItems(list.filter((i) => !i.isDir));
    const all = dirs.concat(filesL);

    box.className = 'files' + (state.view === 'list' ? ' list' : ' grid') + (state.selMode ? ' sel-mode' : '');
    $$('.seg').forEach((b) => {
      const on = b.dataset.view === state.view;
      b.classList.toggle('is-on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    let tagLabel = '';
    if (smart === 'tag') {
      if (state.group != null) {
        const g = state.groups.find((x) => String(x.id) === String(state.group));
        tagLabel = (g && g.name) || '';
      } else {
        tagLabel = state.tags.filter((t) => (state.tag || []).includes(t.id)).map((t) => t.name).join('、');
      }
    }
    const selCount = state.selMode && state.selected.size ? `· 选中 ${state.selected.size} 件` : '';
    $('#countText').textContent = state.query
      ? `搜索「${state.query}」· ${all.length} 个结果${selCount}`
      : smart === 'tag' ? `${state.group != null ? '分类' : '标签'}「${tagLabel}」· ${all.length} 个文件${selCount}`
      : `${dirs.length} 个文件夹 · ${filesL.length} 个文件${selCount}`;

    if (!all.length) {
      box.innerHTML = '';
      const e = $('#empty');
      e.hidden = false;
      // 智能视图（我上传的/照片/视频/文档）和搜索结果里，"上传到当前目录"说不清 → 改为跳回根目录
      const filtered = !!state.query || smart !== 'all';
      const msg = state.query ? '没找到匹配的文件'
        : smart === 'mine' ? '你还没上传过东西'
        : smart === 'tag' ? '这个标签下还没有文件（打开图片或视频，点右上角的标签按钮加上）'
        : smart !== 'all' ? '这里还没有内容'
        : '这里还是空的';
      e.innerHTML = ICON.empty + `<div>${msg}</div>
        <button class="btn btn-primary" id="emptyUp">${filtered ? '去根目录上传' : '上传第一个文件'}</button>`;
      const b = $('#emptyUp');
      if (b) b.addEventListener('click', () => {
        if (filtered) go('/');                 // 先跳到根目录
        else $('#filePicker').click();         // 普通空目录：直接开文件选择
      });
    } else {
      $('#empty').hidden = true;
      box.innerHTML = state.view === 'list' ? all.map(rowHTML).join('') : all.map(cardHTML).join('');
    }
    // 选择模式下的浮动操作栏（先清掉旧的，避免重复叠加）
    const oldBar = document.querySelector('.sel-bar');
    if (oldBar) oldBar.remove();
    if (state.selMode) {
      const selCount = state.selected.size;
      const bar = document.createElement('div');
      bar.className = 'sel-bar';
      bar.innerHTML = `<span class="sel-count">已选 ${selCount} 项</span>
        <button class="btn btn-sm sel-op" data-act="tag"${selCount ? '' : ' disabled'}>批量加标签</button>
        <button class="btn btn-sm sel-op" data-act="move"${selCount ? '' : ' disabled'}>移动到…</button>
        <button class="btn btn-sm sel-op" data-act="cancel">取消</button>`;
      document.querySelector('.main').appendChild(bar);
      bar.addEventListener('click', (e) => {
        if (e.target.disabled) return;
        const act = e.target.dataset.act;
        if (act === 'tag') openBatchTag();
        else if (act === 'move') openBatchMove();
        else if (act === 'cancel') clearSelection();
      });
    }
    bindItems();
  }

  function badgeKind(it) {
    if (it.kind === 'dir') return '';
    return `<span class="badge">${API.extOf(it.name)}</span>`;
  }

  function cardHTML(it) {
    const t = API.thumbUrl(it, 400);
    const isImg = it.kind === 'image' || it.kind === 'video';
    const thumb = (isImg && t)
      ? `<img src="${esc(t)}" alt="" loading="lazy" decoding="async">`
      : `<div class="ph">${ICON[it.kind] || ICON.other}<b>${it.isDir ? '' : API.extOf(it.name)}</b></div>`;
    const mine = it.uploader === state.user.name;
    const canDel = state.user.role === 'admin' || mine;
    const isSelected = state.selMode && state.selected.has(it.path);
    const selCheckbox = state.selMode
      ? `<div class="sel-check${isSelected ? ' is-on' : ''}" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M5 12.6l4.4 4.4L19 7.2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>`
      : '';
    const chips = it.isDir ? '' : tagChips(it, 3);
    const up = (!it.isDir && it.uploader) ? String(it.uploader) : '';
    // 文件名下方一行灰色小字 = 上传者；再往下是「大小 / 修改时间」和标签
    return `<article class="card${isSelected ? ' is-sel' : ''}" data-path="${esc(it.path)}" data-kind="${it.kind}" data-dir="${it.isDir ? 1 : 0}" data-mine="${mine ? 1 : 0}">
      <div class="thumb">${it.isDir ? `<div class="ph">${ICON.folder}<b>文件夹</b></div>` : thumb + badgeKind(it)}</div>
      <div class="meta">
        <div class="fname" title="${esc(it.name)}">${esc(it.name)}</div>
        ${up ? `<div class="fup" title="${esc(up)}">${esc(up)}</div>` : ''}
        <div class="fsub">
          ${it.isDir ? `<span>${it.size || 0} 项</span>` : `<span>${fmtSize(it.size)}</span>`}
          <span>·</span><span>${fmtDate(it.mtime)}</span>
        </div>
        ${chips ? `<div class="ftags">${chips}</div>` : ''}
      </div>
      <div class="acts">
        ${API.canTag(it) ? `<button class="icon-btn" data-act="tag" title="标签">${ICON.tag}</button>` : ''}
        ${it.isDir ? '' : `<button class="icon-btn" data-act="dl" title="下载">${ICON.dl}</button>`}
        <button class="icon-btn" data-act="more" title="详细信息 / 移动">${ICON.info}</button>
        ${canDel ? `<button class="icon-btn danger" data-act="del" title="删除">${ICON.del}</button>` : ''}
      </div>
      ${selCheckbox}
    </article>`;
  }

  function rowHTML(it) {
    const t = API.thumbUrl(it, 120);
    const isImg = it.kind === 'image' || it.kind === 'video';
    const ico = (isImg && t) ? `<img src="${esc(t)}" alt="">` : (it.isDir ? ICON.folder : (ICON[it.kind] || ICON.other));
    const mine = it.uploader === state.user.name;
    const canDel = state.user.role === 'admin' || mine;
    const isSelected = state.selMode && state.selected.has(it.path);
    const chips = it.isDir ? '' : tagChips(it, 3);
    const up = (!it.isDir && it.uploader) ? String(it.uploader) : '';
    const selCheckbox = state.selMode
      ? `<span class="sel-check${isSelected ? ' is-on' : ''}" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M5 12.6l4.4 4.4L19 7.2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>`
      : '';
    return `<div class="row${isSelected ? ' is-sel' : ''}" data-path="${esc(it.path)}" data-kind="${it.kind}" data-dir="${it.isDir ? 1 : 0}" data-mine="${mine ? 1 : 0}">
      <span class="ricon">${ico}</span>
      <span class="rname" title="${esc(it.name)}">
        <span class="rn">${esc(it.name)}</span>
        ${up ? `<span class="rup" title="${esc(up)}">${esc(up)}</span>` : ''}
      </span>
      <div class="rmeta">
        ${chips ? `<span class="rtags">${chips}</span>` : ''}
        ${it.isDir ? `<span>${it.size || 0} 项</span>` : `<span>${fmtSize(it.size)}</span>`}
        <span class="rdate">${fmtDate(it.mtime)}</span>
      </div>
      <span class="racts">
        ${API.canTag(it) ? `<button class="icon-btn" data-act="tag" title="标签">${ICON.tag}</button>` : ''}
        ${it.isDir ? '' : `<button class="icon-btn" data-act="dl" title="下载">${ICON.dl}</button>`}
        <button class="icon-btn" data-act="more" title="详细信息 / 移动">${ICON.info}</button>
        ${canDel ? `<button class="icon-btn danger" data-act="del" title="删除">${ICON.del}</button>` : ''}
      </span>
      ${selCheckbox}
    </div>`;
  }

  function bindItems() {
    $$('#files .card[data-path], #files .row[data-path]').forEach((el) => {
      const it = state.items.concat(state.allItems).find((x) => x.path === el.dataset.path) || { path: el.dataset.path, name: el.dataset.path.split('/').pop(), isDir: el.dataset.dir === '1', kind: el.dataset.kind };
      if (state.selMode) {
        // 选择模式：点击卡片任何位置（包括缩略图）切换选中状态
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-act]')) return;
          e.stopPropagation();
          toggleSelection(el.dataset.path);
        });
        return;
      }
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-act]')) return;
        if (Date.now() - ctxAt < 800) return;        // 刚弹出长按菜单，这次点击不算数
        it.isDir ? go(it.path) : openViewer(it);
      });
      const dl = el.querySelector('[data-act="dl"]');
      if (dl) dl.addEventListener('click', () => download(it));
      const del = el.querySelector('[data-act="del"]');
      if (del) del.addEventListener('click', () => removeItem(it));
      const tg = el.querySelector('[data-act="tag"]');
      if (tg) tg.addEventListener('click', (e) => { e.stopPropagation(); openTagMenu(it, tg); });
      const more = el.querySelector('[data-act="more"]');
      if (more) more.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = more.getBoundingClientRect();
        openCtx(it, r.left - 130, r.bottom + 6);
      });

      /* 右键（桌面）/ 长按（手机）→ 菜单 */
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openCtx(it, e.clientX, e.clientY); });
      let lpTimer = null, lpFrom = null;
      el.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        lpFrom = { x: t.clientX, y: t.clientY };
        clearTimeout(lpTimer);
        lpTimer = setTimeout(() => {
          lpTimer = null;
          try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) {}
          openCtx(it, lpFrom.x, lpFrom.y);
        }, 500);
      }, { passive: true });
      el.addEventListener('touchmove', (e) => {
        if (!lpFrom || !e.touches.length) return;
        const t = e.touches[0];
        if (Math.abs(t.clientX - lpFrom.x) > 10 || Math.abs(t.clientY - lpFrom.y) > 10) { clearTimeout(lpTimer); lpTimer = null; }
      }, { passive: true });
      el.addEventListener('touchend', () => { clearTimeout(lpTimer); lpTimer = null; });
      el.addEventListener('touchcancel', () => { clearTimeout(lpTimer); lpTimer = null; });
    });
  }

  // 当前选中的文件（都在当前列表里）
  const allSelectedItems = () => state.items.filter((i) => state.selected.has(i.path));

  // 切换文件选择状态（不重新渲染，只更新 DOM）
  function toggleSelection(path) {
    const isAdding = !state.selected.has(path);
    if (isAdding) {
      // 普通用户只能选自己传的文件
      const file = state.items.find((i) => i.path === path) || state.allItems.find((i) => i.path === path);
      if (file && file.uploader && file.uploader !== state.user.name && state.user.role !== 'admin') {
        toast('只能选择自己上传的文件');
        return;
      }
      state.selected.add(path);
    } else {
      state.selected.delete(path);
    }
    const el = document.querySelector(`.card[data-path="${CSS.escape(path)}"], .row[data-path="${CSS.escape(path)}"]`);
    if (el) {
      el.classList.toggle('is-sel', isAdding);
      const check = el.querySelector('.sel-check');
      if (check) check.classList.toggle('is-on', isAdding);
    }
    syncSelBar();
  }

  // 更新浮动栏计数 / 按钮可用状态（不整页重绘，手感更顺）
  function syncSelBar() {
    const n = state.selected.size;
    const countEl = document.querySelector('.sel-count');
    if (countEl) countEl.textContent = `已选 ${n} 项`;
    $$('.sel-bar .sel-op[data-act="tag"], .sel-bar .sel-op[data-act="move"]')
      .forEach((b) => { b.disabled = n === 0; });
  }

  // 清除选择状态并退出选择模式
  function clearSelection() {
    state.selected.clear();
    state.selMode = false;
    $('#selBtn').classList.remove('is-on');
    $('#selBtn').setAttribute('aria-selected', 'false');
    render();
  }

  /* ---------- 批量加标签 ---------- */
  let batchItems = [];
  function closeBatchTag() { $('#batchTagModal').hidden = true; batchItems = []; }
  function finishBatchTag() {
    if (smart === 'tag') reapplyFilter(); else { render(); loadTree(); }
  }
  function renderBatchTags() {
    const list = $('#batchTagList');
    const media = batchItems.filter((i) => API.canTag(i));
    if (!state.tags.length) { list.innerHTML = '<div class="bt-none">管理员还没有设置标签</div>'; return; }
    const kw = ($('#batchTagFilter').value || '').trim().toLowerCase();
    const hit = (t) => !kw || t.name.toLowerCase().includes(kw);
    const countHas = (id) => media.filter((i) => (i.tags || []).some((t) => t.id === id)).length;
    const row = (t) => {
      const has = countHas(t.id);
      const cls = has === 0 ? '' : (has === media.length ? 'is-on' : 'is-some');
      const mark = has === 0 ? '' : (has === media.length ? '✓' : '−');
      return `<button type="button" class="bt-item ${cls}" data-tid="${t.id}">
        <span class="tg-dot" data-c="${esc(t.color)}"></span><span class="bt-name">${esc(t.name)}</span>
        <span class="bt-box">${mark}</span></button>`;
    };
    let out = '';
    if (state.groups.length) {
      for (const g of sortGroups(state.groups)) {
        const inG = sortTags(state.tags.filter((t) => t.group === g.id && hit(t)));
        if (inG.length) out += `<div class="modal-sec">${esc(g.name)}</div>` + inG.map(row).join('');
      }
      const loose = sortTags(state.tags.filter((t) => t.group == null && hit(t)));
      if (loose.length) out += (state.groups.length ? '<div class="modal-sec">未分类</div>' : '') + loose.map(row).join('');
    } else {
      out = sortTags(state.tags.filter(hit)).map(row).join('');
    }
    list.innerHTML = out || '<div class="bt-none">没有匹配的标签</div>';
  }
  function openBatchTag() {
    const items = allSelectedItems();
    if (!items.length) return;
    batchItems = items;
    const media = items.filter((i) => API.canTag(i));
    $('#batchTagSub').textContent = media.length === items.length
      ? `给选中的 ${media.length} 个图片 / 视频加标签：`
      : `已选 ${items.length} 项，其中 ${media.length} 个图片 / 视频可以加标签：`;
    $('#batchTagFilter').value = '';
    $('#batchTagModal').hidden = false;
    renderBatchTags();
  }
  $('#batchTagList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tid]');
    if (!b) return;
    const media = batchItems.filter((i) => API.canTag(i));
    if (!media.length) { toast('选中的文件里没有能加标签的图片 / 视频', 3000); return; }
    const id = Number(b.dataset.tid);
    const has = media.filter((i) => (i.tags || []).some((t) => t.id === id)).length;
    const add = has < media.length;          // 不是全都有 → 全部加上；全都有 → 全部去掉
    b.disabled = true;
    try {
      await Promise.all(media.map(async (it) => {
        const res = await API.tagSet(it.path, add ? [id] : [], add ? [] : [id]);
        it.tags = res.tags || [];
        syncItemTags(it);
      }));
      await refreshTags();
      renderBatchTags();
    } catch (err) { toast(err.message, 3600); }
    finally { b.disabled = false; }
  });
  $('#batchTagFilter').addEventListener('input', renderBatchTags);
  $('#batchTagClose').addEventListener('click', () => { closeBatchTag(); finishBatchTag(); });
  $('#batchTagDone').addEventListener('click', () => { closeBatchTag(); finishBatchTag(); });
  $('#batchTagModal').addEventListener('click', (e) => {
    if (e.target === $('#batchTagModal')) { closeBatchTag(); finishBatchTag(); }
  });

  /* ---------- 批量移动（复用「移动到」弹窗） ---------- */
  function openBatchMove() {
    const items = allSelectedItems();
    if (!items.length) return;
    const bad = items.find((i) => i.uploader && i.uploader !== state.user.name && state.user.role !== 'admin');
    if (bad) { toast('只能移动自己上传的文件'); return; }
    openMove(items);
  }

  function go(path) {
    smart = 'all';
    const parts = path.split('/').filter(Boolean);
    let html = `<button data-go="/">全部文件</button>`;
    let acc = '';
    parts.forEach((p, i) => {
      acc += '/' + p;
      html += `<span class="sep">/</span><button data-go="${esc(acc)}" class="${i === parts.length - 1 ? 'cur' : ''}">${esc(p)}</button>`;
    });
    $('#crumbs').innerHTML = html;
    $('#crumbs').querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => load(b.dataset.go)));
    load(path);
  }

  function pickSmart(key) {
    if (key === 'all') { go('/'); loadTree(); return; }
    smart = key; state.query = ''; state.tag = []; state.group = null;
    const s = SMART.find((x) => x.key === key);
    if (s.scope === 'mine') {
      state.items = state.allItems.filter((i) => i.uploader === state.user.name);
      $('#crumbs').innerHTML = '<span class="cur">我上传的</span>';
    } else {
      state.items = state.allItems.filter((i) => s.kinds.includes(i.kind));
      $('#crumbs').innerHTML = `<span class="cur">${s.label}</span>`;
    }
    $('#searchInput').value = '';
    render(); loadTree(); closeDrawer();
  }

  /* ---------------- 视图/排序/搜索 ---------------- */
  $$('.seg').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view; localStorage.setItem(LS_VIEW, state.view); render();
  }));
  $('#sortSel').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  $('#sortSel').value = state.sort;

  let searchTimer;
  $('#searchInput').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.query = q;
      if (!q) { go(state.folder); return; }
      const r = await API.search(q, state.scope, null, null, fieldsQ());
      state.items = r.items;
      $('#crumbs').innerHTML = `<span class="cur">搜索：${esc(q)}</span>`;
      render();
    }, 260);
  });

  /* 搜索范围：标签 / 文件名 / 上传者（可多选，至少留一个） */
  function syncSearchFields() {
    $$('#searchFields .sf').forEach((b) => b.classList.toggle('is-on', !!state.sfields[b.dataset.f]));
  }
  syncSearchFields();
  $$('#searchFields .sf').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.f;
    const on = SF_KEYS.filter((x) => state.sfields[x]);
    if (state.sfields[k] && on.length === 1) { toast('至少留一个搜索范围'); return; }
    state.sfields[k] = !state.sfields[k];
    localStorage.setItem('cd.sfields', JSON.stringify(state.sfields));
    syncSearchFields();
    if (state.query) $('#searchInput').dispatchEvent(new Event('input'));   // 已有搜索词就立刻重搜
  }));

  /* ---------------- 上传（分片 + 断点续传） ---------------- */
  const queue = [];       // {id,file,path,uploadId,chunks,done,status,sent,speed,retry}
  const ETA_WINDOW = [];

  $('#uploadBtn').addEventListener('click', () => $('#filePicker').click());
  $('#mkdirBtn').addEventListener('click', async () => {
    const nn = await uiPrompt({ title: '新建文件夹', label: '文件夹名字', placeholder: '例如：2026 运动会', maxlength: 60, okText: '创建' });
    if (nn == null) return;
    const name = nn.trim();
    if (!name) { toast('名字不能为空'); return; }
    if (/[\/\\\x00-\x1f]/.test(name)) { toast('名字不能带斜杠或换行'); return; }
    const vp = state.folder === '/' ? '/' + name : state.folder.replace(/\/$/, '') + '/' + name;
    try {
      await API.mkdir(vp);
      await load(state.folder);
      toast('文件夹已创建');
    } catch (e) { toast(e.message, 3600); }
  });
  $('#filePicker').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#upMin').addEventListener('click', () => $('#uploader').hidden = true);
  $('#upRetry').addEventListener('click', () => queue.filter((q) => q.status === 'fail').forEach((q) => runTask(q)));

  // 选择按钮：进入/退出选择模式
  $('#selBtn').addEventListener('click', () => {
    if (state.selMode) {
      clearSelection();
    } else {
      state.selMode = true;
      state.selected.clear();
      $('#selBtn').classList.add('is-on');
      $('#selBtn').setAttribute('aria-selected', 'true');
      render();
    }
  });

  function uploadIdFor(file, path) {
    const s = [state.user.name, path, file.name, file.size, file.lastModified].join('|');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'u' + (h >>> 0).toString(36);
  }

  function addFiles(fileList) {
    const filesArr = Array.prototype.slice.call(fileList);
    if (!filesArr.length) return;
    const path = state.folder;
    for (const f of filesArr) {
      const task = {
        id: 't' + Math.random().toString(36).slice(2, 8),
        file: f, path: path === '/' ? '/' + f.name : path + '/' + f.name,
        uploadId: uploadIdFor(f, path), chunks: Math.max(1, Math.ceil(f.size / CHUNK)),
        status: 'wait', sent: 0, speed: 0, retry: 0, lastT: 0, lastB: 0, blob: f
      };
      queue.push(task);
    }
    $('#uploader').hidden = false;
    renderQueue();
    queue.filter((q) => q.status === 'wait').forEach(runTask);
  }

  async function runTask(task) {
    if (task.status === 'up' || task.status === 'done') return;
    task.status = 'up'; task.retry = 0;
    renderQueue();
    // 先问服务端已收哪些分片 → 断点续传
    let received = new Set();
    try {
      const st = await API.uploadStatus(task.uploadId);
      received = new Set(st.received || []);
      if (received.size && received.size < task.chunks) {
        task.sent = received.size * CHUNK;
        toast(`继续上传「${task.file.name}」（已传 ${received.size}/${task.chunks} 片）`);
      }
    } catch (e) { /* 首次上传没有记录，正常 */ }

    try {
      for (let i = 0; i < task.chunks; i++) {
        if (received.has(i)) continue;
        let ok = false, attempt = 0;
        while (!ok) {
          attempt++;
          const start = i * CHUNK;
          const slice = task.file.slice(start, Math.min(task.file.size, start + CHUNK));
          const blob = slice;
          blob.totalSize = task.file.size;
          try {
            const r = await API.uploadChunk({ uploadId: task.uploadId, path: task.path, chunk: i, chunks: task.chunks, blob, offset: start,
                                            otime: task.file.lastModified });   // 带上原文件日期（服务端存成「原始日期」）
            const t = performance.now();
            if (task.lastT) {
              const inst = (slice.size / 1048576) / ((t - task.lastT) / 1000);
              task.speed = task.speed ? task.speed * 0.6 + inst * 0.4 : inst;
            }
            task.lastT = t;
            task.sent = Math.min(task.file.size, task.sent + slice.size);
            renderQueue();
            ok = true;
            if (r && r.done) {
              task.status = 'done';
              task.speed = 0;
              renderQueue();
              onUploaded(task, r.item);
            }
          } catch (err) {
            attempt++;
            if (attempt > 3) { task.status = 'fail'; task.errmsg = err.message; renderQueue(); $('#upRetry').hidden = false; return; }
            renderQueue(`重试 ${attempt}/3：${task.file.name}`);
            await new Promise((r) => setTimeout(r, 700 * attempt));   // 指数退避后从该分片继续
          }
        }
      }
      if (task.status !== 'done') { task.status = 'done'; task.sent = task.file.size; task.speed = 0; renderQueue(); }
    } catch (e) {
      task.status = 'fail'; task.errmsg = e.message; renderQueue(); $('#upRetry').hidden = false;
    }
  }

  /* 上传成功后：本地生成缩略图（图片直接预览 / 视频抓首帧），并回传到后端存旁车 */
  async function onUploaded(task, item) {
    const it = item || { id: 'x' + Date.now(), name: task.file.name, path: task.path, parent: state.folder, size: task.file.size, mtime: Date.now(), uploader: state.user.name, kind: API.kindOf(task.file.name), isDir: false, __local: true };
    if (!it.tags) it.tags = [];
    try { it.localUrl = URL.createObjectURL(task.file); } catch (e) {}
    if (it.kind === 'image') {
      it.localThumb = it.localUrl;
    } else if (it.kind === 'video') {
      it.localThumb = await captureVideoFrame(it.localUrl).catch(() => null);
    }
    if (state.folder === it.parent) {
      const exists = state.items.some((x) => x.path === it.path);
      if (!exists) state.items = [it].concat(state.items);
      state.allItems = [it].concat(state.allItems);
      render(); renderQuota();
    }
    // 真实后端：把封面/缩略图回传，别人打开时不用再耗流量
    if (!API.MOCK && (it.kind === 'image' || it.kind === 'video')) {
      try {
        const blob = it.kind === 'image' ? await makeImageThumb(task.file) : await makeVideoThumb(task.file);
        if (blob) {
          await API.putThumb(it.path, blob);
          it.localThumb = URL.createObjectURL(blob);
          render();
        }
      } catch (e) { console.warn('缩略图回传失败', e); }
    }
  }

  /* 把 canvas 编成 JPEG，必要时逐步降质 / 缩边，保证不超过 maxBytes */
  function canvasToJpegBlob(canvas, quality) {
    return new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', quality));
  }
  async function encodeJpegUnder(canvas, maxBytes, startQ) {
    let q = startQ || 0.8;
    let blob = await canvasToJpegBlob(canvas, q);
    while (blob.size > maxBytes && q > 0.4) {          // 先降质量（0.8 → 0.4）
      q = Math.max(0.4, q - 0.1);
      blob = await canvasToJpegBlob(canvas, q);
    }
    let scale = 1;
    while (blob.size > maxBytes && scale > 0.34) {      // 还超 → 逐步缩边
      scale -= 0.2;
      const c2 = document.createElement('canvas');
      c2.width = Math.max(1, Math.round(canvas.width * scale));
      c2.height = Math.max(1, Math.round(canvas.height * scale));
      c2.getContext('2d').drawImage(canvas, 0, 0, c2.width, c2.height);
      blob = await canvasToJpegBlob(c2, 0.72);
    }
    return blob;
  }

  /* 图片 → 480 宽 JPEG（压到 ≤100KB） */
  function makeImageThumb(file, maxW) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const w = Math.min(maxW || 480, img.naturalWidth || 480);
          const h = Math.round(w * ((img.naturalHeight || 3) / (img.naturalWidth || 4)));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          encodeJpegUnder(c, THUMB_MAX_BYTES, 0.8)
            .then((b) => { URL.revokeObjectURL(url); b ? res(b) : rej(new Error('toBlob')); })
            .catch((e) => { URL.revokeObjectURL(url); rej(e); });
        } catch (e) { URL.revokeObjectURL(url); rej(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }

  /* 视频 → 首帧 JPEG（压到 ≤100KB） */
  async function makeVideoThumb(file) {
    const url = URL.createObjectURL(file);
    try {
      const c = await captureVideoCanvas(url);
      return await encodeJpegUnder(c, THUMB_MAX_BYTES, 0.72);
    } finally { URL.revokeObjectURL(url); }
  }

  /* 视频首帧 → canvas */
  function captureVideoCanvas(url, at) {
    return new Promise((res, rej) => {
      const v = document.createElement('video');
      v.preload = 'metadata'; v.muted = true; v.playsInline = true; v.src = url;
      const to = setTimeout(() => rej(new Error('timeout')), 8000);
      v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(at || 0.15, (v.duration || 1) / 2); });
      v.addEventListener('seeked', () => {
        try {
          const c = document.createElement('canvas');
          const w = 480, h = Math.round(w * (v.videoHeight / v.videoWidth || 0.5625));
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(v, 0, 0, w, h);
          clearTimeout(to);
          res(c);
        } catch (e) { clearTimeout(to); rej(e); }
      });
      v.addEventListener('error', () => { clearTimeout(to); rej(new Error('decode')); });
    });
  }

  /* 视频首帧 → dataURL（本地预览用） */
  function captureVideoFrame(url, at) {
    return captureVideoCanvas(url, at).then((c) => c.toDataURL('image/jpeg', 0.72));
  }

  function renderQueue(msg) {
    const ul = $('#upList');
    ul.innerHTML = queue.map((q) => {
      const pct = q.status === 'done' ? 100 : Math.min(99.5, (q.sent / q.file.size) * 100);
      const left = q.speed ? fmtDur((q.file.size - q.sent) / (q.speed * 1048576)) : '';
      const st = q.status === 'done' ? '完成'
        : q.status === 'fail' ? ('失败：' + (q.errmsg || '') )
        : (q.speed ? `${q.speed.toFixed(1)} MB/s ${left ? '· 剩 ' + left : ''}` : '准备中…');
      return `<li class="up-item is-${q.status}">
        <span class="un" title="${esc(q.file.name)}">${esc(q.file.name)}</span>
        <span class="us">${st}</span>
        <span class="ubar"><i style="width:${pct}%"></i></span>
      </li>`;
    }).join('');
    const done = queue.filter((q) => q.status === 'done').length;
    if (done && done === queue.length) setTimeout(() => { if (queue.every((q) => q.status === 'done')) $('#uploader').hidden = true; }, 2600);
    if (msg) toast(msg);
  }

  /* 拖拽上传 */
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!state.user || !e.dataTransfer || !Array.prototype.some.call(e.dataTransfer.types || [], (t) => t === 'Files')) return;
    dragDepth++;
    if (!$('.drag-mask')) {
      const m = document.createElement('div');
      m.className = 'drag-mask'; m.textContent = '松手即可上传到当前目录';
      document.body.appendChild(m);
    }
  });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { const m = $('.drag-mask'); if (m) m.remove(); } });
  document.addEventListener('dragover', (e) => { if (state.user && e.dataTransfer) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    const m = $('.drag-mask'); if (m) m.remove(); dragDepth = 0;
    if (!state.user || !e.dataTransfer) return;
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  /* ---------------- 下载 / 删除 / 预览 ---------------- */
  function download(it) {
    const url = API.rawUrl(it, true);
    if (url === '#') { toast('演示模式：接入后端后这里会直接下载'); return; }
    const a = document.createElement('a');
    a.href = url; a.download = it.name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }

  async function removeItem(it) {
    const okd = await uiConfirm({
      title: it.isDir ? '删除文件夹' : '删除文件',
      message: it.isDir ? `确定删除文件夹「${it.name}」？\n里面的东西会一起删掉。` : `确定删除「${it.name}」？`,
      okText: '删除', danger: true
    });
    if (!okd) return;
    try {
      await API.remove([it.path]);
      const gone = (x) => x.path === it.path || x.path.indexOf(it.path.replace(/\/$/, '') + '/') === 0;
      state.items = state.items.filter((x) => !gone(x));
      state.allItems = state.allItems.filter((x) => !gone(x));
      render(); renderQuota(); loadTree();
      toast('已删除');
    } catch (e) { toast(e.message, 3600); }
  }

  /* 重命名（入口只在「自己传的 / 管理员」的菜单里出现） */
  async function renameItem(it) {
    const nn = await uiPrompt({ title: '重命名', label: '新名字', value: it.name, maxlength: 120, okText: '保存' });
    if (nn == null) return;
    const name = nn.trim();
    if (!name) { toast('名字不能为空'); return; }
    if (name === it.name) return;
    if (/[\/\\\x00-\x1f]/.test(name)) { toast('名字不能带斜杠或换行'); return; }
    try {
      const r = await API.rename(it.path, name);
      const fix = (arr) => arr.forEach((x) => {
        if (x.path === it.path) { x.name = name; x.path = r.to; }
        else if (it.isDir && x.path.indexOf(it.path + '/') === 0) x.path = r.to + x.path.slice(it.path.length);
      });
      fix(state.items); fix(state.allItems);
      render(); loadTree();
      toast('已重命名');
    } catch (e) { toast(e.message, 3600); }
  }

  /* ---------------- 右键 / 长按菜单 ---------------- */
  let ctxEl = null, ctxAt = 0, ctxOff = null;
  function closeCtx() {
    if (ctxOff) { document.removeEventListener('click', ctxOff); ctxOff = null; }
    if (ctxEl) { ctxEl.remove(); ctxEl = null; }
  }
  function openCtx(it, x, y) {
    closeCtx(); closeTagMenu();
    ctxAt = Date.now();
    const mine = it.uploader === state.user.name;
    const canDel = state.user.role === 'admin' || mine;
    const m = document.createElement('div');
    m.className = 'ctxmenu';
    m.innerHTML = `<div class="cx-head" title="${esc(it.name)}">${esc(it.name)}</div>
      <button data-c="info">${ICON.info}<span>详细信息</span></button>
      ${canDel ? `<button data-c="rename">${ICON.rename}<span>重命名</span></button>
      <button data-c="move">${ICON.move}<span>移动到…</span></button>` : ''}
      ${API.canTag(it) ? `<button data-c="tag">${ICON.tag}<span>标签</span></button>` : ''}
      ${it.isDir ? '' : `<button data-c="dl">${ICON.dl}<span>下载</span></button>`}
      ${canDel ? `<button data-c="del" class="is-danger">${ICON.del}<span>删除</span></button>` : ''}`;
    document.body.appendChild(m);
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8)) + 'px';
    m.style.top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - h - 8)) + 'px';
    ctxEl = m;
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      e.stopPropagation();
      const k = b.dataset.c;
      const r = b.getBoundingClientRect();
      const anchor = { getBoundingClientRect: () => r };
      closeCtx();
      if (k === 'info') openInfo(it);
      else if (k === 'rename') renameItem(it);
      else if (k === 'move') openMove([it]);
      else if (k === 'tag') openTagMenu(it, anchor);
      else if (k === 'dl') download(it);
      else if (k === 'del') removeItem(it);
    });
    ctxOff = (ev) => { if (ctxEl && !ctxEl.contains(ev.target)) closeCtx(); };
    setTimeout(() => document.addEventListener('click', ctxOff), 0);
  }

  /* ---------------- 详细信息 ---------------- */
  const KIND_CN = { dir: '文件夹', image: '图片', video: '视频', audio: '音频', pdf: 'PDF', doc: '文档',
    sheet: '表格', slide: '演示文稿', code: '代码', text: '文本', archive: '压缩包', other: '文件' };
  function openInfo(it) {
    state.infoItem = it;
    const tags = it.tags || [];
    // 上传者只在这里出现（卡片/列表不再展示）
    const whoAv = (it.uploaderAvatar && it.uploaderId != null) ? API.avatarUrl(it.uploaderId) : null;
    const who = whoAv
      ? `<span class="who-inline"><img class="who-av" src="${esc(whoAv)}" alt="">${esc(it.uploader || '—')}</span>`
      : esc(it.uploader || '—');
    const rows = [
      ['名称', esc(it.name)],
      ['类型', esc(it.isDir ? '文件夹' : (KIND_CN[it.kind] || '文件'))],
      ['大小', esc(it.isDir ? (it.size || 0) + ' 项' : fmtSize(it.size))],
      ['修改时间', esc(fmtDate(it.mtime))],
      ['原始日期', it.otime ? esc(fmtDate(it.otime)) : '—'],   // 文件本身的时间（上传时的原文件时间戳）
      ['上传者', who],
      ['位置', esc(it.path)]
    ];
    $('#infoBody').innerHTML = rows.map(([k, v]) =>
      `<div class="info-row"><span>${k}</span><b>${v}</b></div>`).join('') +
      `<div class="info-row info-tags"><span>标签</span><div class="tags">${
        tags.length ? chipHTML(tags) : '<i class="info-none">还没加标签</i>'}</div></div>` +
      (API.canTag(it) ? `<div class="info-actions"><button class="btn btn-ghost btn-sm" id="infoTagBtn">${ICON.tag} 加标签</button></div>` : '');
    $('#infoMove').hidden = !(state.user.role === 'admin' || it.uploader === state.user.name);
    $('#infoModal').hidden = false;
    const tb = $('#infoTagBtn');
    if (tb) tb.addEventListener('click', () => openTagMenu(state.infoItem, tb));
  }
  $('#infoClose').addEventListener('click', () => { $('#infoModal').hidden = true; });
  $('#infoDone').addEventListener('click', () => { $('#infoModal').hidden = true; });
  $('#infoModal').addEventListener('click', (e) => { if (e.target === $('#infoModal')) $('#infoModal').hidden = true; });
  $('#infoMove').addEventListener('click', () => { $('#infoModal').hidden = true; if (state.infoItem) openMove([state.infoItem]); });

  /* ---------------- 移动 ---------------- */
  let moveItems = [], movePick = null;
  async function openMove(items) {
    moveItems = (Array.isArray(items) ? items : [items]).slice();
    movePick = null;
    const one = moveItems.length === 1 ? moveItems[0] : null;
    const blocked = moveItems.map((i) => i.path);
    const inBlocked = (p) => blocked.some((b) => p === b || p.indexOf(b.replace(/\/$/, '') + '/') === 0);
    $('#moveSub').textContent = one
      ? `把「${one.name}」移到哪个文件夹：`
      : `把选中的 ${moveItems.length} 项移到哪个文件夹：`;
    $('#moveTree').innerHTML = '<div class="mv-load">正在读取目录…</div>';
    $('#moveOk').disabled = true;
    $('#moveModal').hidden = false;
    const dirs = [{ path: '/', name: '全部文件', depth: 0 }];
    async function walk(p, depth) {
      if (depth > 3 || dirs.length >= 150) return;
      let r;
      try { r = await API.list(p); } catch (e) { return; }
      for (const d of r.items.filter((x) => x.isDir)) {
        if (inBlocked(d.path)) continue;                 // 不能移进自己或自己的子目录
        dirs.push({ path: d.path, name: d.name, depth });
        await walk(d.path, depth + 1);
      }
    }
    await walk('/', 1);
    const cur = state.folder.replace(/\/$/, '') || '/';
    $('#moveTree').innerHTML = dirs.map((d) => {
      const here = d.path === cur;
      return `<button class="mv-item${here ? ' is-cur' : ''}" data-p="${esc(d.path)}"${here ? ' disabled' : ''}
        style="padding-left:${10 + d.depth * 15}px">${ICON.folderSm}<span>${esc(d.name)}</span>${here ? '<i class="mv-hint">当前位置</i>' : ''}</button>`;
    }).join('');
    $('#moveTree').querySelectorAll('.mv-item').forEach((b) => b.addEventListener('click', () => {
      if (b.disabled) return;
      movePick = b.dataset.p;
      $$('#moveTree .mv-item').forEach((x) => x.classList.toggle('is-on', x === b));
      $('#moveOk').disabled = false;
    }));
  }
  $('#moveClose').addEventListener('click', () => { $('#moveModal').hidden = true; });
  $('#moveCancel').addEventListener('click', () => { $('#moveModal').hidden = true; });
  $('#moveModal').addEventListener('click', (e) => { if (e.target === $('#moveModal')) $('#moveModal').hidden = true; });
  $('#moveOk').addEventListener('click', async () => {
    if (!moveItems.length || !movePick) return;
    const btn = $('#moveOk');
    btn.disabled = true; btn.textContent = '移动中…';
    try {
      const r = await API.move(moveItems.map((i) => i.path), movePick);
      $('#moveModal').hidden = true;
      if (r && r.error) toast(r.error, 4200);
      else toast('已移到「' + (movePick === '/' ? '全部文件' : movePick.split('/').pop()) + '」');
      clearSelection();
      await load(state.folder);
    } catch (e) { toast(e.message, 4200); }
    finally { btn.disabled = false; btn.textContent = '移到这个文件夹'; }
  });

  /* 预览：同一目录里的图片/视频连成一个相册，可左右切换 */
  let viewerList = [], viewerIdx = -1;
  function viewerStep(step) {
    if (viewerList.length < 2) return;
    viewerIdx = (viewerIdx + step + viewerList.length) % viewerList.length;
    openViewer(viewerList[viewerIdx], true);
  }

  async function openViewer(it, keep) {
    const v = $('#viewer'), body = $('#viewerBody');
    if (!keep) {
      const src = (state.items && state.items.length) ? state.items : state.allItems;
      const media = sortItems(src.filter((x) => !x.isDir && (x.kind === 'image' || x.kind === 'video')));
      const i = media.findIndex((x) => x.path === it.path);
      if (i >= 0) { viewerList = media; viewerIdx = i; } else { viewerList = [it]; viewerIdx = 0; }
    }
    $('#viewerName').textContent = it.name;
    $('#viewerPos').textContent = viewerList.length > 1 ? (viewerIdx + 1) + ' / ' + viewerList.length : '';
    $('#viewerPrev').hidden = $('#viewerNext').hidden = viewerList.length < 2;
    $('#viewerTags').innerHTML = chipHTML(it.tags);
    const vt = $('#viewerTag');
    vt.hidden = !API.canTag(it);
    vt.onclick = () => openTagMenu(it, vt);
    // 评论：图片 / 视频才有
    const vc = $('#viewerComment');
    vc.hidden = !API.canComment(it);
    if (vc.hidden) {
      vcmPanel().hidden = true;
      vcmItem = null; vcmMsgs = [];
      $('#viewerCmtN').textContent = '';
    } else {
      loadComments(it);
    }
    const url = API.rawUrl(it);
    const dl = $('#viewerDl');
    dl.href = url === '#' ? 'javascript:void 0' : API.rawUrl(it, true);

    if (it.kind === 'image' || it.kind === 'video' || it.kind === 'audio') {
      let src = it.localUrl || url;
      if (API.MOCK && src === '#') src = it.kind === 'image' ? (it.thumb || null) : null;  // 演示模式用占位图
      if (!src) { toast('演示模式：真实文件接入后端后这里能直接预览'); return; }
      body.innerHTML = it.kind === 'image' ? `<img src="${esc(src)}" alt="">`
        : it.kind === 'video' ? `<video src="${esc(src)}" controls autoplay playsinline></video>`
        : `<audio src="${esc(src)}" controls autoplay></audio>`;
    } else if ((it.kind === 'text' || it.kind === 'code') && !API.MOCK) {
      const r = await fetch(API.rawUrl(it)).then((x) => x.text()).catch(() => '');
      body.innerHTML = `<pre style="color:#e8efea;max-width:900px;white-space:pre-wrap;word-break:break-all;font:13px/1.6 ui-monospace,Consolas,monospace">${esc(r.slice(0, 20000))}</pre>`;
    } else if (it.kind === 'pdf' && !API.MOCK) {
      body.innerHTML = `<iframe src="${esc(url)}" style="width:min(1000px,96vw);height:80vh;border:0;border-radius:12px;background:#fff"></iframe>`;
    } else {
      toast('这类文件请下载后查看');
      return;
    }
    v.hidden = false;
  }
  function closeViewer() {
    $('#viewer').hidden = true;
    $('#viewerBody').innerHTML = '';
    closeTagMenu();
    $('#viewerComments').hidden = true;
    $('#viewerCmtN').textContent = '';
    vcmItem = null; vcmMsgs = [];
  }
  $('#viewerClose').addEventListener('click', closeViewer);
  $('#viewerPrev').addEventListener('click', () => viewerStep(-1));
  $('#viewerNext').addEventListener('click', () => viewerStep(1));

  /* 手机：在预览里左右滑动 = 上一张 / 下一张（像相册那样） */
  (function viewerSwipe() {
    const v = $('#viewer');
    let sx = 0, sy = 0, on = false;
    v.addEventListener('touchstart', (e) => {
      if (v.hidden || e.touches.length !== 1) return;
      if (e.target.closest('video, audio')) return;      // 播放器上的手势不抢
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; on = true;
    }, { passive: true });
    v.addEventListener('touchend', (e) => {
      if (!on) return;
      on = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      viewerStep(dx < 0 ? 1 : -1);
    }, { passive: true });
  })();

  /* ---------------- 预览里的评论（图片 / 视频）---------------- */
  let vcmItem = null, vcmMsgs = [], vcmCanEdit = false;
  const vcmPanel = () => $('#viewerComments');

  function commentItemHTML(c) {
    const mine = !!(state.user && state.user.id === c.uid);
    const del = (mine || vcmCanEdit)
      ? `<button class="vcm-del" data-del="${c.id}" title="删除" aria-label="删除">×</button>` : '';
    return `<li class="vcm-item">
      ${avatarHTML(c.name, c.uid, c.hasAvatar, 'vcm-av')}
      <div class="vcm-main">
        <div class="vcm-top"><b>${esc(c.name)}</b><time>${esc(fmtWhen(c.created))}</time></div>
        <div class="vcm-text">${esc(c.text).replace(/\n/g, '<br>')}</div>
      </div>${del}</li>`;
  }
  function renderComments() {
    const list = $('#vcmList');
    $('#vcmCount').textContent = vcmMsgs.length ? vcmMsgs.length : '';
    $('#viewerCmtN').textContent = vcmMsgs.length ? ' ' + vcmMsgs.length : '';
    if (!vcmMsgs.length) { list.innerHTML = '<li class="vcm-empty">还没有评论，来说一句吧</li>'; return; }
    list.innerHTML = vcmMsgs.map(commentItemHTML).join('');
    list.scrollTop = list.scrollHeight;
  }
  async function loadComments(it) {
    vcmItem = it;
    $('#vcmList').innerHTML = '<li class="vcm-empty">加载中…</li>';
    try {
      const r = await API.comments(it.path);
      if (vcmItem !== it) return;                 // 已经切到别的文件了
      vcmMsgs = r.comments || [];
      vcmCanEdit = !!r.canEdit;
      renderComments();
    } catch (e) {
      $('#vcmList').innerHTML = `<li class="vcm-empty">评论加载失败：${esc(e.message)}</li>`;
    }
  }
  $('#viewerComment').addEventListener('click', () => {
    const p = vcmPanel();
    p.hidden = !p.hidden;
    if (!p.hidden) $('#vcmInput').focus();
  });
  $('#viewerCmtClose').addEventListener('click', () => { vcmPanel().hidden = true; });
  $('#vcmForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#vcmInput'), btn = $('#vcmSend');
    const text = inp.value.trim();
    if (!text || !vcmItem) return;
    btn.disabled = true;
    try {
      const r = await API.commentAdd(vcmItem.path, text);
      inp.value = '';
      vcmMsgs.push(r.comment);
      renderComments();
      loadBoard();                              // 侧栏留言板同步刷新（它就是最近的评论）
    } catch (ex) { toast(ex.message, 3200); }
    finally { btn.disabled = false; inp.focus(); }
  });
  $('#vcmList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    if (!await uiConfirm({ title: '删除评论', text: '确定删掉这条评论吗？', okText: '删除' })) return;
    try {
      await API.commentDel(b.dataset.del);
      vcmMsgs = vcmMsgs.filter((x) => String(x.id) !== String(b.dataset.del));
      renderComments();
      loadBoard();                              // 留言板里的那条也一起去掉
    } catch (ex) { toast(ex.message, 3200); }
  });

  /* ---------------- 留言板（挂在左侧栏）---------------- */
  let boardMsgs = [], boardCanEdit = false, boardLoadedOnce = false;
  const LS_BOARD = 'cd.boardopen';
  function applyBoardOpen() {
    const open = localStorage.getItem(LS_BOARD) !== '0';
    $('#boardBody').hidden = !open;
    $('#boardHead').setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function boardItemHTML(m) {
    const mine = !!(state.user && state.user.id === m.uid);
    const del = (mine || boardCanEdit)
      ? `<button class="board-del" data-del="${m.id}" title="删除" aria-label="删除">×</button>` : '';
    const ico = m.kind === 'video'
      ? '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2" fill="currentColor" opacity=".9"/><path d="M17 10.5 21 8v8l-4-2.5z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-11Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.6 16.4l3.5-4 2.6 2.9 1.9-2.1 2.8 3.2z" fill="currentColor"/></svg>';
    return `<li class="board-item">
      ${avatarHTML(m.name, m.uid, m.hasAvatar, 'board-av')}
      <div class="board-main">
        <div class="board-top"><b>${esc(m.name)}</b><time>${esc(fmtWhen(m.created))}</time></div>
        <div class="board-text">${esc(m.text).replace(/\n/g, '<br>')}</div>
        <button class="board-img" data-open="${esc(m.path)}" title="打开 ${esc(m.file)}">${ico}<span class="board-img-n">${esc(m.file)}</span></button>
      </div>${del}</li>`;
  }
  function renderBoard() {
    const list = $('#boardList');
    $('#boardCount').textContent = boardMsgs.length ? boardMsgs.length : '';
    if (!boardMsgs.length) { list.innerHTML = '<li class="board-empty">还没有评论 —— 打开一张图片就能评论</li>'; return; }
    list.innerHTML = boardMsgs.map(boardItemHTML).join('');
    list.scrollTop = list.scrollHeight;
  }
  async function loadBoard() {
    if (!boardLoadedOnce) $('#boardList').innerHTML = '<li class="board-empty">加载中…</li>';
    try {
      const r = await API.board();
      boardMsgs = r.messages || [];
      boardCanEdit = !!r.canEdit;
      boardLoadedOnce = true;
      renderBoard();
    } catch (e) {
      $('#boardList').innerHTML = `<li class="board-empty">评论加载失败：${esc(e.message)}</li>`;
    }
  }
  $('#boardHead').addEventListener('click', () => {
    const willOpen = $('#boardBody').hidden;
    localStorage.setItem(LS_BOARD, willOpen ? '1' : '0');
    applyBoardOpen();
  });
  /* 留言板里的条目就是图片/视频下面的评论：点名字打开那张图，× 删自己那条 */
  function openBoardItem(path) {
    const m = boardMsgs.find((x) => x.path === path);
    if (!m) return;
    // 当前目录里能找到就用现成的那条（有缩略图/标签），找不到就现造一个最小对象
    const pool = (state.items && state.items.length) ? state.items : state.allItems;
    const found = (pool || []).find((x) => x.path === path);
    closeDrawer();
    openViewer(found || { path: m.path, name: m.file, kind: m.kind || 'image', isDir: false, tags: [], thumb: m.thumb });
  }
  $('#boardList').addEventListener('click', async (e) => {
    const op = e.target.closest('[data-open]');
    if (op) { openBoardItem(op.dataset.open); return; }
    const b = e.target.closest('[data-del]');
    if (!b) return;
    if (!await uiConfirm({ title: '删除评论', text: '确定删掉这条评论吗？', okText: '删除' })) return;
    try {
      await API.commentDel(b.dataset.del);
      boardMsgs = boardMsgs.filter((x) => String(x.id) !== String(b.dataset.del));
      renderBoard();
      if (vcmItem) loadComments(vcmItem);        // 评论抽屉开着的话，一起去掉
    } catch (ex) { toast(ex.message, 3200); }
  });

  document.addEventListener('keydown', (e) => {
    if (!$('#viewer').hidden && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      viewerStep(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (e.key === 'Escape') {
      $('#viewer').hidden = true; $('#viewerBody').innerHTML = '';
      $('#viewerComments').hidden = true; $('#viewerCmtN').textContent = '';
      closeDrawer(); closeTagMenu(); closeTagModal(); closeCtx();
      $('#infoModal').hidden = true; $('#moveModal').hidden = true;
      $('#settingsScreen').hidden = true;
      closeNotice();
      if (!$('#batchTagModal').hidden) { closeBatchTag(); finishBatchTag(); }
    }
  });

  /* ---------------- 移动端抽屉 ---------------- */
  function closeDrawer() { $('#sidebar').classList.remove('is-open'); const s = $('.scrim'); if (s) s.remove(); }
  $('#menuBtn').addEventListener('click', () => {
    const sb = $('#sidebar');
    if (sb.classList.contains('is-open')) return closeDrawer();
    sb.classList.add('is-open');
    const sc = document.createElement('div'); sc.className = 'scrim'; sc.addEventListener('click', closeDrawer);
    document.body.appendChild(sc);
  });

  /* ---------------- 设置：主题 / 修改密码 ---------------- */
  const LS_THEME = 'cd.theme';
  const themePref = () => localStorage.getItem(LS_THEME) || 'system';
  const sysDark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  function applyTheme(pref) {
    const resolved = pref === 'dark' ? 'dark' : pref === 'light' ? 'light' : (sysDark() ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', resolved);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0f1512' : '#0f9d58');
  }
  function syncThemeOpts() {
    const pref = themePref();
    $$('#themeOpts .theme-opt').forEach((b) => {
      const on = b.dataset.theme === pref;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  applyTheme(themePref());
  syncThemeOpts();
  $$('#themeOpts .theme-opt').forEach((b) => b.addEventListener('click', () => {
    localStorage.setItem(LS_THEME, b.dataset.theme);
    applyTheme(b.dataset.theme);
    syncThemeOpts();
  }));
  if (window.matchMedia) {                       // 跟随系统时，系统切换深浅色要跟着变
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSys = () => { if (themePref() === 'system') applyTheme('system'); };
    if (mq.addEventListener) mq.addEventListener('change', onSys);
    else if (mq.addListener) mq.addListener(onSys);
  }

  /* 字体：鸿蒙黑体（默认）/ 霞鹜文楷 / 系统（CSS 地址在 head 的 window.CD_FONTS 里，选了才按需加载） */
  const LS_FONT = 'cd.font';
  const FONT_CSS = window.CD_FONTS || {};
  const fontPref = () => localStorage.getItem(LS_FONT) || 'harmony';
  function applyFont(pref) {
    let link = document.getElementById('fontCss');
    if (FONT_CSS[pref]) {
      document.documentElement.setAttribute('data-font', pref);
      if (!link) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.id = 'fontCss';
        document.head.appendChild(link);
      }
      if (link.getAttribute('href') !== FONT_CSS[pref]) link.setAttribute('href', FONT_CSS[pref]);
    } else {                                       // 默认字体：撤掉外链，回系统字体
      document.documentElement.removeAttribute('data-font');
      if (link) link.remove();
    }
  }
  function syncFontOpts() {
    const pref = fontPref();
    $$('#fontOpts .font-opt').forEach((b) => {
      const on = b.dataset.font === pref;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  applyFont(fontPref());
  syncFontOpts();
  $$('#fontOpts .font-opt').forEach((b) => b.addEventListener('click', () => {
    localStorage.setItem(LS_FONT, b.dataset.font);
    applyFont(b.dataset.font);
    syncFontOpts();
  }));

  function openSettings() {
    syncThemeOpts();
    syncFontOpts();
    syncAvatarUI();
    $('#setPwErr').hidden = true;
    closeDrawer();
    const sc = $('#settingsScreen');
    sc.hidden = false;
    sc.scrollTop = 0;
  }
  function closeSettings() { $('#settingsScreen').hidden = true; }
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsBack').addEventListener('click', closeSettings);
  $('#setPwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#setPwErr'); err.hidden = true;
    const oldPw = $('#setPwOld').value, n1 = $('#setPwNew').value, n2 = $('#setPwNew2').value;
    if (n1 !== n2) { err.textContent = '两次输入的新密码不一样'; err.hidden = false; return; }
    if (n1.length < 4) { err.textContent = '新密码至少 4 位'; err.hidden = false; return; }
    const btn = $('#setPwBtn');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await API.changePassword(oldPw, n1);
      state.user = r.user || Object.assign({}, state.user, { mustChange: false });
      localStorage.setItem(LS_USER, JSON.stringify(state.user));
      $('#setPwOld').value = ''; $('#setPwNew').value = ''; $('#setPwNew2').value = '';
      closeSettings();
      toast('密码已修改');
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = '保存新密码';
    }
  });

  /* ---------------- 设置：头像 ---------------- */
  $('#avatarPick').addEventListener('click', () => $('#avatarFile').click());
  $('#avatarFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) { toast('请选择图片文件'); return; }
    const hint = $('#avatarHint'), old = hint.textContent;
    hint.textContent = '处理中…';
    try {
      const blob = await makeImageThumb(f, 256);        // 缩到 ≤256 宽、JPEG
      if (!blob) throw new Error('图片处理失败');
      const r = await API.setAvatar(blob);
      state.user = (r && r.user) || Object.assign({}, state.user, { hasAvatar: true });
      localStorage.setItem(LS_USER, JSON.stringify(state.user));
      syncAvatarUI();
      toast('头像已更新');
    } catch (err) { toast(err.message, 3600); }
    finally { hint.textContent = old; }
  });
  $('#avatarClear').addEventListener('click', async () => {
    const okd = await uiConfirm({ title: '移除头像', message: '确定移除当前头像吗？', okText: '移除', danger: true });
    if (!okd) return;
    try {
      const r = await API.clearAvatar();
      state.user = (r && r.user) || Object.assign({}, state.user, { hasAvatar: false });
      localStorage.setItem(LS_USER, JSON.stringify(state.user));
      syncAvatarUI();
      toast('头像已移除');
    } catch (e) { toast(e.message, 3600); }
  });

  /* ---------------- 公告 ----------------
     内容放在服务器：GET /api/notice（后台可随时改，网页每次登录都会重新拉）；
     拉不到时退回本地 assets/notice.json（离线也能看）。 */
  const LS_NOTICE = 'cd.noticeAck';
  const NOTICE_DAYS = 3;
  let noticeData = null;

  function noticeMuted() {
    const t = parseInt(localStorage.getItem(LS_NOTICE) || '0', 10);
    return t > 0 && (Date.now() - t) < NOTICE_DAYS * 24 * 60 * 60 * 1000;
  }
  function noticeValid(o) {
    return !!o && typeof o === 'object' && Array.isArray(o.sections) && o.sections.length > 0;
  }
  async function loadNotice() {
    if (noticeValid(noticeData)) return noticeData;
    try {                                   // 1) 服务器（以后台为准）
      const r = await API.notice();
      if (r && noticeValid(r.notice)) { noticeData = r.notice; return noticeData; }
    } catch (e) {}
    try {                                   // 2) 本地兜底
      const r = await fetch('assets/notice.json', { cache: 'no-cache' });
      if (r.ok) { const o = await r.json(); if (noticeValid(o)) noticeData = o; }
    } catch (e) {}
    return noticeData;
  }
  function renderNotice(o) {
    if (!noticeValid(o)) return;
    if (o.title) $('#noticeTitle').textContent = o.title;
    if (o.okText) $('#noticeOk').textContent = o.okText;
    const body = $('#noticeBody');
    body.textContent = '';
    if (o.intro) { const p = document.createElement('p'); p.textContent = o.intro; body.appendChild(p); }
    o.sections.forEach((s) => {
      if (!s || typeof s !== 'object') return;
      if (s.heading) { const h = document.createElement('h3'); h.textContent = s.heading; body.appendChild(h); }
      if (Array.isArray(s.items) && s.items.length) {
        const ol = document.createElement('ol');
        s.items.forEach((t) => { const li = document.createElement('li'); li.textContent = String(t); ol.appendChild(li); });
        body.appendChild(ol);
      } else if (s.text) {
        const p = document.createElement('p'); p.textContent = s.text; body.appendChild(p);
      }
    });
  }
  function openNotice() { $('#noticeModal').hidden = false; }
  function closeNotice() { $('#noticeModal').hidden = true; }
  async function maybeShowNotice() {
    try {
      renderNotice(await loadNotice());
      if (!noticeMuted()) openNotice();
    } catch (e) {}
  }
  $('#noticeBtn').addEventListener('click', async () => {
    closeDrawer();
    openNotice();
    renderNotice(await loadNotice());   // 第一次点的时候可能还没拉到
  });
  $('#noticeClose').addEventListener('click', closeNotice);
  $('#noticeModal').addEventListener('click', (e) => { if (e.target === $('#noticeModal')) closeNotice(); });
  $('#noticeOk').addEventListener('click', () => {
    try { localStorage.setItem(LS_NOTICE, String(Date.now())); } catch (e) {}
    closeNotice();
  });

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    const tk = localStorage.getItem(LS_TOKEN);
    const u = localStorage.getItem(LS_USER);
    if (tk && u) {
      API.token = tk;
      try {
        const r = await API.me();
        state.user = r.user || JSON.parse(u);
        if (state.user.mustChange) { askNewPassword(''); return; }   // 上次没改完就关掉了
        showApp();
        return;
      } catch (e) { localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER); }
    }
    $('#loginUser').focus();
  })();
})();
