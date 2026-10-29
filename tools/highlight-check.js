/**
 * 高亮自检 —— 用 VS Code 同款 TextMate 引擎跑一遍语法文件，
 * 看每个 token 到底被分到了哪个 scope。
 *
 *   node editors/vscode/tools/highlight-check.js         只报断言结果
 *   node editors/vscode/tools/highlight-check.js -v      额外打印逐 token 的 scope
 *
 * 依赖（不进 package.json，属于开发期工具）：
 *   npm install --no-save vscode-textmate vscode-oniguruma
 */

const fs = require('fs');
const path = require('path');
const onig = require('vscode-oniguruma');
const vsctm = require('vscode-textmate');

const GRAMMAR = path.join(__dirname, '..', 'syntaxes', 'yan.tmLanguage.json');
const WASM = path.join(__dirname, '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm');
const VERBOSE = process.argv.includes('-v');

// 一段把语言特性都覆盖到的样例
const SAMPLE = [
  '// 行注释',
  '/* 块注释 */',
  'constexpr SIZE: u16 = 8;',
  'fn pack(mode: u16, gain: u16) -> u16 {',
  '    let mut reg: u16 = 0xB1C8;',
  '    let flags = [true, false];',
  '    println("mode   = {}", reg[15:13]);',
  '    reg[12:8] = 0x5;',
  '    if (reg[15] == 1 && true) {',
  '        let f: f64 = 1.5e3;',
  '        return f as u8;',
  '    } else {',
  '        loop { break; }',
  '    }',
  '    for (i in 1..=SIZE) { reg[i] = 0; }',
  '    while (len(flags) > 0) { }',
  '    let _i32 = 0b1010;',
  '    struct Later {}',
  '}',
];

const EXPECT = [
  ['keyword.declaration.yan', ['constexpr', 'fn', 'let', 'mut', 'as']],
  ['keyword.control.yan', ['if', 'else', 'loop', 'break', 'for', 'in', 'while', 'return']],
  ['entity.name.function.yan', ['pack']],
  ['entity.name.constant.yan', ['SIZE']],
  ['storage.type.yan', ['u16', 'f64']],
  ['support.function.builtin.yan', ['println', 'len']],
  ['constant.language.yan', ['true', 'false']],
  ['constant.numeric.hex.yan', ['0xB1C8', '0x5']],
  ['constant.numeric.binary.yan', ['0b1010']],
  ['string.quoted.double.yan', ['"mode   = {}"']],
  ['comment.line.double-slash.yan', ['// 行注释']],
  ['comment.block.yan', ['/* 块注释 */']],
  ['keyword.other.reserved.yan', ['struct']],
];

(async () => {
  await onig.loadWASM(fs.readFileSync(WASM).buffer);

  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new onig.OnigScanner(patterns),
      createOnigString: (s) => new onig.OnigString(s),
    }),
    loadGrammar: async (scope) => (scope === 'source.yan'
      ? vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR, 'utf8'), GRAMMAR)
      : null),
  });

  const grammar = await registry.loadGrammar('source.yan');
  if (!grammar) {
    console.error('语法文件没能加载，检查 syntaxes/yan.tmLanguage.json');
    process.exit(1);
  }

  // 逐行 tokenize。注意 TextMate 会按 scope 变化把一段文本切开
  // （字符串的引号与内容是两个 token），所以断言按「子串命中」来判断
  const all = [];
  let ruleStack = vsctm.INITIAL;
  for (const line of SAMPLE) {
    const res = grammar.tokenizeLine(line, ruleStack);
    ruleStack = res.ruleStack;
    if (VERBOSE) {
      console.log(`  ${line}`);
    }
    for (const t of res.tokens) {
      const text = line.slice(t.startIndex, t.endIndex).trim();
      if (text === '') {
        continue;
      }
      all.push({ text, scopes: new Set(t.scopes) });
      if (VERBOSE) {
        console.log(`      ${JSON.stringify(text)} → ${t.scopes.join(' ')}`);
      }
    }
  }

  const hit = (scope, needle) => all.some(
    (t) => t.scopes.has(scope) && (t.text === needle || needle.includes(t.text)),
  );

  let fail = 0;
  console.log('== 高亮断言 ==');
  for (const [scope, needles] of EXPECT) {
    const missing = needles.filter((n) => !hit(scope, n));
    if (missing.length > 0) {
      fail++;
      console.log(`  [未命中] ${scope}  缺: ${missing.join(', ')}`);
    } else {
      console.log(`  ${scope}  ✓ ${needles.join(' ')}`);
    }
  }

  console.log(`\n共 ${EXPECT.length} 组断言，${fail === 0 ? '全部命中' : fail + ' 组未命中'}`);
  process.exit(fail === 0 ? 0 : 1);
})();
