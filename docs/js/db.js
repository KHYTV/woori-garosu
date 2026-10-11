// SNS 기록(내 나무, 게시물, 대화)의 기기 저장소. IndexedDB를 쓰고, 안 되면 메모리에만 둔다.
// 서버 저장(Supabase)은 아직 붙이지 않았다. 사진은 압축한 JPEG Blob으로 저장한다.
const NAME = "wg-sns", VERSION = 1;
let dbp = null, memory = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise(resolve => {
    if (!("indexedDB" in window)) return resolve(null);
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("trees", { keyPath: "id" });
      const posts = d.createObjectStore("posts", { keyPath: "pid", autoIncrement: true });
      posts.createIndex("treeId", "treeId");
      const msgs = d.createObjectStore("messages", { keyPath: "mid", autoIncrement: true });
      msgs.createIndex("treeId", "treeId");
      d.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { console.warn("IndexedDB를 열 수 없어 메모리에만 저장합니다.", req.error); resolve(null); };
  });
  return dbp;
}
function mem() {
  if (!memory) memory = { trees: new Map(), posts: [], messages: [], meta: new Map(), seq: 1 };
  return memory;
}
const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
async function tx(store, mode, fn) {
  const d = await open();
  if (!d) return null;
  const t = d.transaction(store, mode);
  const result = await fn(t.objectStore(store));
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return result;
}
const byTime = (a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0);

export const db = {
  async allTrees() {
    const d = await open();
    if (!d) return [...mem().trees.values()];
    return tx("trees", "readonly", s => wrap(s.getAll()));
  },
  async getTree(id) {
    const d = await open();
    if (!d) return mem().trees.get(id) || null;
    return (await tx("trees", "readonly", s => wrap(s.get(id)))) || null;
  },
  async putTree(rec) {
    const d = await open();
    if (!d) { mem().trees.set(rec.id, rec); return rec; }
    await tx("trees", "readwrite", s => wrap(s.put(rec)));
    return rec;
  },
  async deleteTree(id) {
    const d = await open();
    if (!d) { const m = mem(); m.trees.delete(id); m.posts = m.posts.filter(p => p.treeId !== id); m.messages = m.messages.filter(x => x.treeId !== id); return; }
    await tx("trees", "readwrite", s => wrap(s.delete(id)));
    for (const store of ["posts", "messages"]) {
      await tx(store, "readwrite", async s => {
        const keys = await wrap(s.index("treeId").getAllKeys(id));
        for (const k of keys) s.delete(k);
      });
    }
  },
  async addPost(post) {
    const d = await open();
    if (!d) { const m = mem(); post.pid = m.seq++; m.posts.push(post); return post; }
    post.pid = await tx("posts", "readwrite", s => wrap(s.add(post)));
    return post;
  },
  async putPost(post) {
    const d = await open();
    if (!d) { const m = mem(); const k = m.posts.findIndex(p => p.pid === post.pid); if (k >= 0) m.posts[k] = post; return post; }
    await tx("posts", "readwrite", s => wrap(s.put(post)));
    return post;
  },
  async postsFor(treeId) {
    const d = await open();
    const rows = d ? await tx("posts", "readonly", s => wrap(s.index("treeId").getAll(treeId))) : mem().posts.filter(p => p.treeId === treeId);
    return rows.sort(byTime);
  },
  async allPosts() {
    const d = await open();
    const rows = d ? await tx("posts", "readonly", s => wrap(s.getAll())) : [...mem().posts];
    return rows.sort(byTime);
  },
  async addMessage(msg) {
    const d = await open();
    if (!d) { const m = mem(); msg.mid = m.seq++; m.messages.push(msg); return msg; }
    msg.mid = await tx("messages", "readwrite", s => wrap(s.add(msg)));
    return msg;
  },
  async messagesFor(treeId) {
    const d = await open();
    const rows = d ? await tx("messages", "readonly", s => wrap(s.index("treeId").getAll(treeId))) : mem().messages.filter(x => x.treeId === treeId);
    return rows.sort((a, b) => (a.t < b.t ? -1 : 1));
  },
  async getMeta(key, fallback = null) {
    const d = await open();
    if (!d) return mem().meta.has(key) ? mem().meta.get(key) : fallback;
    const row = await tx("meta", "readonly", s => wrap(s.get(key)));
    return row ? row.value : fallback;
  },
  async setMeta(key, value) {
    const d = await open();
    if (!d) { mem().meta.set(key, value); return; }
    await tx("meta", "readwrite", s => wrap(s.put({ key, value })));
  },
  async clearAll() {
    const d = await open();
    if (!d) { memory = null; return; }
    for (const store of ["trees", "posts", "messages", "meta"]) await tx(store, "readwrite", s => wrap(s.clear()));
  },
};

// 사진을 긴 변 max px, JPEG로 줄인다(저장 공간과 화면 속도 때문)
export function compressImage(file, max = 1024, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => (b ? resolve(b) : reject(new Error("사진을 변환하지 못했습니다."))), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("사진을 읽지 못했습니다.")); };
    img.src = url;
  });
}
