import * as pdfjs from '/vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
const { PDFDocument, degrees } = window.PDFLib;

const $ = (sel) => document.querySelector(sel);
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// Trigger individual downloads, spaced out so the browser doesn't drop any.
async function downloadFiles(files) {
  for (const f of files) {
    const a = document.createElement('a');
    a.href = `/download/${f.id}`;
    a.click();
    await new Promise((r) => setTimeout(r, 250));
  }
}

function resultLinks(files) {
  const total = fmtSize(files.reduce((n, f) => n + f.size, 0));
  if (files.length === 1) return `<a href="/download/${files[0].id}">Download</a> ${total}`;
  return `<a href="#" data-dl>Download ${files.length} files</a> · <a href="/zip?ids=${files.map((f) => f.id).join(',')}">.zip</a> ${total}`;
}

function setupDrop(label, input, onFiles) {
  input.addEventListener('change', () => { onFiles([...input.files]); input.value = ''; });
  label.addEventListener('dragover', (e) => { e.preventDefault(); label.classList.add('over'); });
  label.addEventListener('dragleave', () => label.classList.remove('over'));
  label.addEventListener('drop', (e) => {
    e.preventDefault();
    label.classList.remove('over');
    onFiles([...e.dataTransfer.files]);
  });
}

// Tabs
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab, .panel').forEach((el) => el.classList.remove('active'));
  tab.classList.add('active');
  $(`#${tab.dataset.tab}`).classList.add('active');
}));

/* ---------------- Convert ---------------- */

let formats = [];
const convertItems = []; // { file, cat, target, li, files }

const catFor = (ext) => formats.find((c) => c.exts.includes(ext));

fetch('/formats').then((r) => r.json()).then((data) => {
  formats = data;
  $('#formats-hint').textContent = formats.filter((c) => c.available)
    .map((c) => `${c.name}: ${c.exts.join(' ')}`).join(' · ');
});

async function convertOne(file, target) {
  const body = new FormData();
  body.append('target', target);
  body.append('file', file);
  const res = await fetch('/convert', { method: 'POST', body });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

setupDrop($('#convert-drop'), $('#convert-input'), (files) => {
  for (const file of files) {
    const cat = catFor(extOf(file.name));
    const li = document.createElement('li');
    const item = { file, cat, target: cat?.targets.find((t) => t !== extOf(file.name)), li };
    li.innerHTML = `<span class="name"></span><span class="size">${fmtSize(file.size)}</span><select></select><span class="status"></span><button class="x" title="Remove">✕</button>`;
    li.querySelector('.name').textContent = file.name;
    const select = li.querySelector('select');
    if (cat && cat.available) {
      select.innerHTML = cat.targets.map((t) => `<option>${t}</option>`).join('');
      select.value = item.target;
      select.onchange = () => { item.target = select.value; };
    } else {
      select.hidden = true;
      setStatus(item, cat ? `${cat.name} tools not installed` : 'Unsupported type', 'err');
    }
    li.querySelector('.x').onclick = () => {
      convertItems.splice(convertItems.indexOf(item), 1);
      li.remove();
      refreshConvertBar();
    };
    convertItems.push(item);
    $('#convert-list').append(li);
  }
  refreshConvertBar();
});

function setStatus(item, html, cls = '') {
  const el = item.li.querySelector('.status');
  el.className = `status ${cls}`;
  el.innerHTML = html;
  const dl = el.querySelector('[data-dl]');
  if (dl) dl.onclick = (e) => { e.preventDefault(); downloadFiles(item.files); };
}

function refreshConvertBar() {
  const valid = convertItems.filter((i) => i.cat?.available);
  $('#convert-bar').hidden = !convertItems.length;
  const all = [...new Set(valid.flatMap((i) => i.cat.targets))];
  $('#convert-all').innerHTML = `<option value="">—</option>${all.map((t) => `<option>${t}</option>`).join('')}`;
  const images = valid.filter((i) => i.cat.name === 'Image');
  $('#combine-wrap').hidden = !(images.length > 1);
  refreshDownloadAll();
}

function refreshDownloadAll() {
  const files = [...new Set(convertItems.flatMap((i) => i.files || []))];
  $('#download-bar').hidden = files.length < 2;
  $('#download-zip').href = `/zip?ids=${files.map((f) => f.id).join(',')}`;
  $('#download-all').onclick = () => downloadFiles(files);
}

$('#convert-all').onchange = (e) => {
  for (const item of convertItems) {
    if (item.cat?.targets.includes(e.target.value)) {
      item.target = e.target.value;
      item.li.querySelector('select').value = item.target;
    }
  }
};

$('#convert-clear').onclick = () => {
  convertItems.length = 0;
  $('#convert-list').innerHTML = '';
  refreshConvertBar();
};

$('#convert-go').onclick = async () => {
  const btn = $('#convert-go');
  btn.disabled = true;
  const pending = convertItems.filter((i) => i.cat?.available);

  if ($('#combine').checked && !$('#combine-wrap').hidden) {
    const images = pending.filter((i) => i.cat.name === 'Image');
    images.forEach((i) => setStatus(i, 'Combining…'));
    try {
      const body = new FormData();
      images.forEach((i) => body.append('files', i.file));
      const res = await fetch('/combine', { method: 'POST', body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      images.forEach((i) => { i.files = null; setStatus(i, 'Combined', 'ok'); });
      images[0].files = json.files;
      setStatus(images[0], resultLinks(json.files), 'ok');
      refreshDownloadAll();
    } catch (err) {
      images.forEach((i) => setStatus(i, err.message, 'err'));
    }
    pending.splice(0, pending.length, ...pending.filter((i) => i.cat.name !== 'Image'));
  }

  // Run a few at a time; LibreOffice jobs are serialized server-side anyway.
  const queue = [...pending];
  const worker = async () => {
    for (let item; (item = queue.shift());) {
      setStatus(item, 'Converting…');
      try {
        item.files = (await convertOne(item.file, item.target)).files;
        setStatus(item, resultLinks(item.files), 'ok');
        refreshDownloadAll();
      } catch (err) {
        setStatus(item, '', 'err');
        item.li.querySelector('.status').textContent = err.message;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  btn.disabled = false;
};

/* ---------------- Merge / arrange ---------------- */

const sources = []; // { name, bytes: Uint8Array, pdfjs, lib? }
let pages = []; // { id, src, index, rot, el }
let nextId = 1;
let lastClicked = null;

const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    renderThumb(pages.find((p) => p.el === e.target));
  }
}, { rootMargin: '400px' });

async function renderThumb(page) {
  if (!page) return;
  const pdfPage = await page.src.pdfjs.getPage(page.index + 1);
  const vp1 = pdfPage.getViewport({ scale: 1 });
  const viewport = pdfPage.getViewport({ scale: (140 * devicePixelRatio) / Math.max(vp1.width, vp1.height) });
  const canvas = page.el.querySelector('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${viewport.width / devicePixelRatio}px`;
  await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
}

async function toPdfBytes(file) {
  if (extOf(file.name) === 'pdf') return new Uint8Array(await file.arrayBuffer());
  // Anything else (images, HEIC, docx…) gets converted to PDF by the server.
  const result = await convertOne(file, 'pdf');
  return new Uint8Array(await (await fetch(`/download/${result.files[0].id}`)).arrayBuffer());
}

setupDrop($('#merge-drop'), $('#merge-input'), async (files) => {
  const status = document.createElement('div');
  status.className = 'loading';
  $('#pages').before(status);
  for (const file of files) {
    status.textContent = `Loading ${file.name}…`;
    try {
      const bytes = await toPdfBytes(file);
      const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
      const src = { name: file.name, bytes, pdfjs: doc };
      sources.push(src);
      for (let i = 0; i < doc.numPages; i++) pages.push({ id: nextId++, src, index: i, rot: 0, selected: false });
      renderPages();
    } catch (err) {
      alert(`Couldn't load ${file.name}: ${err.message}`);
    }
  }
  status.remove();
});

function renderPages() {
  const grid = $('#pages');
  for (const [i, p] of pages.entries()) {
    if (!p.el) {
      p.el = document.createElement('div');
      p.el.className = 'page';
      p.el.draggable = true;
      p.el.innerHTML = `<div class="thumb"><canvas></canvas></div>
        <div class="label"><span></span><span class="num"></span></div>
        <div class="tools"><button data-t="rot" title="Rotate">↻</button><button data-t="del" title="Delete">✕</button></div>`;
      p.el.querySelector('.label span').textContent = `${p.src.name} p${p.index + 1}`;
      p.el.querySelector('.label span').title = p.src.name;
      p.el.dataset.id = p.id;
      thumbObserver.observe(p.el);
    }
    p.el.querySelector('.num').textContent = i + 1;
    p.el.classList.toggle('selected', p.selected);
    p.el.querySelector('canvas').style.transform = `rotate(${p.rot}deg)`;
    if (grid.children[i] !== p.el) grid.insertBefore(p.el, grid.children[i] || null);
  }
  // Remove deleted pages' elements
  const live = new Set(pages.map((p) => p.el));
  [...grid.children].forEach((el) => { if (!live.has(el)) el.remove(); });

  const sel = pages.filter((p) => p.selected).length;
  $('#merge-bar').hidden = $('#merge-hint').hidden = !pages.length;
  $('#merge-count').textContent = `${pages.length} pages${sel ? `, ${sel} selected` : ''}`;
  $('#extract-btn').disabled = !sel;
}

const pageFor = (el) => pages.find((p) => p.el === el.closest('.page'));

$('#pages').addEventListener('click', (e) => {
  const page = pageFor(e.target);
  if (!page) return;
  const tool = e.target.dataset.t;
  if (tool === 'rot') page.rot = (page.rot + 90) % 360;
  else if (tool === 'del') pages = pages.filter((p) => p !== page);
  else if (e.shiftKey && lastClicked && pages.includes(lastClicked)) {
    const [a, b] = [pages.indexOf(lastClicked), pages.indexOf(page)].sort((x, y) => x - y);
    pages.forEach((p, i) => { if (i >= a && i <= b) p.selected = true; });
  } else if (e.metaKey || e.ctrlKey) {
    page.selected = !page.selected;
    lastClicked = page;
  } else {
    const only = page.selected && pages.filter((p) => p.selected).length === 1;
    pages.forEach((p) => { p.selected = false; });
    page.selected = !only;
    lastClicked = page;
  }
  renderPages();
});

// Drag & drop reordering. Dragging a selected page moves the whole selection.
let dragging = [];
let dropTarget = null;
const clearMarkers = () => document.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));

$('#pages').addEventListener('dragstart', (e) => {
  const page = pageFor(e.target);
  if (!page) return;
  dragging = page.selected ? pages.filter((p) => p.selected) : [page];
  dragging.forEach((p) => p.el.classList.add('dragging'));
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
});

$('#pages').addEventListener('dragover', (e) => {
  if (!dragging.length) return;
  e.preventDefault();
  const page = pageFor(e.target);
  clearMarkers();
  if (!page) return;
  const rect = page.el.getBoundingClientRect();
  const after = e.clientX > rect.left + rect.width / 2;
  page.el.classList.add(after ? 'drop-after' : 'drop-before');
  dropTarget = { page, after };
});

$('#pages').addEventListener('drop', (e) => {
  e.preventDefault();
  if (!dropTarget || dragging.includes(dropTarget.page)) return;
  const rest = pages.filter((p) => !dragging.includes(p));
  const at = rest.indexOf(dropTarget.page) + (dropTarget.after ? 1 : 0);
  rest.splice(at, 0, ...dragging);
  pages = rest;
  renderPages();
});

$('#pages').addEventListener('dragend', () => {
  dragging.forEach((p) => p.el.classList.remove('dragging'));
  dragging = [];
  dropTarget = null;
  clearMarkers();
});

const selectedOrAll = () => {
  const sel = pages.filter((p) => p.selected);
  return sel.length ? sel : pages;
};

const actions = {
  rotate: () => selectedOrAll().forEach((p) => { p.rot = (p.rot + 90) % 360; }),
  delete: () => { pages = pages.filter((p) => !p.selected); },
  reverse: () => { pages.reverse(); },
  sort: () => { pages.sort((a, b) => sources.indexOf(a.src) - sources.indexOf(b.src) || a.index - b.index); },
  all: () => { const every = pages.every((p) => p.selected); pages.forEach((p) => { p.selected = !every; }); },
  clear: () => { pages = []; sources.length = 0; },
  merge: () => buildPdf(pages, 'merged.pdf'),
  extract: () => buildPdf(pages.filter((p) => p.selected), 'extracted.pdf'),
};

$('#merge-bar').addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  actions[act]();
  renderPages();
});

document.addEventListener('keydown', (e) => {
  if (!$('#merge').classList.contains('active') || e.target.matches('input, select, textarea')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') actions.delete();
  else if (e.key === 'r') actions.rotate();
  else if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); pages.forEach((p) => { p.selected = true; }); }
  else return;
  renderPages();
});

async function buildPdf(list, name) {
  if (!list.length) return;
  const btns = document.querySelectorAll('#merge-bar button');
  btns.forEach((b) => { b.disabled = true; });
  try {
    const out = await PDFDocument.create();
    for (const src of new Set(list.map((p) => p.src))) {
      src.lib ||= await PDFDocument.load(src.bytes, { ignoreEncryption: true });
    }
    for (const p of list) {
      const [copied] = await out.copyPages(p.src.lib, [p.index]);
      if (p.rot) copied.setRotation(degrees((copied.getRotation().angle + p.rot) % 360));
      out.addPage(copied);
    }
    saveBlob(new Blob([await out.save()], { type: 'application/pdf' }), name);
  } catch (err) {
    alert(`Failed to build PDF: ${err.message}`);
  } finally {
    btns.forEach((b) => { b.disabled = false; });
    renderPages();
  }
}
