const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { categories, findCategory, combineToPdf, toolAvailable, exec } = require('./converters');

const PORT = process.env.PORT || 3000;
const WORK = path.join(os.tmpdir(), 'converter');
const TTL = 30 * 60 * 1000; // results kept for 30 minutes
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const app = express();
const jobs = new Map(); // id -> { file, name, dir, created }

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/build')));
app.use('/vendor/pdf-lib', express.static(path.join(__dirname, 'node_modules/pdf-lib/dist')));

// Each request gets its own job dir with in/ and out/ so same-extension conversions never collide.
function newJob(req, res, next) {
  req.jobId = crypto.randomUUID();
  req.jobDir = path.join(WORK, req.jobId);
  fs.mkdirSync(path.join(req.jobDir, 'in'), { recursive: true });
  fs.mkdirSync(path.join(req.jobDir, 'out'), { recursive: true });
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(req.jobDir, 'in')),
    filename: (req, file, cb) => {
      req.fileCount = (req.fileCount || 0) + 1;
      cb(null, `input${req.fileCount}.${extOf(file.originalname)}`);
    },
  }),
  limits: { fileSize: 4 * 1024 ** 3 },
});

const extOf = (name) => path.extname(name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '');
const baseOf = (name) => path.parse(Buffer.from(name, 'latin1').toString('utf8')).name.replace(/[\\/:*?"<>|]/g, '_') || 'file';

let health = {};
async function checkTools() {
  const tools = [...new Set(categories.map((c) => c.tool)), 'zip'];
  const results = await Promise.all(tools.map(toolAvailable));
  health = Object.fromEntries(tools.map((t, i) => [t, results[i]]));
}

app.get('/health', async (req, res) => {
  await checkTools();
  res.json(health);
});

app.get('/formats', async (req, res) => {
  await checkTools();
  res.json(categories.map((c) => ({ name: c.name, exts: c.exts, targets: c.targets, available: health[c.tool] !== false })));
});

// Register each output file under its own id; runners return a path or an array of paths.
function finish(req, res, output, base) {
  const outputs = [].concat(output);
  const files = outputs.map((file, i) => {
    const ext = path.extname(file).slice(1);
    const name = outputs.length > 1 ? `${base}-${String(i + 1).padStart(3, '0')}.${ext}` : `${base}.${ext}`;
    const id = `${req.jobId}-${i}`;
    jobs.set(id, { file, name, dir: req.jobDir, created: Date.now() });
    return { id, name, size: fs.statSync(file).size };
  });
  res.json({ files });
}

function fail(req, res, err) {
  fs.rm(req.jobDir, { recursive: true, force: true }, () => {});
  console.error(err.message);
  res.status(400).json({ error: err.message });
}

app.post('/convert', newJob, upload.single('file'), async (req, res) => {
  try {
    const { file } = req;
    const target = String(req.body.target || '').toLowerCase();
    if (!file) throw new Error('No file uploaded');
    const ext = extOf(file.originalname);
    const cat = findCategory(ext);
    if (!cat) throw new Error(`Unsupported input type: .${ext}`);
    if (!cat.targets.includes(target)) throw new Error(`Can't convert .${ext} to .${target}`);
    const out = await cat.run(file.path, path.join(req.jobDir, 'out'), target, ext);
    finish(req, res, out, baseOf(file.originalname));
  } catch (err) {
    fail(req, res, err);
  }
});

app.post('/combine', newJob, upload.array('files'), async (req, res) => {
  try {
    if (!req.files?.length) throw new Error('No files uploaded');
    const out = await combineToPdf(req.files.map((f) => f.path), path.join(req.jobDir, 'out'));
    finish(req, res, out, `${baseOf(req.files[0].originalname)}-combined`);
  } catch (err) {
    fail(req, res, err);
  }
});

app.get('/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send('Expired or not found');
  res.download(job.file, job.name);
});

app.get('/zip', newJob, async (req, res) => {
  try {
    const picked = String(req.query.ids || '').split(',').map((id) => jobs.get(id)).filter(Boolean);
    if (!picked.length) throw new Error('Nothing to zip');
    // Copy under friendly names (deduped) so the archive contents are readable.
    const staging = path.join(req.jobDir, 'out');
    const used = new Set();
    for (const job of picked) {
      let name = job.name;
      for (let i = 2; used.has(name); i++) name = job.name.replace(/(\.[^.]*)?$/, ` (${i})$1`);
      used.add(name);
      fs.copyFileSync(job.file, path.join(staging, name));
    }
    const zip = path.join(req.jobDir, 'converted.zip');
    await exec('zip', ['-q', '-j', zip, ...[...used].map((n) => path.join(staging, n))]);
    res.download(zip, 'converted.zip', () => fs.rm(req.jobDir, { recursive: true, force: true }, () => {}));
  } catch (err) {
    fail(req, res, err);
  }
});

setInterval(() => {
  for (const [id, job] of jobs) {
    if (Date.now() - job.created > TTL) {
      jobs.delete(id);
      fs.rm(job.dir, { recursive: true, force: true }, () => {});
    }
  }
}, 60 * 1000).unref();

checkTools().then(() => {
  app.listen(PORT, '0.0.0.1', () => {
    console.log(`Converter running at http://localhost:${PORT}`);
    const missing = Object.entries(health).filter(([, ok]) => !ok).map(([t]) => t);
    if (missing.length) console.log(`Missing tools (some formats disabled): ${missing.join(', ')}`);
  });
});
