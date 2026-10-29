/**
 * 格式化器自检脚本（不需要 VS Code，node 直接跑）
 *
 *   node tools/verify.js               幂等性 / token 不丢失 / 残缺代码不崩
 *   node tools/verify.js --full        再把格式化后的代码交给编译器 check + run，
 *                                      与格式化前的输出逐字比对
 *
 * 编译器位置（按优先级）：
 *   --yan-home=<dir>  命令行参数
 *   YAN_HOME          环境变量
 *   ../yan-lang       与扩展仓并列的公开仓（yan-lang 里有 bin/yan.exe 与 examples/）
 *
 * 两条判据：
 *   1. 幂等   format(format(x)) === format(x)
 *   2. 不改语义 格式化前 / 后，编译器 check / run 的输出必须完全一致
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { formatYan } = require('../dist/formatter.js');

const ROOT = path.resolve(__dirname, '..'); // → 扩展仓根
const FULL = process.argv.includes('--full');

const YAN_HOME = (() => {
  const arg = process.argv.find((a) => a.startsWith('--yan-home='));
  if (arg) {
    return path.resolve(arg.slice('--yan-home='.length));
  }
  return path.resolve(process.env.YAN_HOME || path.join(ROOT, '..', 'yan-lang'));
})();

const YAN = path.join(YAN_HOME, 'bin', 'yan.exe');

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

/** 默认只跑公开仓 examples/；也可以用 YAN_FILES 指定（分隔符 ; 或 ,） */
function collectFiles() {
  const env = process.env.YAN_FILES;
  if (env) {
    return env.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  }
  const dir = path.join(YAN_HOME, 'examples');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir).filter((f) => f.endsWith('.yan')).map((f) => path.join(dir, f));
}

const files = collectFiles();

function norm(s) {
  return s.replace(/\r/g, '');
}

function read(abs) {
  return fs.readFileSync(abs, 'utf8');
}

function yan(args, cwd = YAN_HOME) {
  try {
    const out = execFileSync(YAN, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: norm(out) };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: norm((e.stdout || '') + (e.stderr || '')) };
  }
}

if (files.length === 0) {
  console.error(`找不到 .yan 用例：${path.join(YAN_HOME, 'examples')}`);
  console.error('用 --yan-home=<编译器仓> 或 YAN_FILES=<file;file> 指定。');
  process.exit(2);
}

let bad = 0;

// ------------------------------------------------- 0. token 一个都不能少
// 格式化只改空白，不该改内容：把格式化前后各自 tokenize，文本序列必须逐字相同
console.log('== token 不丢失 ==');
{
  const { tokenize } = require('../dist/lexer.js');
  let lost = 0;
  for (const file of files) {
    const before = tokenize(read(file)).map((t) => t.text).join('');
    const after = tokenize(formatYan(read(file), OPT)).map((t) => t.text).join('');
    if (before !== after) {
      lost++;
      bad++;
      console.log(`  [丢 token] ${path.basename(file)}`);
    }
  }
  console.log(`  ${files.length} 个文件，${lost === 0 ? '内容全部保留' : lost + ' 个有出入'}`);
}

// ------------------------------------------------- 0b. 残缺代码不许崩
const EDGE = [
  ['空文件', ''],
  ['只有空行', '\n\n\n'],
  ['只有注释', '// a\n// b\n'],
  ['嵌套块注释', '/* a /* b */ c */\nfn main() { }\n'],
  ['未闭合花括号', 'fn main() {\n    let x = 1;\n'],
  ['多余的右括号', '}\n}\n'],
  ['未闭合字符串', 'fn main() {\n    println("abc\n}\n'],
  ['未闭合块注释', '/* abc\nfn main() {\n'],
  ['未闭合字符', "let c: char = 'a\n"],
  ['字符与生命周期', "fn f<'a>(x: &'a i32) -> char { 'x' }\n"],
  ['一行写完整个函数', 'fn main() { println("hi"); }'],
  ['空块', 'fn main() {\n}\n'],
  ['嵌套三层', 'fn main() {\nif (a) {\nif (b) {\nx;\n}\n}\n}\n'],
  ['全是运算符', '+ - * / % & | ^ ~ ! << >> :: => -> .. ..=\n'],
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
  for (const file of files) {
    const once = formatYan(read(file), opt);
    if (once !== formatYan(once, opt)) {
      n++;
      bad++;
      console.log(`  [不幂等] ${path.basename(file)}  (keepSingleLineBlocks=${opt.keepSingleLineBlocks})`);
    }
  }
  console.log(`  keepSingleLineBlocks=${opt.keepSingleLineBlocks}: `
    + `${files.length} 个文件，${n === 0 ? '全部幂等' : n + ' 个不幂等'}`);
}

// ---------------------------------------------------------------- 2. 语义不变
if (FULL) {
  if (!fs.existsSync(YAN)) {
    console.log(`== 格式化后仍编译/运行一致 ==\n  跳过：找不到 ${YAN}`);
  } else {
    // 固定用一个临时文件反复覆盖；落在系统 temp 里，不污染仓库
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-fmt-'));
    console.log('== 格式化后仍编译/运行一致 ==');
    let diff = 0;
    for (const file of files) {
      const src = read(file);
      const formatted = formatYan(src, OPT);
      const dest = path.join(tmp, path.basename(file));
      fs.writeFileSync(dest, formatted);

      const beforeCheck = yan(['check', file]);
      const afterCheck = yan(['check', dest]);

      // 报错信息里带路径，行号会变 ⇒ 抹掉路径，只比是否通过 + 错误码集合
      const clean = (s) => s.replace(/\r/g, '')
        .replace(/[^\s:]*[\\/][^\s:]+\.yan/g, '<FILE>');
      const codes = (s) => (s.match(/error\[E\d+\]/g) || []).sort().join(',');

      let ok = beforeCheck.code === afterCheck.code
        && codes(clean(beforeCheck.out)) === codes(clean(afterCheck.out));

      // check 通过才跑程序；程序输出必须逐字相同（构建提示里的 exe 名抹掉）
      if (ok && beforeCheck.code === 0) {
        const strip = (s) => clean(s).replace(/build[\\/][^\s（]+\.exe/g, '<EXE>');
        const beforeRun = yan(['run', file]);
        const afterRun = yan(['run', dest]);
        ok = beforeRun.code === afterRun.code && strip(beforeRun.out) === strip(afterRun.out);
      }

      if (!ok) {
        diff++;
        bad++;
        console.log(`  [不一致] ${path.basename(file)}`);
        console.log(`    前: ${JSON.stringify(clean(beforeCheck.out).slice(0, 200))}`);
        console.log(`    后: ${JSON.stringify(clean(afterCheck.out).slice(0, 200))}`);
      }
    }
    console.log(`  ${files.length} 个文件，${diff === 0 ? '输出全部一致' : diff + ' 个不一致'}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

process.exit(bad === 0 ? 0 : 1);
