// Format routing: each category maps input extensions to output targets and a CLI runner.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const TIMEOUT = 30 * 60 * 1000;

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} failed: ${(stderr || err.message).toString().trim().slice(-800)}`;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// LibreOffice can't run two conversions against the same profile at once, so serialize them.
let officeQueue = Promise.resolve();
function soffice(args) {
  const run = officeQueue.then(() => exec(sofficePath() || 'soffice', ['--headless', '--norestore', ...args]));
  officeQueue = run.catch(() => {});
  return run;
}

// Resolved on each use so installing LibreOffice doesn't require a server restart.
const sofficePath = () => ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice', '/usr/bin/soffice']
  .find((p) => fs.existsSync(p));

// Convert with LibreOffice; it names output <inputbase>.<ext> inside outDir.
async function officeConvert(input, outDir, target, extraArgs = []) {
  await soffice([...extraArgs, '--convert-to', target, '--outdir', outDir, input]);
  const out = path.join(outDir, `${path.parse(input).name}.${target.split(':')[0]}`);
  if (!fs.existsSync(out)) throw new Error('LibreOffice produced no output');
  return out;
}

const FLATTEN = ['jpg', 'jpeg', 'bmp'];
const SINGLE_FRAME = ['jpg', 'jpeg', 'png', 'bmp', 'ico', 'avif'];

const PANDOC_FMT = {
  md: 'markdown', markdown: 'markdown', txt: 'markdown', html: 'html', htm: 'html', epub: 'epub',
  rst: 'rst', org: 'org', tex: 'latex', odt: 'odt', docx: 'docx', ipynb: 'ipynb', textile: 'textile',
};
const PANDOC_OUT = { md: 'gfm', txt: 'plain', html: 'html5', tex: 'latex', rst: 'rst', org: 'org', epub: 'epub', docx: 'docx', odt: 'odt', ipynb: 'ipynb' };

const categories = [
  {
    name: 'Image',
    tool: 'magick',
    exts: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'svg', 'ico', 'psd', 'jxl', 'tga', 'dng', 'cr2', 'nef', 'arw'],
    targets: ['jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'avif', 'ico', 'pdf'],
    async run(input, outDir, target) {
      const out = path.join(outDir, `out.${target}`);
      const src = SINGLE_FRAME.includes(target) ? `${input}[0]` : input;
      const args = [src, '-auto-orient'];
      if (FLATTEN.includes(target)) args.push('-background', 'white', '-alpha', 'remove', '-alpha', 'off');
      if (target === 'ico') args.push('-resize', '256x256>');
      if (target === 'jpg') args.push('-quality', '92');
      await exec('magick', [...args, out]);
      return out;
    },
  },
  {
    name: 'PDF',
    tool: 'gs',
    exts: ['pdf'],
    targets: ['png', 'jpg', 'txt', 'docx'],
    async run(input, outDir, target) {
      if (target === 'txt') {
        const out = path.join(outDir, 'out.txt');
        await exec('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=txtwrite', `-sOutputFile=${out}`, input]);
        return out;
      }
      if (target === 'docx') return officeConvert(input, outDir, 'docx', ['--infilter=writer_pdf_import']);
      const device = target === 'png' ? 'png16m' : 'jpeg';
      await exec('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-r150', '-dJPEGQ=92', '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
        `-sDEVICE=${device}`, `-sOutputFile=${path.join(outDir, `page-%03d.${target}`)}`, input]);
      return collect(outDir, target);
    },
  },
  {
    name: 'Audio',
    tool: 'ffmpeg',
    exts: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'amr'],
    targets: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'aiff'],
    async run(input, outDir, target) {
      const out = path.join(outDir, `out.${target}`);
      await exec('ffmpeg', ['-y', '-v', 'error', '-i', input, '-vn', ...audioArgs(target), out]);
      return out;
    },
  },
  {
    name: 'Video',
    tool: 'ffmpeg',
    exts: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts'],
    targets: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'gif', 'mp3', 'wav', 'm4a'],
    async run(input, outDir, target) {
      const out = path.join(outDir, `out.${target}`);
      let args;
      if (target === 'gif') {
        args = ['-vf', 'fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0'];
      } else if (['mp3', 'wav', 'm4a'].includes(target)) {
        args = ['-vn', ...audioArgs(target)];
      } else if (target === 'webm') {
        args = ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-c:a', 'libopus'];
      } else {
        args = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k'];
        if (['mp4', 'mov'].includes(target)) args.push('-movflags', '+faststart');
      }
      await exec('ffmpeg', ['-y', '-v', 'error', '-i', input, ...args, out]);
      return out;
    },
  },
  {
    name: 'Document',
    tool: 'soffice',
    exts: ['doc', 'docx', 'odt', 'rtf', 'pages', 'wpd'],
    targets: ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html', 'md', 'epub'],
    async run(input, outDir, target, ext) {
      // Markdown/EPUB aren't LibreOffice outputs; route docx/odt through pandoc for those.
      if (['md', 'epub'].includes(target)) {
        let src = input;
        if (!['docx', 'odt'].includes(ext)) src = await officeConvert(input, path.join(outDir, 'tmp'), 'docx');
        return pandoc(src, PANDOC_FMT[path.extname(src).slice(1)], outDir, target);
      }
      return officeConvert(input, outDir, target === 'txt' ? 'txt:Text' : target);
    },
  },
  {
    name: 'Spreadsheet',
    tool: 'soffice',
    exts: ['xls', 'xlsx', 'ods', 'csv', 'numbers', 'tsv'],
    targets: ['pdf', 'xlsx', 'ods', 'csv', 'html'],
    run: (input, outDir, target) => officeConvert(input, outDir, target),
  },
  {
    name: 'Presentation',
    tool: 'soffice',
    exts: ['ppt', 'pptx', 'odp', 'key'],
    targets: ['pdf', 'pptx', 'odp'],
    run: (input, outDir, target) => officeConvert(input, outDir, target),
  },
  {
    name: 'Text / Markup',
    tool: 'pandoc',
    exts: ['md', 'markdown', 'txt', 'html', 'htm', 'epub', 'rst', 'org', 'tex', 'ipynb', 'textile'],
    targets: ['pdf', 'docx', 'odt', 'html', 'md', 'txt', 'epub', 'rst', 'tex'],
    async run(input, outDir, target, ext) {
      const from = PANDOC_FMT[ext];
      if (target === 'pdf') {
        // No LaTeX needed: pandoc -> docx -> LibreOffice -> pdf.
        const docx = await pandoc(input, from, path.join(outDir, 'tmp'), 'docx');
        return officeConvert(docx, outDir, 'pdf');
      }
      return pandoc(input, from, outDir, target);
    },
  },
];

async function pandoc(input, from, outDir, target) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `out.${target}`);
  const args = ['-f', from, '-t', PANDOC_OUT[target], '-o', out, input];
  if (target === 'html') args.unshift('--standalone', '--embed-resources');
  await exec('pandoc', args, { cwd: path.dirname(input) });
  return out;
}

function audioArgs(target) {
  return {
    mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],
    aac: ['-c:a', 'aac', '-b:a', '192k'],
    m4a: ['-c:a', 'aac', '-b:a', '192k'],
    ogg: ['-c:a', 'libopus', '-b:a', '160k'],
    opus: ['-c:a', 'libopus', '-b:a', '128k'],
  }[target] || [];
}

// Multi-output conversions (e.g. PDF pages): return every produced file.
function collect(outDir, ext) {
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(`.${ext}`)).sort();
  if (!files.length) throw new Error('No output produced');
  return files.map((f) => path.join(outDir, f));
}

// Combine several images (or PDFs) into one PDF.
async function combineToPdf(inputs, outDir) {
  const out = path.join(outDir, 'combined.pdf');
  await exec('magick', [...inputs.map((i) => (i.endsWith('.pdf') ? i : `${i}[0]`)), '-auto-orient', '-background', 'white', '-alpha', 'remove', '-density', '150', out]);
  return out;
}

function findCategory(ext) {
  return categories.find((c) => c.exts.includes(ext));
}

function toolAvailable(tool) {
  if (tool === 'soffice') return Promise.resolve(Boolean(sofficePath()));
  return exec('which', [tool]).then(() => true, () => false);
}

module.exports = { categories, findCategory, combineToPdf, toolAvailable, exec };
