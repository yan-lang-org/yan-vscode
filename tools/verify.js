/**
 * 格式化器自检脚本（不需要 VS Code，node 直接跑）
 *
 *   node editors/vscode/tools/verify.js         只查幂等性 + 打印 examples 的差异
 *   node editors/vscode/tools/verify.js --full  额外把格式化后的代码交给 yanc 编译运行，
 *                                               与格式化前的输出逐字比对
 *
 * 两条判据：
 *   1. 幂等   format(format(x)) === format(x)
 *   2. 不改语义 格式化前 / 后，`yanc run` 的输出必须完全一致
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { formatYan } = require('../dist/formatter.js');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // → 仓库根
const PY = process.env.YAN_PY
  || 'C:/Users/bette/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const FULL = process.argv.includes('--full');

const BASE = {
  indentUnit: '    ',
  maxBlankLines: 1,
  alignTrailingComments: true,
  maxColumn: 100,
  eol: '\n',
};
// 两组开关都要幂等：单行块保留 / 展开
const OPT_SETS = [
  { ...BASE, keepSingleLineBlocks: true },
  { ...BASE, keepSingleLineBlocks: false },
];
const OPT = OPT_SETS[0];

function list(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) {
    return [];
  }
  return fs.readdirSync(abs).filter((f) => f.endsWith('.yan')).map((f) => path.join(dir, f));
}

const files = [
  ...list('examples'),
  ...list(path.join('tests', 'cases')),
  ...list(path.join('tests', 'errors')),
];

function norm(s) {
  return s.replace(/\r/g, '');
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function yan(args) {
  try {
    const out = execFileSync(PY, ['yan.py', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: norm(out) };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: norm((e.stdout || '') + (e.stderr || '')) };
  }
}

let bad = 0;

// ------------------------------------------------- 0. token 一个都不能少
// 格式化只改空白，不该改内容：把格式化前后各自 tokenize，文本序列必须逐字相同
console.log('== token 不丢失 ==');
{
  const { tokenize } = require('../dist/lexer.js');
  let lost = 0;
  for (const rel of files) {
    const before = tokenize(read(rel)).map((t) => t.text).join('');
    const after = tokenize(formatYan(read(rel), OPT)).map((t) => t.text).join('');
    if (before !== after) {
      lost++;
      bad++;
      console.log(`  [丢 token] ${rel}`);
    }
  }
  console.log(`  ${files.length} 个文件，${lost === 0 ? '内容全部保留' : lost + ' 个有出入'}`);
}

// ------------------------------------------------- 0b. 残缺代码不许崩
const EDGE = [
  ['空文件', ''],
  ['只有空行', '\n\n\n'],
  ['只有注释', '// a\n// b\n'],
  ['未闭合花括号', 'fn main() {\n    let x = 1;\n'],
  ['多余的右括号', '}\n}\n'],
  ['未闭合字符串', 'fn main() {\n    println("abc\n}\n'],
  ['未闭合块注释', '/* abc\nfn main() {\n'],
  ['一行写完整个函数', 'fn main() { println("hi"); }'],
  ['空块', 'fn main() {\n}\n'],
  ['嵌套三层', 'fn main() {\nif (a) {\nif (b) {\nx;\n}\n}\n}\n'],
  ['全是运算符', '+ - * / % & | ^ ~ ! << >>\n'],
  ['CRLF', 'fn main() {\r\n    let x = 1;\r\n}\r\n'],
];
console.log('== 残缺代码 ==');
{
  let n = 0;
  for (const [name, src] of EDGE) {
    try {
      const once = formatYan(src, OPT);
      const twice = formatYan(once, OPT);
      if (once !== twice) {
        n++;
        bad++;
        console.log(`  [不幂等] ${name}`);
      }
    } catch (e) {
      n++;
      bad++;
      console.log(`  [抛异常] ${name}: ${e.message}`);
    }
  }
  console.log(`  ${EDGE.length} 个用例，${n === 0 ? '全部不崩且幂等' : n + ' 个有问题'}`);
}

// ---------------------------------------------------------------- 1. 幂等
console.log('== 幂等性 ==');
for (const opt of OPT_SETS) {
  let n = 0;
  for (const rel of files) {
    const once = formatYan(read(rel), opt);
    if (once !== formatYan(once, opt)) {
      n++;
      bad++;
      console.log(`  [不幂等] ${rel}  (keepSingleLineBlocks=${opt.keepSingleLineBlocks})`);
    }
  }
  console.log(`  keepSingleLineBlocks=${opt.keepSingleLineBlocks}: `
    + `${files.length} 个文件，${n === 0 ? '全部幂等' : n + ' 个不幂等'}`);
}

// ---------------------------------------------------------------- 2. 语义不变
if (FULL) {
  // 固定用一个临时文件反复覆盖；落在系统 temp 里，不污染仓库
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-fmt-'));
  const dest = path.join(tmp, 'case.yan');
  console.log('== 格式化后仍编译/运行一致 ==');
  let diff = 0;
  for (const rel of files) {
    const src = read(rel);
    const formatted = formatYan(src, OPT);
    fs.writeFileSync(dest, formatted);

    const isError = rel.includes('errors');
    const cmd = isError ? 'check' : 'run';
    const before = yan([cmd, rel]).out;
    const after = yan([cmd, dest]).out;

    let ok;
    if (isError) {
      // 行号会变，只比错误码集合
      const codes = (s) => (s.match(/error\[E\d+\]/g) || []).sort().join(',');
      ok = codes(before) === codes(after) && before !== '';
    } else {
      ok = before === after;
    }
    if (!ok) {
      diff++;
      bad++;
      console.log(`  [不一致] ${rel}`);
      console.log(`    前: ${JSON.stringify(before.slice(0, 200))}`);
      console.log(`    后: ${JSON.stringify(after.slice(0, 200))}`);
    }
  }
  console.log(`  ${files.length} 个文件，${diff === 0 ? '输出全部一致' : diff + ' 个不一致'}`);
  try {
    fs.unlinkSync(dest);
    fs.rmdirSync(tmp);
  } catch {
    // 清理失败不影响结论
  }
}

process.exit(bad === 0 ? 0 : 1);
