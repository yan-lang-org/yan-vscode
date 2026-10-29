/**
 * 高亮自检 —— 用 VS Code 同款 TextMate 引擎跑一遍语法文件，
 * 看每个 token 到底被分到了哪个 scope。
 *
 *   node tools/highlight-check.js         只报断言结果
 *   node tools/highlight-check.js -v      额外打印逐 token 的 scope
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

// 一段把语言特性都覆盖到的样例（对照 docs/SPEC.md，yan 0.11）
const SAMPLE = [
  '// 行注释',
  '/* 块注释 /* 嵌套一层 */ 回到外层 */',
  'use calc::ops;',
  'comptime SIZE: usize = 8;',
  "struct Point<'a> { p: &'a i32, tag: char }",
  'enum Shape { Dot, Circle(i32) }',
  "fn pack<'a>(mode: u16, gain: u16) -> (u16, u16) {",
  '    let mut reg: u16 = 0xB1C8;',
  "    let c: char = '\\u{4E2D}';",
  '    let t = (mode, gain);',
  '    let v: Vec<u8> = Vec::new();',
  '    let o: Option<i32> = Some(1);',
  '    let n: Option<i32> = None;',
  '    match (o) {',
  '        Option::Some(x) => { println("{}", x); }',
  '        Option::None => { }',
  '    }',
  '    reg[12:8] = 0x5;',
  '    for (i in 1..=SIZE) { reg[i] = 0; }',
  '    while (len(a) > 0) { break; }',
  '    comptime if (true) { } else { }',
  '    defer v.drop();',
  '    let b = mode as u8;',
  '    return 0;',
  '}',
];

const EXPECT = [
  ['keyword.declaration.yan', ['comptime', 'fn', 'let', 'mut', 'as', 'struct', 'enum']],
  ['keyword.control.yan', ['if', 'else', 'match', 'for', 'in', 'while', 'break', 'defer', 'return']],
  ['keyword.control.import.yan', ['use']],
  ['entity.name.function.yan', ['pack']],
  ['entity.name.constant.yan', ['SIZE']],
  ['entity.name.type.yan', ['Point', 'Shape']],
  ['entity.name.namespace.yan', ['calc::ops']],
  ['storage.modifier.lifetime.yan', ["'a"]],
  ['storage.type.yan', ['u16', 'usize', 'char', 'i32', 'u8']],
  ['support.type.yan', ['Vec', 'Option']],
  ['support.function.builtin.yan', ['println', 'len']],
  ['constant.language.yan', ['true']],
  ['support.constant.yan', ['Some']],
  ['constant.numeric.hex.yan', ['0xB1C8', '0x5']],
  ['string.quoted.double.yan', ['"{}"']],
  ['string.quoted.single.char.yan', ["'\\u{4E2D}'"]],
  ['comment.line.double-slash.yan', ['// 行注释']],
  ['comment.block.yan', ['块注释', '嵌套一层']],
  ['keyword.operator.fat-arrow.yan', ['=>']],
  ['keyword.operator.range.yan', ['..=']],
  ['punctuation.accessor.double-colon.yan', ['::Some']],
  ['variable.other.enummember.yan', ['Some']],
];

(async () => {
  const wasm = fs.readFileSync(WASM);
  await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

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
