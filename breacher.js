/**
 * Optical Breacher — 完整管线 v3 (使用 Tesseract.js OCR)
 * CLI:  node breacher.js 截图.png
 * HTTP: node breacher.js --serve  (打开 http://localhost:3000)
 */

const Tesseract = require('tesseract.js');
const Jimp = require('jimp');
const path = require('path');
const fs = require('fs');

// ====== 配置 ======
const BYTE_MAP = { '1':'1C', '5':'55', '7':'7A', 'B':'BD', 'E':'E9', 'F':'FF' };
const VALID_BYTES = ['1C','55','7A','BD','E9','FF'];

// 单字符直接映射（OCR 把完整 hex 值识别成单字符时）
const CHAR_MAP = { '1':'1', '5':'5', '7':'7', 'B':'B', 'E':'E', 'F':'F' };

// 常见 OCR 单字符误读 → 纠正
const CHAR_FIX = { 'I':'1', 'L':'1', 'S':'5', 'G':'5', 'O':'0', '0':'B', '8':'B', '3':'B', '€':'E' };

function levenshtein(a, b) {
  const m = []; for (let i = 0; i <= a.length; i++) { m[i] = [i]; for (let j = 1; j <= b.length; j++) m[i][j] = i === 0 ? j : 0; }
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    m[i][j] = b[j-1] === a[i-1] ? m[i-1][j-1] : Math.min(m[i-1][j-1]+1, m[i][j-1]+1, m[i-1][j]+1);
  return m[a.length][b.length];
}

function cleanToken(t) {
  let s = t.trim().toUpperCase();
  // 1) 直接命中完整 hex 值
  if (BYTE_MAP[s]) return s;
  // 2) 单字符直接映射
  if (CHAR_MAP[s]) return s;
  // 3) 已知特殊误读（Levenshtein 处理不好的）
  const KNOWN = { 'AD':'1', 'IC':'1', 'LC':'1', 'LE':'1', 'TA':'7', '3D':'B', '8D':'B', 'DB':'B', 'BB':'B', '21D':'B', '2D':'B', 'E€':'E', 'FFE':'F', 'Ff':'F' };
  if (KNOWN[s]) return KNOWN[s];
  // 4) 常见 OCR 单字符误读替换
  s = s.split('').map(c => CHAR_FIX[c] || c).join('');
  // 5) 替换后再次检查
  if (BYTE_MAP[s]) return s;
  if (CHAR_MAP[s]) return s;
  // 6) 双字符尝试拆分成两个单字符识别
  if (s.length === 2) {
    const c0 = CHAR_MAP[s[0]] || CHAR_FIX[s[0]] || s[0];
    const c1 = CHAR_MAP[s[1]] || CHAR_FIX[s[1]] || s[1];
    if (BYTE_MAP[c0 + c1]) return c0;
  }
  // 7) 编辑距离模糊匹配（允许 1 以内误差）
  let best = null, minD = 99;
  for (const v of VALID_BYTES) { const d = levenshtein(s, v); if (d < minD) { minD = d; best = v; } }
  if (minD <= 1 && best) return best[0];
  // 8) 最终 fallback: 取首字符
  const first = s[0];
  if (BYTE_MAP[first]) return first;
  return null;
}

// ====== OCR ======
async function ocrImage(worker, imgPath) {
  const ret = await worker.recognize(imgPath);
  const text = ret.data.text.trim();
  const lines = text.split('\n').filter(l => l.trim());
  const result = [];
  for (const line of lines) {
    const tokens = line.trim().split(/[\s|_()\u201c\u201d\u2018\u2019`'";:!?\[\]{}]+/).filter(t => t.length > 0);
    const row = tokens.map(cleanToken).filter(t => t !== null);
    if (row.length > 0) result.push(row);
  }
  return result;
}

// ====== 求解器 ======
function sequencesToString(seqs, matrix) {
  return seqs.map(seq => { let r=''; for(let i=0;i<seq.length;i+=2) r+=matrix[parseInt(seq[i],10)][parseInt(seq[i+1],10)]; return r; });
}
function getSequences({ bufferSize, orientation, index, used, matrix, targets }) {
  const n = matrix.length;
  const nexts = [];
  for (let i = 0; i < n; i++) { const pos = orientation==='row' ? index+i : i+index; if (!used.has(pos)) nexts.push(pos); }
  if (bufferSize === 1) return nexts;
  const init = [];
  for (const rc of nexts) {
    const sub = getSequences({ bufferSize: Math.min(bufferSize,6)-1, orientation: orientation==='row'?'col':'row', index: orientation==='row'?rc[1]:rc[0], used: new Set(used).add(rc), matrix, targets });
    for (const s of sub) init.push(rc + s);
  }
  if (bufferSize > 6) {
    const strs = sequencesToString(init, matrix);
    const tStrs = targets.map(t => t.join(''));
    const filtered = init.filter((_s,i) => tStrs.some(ts => strs[i].includes(ts)));
    const res = [];
    for (const seq of filtered) { const sub = getSequences({ bufferSize: bufferSize-6, orientation:'row', index: seq[10], used: new Set(seq.match(/.{1,2}/g)), matrix, targets }); for (const s of sub) res.push(seq + s); }
    return res;
  }
  return init;
}
function evaluate(seqs, matrix, targets) {
  const strs = sequencesToString(seqs, matrix);
  const tStrs = targets.map(t => t.join(''));
  let maxSc = 0;
  const ev = strs.map((s,si) => { let sc=0,sl=0,mi=[]; tStrs.forEach((ts,i)=>{ const p=s.indexOf(ts); if(p>-1){ sc+=1+0.1*i; sl=Math.max(sl,p+ts.length); mi.push(i); }}); maxSc=Math.max(sc,maxSc); return {score:sc,idx:si,len:sl,mi}; });
  const best = ev.filter(r => r.score === maxSc);
  const minL = Math.min(...best.map(r => r.len));
  const sh = best.filter(r => r.len === minL);
  const ch = sh.map(r => ({ seq: seqs[r.idx].slice(0, minL*2), mi: r.mi }));
  const seen = new Set();
  return ch.filter(i => { if(seen.has(i.seq)) return false; seen.add(i.seq); return true; });
}
function solveWuthering(matrix, targets, buf) {
  const n = matrix.length; let all = [];
  function ss(bs, ori, idx, used) {
    const nxt = []; for (let i = 0; i < n; i++) { const p = ori==='row'?idx+i:i+idx; if (!used.has(p)) nxt.push(p); }
    if (bs === 1) return nxt;
    const init = []; for (const rc of nxt) { const s = ss(Math.min(bs,6)-1, ori==='row'?'col':'row', ori==='row'?rc[1]:rc[0], new Set(used).add(rc)); for (const x of s) init.push(rc + x); }
    if (bs > 6) { const strs = sequencesToString(init, matrix); const ts = targets.map(t=>t.join('')); const f = init.filter((s,i)=>ts.some(t=>strs[i].includes(t))); const r = []; for (const seq of f) { const s = ss(bs-6,'row',seq[10],new Set(seq.match(/.{1,2}/g))); for (const x of s) r.push(seq + x); } return r; }
    return init;
  }
  for (let c = 0; c < n; c++) { if (buf === 1) { all.push('0'+c); continue; } const s = ss(buf-1, 'col', ''+c, new Set(['0'+c])); for (const x of s) all.push('0'+c + x); }
  return evaluate(all, matrix, targets);
}

// ====== 核心管线（返回结构化数据） ======
async function runPipeline(screenshotPath, crops) {
  let img = await Jimp.read(path.resolve(screenshotPath));
  const standardW = 1562;
  const originalW = img.bitmap.width;
  let cropScale = 1;
  if (originalW !== standardW) {
    cropScale = standardW / originalW;
    img = img.resize(standardW, Math.round(img.bitmap.height * cropScale));
  }
  // 默认裁剪坐标（基于 test.png 校准到 1562px 宽度）
  // 前端传来的坐标是原始图像像素，需等比缩放到 1562px 空间
  const scale = (c) => c ? { x: Math.round(c.x * cropScale), y: Math.round(c.y * cropScale), w: Math.round(c.w * cropScale), h: Math.round(c.h * cropScale) } : null;
  const MATRIX_CROP = crops && crops.matrix ? scale(crops.matrix) : { x: 30, y: 45, w: 480, h: 450 };
  const TARGET_CROP = crops && crops.targets ? scale(crops.targets) : { x: 880, y: 45, w: 650, h: 160 };
  // 扩展裁剪区域 5px 边距，防 Tesseract 切掉边缘行
  if (crops && crops.matrix) {
    MATRIX_CROP.x = Math.max(0, MATRIX_CROP.x - 5);
    MATRIX_CROP.y = Math.max(0, MATRIX_CROP.y - 5);
    MATRIX_CROP.w += 10;
    MATRIX_CROP.h += 10;
  }
  if (crops && crops.targets) {
    // 目标区自动收缩 3px 防边缘干扰（框太宽时 E9 → BD 等问题）
    TARGET_CROP.x = Math.max(0, TARGET_CROP.x + 3);
    TARGET_CROP.y = Math.max(0, TARGET_CROP.y + 3);
    TARGET_CROP.w = Math.max(50, TARGET_CROP.w - 6);
    TARGET_CROP.h = Math.max(30, TARGET_CROP.h - 6);
    TARGET_CROP.h += 10;
  }
  const matrixArea = img.clone().crop(MATRIX_CROP.x, MATRIX_CROP.y, MATRIX_CROP.w, MATRIX_CROP.h);
  const targetArea = img.clone().crop(TARGET_CROP.x, TARGET_CROP.y, TARGET_CROP.w, TARGET_CROP.h);
  
  // 图像预处理：灰度 + 固定阈值二值化 + 反色
  // 目的：消除各行背景色差异，生成白底黑字（Tesseract 最优格式）
  function prepareForOcr(jimpImg) {
    // 自动放大：确保宽度至少 480px（全屏截图裁剪区域太小会导致 OCR 精度暴跌）
    const minW = 480;
    if (jimpImg.bitmap.width < minW) {
      const scale = Math.ceil(minW / jimpImg.bitmap.width);
      jimpImg.resize(jimpImg.bitmap.width * scale, jimpImg.bitmap.height * scale);
    }
    jimpImg.greyscale();
    jimpImg.scan(0, 0, jimpImg.bitmap.width, jimpImg.bitmap.height, function(x, y, idx) {
      const v = this.bitmap.data[idx];
      const out = v > 80 ? 0 : 255;
      this.bitmap.data[idx] = this.bitmap.data[idx + 1] = this.bitmap.data[idx + 2] = out;
    });
  }
  prepareForOcr(matrixArea);
  prepareForOcr(targetArea);
  
  const tmpDir = fs.mkdtempSync('ocr-');
  const mPath = path.join(tmpDir, 'matrix.png');
  const tPath = path.join(tmpDir, 'targets.png');
  await matrixArea.writeAsync(mPath);
  await targetArea.writeAsync(tPath);
  const worker = await Tesseract.createWorker('eng', 1);
  // SINGLE_BLOCK (6): 整块多行文本，适合网格布局
  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
  });
  const matrixRows = await ocrImage(worker, mPath);
  const targetRows = await ocrImage(worker, tPath);
  await worker.terminate();
  // 保存调试图（base64）— 必须在删 tmpDir 之前
  const debugImages = { matrix: '', targets: '' };
  try { debugImages.matrix = 'data:image/png;base64,' + fs.readFileSync(mPath).toString('base64'); } catch(e) {}
  try { debugImages.targets = 'data:image/png;base64,' + fs.readFileSync(tPath).toString('base64'); } catch(e) {}
  try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
  
  let validMatrixRows = matrixRows.filter(r => r.length >= 3 && r.length <= 9);
  const validTargetRows = targetRows.filter(r => r.length >= 2 && r.length <= 6);
  
  const result = { matrix: [], targets: [], solved: false, buffer: 0, path: [], steps: [], matchedTargets: [], matrixSize: '', error: null, hexMatrix: [], hexTargets: [], debugImages };
  
  // 如果严格过滤行数太少，放宽到 2 列
  if (validMatrixRows.length < 2 && matrixRows.some(r => r.length >= 2)) {
    validMatrixRows = matrixRows.filter(r => r.length >= 2 && r.length <= 10);
  }
  
  if (validMatrixRows.length < 2) { result.error = '矩阵行数不足 (' + validMatrixRows.length + ' 行)'; return result; }
  
  // 确定期望的列数（众数）
  const colLengths = {};
  for (const row of validMatrixRows) colLengths[row.length] = (colLengths[row.length] || 0) + 1;
  const sorted = Object.entries(colLengths).sort((a,b) => b[1]-a[1] || (parseInt(b[0])-parseInt(a[0])));
  const mostCommonLen = parseInt(sorted[0][0]);
  
  // 修复行：对于列数不等于期望值的行，尝试修剪或保留
  const fixedRows = [];
  for (const row of validMatrixRows) {
    if (row.length === mostCommonLen) {
      fixedRows.push(row);
    } else if (row.length > mostCommonLen) {
      // 多余 token，尝试从两端丢弃直到匹配列数
      while (row.length > mostCommonLen) {
        // 丢弃最后一个（通常是噪音）
        row.pop();
      }
      if (row.length === mostCommonLen) fixedRows.push(row);
    }
    // 行数不足的直接丢弃
  }
  
  result.matrix = fixedRows.length >= 2 ? fixedRows : validMatrixRows.filter(r => r.length === mostCommonLen);
  result.targets = validTargetRows.slice(0, 6);
  result.matrixSize = result.matrix.length + '×' + mostCommonLen;
  // 总是设置 hex 版本
  result.hexMatrix = result.matrix.map(r => r.map(c => BYTE_MAP[c] || c));
  result.hexTargets = result.targets.map(r => r.map(c => BYTE_MAP[c] || c));
  
  // 目标序列交叉验证：如果某 hex 值不在矩阵中，尝试修正（如 E9→BD 误读）
  const matrixHexSet = new Set(result.hexMatrix.flat());
  for (const tRow of result.targets) {
    for (let i = 0; i < tRow.length; i++) {
      const hex = BYTE_MAP[tRow[i]] || tRow[i];
      if (!matrixHexSet.has(hex)) {
        // 该值不在矩阵中，找编辑距离最近的合法值
        let best = null, minD = 99;
        for (const v of VALID_BYTES) {
          if (matrixHexSet.has(v)) { // 只考虑矩阵中存在的值
            const d = levenshtein(hex, v);
            if (d < minD) { minD = d; best = v; }
          }
        }
        if (minD <= 2 && best) {
          tRow[i] = best[0]; // 修正为目标值的首字符
        }
      }
    }
  }
  // 修正后更新 hexTargets
  result.hexTargets = result.targets.map(r => r.map(c => BYTE_MAP[c] || c));
  
  if (result.matrix.length < 2 || result.targets.length === 0) { result.error = 'OCR 结果不足以求解'; return result; }
  
  let bestSolution = null, bestBuf = 0;
  for (const buf of [5, 6, 7, 8]) {
    const solutions = solveWuthering(result.matrix, result.targets, buf);
    if (solutions.length === 0) continue;
    if (solutions[0].mi.length === result.targets.length) { bestSolution = solutions[0]; bestBuf = buf; break; }
  }
  if (bestSolution) {
    result.solved = true; result.buffer = bestBuf;
    for (let i = 0; i < bestSolution.seq.length; i += 2) {
      const r = parseInt(bestSolution.seq[i]), c = parseInt(bestSolution.seq[i+1]);
      result.path.push(BYTE_MAP[result.matrix[r][c]] || result.matrix[r][c]);
      const dir = i === 0 ? '' : (() => {
        const pr = parseInt(bestSolution.seq[i-2]), pc = parseInt(bestSolution.seq[i-1]);
        return r === pr ? (c > pc ? 'right' : 'left') : (r > pr ? 'down' : 'up');
      })();
      result.steps.push({ row: r, col: c, step: i/2 + 1, value: BYTE_MAP[result.matrix[r][c]] || result.matrix[r][c], dir });
    }
    result.matchedTargets = bestSolution.mi;
  }
  return result;
}

// ====== CLI 入口 ======
async function main() {
  const screenshotPath = process.argv[2] || './test.png';
  const debug = process.argv.includes('--debug');
  console.log('=== Optical Breacher Pipeline v3 (OCR) ===\n');
  const result = await runPipeline(screenshotPath);
  
  if (debug && result.matrix.length > 0) {
    console.log('--- 矩阵 (raw) ---');
    for (const row of result.matrix) console.log('  ' + row.join(' '));
    console.log('--- 目标 (raw) ---');
    for (const row of result.targets) console.log('  ' + row.join(' '));
  }
  console.log('\n解析结果:');
  console.log('矩阵 ' + result.matrixSize + ':');
  for (const row of result.hexMatrix) console.log('  ' + row.join('  '));
  console.log('\n目标序列 ' + result.targets.length + ' 条:');
  for (const row of result.hexTargets) console.log('  ' + row.join(', '));
  if (result.error) { console.log('\n错误: ' + result.error); process.exit(1); }
  
  console.log('\n========== 求解结果 ==========\n');
  if (result.solved) {
    const names = result.matchedTargets.map(i => '目标' + (i+1));
    console.log('Buffer=' + result.buffer + ' (' + result.steps.length + '步)  全部匹配: ' + names.join(', '));
    console.log('路径值: ' + result.path.join(' → ') + '\n');
    const stepMap = {}; for (const s of result.steps) stepMap[s.row + ',' + s.col] = s.step;
    for (let r = 0; r < result.matrix.length; r++) {
      let line = '  ';
      for (let c = 0; c < result.matrix[r].length; c++) {
        const val = (result.hexMatrix[r][c] || '').padEnd(3);
        const step = stepMap[r + ',' + c];
        line += step ? '[' + val + step + ']' : ' ' + val + '   ';
      }
      console.log(line);
    }
    console.log('');
    for (const s of result.steps) {
      const dirSymbol = { 'right':'→', 'left':'←', 'down':'↓', 'up':'↑', '':'' }[s.dir] || '';
      console.log('  第' + s.step + '步: ' + (s.step > 1 ? dirSymbol + ' ' : '') + '第' + (s.row+1) + '行第' + (s.col+1) + '列 [' + s.value + ']');
    }
    console.log('');
  } else {
    console.log('未找到能同时匹配所有目标的路径');
    for (const buf of [5, 6, 7, 8]) {
      const solutions = solveWuthering(result.matrix, result.targets, buf);
      if (solutions.length > 0) {
        const names = solutions[0].mi.map(i => '目标' + (i+1));
        console.log('  Buffer=' + buf + ': 匹配 ' + names.join(', '));
      }
    }
  }
  console.log('\n完成!');
}

// ====== HTTP 服务 ======
function startServer() {
  const http = require('http');
  const port = parseInt(process.env.PORT || '3000');
  const baseDir = __dirname;
  const mime = { 'html':'text/html', 'js':'application/javascript', 'css':'text/css', 'png':'image/png', 'json':'application/json', 'ico':'image/x-icon', 'svg':'image/svg+xml' };
  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/solve' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { image, crops } = JSON.parse(body);
          if (!image) { res.writeHead(400); res.end(JSON.stringify({ error: 'No image data' })); return; }
          const m = image.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
          if (!m) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid image' })); return; }
          const buf = Buffer.from(m[2], 'base64');
          const tmpFile = path.join(baseDir, '_tmp_upload.' + m[1]);
          fs.writeFileSync(tmpFile, buf);
          const result = await runPipeline(tmpFile, crops);
          try { fs.unlinkSync(tmpFile); } catch(e) {}
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(result));
        } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }
    const filePath = url === '/' ? '/index.html' : url;
    const fullPath = path.join(baseDir, filePath);
    // 防目录遍历
    if (!fullPath.startsWith(baseDir)) { res.writeHead(403); res.end('Forbidden'); return; }
    try {
      const data = fs.readFileSync(fullPath);
      const ext = path.extname(filePath).slice(1) || 'html';
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      res.end(data);
    } catch(e) { res.writeHead(404); res.end('Not Found'); }
  });
  server.listen(port, '0.0.0.0', () => {
    console.log('Optical Breacher Server running at:');
    console.log('  http://localhost:' + port + '/');
  });
}

// ====== 入口 ======
if (process.argv.includes('--serve')) {
  startServer();
} else {
  main().catch(e => console.error('错误:', e));
}
