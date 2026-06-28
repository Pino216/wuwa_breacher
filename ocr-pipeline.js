/**
 * Optical Breacher — OCR 管线核心代码
 * 
 * 流程：
 * 1. 接收裁剪后的矩阵区图片和目标区图片（PNG）
 * 2. Tesseract.js OCR 识别
 * 3. 文本清洗 → 映射为 byte 键
 * 4. 矩阵行/列对齐 + 目标序列提取
 * 
 * 问题：调试图显示完整 5×5 矩阵，但 OCR 输出只有 4 行，首行丢失
 */

// ====== 配置 ======

// byte 映射表：单字符键 → 完整 hex 值
const BYTE_MAP = {
  '1': '1C',
  '5': '55',
  '7': '7A',
  'B': 'BD',
  'E': 'E9',
  'F': 'FF',
}
const VALID_BYTES = ['1C', '55', '7A', 'BD', 'E9', 'FF']
const CHAR_MAP = { '1':'1', '5':'5', '7':'7', 'B':'B', 'E':'E', 'F':'F' }
const CHAR_FIX = { 'I':'1', 'L':'1', 'S':'5', 'G':'5', 'O':'0', '0':'B', '8':'B', '3':'B', '€':'E' }

function levenshtein(a, b) {
  const m = []; for (let i = 0; i <= a.length; i++) { m[i] = [i]; for (let j = 1; j <= b.length; j++) m[i][j] = i === 0 ? j : 0; }
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    m[i][j] = b[j-1] === a[i-1] ? m[i-1][j-1] : Math.min(m[i-1][j-1]+1, m[i][j-1]+1, m[i-1][j]+1);
  return m[a.length][b.length];
}

function cleanToken(t) {
  let s = t.trim().toUpperCase()
  if (BYTE_MAP[s]) return s
  if (CHAR_MAP[s]) return s
  const KNOWN = { 'AD':'1', 'IC':'1', 'LC':'1', 'LE':'1', 'TA':'7', '3D':'B', '8D':'B', 'DB':'B', 'BB':'B', '21D':'B', '2D':'B', 'E€':'E', 'FFE':'F', 'Ff':'F' }
  if (KNOWN[s]) return KNOWN[s]
  s = s.split('').map(c => CHAR_FIX[c] || c).join('')
  if (BYTE_MAP[s]) return s
  if (CHAR_MAP[s]) return s
  if (s.length === 2) {
    const c0 = CHAR_MAP[s[0]] || CHAR_FIX[s[0]] || s[0]
    const c1 = CHAR_MAP[s[1]] || CHAR_FIX[s[1]] || s[1]
    if (BYTE_MAP[c0 + c1]) return c0
  }
  let best = null, minD = 99
  for (const v of VALID_BYTES) { const d = levenshtein(s, v); if (d < minD) { minD = d; best = v; } }
  if (minD <= 1 && best) return best[0]
  const first = s[0]
  if (BYTE_MAP[first]) return first
  return null
}

// ====== OCR 识别 + 文本行清洗 ======

async function ocrImage(worker, imgPath) {
  // Tesseract.js 识别
  const ret = await worker.recognize(imgPath)
  const text = ret.data.text.trim()
  const lines = text.split('\n').filter(l => l.trim())

  const result = []
  for (const line of lines) {
    // 按空白/分隔符拆分 token
    const tokens = line.trim().split(/[\s|_()\u201c\u201d\u2018\u2019`'";:!?\[\]{}]+/).filter(t => t.length > 0)
    // 每个 token 过清洗 → 去无效
    const row = tokens.map(cleanToken).filter(t => t !== null)
    if (row.length > 0) result.push(row)
  }
  return result
}

// ====== OCR Worker 创建与配置 ======

async function createOcrWorker() {
  const Tesseract = require('tesseract.js')
  const worker = await Tesseract.createWorker('eng', 1)
  // SINGLE_BLOCK (6): 整块多行文本，适合网格布局
  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
  })
  return worker
}

// ====== 矩阵行对齐 ======

function alignMatrixRows(matrixRows) {
  // 过滤：只保留每行 3~9 个 token 的（矩阵列数范围 4~7）
  let validRows = matrixRows.filter(r => r.length >= 3 && r.length <= 9)

  // 如果太严格，放宽到 2 列以上
  if (validRows.length < 2 && matrixRows.some(r => r.length >= 2)) {
    validRows = matrixRows.filter(r => r.length >= 2 && r.length <= 10)
  }

  if (validRows.length < 2) return { matrix: [], cols: 0 }

  // 统计每行的列数，取众数作为期望列数
  const colLengths = {}
  for (const row of validRows) {
    colLengths[row.length] = (colLengths[row.length] || 0) + 1
  }
  const sorted = Object.entries(colLengths)
    .sort((a, b) => b[1] - a[1] || (parseInt(b[0]) - parseInt(a[0])))
  const mostCommonLen = parseInt(sorted[0][0])

  // 对齐：列数不对的行尝试修复
  const fixedRows = []
  for (const row of validRows) {
    if (row.length === mostCommonLen) {
      fixedRows.push(row)
    } else if (row.length > mostCommonLen) {
      // 多余 token 从尾部丢弃（通常是噪音）
      while (row.length > mostCommonLen) row.pop()
      if (row.length === mostCommonLen) fixedRows.push(row)
    }
    // 行数不足的直接丢弃
  }

  return {
    matrix: fixedRows.length >= 2 ? fixedRows : validRows.filter(r => r.length === mostCommonLen),
    cols: mostCommonLen,
  }
}

// ====== 目标行提取 ======

function extractTargets(targetRows) {
  return targetRows
    .filter(r => r.length >= 2 && r.length <= 6)
    .slice(0, 6)
}

// ====== 完整 OCR 管线 ======

async function runOcrPipeline(matrixImagePath, targetsImagePath) {
  const worker = await createOcrWorker()

  // 分别识别矩阵区和目标区
  const matrixRows = await ocrImage(worker, matrixImagePath)
  const targetRows = await ocrImage(worker, targetsImagePath)

  await worker.terminate()

  // 解析
  const { matrix, cols } = alignMatrixRows(matrixRows)
  const targets = extractTargets(targetRows)

  return {
    matrix,        // string[][] — ex: [['1','B','7','F'], ...]
    cols,          // number — 矩阵列数
    targets,       // string[][] — ex: [['7','B','5'], ['B','1','F','7','B']]
    rawMatrixText: matrixRows,  // OCR 原始行（调试用）
    rawTargetText: targetRows,  // OCR 原始行（调试用）
  }
}

module.exports = { runOcrPipeline, cleanToken, alignMatrixRows, BYTE_MAP, VALID_BYTES, levenshtein }
