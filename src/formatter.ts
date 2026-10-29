/**
 * Yan 格式化器 —— 基于 token 流的 pretty printer。
 *
 * 刻意**不做完整语法分析**：只认 token 与括号层级。好处是代码写了一半、
 * 语法还不成立的时候也能格式化（编辑器里这是常态），代价是它不会
 * 重排表达式结构 —— 这本来也不是格式化器该干的事。
 *
 * 定下的风格与 yan-lang/examples 下的验收程序一致：
 *   · K&R 花括号：`fn main() {`，`}` 独占一行
 *   · `} else {` / `} else if (cond) {` 不换行
 *   · 语句终结符 `;` 后换行；数组类型 `[i32; N]` 里的 `;` 不换行
 *   · `.` `::` 两侧紧贴（`p.x` / `d.0` / `Color::Red`），`=>` 两侧留空格
 *   · 泛型实参 `Vec<u8>` / `Result<i32, i32>` / `<'a>` 的尖括号紧贴
 *   · 相邻行的行尾注释对齐到同一列
 */

import { isBalanced, matchBrace, Tok, tokenize } from './lexer';

export interface FormatOptions {
  /** 一级缩进的字符串，'\t' 或若干个空格 */
  indentUnit: string;
  maxBlankLines: number;
  alignTrailingComments: boolean;
  maxColumn: number;
  keepSingleLineBlocks: boolean;
  /** 输出使用的换行符 */
  eol: string;
}

interface OutLine {
  indent: number;
  code: string;
  comment?: string;
  /** 原样输出，不加缩进（多行块注释） */
  raw?: boolean;
  /** 注释在源码里的起始列，用来沿用作者已有的对齐 */
  origCol?: number;
}

const CONTROL_BEFORE_PAREN = new Set(['if', 'while', 'for', 'match', 'comptime']);
const BINARY_OPS = new Set(['+', '-', '*', '/', '%', '=', '==', '!=', '<', '>', '<=', '>=',
  '&&', '||', '&', '|', '^', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '<<=', '>>=', '->', '=>', 'as']);
const UNARY_CANDIDATES = new Set(['-', '&', '+', '*']);
/** 这些 token 可以跟在刚写完的 `}` 后面（否则 `}` 必须先单独成行） */
const KEEP_ON_BRACE_LINE = new Set(['else', ';', '}', ')', ']', ',']);

/** 出现在这个集合之后，`-` `&` `+` `*` 是一元运算符而不是二元 */
function unaryPosition(prev2: string | null): boolean {
  return prev2 === null
    || prev2 === '(' || prev2 === '[' || prev2 === ','
    || prev2 === ';' || prev2 === ':' || prev2 === '!'
    || prev2 === '~' || prev2 === '&mut' || prev2 === 'return'
    || prev2 === 'in' || BINARY_OPS.has(prev2);
}

/** `Vec<T>` / `Option<T>` 的 `<`：前一个 token 是大写开头的类型名 */
function isTypeName(prev: string | null): boolean {
  return prev !== null && /^[A-Z][A-Za-z0-9_]*$/.test(prev);
}

/** 生命周期 `'a`（字符字面量 `'a'` 以引号结尾，不算） */
function isLifetime(text: string | null): boolean {
  return text !== null && text.startsWith("'") && !text.endsWith("'");
}

/** 两个相邻 token 之间要不要留一个空格 */
function gapBetween(
  prev: string | null,
  prev2: string | null,
  cur: string,
  bracket: number,
  angle: number = 0,
  next: string | null = null,
  genericClose: boolean = false,
): boolean {
  if (prev === null) {
    return false;
  }

  // 前面不留空格：闭合符号、分隔符与类型冒号
  if (cur === ',' || cur === ';' || cur === ')' || cur === ']' || cur === '}' || cur === ':') {
    return false;
  }

  // 开括号 / 一元前缀后面不留空格
  if (prev === '(' || prev === '[' || prev === '!' || prev === '~') {
    return false;
  }

  // `.` 是成员访问/元组下标：两侧都紧贴（`p.x` / `d.0`）
  if (cur === '.' || prev === '.') {
    return false;
  }

  // `::` 是路径分隔符：两侧都紧贴（`Color::Red` / `use calc::ops`）
  if (cur === '::' || prev === '::') {
    return false;
  }

  // 泛型实参的尖括号：`Vec<u8>` / `Result<i32, i32>` / `make<'a>`
  if (cur === '<' && (isTypeName(prev) || isLifetime(next))) {
    return false;
  }
  if (angle > 0 && (prev === '<' || prev === '>' || prev === '>>' || cur === '>' || cur === '>>')) {
    return false;
  }
  // `make<'a>(...)`：泛型右尖括号后面的 `(` 是参数表，不是调用
  if (cur === '(' && genericClose) {
    return false;
  }

  // `[` 有两种身份：紧贴的话是下标或位访问（`a[i]` `x[7:0]` `[[i32; 4]; 8]`），
  // 留空格的话是数组字面量（`= [1, 2]`）
  if (cur === '[') {
    return !(prev === '(' || prev === '[' || isOperandEnd(prev));
  }
  if (prev === '..' || prev === '..=' || cur === '..' || cur === '..=') {
    return false;
  }
  // 位切片 reg[7:0] 的冒号两侧都不留空格；类型标注 `x: i32` 则留一个
  if (prev === ':' && bracket > 0) {
    return false;
  }
  // `-1` `&x` 贴着操作数
  if (UNARY_CANDIDATES.has(prev) && unaryPosition(prev2)) {
    return false;
  }

  // `if (` `while (` `for (` `match (` `comptime if (` 前留空格；函数调用 `println(` 不留；
  // 其余（`, (` `= (` `| (`）留一个空格
  if (cur === '(') {
    if (CONTROL_BEFORE_PAREN.has(prev)) {
      return true;
    }
    return !isOperandEnd(prev);
  }

  return true;
}

/** 前一个 token 是不是一个完整的操作数结尾（决定后面的 `[` `(` 要不要贴上） */
function isOperandEnd(prev: string): boolean {
  return /[A-Za-z0-9_'"\]]$/.test(prev) || prev === ')';
}

/** 显示宽度：CJK 与全角标点按 2 列算，其余按 1 列 */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += isWide(c) ? 2 : 1;
  }
  return w;
}

function isWide(c: number): boolean {
  return (c >= 0x1100 && c <= 0x115f)
    || (c >= 0x2e80 && c <= 0xa4cf)
    || (c >= 0xac00 && c <= 0xd7a3)
    || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe6f)
    || (c >= 0xff00 && c <= 0xff60)
    || (c >= 0xffe0 && c <= 0xffe6)
    || (c >= 0x20000 && c <= 0x3fffd);
}

class Printer {
  private readonly toks: Tok[];
  private readonly opt: FormatOptions;
  private readonly out: OutLine[] = [];
  private parts: string[] = [];
  private comment: string | null = null;
  private indent = 0;
  /** 续行缩进：这一行是从 `(` / `[` 里面开始的，多缩一级（长调用拆行时不贴左边） */
  private contIndent = 0;
  private pendingBlank = 0;
  private bracket = 0;
  private paren = 0;
  /** 当前位于第几层泛型实参 `<...>` 里（`Vec<u8>` / `Result<i32, i32>`） */
  private angle = 0;
  private prev: Tok | null = null;
  private prev2: Tok | null = null;
  private justClosed = false;
  private justClosedGeneric = false;
  private semiPending = false;

  constructor(src: string, opt: FormatOptions) {
    this.toks = tokenize(src);
    this.opt = opt;
  }

  run(): string {
    let i = 0;
    while (i < this.toks.length) {
      const t = this.toks[i];
      const isComment = t.kind === 'comment-line' || t.kind === 'comment-block';
      // 源码里的换行要先记下来：连续两个以上换行折叠成一个空行
      const nl = this.prev ? t.line - this.prev.endLine : 0;

      // ★ `}` 写完先落行，再去记空行 —— 否则空行会跑到 `}` 前面去。
      //   只有紧跟在同一行的行尾注释（nl == 0）才允许挂到 `}` 后面。
      if (this.justClosed && (nl >= 1 || (!isComment && !KEEP_ON_BRACE_LINE.has(t.text)))) {
        this.flush();
      }
      // ★ `;` 写完先不落行：同一行还跟着注释的话要留给它挂上去，换行了就照常落行
      if (this.semiPending && (nl >= 1 || !isComment)) {
        this.flush();
      }
      if (!isComment || nl >= 1) {
        this.semiPending = false;
      }

      if (nl >= 2) {
        this.pendingBlank = Math.max(this.pendingBlank, Math.min(nl - 1, this.opt.maxBlankLines));
      }
      if (nl >= 1 && this.hasContent()) {
        this.flush();
      }

      // 这一行是从括号/下标里面续上的（长调用、长数组字面量）：多缩一级
      if (!this.hasContent()) {
        this.contIndent = this.paren > 0 || this.bracket > 0 ? 1 : 0;
      }

      if (isComment) {
        this.emitComment(t);
        i++;
        continue;
      }

      if (t.text === '{') {
        i = this.openBrace(t, i);
      } else if (t.text === '}') {
        this.closeBrace(t);
        i++;
      } else if (t.text === ';') {
        this.push(t, this.toks[i + 1] ?? null);
        if (this.bracket === 0 && this.paren === 0) {
          this.semiPending = true; // 真正的换行交给下一个 token 决定
        }
        i++;
      } else {
        this.push(t, this.toks[i + 1] ?? null);
        if (t.text === '[') {
          this.bracket++;
        } else if (t.text === ']') {
          this.bracket = Math.max(0, this.bracket - 1);
        } else if (t.text === '(') {
          this.paren++;
        } else if (t.text === ')') {
          this.paren = Math.max(0, this.paren - 1);
        }
        i++;
      }
    }

    this.flush();
    return this.render();
  }

  // ---------------------------------------------------------------- 花括号

  private openBrace(t: Tok, i: number): number {
    if (this.opt.keepSingleLineBlocks) {
      const close = matchBrace(this.toks, i);
      if (close > i && this.toks[close].endLine === this.toks[i].line) {
        this.push(this.synthetic(this.inlineBlock(i, close), t));
        this.prev2 = this.prev;
        this.prev = this.toks[close];
        this.justClosed = true;
        return close + 1;
      }
    }

    if (!this.hasContent()) {
      // 源码里 `{` 独占一行（Allman 风格）：把它挂回上一行末尾
      const last = this.out.length > 0 ? this.out[this.out.length - 1] : null;
      if (last && last.code !== '' && !last.raw) {
        last.code += ' {';
      } else {
        this.parts.push('{');
      }
    } else {
      this.parts.push(' {');
    }

    this.flush();
    this.indent++;
    this.prev = t;
    this.prev2 = i > 0 ? this.toks[i - 1] : null;
    return i + 1;
  }

  private closeBrace(t: Tok): void {
    if (this.hasContent()) {
      this.flush();
    } else {
      this.pendingBlank = 0; // `}` 前不留空行
    }
    this.indent = Math.max(0, this.indent - 1);
    this.parts.push('}');
    this.justClosed = true;
    this.prev2 = this.prev;
    this.prev = t;
  }

  /** 把 `{ ... }` 之间的 token 摊成一行 */
  private inlineBlock(open: number, close: number): string {
    let s = '{';
    let p: string | null = null;
    let p2: string | null = null;
    let angle = this.angle;
    let closedGeneric = false;
    for (let k = open + 1; k < close; k++) {
      const text = this.toks[k].text;
      const next = k + 1 < close ? this.toks[k + 1].text : null;
      s += (p === null ? ' ' : gapBetween(p, p2, text, this.bracket, angle, next, closedGeneric) ? ' ' : '') + text;
      if (text === '<' && (isTypeName(p) || isLifetime(next))) {
        angle++;
        closedGeneric = false;
      } else if (text === '>') {
        if (angle > 0) {
          angle--;
          closedGeneric = true;
        }
      } else if (text === '>>') {
        if (angle > 0) {
          angle = Math.max(0, angle - 2);
          closedGeneric = true;
        }
      } else {
        closedGeneric = false;
      }
      p2 = p;
      p = text;
    }
    return s + ' }';
  }

  // ---------------------------------------------------------------- 输出

  private synthetic(text: string, like: Tok): Tok {
    return {
      kind: 'op',
      text,
      start: like.start,
      end: like.end,
      line: like.line,
      endLine: like.endLine,
      col: like.col,
    };
  }

  private hasContent(): boolean {
    return this.parts.length > 0 || this.comment !== null;
  }

  private push(t: Tok, next: Tok | null = null): void {
    const prevText = this.prev ? this.prev.text : null;
    if (this.parts.length === 0) {
      this.parts.push(t.text);
    } else {
      const need = t.text === 'else'
        ? true
        : gapBetween(prevText, this.prev2 ? this.prev2.text : null,
          t.text, this.bracket, this.angle, next ? next.text : null, this.justClosedGeneric);
      this.parts.push((need ? ' ' : '') + t.text);
    }

    // 泛型尖括号深度：只在 `<` 前面是大写类型名（或后面是生命周期）时才算泛型，
    // 否则 `a < b` 的比较会被误判成类型实参。
    if (t.text === '<' && (isTypeName(prevText) || isLifetime(next ? next.text : null))) {
      this.angle++;
      this.justClosedGeneric = false;
    } else if (t.text === '>') {
      if (this.angle > 0) {
        this.angle--;
        this.justClosedGeneric = true;
      }
    } else if (t.text === '>>') {
      if (this.angle > 0) {
        this.angle = Math.max(0, this.angle - 2);
        this.justClosedGeneric = true;
      }
    } else {
      this.justClosedGeneric = false;
    }

    this.prev2 = this.prev;
    this.prev = t;
    this.justClosed = false;
  }

  private flush(): void {
    if (!this.hasContent()) {
      return;
    }
    this.emitBlanks();
    this.out.push({
      indent: this.indent + this.contIndent,
      code: this.parts.join(''),
      comment: this.comment ?? undefined,
    });
    this.parts = [];
    this.comment = null;
    this.justClosed = false;
    this.justClosedGeneric = false;
    this.semiPending = false;
  }

  private emitBlanks(): void {
    if (this.pendingBlank > 0 && this.out.length > 0) {
      for (let k = 0; k < this.pendingBlank; k++) {
        this.out.push({ indent: 0, code: '' });
      }
    }
    this.pendingBlank = 0;
  }

  private emitComment(t: Tok): void {
    if (t.kind === 'comment-block' && t.text.includes('\n')) {
      if (this.hasContent()) {
        this.flush();
      }
      this.emitBlanks();
      for (const raw of t.text.split('\n')) {
        this.out.push({ indent: 0, code: raw.replace(/^[ \t]+/, ''), raw: true });
      }
    } else if (this.parts.length > 0) {
      // 挂在当前行尾（`}` 后面紧跟的注释也属于这一行）
      this.comment = t.text;
      this.flush();
      this.out[this.out.length - 1].origCol = t.col;
    } else {
      this.emitBlanks();
      this.out.push({ indent: this.indent + this.contIndent, code: '', comment: t.text, origCol: t.col });
    }
    this.prev2 = this.prev;
    this.prev = t;
  }

  private render(): string {
    const unit = this.opt.indentUnit;
    const built: string[] = [];
    const groups: number[][] = [];
    let curGroup: number[] | null = null;

    this.out.forEach((ln) => {
      if (ln.raw) {
        built.push(ln.code);
        curGroup = null;
        return;
      }
      const ind = unit.repeat(ln.indent);

      if (ln.code === '' && ln.comment === undefined) {
        built.push(''); // 空行
        curGroup = null;
        return;
      }
      if (ln.code === '') {
        built.push(ind + ln.comment); // 独占一行的注释
        curGroup = null;
        return;
      }
      if (ln.comment === undefined) {
        built.push(ind + ln.code);
        curGroup = null;
        return;
      }

      // 有行尾注释：纳入对齐组，稍后回填
      if (!curGroup) {
        curGroup = [];
        groups.push(curGroup);
      }
      curGroup.push(built.length);
      built.push('');
    });

    for (const items of groups) {
      const codes = items.map((idx) => unit.repeat(this.out[idx].indent) + this.out[idx].code);
      const widths = codes.map((c) => dispWidth(c));
      const natural = Math.max(...widths) + 1;

      // 作者原本就把这组注释对齐在同一列（允许 1 列误差）时沿用那一列，
      // 免得格式化把人家手工排好的注释推歪 —— 除非那一列已经放不下代码了
      const origCols = items.map((idx) => this.out[idx].origCol ?? 0);
      const wasAligned = Math.max(...origCols) - Math.min(...origCols) <= 1;
      const target = wasAligned ? Math.max(natural, Math.max(...origCols)) : natural;
      const fits = items.every((idx) =>
        target + dispWidth(this.out[idx].comment!) <= this.opt.maxColumn);

      items.forEach((idx, k) => {
        const cmt = this.out[idx].comment!;
        if (!this.opt.alignTrailingComments || !fits) {
          built[idx] = codes[k] + ' ' + cmt;
        } else {
          const pad = Math.max(1, target - widths[k]);
          built[idx] = codes[k] + ' '.repeat(pad) + cmt;
        }
      });
    }

    const lines = built.map((s) => s.replace(/[ \t]+$/, ''));
    while (lines.length > 1 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.join(this.opt.eol) + this.opt.eol;
  }
}

/** 格式化一整份源码。 */
export function formatYan(src: string, opt: FormatOptions): string {
  return new Printer(src, opt).run();
}

/** 选区能否单独格式化（括号配平才行，否则调用方应退回整份文档）。 */
export function canFormatFragment(src: string): boolean {
  return isBalanced(tokenize(src));
}

/** 所有非空行前导空白的最长公共前缀 —— 选区格式化时先剥掉、格式化后再补回。 */
export function commonIndent(text: string): string {
  const lines = text.split(/\r?\n/);
  let prefix: string | null = null;
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    const m = /^[ \t]*/.exec(line);
    const lead = m ? m[0] : '';
    if (prefix === null) {
      prefix = lead;
    } else {
      let k = 0;
      while (k < prefix.length && k < lead.length && prefix[k] === lead[k]) {
        k++;
      }
      prefix = prefix.slice(0, k);
    }
  }
  return prefix ?? '';
}
