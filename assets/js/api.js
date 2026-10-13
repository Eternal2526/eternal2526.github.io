/* ============================================================
   api.js —— 前端与后端的唯一接口层
   ------------------------------------------------------------
   MOCK = true  → 用内置假数据跑（现在就能看界面、能上传试玩）
   MOCK = false → 走真实门户服务（地址在 API.base 里改）

   后端只需实现下面这 9 个接口（这就是契约，前后端可以并行开发）：

   POST /api/login          {username,password}      → {token, user:{id,name,nick,role,mustChange}}
   POST /api/password       {old,new}                ← 改自己的密码（首登强制改密也走这里）
   POST /api/logout         (Bearer token)
   GET  /api/me                                       → {user}
   (mustChange=true 时，除以上三个接口外一律 403「请先修改初始密码」)
   GET  /api/list?path=/学习资料                       → {path, items:[Item]}
   GET  /api/search?q=关键词&scope=all|mine            → {items:[Item]}
   GET  /api/search?...&fields=name,uploader,tag        ← 搜索范围（默认三个都搜）
   POST /api/mkdir          {path}
   POST /api/move           {paths:[...], to:"/目标目录"}  ← 移动（只能动自己传的，管理员不限）
   POST /api/rename         {path, name}                   ← 重命名（只能改自己传的，管理员不限）
   POST /api/delete         {paths:["/a.jpg"]}        ← 服务端必须校验"只能删自己传的"
   POST /api/upload         ?uploadId=&path=&chunk=&chunks=  (body=该分片原始字节)
                            → {done:false} | {done:true,item:Item}
   GET  /api/upload/status?uploadId=                  → {received:[0,2,3]}   ← 断点续传
   GET  /api/raw?path=/a.jpg                          → 302 直链 / 文件流
   GET  /api/thumb?path=/照片/a.jpg&w=480             → 图片字节（视频封面由后端 ffmpeg 生成）

   —— 标签（预设标签，只有管理员能改标签本身）——
   GET  /api/tags                                     → {tags:[Tag], groups:[Group], canEdit:bool}
   POST /api/tags          {name,color,group}         ← 管理员：新建标签（group=分类 id，可省）
   POST /api/tags/update   {id,name?,color?,group?}   ← 管理员：改名/换色/换分类
   POST /api/tags/delete   {id}                       ← 管理员：删除标签（连带摘掉所有文件上的）
   POST /api/tag           {path,add:[id],remove:[id]}← 任何登录用户；只能给图片/视频打标签
   POST /api/tag-groups    {name}                     ← 管理员：新建「标签分类」（tag 文件夹）
   POST /api/tag-groups/update {id,name}              ← 管理员：分类改名
   POST /api/tag-groups/delete {id,withTags?}         ← 管理员：删分类（默认把里面的标签挪到未分类）
   GET  /api/list?path=&tag=<id>&group=<id>            ← 按标签 / 按分类筛选（只回带该标签/该分类的文件的）
   GET  /api/search?q=&scope=&tag=<id>&group=<id>      ← 同上；q 也能命中标签名

   Item  = {id,name,path,isDir,size,mtime,uploader,kind,thumb,tags:[Tag]}
           kind ∈ image|video|audio|pdf|doc|sheet|slide|code|archive|zip|text|other
   Tag   = {id, name, color, group}   group=分类 id（null=未分类）
           color ∈ green|blue|purple|orange|red|teal
   Group = {id, name, tags}           标签分类，例如「同学名字」
   ============================================================ */
(function () {
  const API = {
    MOCK: false,                       // ← 接好后端：false 走真服务（演示模式请改回 true）
    base: 'https://classdisk.dynv6.net:9443',   // ← 公网后端（IPv6 直连：dynv6 DDNS + Let's Encrypt 证书 + N1 上的 nginx 反代到本地 8081）
    token: null,
    user: null
  };

  /* ---------- 工具 ---------- */
  const KIND_MAP = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image', heic: 'image', avif: 'image',
    mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video', m4v: 'video',
    mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio',
    pdf: 'pdf', doc: 'doc', docx: 'doc', txt: 'text', md: 'text',
    xls: 'sheet', xlsx: 'sheet', csv: 'sheet', ppt: 'slide', pptx: 'slide',
    zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
    js: 'code', ts: 'code', py: 'code', java: 'code', c: 'code', cpp: 'code', html: 'code', css: 'code', json: 'code', go: 'code', rs: 'code'
  };
  const kindOf = (name) => KIND_MAP[(name.split('.').pop() || '').toLowerCase()] || 'other';
  const extOf = (name) => (name.includes('.') ? name.split('.').pop().toUpperCase().slice(0, 5) : 'FILE');

  API.kindOf = kindOf;
  API.extOf = extOf;

  /* ============================================================
     MOCK 后端
     ============================================================ */
  const now = Date.now();
  const D = 864e5;
  let seed = [
    ['/', '学习资料', 0, 0, '', 'dir'],
    ['/', '照片', 0, 0, '', 'dir'],
    ['/', '视频', 0, 0, '', 'dir'],
    ['/', '作业', 0, 0, '', 'dir'],
    ['/', '共享', 0, 0, '', 'dir'],
    ['/学习资料', '数学期中复习提纲.pdf', 4.2e6, 3 * D, '林小满'],
    ['/学习资料', '英语听力原文.docx', 380e3, 6 * D, '陈小雨'],
    ['/学习资料', '物理公式汇总.pdf', 2.1e6, 9 * D, '王浩'],
    ['/学习资料', '化学实验报告模板.docx', 120e3, 12 * D, '陈小雨'],
    ['/学习资料', '历史时间轴.png', 1.8e6, 14 * D, '赵一鸣'],
    ['/照片', '运动会合影.jpg', 5.6e6, 1 * D, '赵一鸣'],
    ['/照片', '元旦晚会1.jpg', 4.4e6, 2 * D, '林小满'],
    ['/照片', '元旦晚会2.jpg', 4.9e6, 2 * D, '林小满'],
    ['/照片', '教室窗外.jpg', 3.1e6, 5 * D, '王浩'],
    ['/照片', '毕业照-草稿.jpg', 6.2e6, 7 * D, '陈小雨'],
    ['/视频', '运动会开幕式.mp4', 268e6, 1 * D, '赵一鸣'],
    ['/视频', '元旦晚会节目.mp4', 512e6, 2 * D, '林小满'],
    ['/视频', '班会记录.mp4', 96e6, 8 * D, '王浩'],
    ['/作业', '第一周数学作业.docx', 90e3, 4 * D, '林小满'],
    ['/作业', '英语作文.zip', 1.4e6, 5 * D, '陈小雨'],
    ['/共享', '班级公约.pdf', 300e3, 20 * D, '林小满'],
    ['/共享', '期末复习资料合集.zip', 88e6, 10 * D, '赵一鸣'],
    ['/共享', '校历.png', 700e3, 30 * D, '王浩']
  ];

  // 演示用缩略图：按名字生成渐变占位 SVG
  function placeholderThumb(name) {
    const h = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
    const label = extOf(name);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="hsl(${h} 62% 62%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360} 58% 44%)"/>
      </linearGradient></defs>
      <rect width="320" height="240" fill="url(#g)"/>
      <text x="160" y="128" font-family="sans-serif" font-size="34" font-weight="700"
        fill="rgba(255,255,255,.92)" text-anchor="middle">${label}</text></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  let SEQ = 1;
  const files = seed.map(([dir, name, size, ago, uploader, forceDir]) => {
    const isDir = forceDir === 'dir';
    const path = (dir === '/' ? '' : dir) + '/' + name;
    return {
      id: 'f' + (SEQ++), name, path, parent: dir, isDir,
      size: isDir ? 0 : size, mtime: now - ago,
      uploader: isDir ? '' : uploader, kind: isDir ? 'dir' : kindOf(name),
      thumb: isDir || kindOf(name) === 'image' ? placeholderThumb(name) : null
    };
  });

  const MOCK_USERS = [
    { id: 'u1', name: '林小满', nick: '班长', role: 'admin' },
    { id: 'u2', name: '陈小雨', nick: '宣传委员', role: 'member' },
    { id: 'u3', name: '王浩', nick: '同学', role: 'member' },
    { id: 'u4', name: '赵一鸣', nick: '同学', role: 'member' }
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let mockUser = null;
  const uploads = {};   // uploadId -> Set(received chunk index)

  /* ---------- 演示模式的标签 ---------- */
  const TAG_COLORS = ['green', 'blue', 'purple', 'orange', 'red', 'teal'];
  let MOCK_GROUPS = [
    { id: 1, name: '同学名字' }              // 标签分类（tag 文件夹）
  ];
  let GROUP_SEQ = 2;
  let MOCK_TAGS = [
    { id: 1, name: '班级活动', color: 'green', group: null },
    { id: 2, name: '运动会', color: 'orange', group: null },
    { id: 3, name: '元旦晚会', color: 'purple', group: null },
    { id: 4, name: '学习资料', color: 'blue', group: null },
    { id: 5, name: '风景', color: 'teal', group: null },
    { id: 6, name: '合影', color: 'red', group: null },
    { id: 7, name: '林小满', color: 'green', group: 1 },
    { id: 8, name: '陈小雨', color: 'blue', group: 1 },
    { id: 9, name: '王浩', color: 'orange', group: 1 }
  ];
  let TAG_SEQ = 10;
  const fileTags = {                       // path -> [tagId]
    '/照片/运动会合影.jpg': [2, 6, 7],
    '/照片/元旦晚会1.jpg': [3, 7, 8],
    '/视频/运动会开幕式.mp4': [2],
    '/共享/校历.png': [4]
  };
  const groupById = (id) => MOCK_GROUPS.find((g) => g.id === Number(id)) || null;
  const tagById = (id) => MOCK_TAGS.find((t) => t.id === Number(id)) || null;
  const pubTag = (t) => ({ id: t.id, name: t.name, color: t.color, group: t.group == null ? null : t.group });
  const tagsOfPath = (p) => (fileTags[p] || []).map(tagById).filter(Boolean).map(pubTag);
  const withTags = (f) => (f.isDir ? { ...f, tags: [] } : { ...f, tags: tagsOfPath(f.path) });
  const isTagKind = (kind) => kind === 'image' || kind === 'video';

  const mock = {
    async login(username, password) {
      await sleep(420);
      if (!username.trim()) throw new Error('请输入账号');
      if (password !== '2526') throw new Error('密码不对（演示模式密码是 2526）');
      mockUser = MOCK_USERS.find((u) => u.name === username.trim()) ||
                 { id: 'u9', name: username.trim(), nick: '同学', role: 'member' };
      return { token: 'mock-' + Date.now(), user: mockUser };
    },
    async me() { return { user: mockUser }; },
    async changePassword(oldPw, newPw) {
      await sleep(300);
      if (newPw.length < 4) throw new Error('新密码至少 4 位');
      mockUser = { ...(mockUser || { name: '同学' }), mustChange: false };
      return { ok: true, user: mockUser };
    },
    async logout() { mockUser = null; },
    async register(username, password, invite) {
      await sleep(420);
      if (invite !== '2526') throw new Error('班级口令不对（演示模式口令是 2526）');
      if (!username.trim()) throw new Error('用户名要填');
      if (password.length < 4) throw new Error('密码至少 4 位');
      mockUser = { id: 'u' + Date.now(), name: username.trim(), nick: username.trim(), role: 'member' };
      return { token: 'mock-' + Date.now(), user: mockUser };
    },
    async list(path, tag, group) {
      await sleep(160);
      const norm = path.replace(/\/+$/, '') || '/';
      let items = files.filter((f) => f.parent === norm)
        .map((f) => (f.isDir ? { ...f, size: files.filter((x) => x.parent === f.path).length, count: true } : withTags(f)));
      if (tag != null || group != null) {
        items = items.filter((f) => !f.isDir && (f.tags || []).some((t) =>
          (tag != null && t.id === Number(tag)) || (group != null && t.group === Number(group))));
      }
      return { path: norm, items };
    },
    async search(q, scope, tag, group, fields) {
      await sleep(180);
      const k = (q || '').trim().toLowerCase();
      const fset = fields ? new Set(fields.split(',')) : new Set(['name', 'uploader', 'tag']);
      let r = files.filter((f) => !f.isDir).map(withTags);
      if (scope === 'mine') r = r.filter((f) => f.uploader === mockUser?.name);
      if (tag != null) r = r.filter((f) => (f.tags || []).some((t) => t.id === Number(tag)));
      if (group != null) r = r.filter((f) => (f.tags || []).some((t) => t.group === Number(group)));
      if (k) r = r.filter((f) => (fset.has('name') && f.name.toLowerCase().includes(k))
        || (fset.has('uploader') && (f.uploader || '').toLowerCase().includes(k))
        || (fset.has('tag') && (f.tags || []).some((t) => t.name.toLowerCase().includes(k))));
      return { items: r.slice(0, 200) };
    },
    async move(paths, to) {
      await sleep(200);
      const moved = [];
      for (const p of paths) {
        const it = files.find((f) => f.path === p);
        if (!it) continue;
        const np = to === '/' ? '/' + it.name : to.replace(/\/$/, '') + '/' + it.name;
        if (np === it.path) continue;
        if (files.some((f) => f.path === np)) throw new Error('目标里已经有同名的了：' + it.name);
        const old = it.path;
        it.path = np; it.parent = to;
        files.filter((f) => f.path.indexOf(old + '/') === 0).forEach((f) => {
          f.path = np + f.path.slice(old.length);
          f.parent = f.path.replace(/\/[^/]*$/, '') || '/';
        });
        moved.push({ from: old, to: np });
      }
      return { ok: true, moved };
    },
    async rename(path, name) {
      await sleep(180);
      const it = files.find((f) => f.path === path);
      if (!it) throw new Error('文件不存在');
      const np = path.replace(/\/[^/]*$/, '') + '/' + name;
      if (files.some((f) => f.path === np)) throw new Error('已经有同名的了');
      const old = it.path;
      it.name = name; it.path = np;
      files.filter((f) => f.path.indexOf(old + '/') === 0).forEach((f) => { f.path = np + f.path.slice(old.length); });
      return { ok: true, from: old, to: np, item: it };
    },
    async tags() {
      await sleep(90);
      const tags = MOCK_TAGS.map((t) => ({
        ...pubTag(t),
        count: files.filter((f) => !f.isDir && (fileTags[f.path] || []).includes(t.id)).length
      }));
      const groups = MOCK_GROUPS.map((g) => ({ ...g, tags: MOCK_TAGS.filter((t) => t.group === g.id).length }));
      return { tags, groups, canEdit: mockUser?.role === 'admin' };
    },
    async tagSet(path, add, remove) {
      await sleep(120);
      const f = files.find((x) => x.path === path);
      if (!f) throw new Error('文件不存在');
      if (!isTagKind(f.kind)) throw new Error('只有图片和视频能加标签');
      const cur = new Set((fileTags[path] || []).filter((id) => tagById(id)));
      (add || []).forEach((id) => { if (tagById(id)) cur.add(Number(id)); });
      (remove || []).forEach((id) => cur.delete(Number(id)));
      fileTags[path] = [...cur];
      return { ok: true, path, tags: tagsOfPath(path) };
    },
    async tagCreate(name, color, group) {
      await sleep(120);
      name = (name || '').trim();
      if (!name) throw new Error('标签名不能为空');
      if (name.length > 12) throw new Error('标签名最多 12 个字');
      if (MOCK_TAGS.some((t) => t.name === name)) throw new Error('这个标签已经有了');
      const gid = groupById(group) ? Number(group) : null;
      const t = { id: TAG_SEQ++, name, color: TAG_COLORS.includes(color) ? color : TAG_COLORS[0], group: gid };
      MOCK_TAGS.push(t);
      return { ok: true, tag: { ...pubTag(t), count: 0 } };
    },
    async tagUpdate(id, name, color, group) {
      await sleep(120);
      const t = tagById(id);
      if (!t) throw new Error('标签不存在');
      const nn = (name || t.name).trim();
      if (!nn) throw new Error('标签名不能为空');
      if (nn.length > 12) throw new Error('标签名最多 12 个字');
      if (MOCK_TAGS.some((x) => x.name === nn && x.id !== t.id)) throw new Error('已经有同名标签了');
      t.name = nn;
      if (TAG_COLORS.includes(color)) t.color = color;
      if (group !== undefined) t.group = groupById(group) ? Number(group) : null;
      return { ok: true, tag: pubTag(t) };
    },
    async tagDelete(id) {
      await sleep(120);
      const t = tagById(id);
      if (!t) throw new Error('标签不存在');
      let used = 0;
      Object.keys(fileTags).forEach((p) => {
        if (fileTags[p].includes(t.id)) { used++; fileTags[p] = fileTags[p].filter((x) => x !== t.id); }
      });
      MOCK_TAGS = MOCK_TAGS.filter((x) => x.id !== t.id);
      return { ok: true, removedFiles: used };
    },
    async tagGroupCreate(name) {
      await sleep(120);
      name = (name || '').trim();
      if (!name) throw new Error('分类名不能为空');
      if (name.length > 16) throw new Error('分类名最多 16 个字');
      if (MOCK_GROUPS.some((g) => g.name === name)) throw new Error('这个分类已经有了');
      const g = { id: GROUP_SEQ++, name };
      MOCK_GROUPS.push(g);
      return { ok: true, group: { ...g, tags: 0 } };
    },
    async tagGroupUpdate(id, name) {
      await sleep(120);
      const g = groupById(id);
      if (!g) throw new Error('分类不存在');
      const nn = (name || g.name).trim();
      if (!nn) throw new Error('分类名不能为空');
      if (MOCK_GROUPS.some((x) => x.name === nn && x.id !== g.id)) throw new Error('已经有同名分类了');
      g.name = nn;
      return { ok: true, group: { ...g } };
    },
    async tagGroupDelete(id, withTags) {
      await sleep(120);
      const g = groupById(id);
      if (!g) throw new Error('分类不存在');
      const inner = MOCK_TAGS.filter((t) => t.group === g.id);
      if (withTags) {
        for (const t of inner) await this.tagDelete(t.id);
      } else {
        inner.forEach((t) => { t.group = null; });
      }
      MOCK_GROUPS = MOCK_GROUPS.filter((x) => x.id !== g.id);
      return { ok: true, deletedTags: withTags ? inner.length : 0, moved: withTags ? 0 : inner.length };
    },
    async mkdir(path) {
      await sleep(120);
      const parent = path.replace(/\/[^/]+$/, '') || '/';
      const name = path.split('/').pop();
      files.push({ id: 'f' + (SEQ++), name, path, parent, isDir: true, size: 0, mtime: Date.now(), uploader: '', kind: 'dir', thumb: null });
      return { ok: true };
    },
    async delete(paths) {
      await sleep(220);
      const mine = paths.filter((p) => {
        const f = files.find((x) => x.path === p);
        if (!f) return false;
        if (f.uploader && f.uploader !== mockUser?.name && mockUser?.role !== 'admin') {
          throw new Error('只能删除自己上传的文件：' + f.name);
        }
        return true;
      });
      for (const p of mine) {
        const kill = (pp) => files.filter((f) => f.path === pp || f.path.startsWith(pp + '/')).forEach((f) => {
          delete fileTags[f.path];
          const i = files.indexOf(f); if (i >= 0) files.splice(i, 1);
        });
        kill(p);
      }
      return { ok: true, removed: mine.length };
    },
    async uploadStatus(uploadId) {
      await sleep(80);
      return { received: [...(uploads[uploadId] || [])] };
    },
    async uploadChunk({ uploadId, path, chunk, chunks, blob }) {
      // 模拟网络：~5MB/s 吞吐 + 偶尔一次分片抖动（用来演示断点续传）
      const mb = blob.size / 1048576;
      await sleep(Math.max(90, mb * 200));
      if (Math.random() < 0.07) throw new Error('网络抖动（模拟）');
      (uploads[uploadId] = uploads[uploadId] || new Set()).add(chunk);
      if (uploads[uploadId].size < chunks) return { done: false };
      const name = path.split('/').pop();
      const parent = path.replace(/\/[^/]+$/, '') || '/';
      const item = {
        id: 'f' + (SEQ++), name, path, parent, isDir: false,
        size: blob.totalSize, mtime: Date.now(), uploader: mockUser?.name || '我',
        kind: kindOf(name), thumb: null, tags: [], __local: true
      };
      item.size = blob.totalSize;
      files.push(item);
      return { done: true, item };
    }
  };

  /* ============================================================
     真实后端
     ============================================================ */
  function filterQ(tag, group) {
    let s = '';
    if (tag !== null && tag !== undefined && tag !== '') s += '&tag=' + encodeURIComponent(tag);
    if (group !== null && group !== undefined && group !== '') s += '&group=' + encodeURIComponent(group);
    return s;
  }
  function headers(extra) {
    const h = Object.assign({}, extra || {});
    if (API.token) h.Authorization = 'Bearer ' + API.token;
    return h;
  }
  async function req(path, opts = {}) {
    const res = await fetch(API.base + path, {
      ...opts,
      headers: headers(opts.headers),
      credentials: 'omit'
    });
    if (res.status === 401) { API.token = null; throw new Error('登录已过期，请重新登录'); }
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }
  const real = {
    async login(username, password) {
      const r = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      return r;
    },
    async register(username, password, invite) {
      return req('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, invite }) });
    },
    async me() { return req('/api/me'); },
    async changePassword(oldPw, newPw) {
      return req('/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old: oldPw, new: newPw }) });
    },
    async logout() { try { await req('/api/logout', { method: 'POST' }); } catch (e) {} },
    async list(path, tag, group) {
      return req('/api/list?path=' + encodeURIComponent(path) + filterQ(tag, group));
    },
    async search(q, scope, tag, group, fields) {
      return req('/api/search?q=' + encodeURIComponent(q) + '&scope=' + (scope || 'all') + filterQ(tag, group)
        + (fields ? '&fields=' + fields : ''));
    },
    async move(paths, to) {
      return req('/api/move', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, to }) });
    },
    async rename(path, name) {
      return req('/api/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, name }) });
    },
    async tags() { return req('/api/tags'); },
    async tagSet(path, add, remove) {
      return req('/api/tag', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, add: add || [], remove: remove || [] }) });
    },
    async tagCreate(name, color, group) {
      return req('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color, group: group == null ? null : group }) });
    },
    async tagUpdate(id, name, color, group) {
      const body = { id };
      if (name !== undefined) body.name = name;
      if (color !== undefined) body.color = color;
      if (group !== undefined) body.group = (group == null ? null : group);
      return req('/api/tags/update', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
    },
    async tagDelete(id) {
      return req('/api/tags/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }) });
    },
    async tagGroupCreate(name) {
      return req('/api/tag-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }) });
    },
    async tagGroupUpdate(id, name) {
      return req('/api/tag-groups/update', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name }) });
    },
    async tagGroupDelete(id, withTags) {
      return req('/api/tag-groups/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, withTags: !!withTags }) });
    },
    async mkdir(path) {
      return req('/api/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    },
    async delete(paths) {
      return req('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
    },
    async uploadStatus(uploadId) { return req('/api/upload/status?uploadId=' + encodeURIComponent(uploadId)); },
    async uploadChunk({ uploadId, path, chunk, chunks, blob, offset }) {
      const q = `?uploadId=${encodeURIComponent(uploadId)}&path=${encodeURIComponent(path)}` +
                `&chunk=${chunk}&chunks=${chunks}&total=${blob.totalSize}&offset=${offset != null ? offset : chunk * CHUNK_SIZE}`;
      return req('/api/upload' + q, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
    },
    async putThumb(path, jpegBlob) {
      return req('/api/thumb?path=' + encodeURIComponent(path), {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpegBlob
      });
    }
  };

  Object.assign(API, {
    login: (u, p) => (API.MOCK ? mock : real).login(u, p),
    register: (u, p, i) => (API.MOCK ? mock : real).register(u, p, i),
    me: () => (API.MOCK ? mock : real).me(),
    changePassword: (o, n) => (API.MOCK ? mock : real).changePassword(o, n),
    logout: () => (API.MOCK ? mock : real).logout(),
    list: (p, t, g) => (API.MOCK ? mock : real).list(p, t, g),
    search: (q, s, t, g, f) => (API.MOCK ? mock : real).search(q, s, t, g, f),
    move: (ps, to) => (API.MOCK ? mock : real).move(ps, to),
    rename: (p, n) => (API.MOCK ? mock : real).rename(p, n),
    tags: () => (API.MOCK ? mock : real).tags(),
    tagSet: (p, add, rm) => (API.MOCK ? mock : real).tagSet(p, add, rm),
    tagCreate: (n, c, g) => (API.MOCK ? mock : real).tagCreate(n, c, g),
    tagUpdate: (id, n, c, g) => (API.MOCK ? mock : real).tagUpdate(id, n, c, g),
    tagDelete: (id) => (API.MOCK ? mock : real).tagDelete(id),
    tagGroupCreate: (n) => (API.MOCK ? mock : real).tagGroupCreate(n),
    tagGroupUpdate: (id, n) => (API.MOCK ? mock : real).tagGroupUpdate(id, n),
    tagGroupDelete: (id, wt) => (API.MOCK ? mock : real).tagGroupDelete(id, wt),
    mkdir: (p) => (API.MOCK ? mock : real).mkdir(p),
    remove: (ps) => (API.MOCK ? mock : real).delete(ps),
    uploadStatus: (id) => (API.MOCK ? mock : real).uploadStatus(id),
    uploadChunk: (o) => (API.MOCK ? mock : real).uploadChunk(o),
    putThumb: (p, blob) => (API.MOCK ? Promise.resolve({ ok: true }) : real).putThumb(p, blob)
  });

  /* 预设标签的配色（前后端共用这一套名字） */
  API.TAG_COLORS = ['green', 'blue', 'purple', 'orange', 'red', 'teal'];
  API.TAG_COLOR_CN = { green: '绿', blue: '蓝', purple: '紫', orange: '橙', red: '红', teal: '青' };
  API.canTag = (item) => !!item && (item.kind === 'image' || item.kind === 'video');

  /* 缩略图 / 直链地址（真实模式走后端，mock 模式返回本地地址） */
  API.diskInfo = function () {
    if (API.MOCK) return Promise.resolve({ total: 200 * 1024 ** 3, free: 150 * 1024 ** 3 });
    return fetch(API.base + '/api/health').then((r) => r.json());
  };
  API.auth = function () { return API.token ? ('t=' + encodeURIComponent(API.token)) : ''; };
  API.thumbUrl = function (item, w) {
    if (item.localThumb) return item.localThumb;
    if (API.MOCK) return item.thumb || null;
    if (item.thumb) return item.thumb.startsWith('http') ? item.thumb : API.base + item.thumb + '&' + API.auth();
    if (item.kind === 'image') return API.base + '/api/thumb?path=' + encodeURIComponent(item.path) + '&w=' + (w || 480) + '&' + API.auth();
    return null;                       // 视频还没有封面 → 前端显示占位
  };
  API.rawUrl = function (item, download) {
    if (item.localUrl) return item.localUrl;
    if (API.MOCK) return '#';
    return API.base + '/api/raw?path=' + encodeURIComponent(item.path) + (download ? '&dl=1' : '') + '&' + API.auth();
  };

  window.API = API;
})();
