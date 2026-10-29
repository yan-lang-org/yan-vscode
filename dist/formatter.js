"use strict";
/**
 * Yan 格式化器 —— 基于 token 流的 pretty printer。
 *
 * 刻意**不做完整语法分析**：只认 token 与括号层级。好处是代码写了一半、
 * 语法还不成立的时候也能格式化（编辑器里这是常态），代价是它不会
 * 重排表达式结构 —— 这本来也不是格式化器该干的事。
 *
 * 定下的风格与 examples/ 下的 9 个验收程序一致：
 *   · K&R 花括号：`fn main() {`，`}` 独占一行
 *   · `} else {` / `} else if (cond) {` 不换行
 *   · 语句终结符 `;` 后换行；数组类型 `[i32; N]` 里的 `;` 不换行
 *   · 相邻行的行尾注释对齐到同一列
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatYan = formatYan;
exports.canFormatFragment = canFormatFragment;
exports.commonIndent = commonIndent;
const lexer_1 = require("./lexer");
const CONTROL_BEFORE_PAREN = new Set(['if', 'while', 'for', 'constexpr']);
const BINARY_OPS = new Set(['+', '-', '*', '/', '%', '=', '==', '!=', '<', '>', '<=', '>=',
    '&&', '||', '&', '|', '^', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
    '<<=', '>>=', '->', 'as']);
const UNARY_CANDIDATES = new Set(['-', '&', '+', '*']);
/** 这些 token 可以跟在刚写完的 `}` 后面（否则 `}` 必须先单独成行） */
const KEEP_ON_BRACE_LINE = new Set(['else', ';', '}', ')', ']', ',']);
/** 出现在这个集合之后，`-` `&` `+` `*` 是一元运算符而不是二元 */
function unaryPosition(prev2) {
    return prev2 === null
        || prev2 === '(' || prev2 === '[' || prev2 === ','
        || prev2 === ';' || prev2 === ':' || prev2 === '!'
        || prev2 === '~' || prev2 === '&mut' || prev2 === 'return'
        || prev2 === 'in' || BINARY_OPS.has(prev2);
}
/** 两个相邻 token 之间要不要留一个空格 */
function gapBetween(prev, prev2, cur, bracket) {
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
    // `if (` `while (` `for (` `constexpr if (` 前留空格；函数调用 `println(` 不留；
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
function isOperandEnd(prev) {
    return /[A-Za-z0-9_]$/.test(prev) || prev === ')' || prev === ']';
}
/** 显示宽度：CJK 与全角标点按 2 列算，其余按 1 列 */
function dispWidth(s) {
    let w = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0);
        w += isWide(c) ? 2 : 1;
    }
    return w;
}
function isWide(c) {
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
    constructor(src, opt) {
        this.out = [];
        this.parts = [];
        this.comment = null;
        this.indent = 0;
        this.pendingBlank = 0;
        this.bracket = 0;
        this.paren = 0;
        this.prev = null;
        this.prev2 = null;
        this.justClosed = false;
        this.semiPending = false;
        this.toks = (0, lexer_1.tokenize)(src);
        this.opt = opt;
    }
    run() {
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
            if (isComment) {
                this.emitComment(t);
                i++;
                continue;
            }
            if (t.text === '{') {
                i = this.openBrace(t, i);
            }
            else if (t.text === '}') {
                this.closeBrace(t);
                i++;
            }
            else if (t.text === ';') {
                this.push(t);
                if (this.bracket === 0 && this.paren === 0) {
                    this.semiPending = true; // 真正的换行交给下一个 token 决定
                }
                i++;
            }
            else {
                this.push(t);
                if (t.text === '[') {
                    this.bracket++;
                }
                else if (t.text === ']') {
                    this.bracket = Math.max(0, this.bracket - 1);
                }
                else if (t.text === '(') {
                    this.paren++;
                }
                else if (t.text === ')') {
                    this.paren = Math.max(0, this.paren - 1);
                }
                i++;
            }
        }
        this.flush();
        return this.render();
    }
    // ---------------------------------------------------------------- 花括号
    openBrace(t, i) {
        if (this.opt.keepSingleLineBlocks) {
            const close = (0, lexer_1.matchBrace)(this.toks, i);
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
            }
            else {
                this.parts.push('{');
            }
        }
        else {
            this.parts.push(' {');
        }
        this.flush();
        this.indent++;
        this.prev = t;
        this.prev2 = i > 0 ? this.toks[i - 1] : null;
        return i + 1;
    }
    closeBrace(t) {
        if (this.hasContent()) {
            this.flush();
        }
        else {
            this.pendingBlank = 0; // `}` 前不留空行
        }
        this.indent = Math.max(0, this.indent - 1);
        this.parts.push('}');
        this.justClosed = true;
        this.prev2 = this.prev;
        this.prev = t;
    }
    /** 把 `{ ... }` 之间的 token 摊成一行 */
    inlineBlock(open, close) {
        let s = '{';
        let p = null;
        let p2 = null;
        for (let k = open + 1; k < close; k++) {
            const text = this.toks[k].text;
            s += (p === null ? ' ' : gapBetween(p, p2, text, this.bracket) ? ' ' : '') + text;
            p2 = p;
            p = text;
        }
        return s + ' }';
    }
    // ---------------------------------------------------------------- 输出
    synthetic(text, like) {
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
    hasContent() {
        return this.parts.length > 0 || this.comment !== null;
    }
    push(t) {
        if (this.parts.length === 0) {
            this.parts.push(t.text);
        }
        else {
            const need = t.text === 'else'
                ? true
                : gapBetween(this.prev ? this.prev.text : null, this.prev2 ? this.prev2.text : null, t.text, this.bracket);
            this.parts.push((need ? ' ' : '') + t.text);
        }
        this.prev2 = this.prev;
        this.prev = t;
        this.justClosed = false;
    }
    flush() {
        if (!this.hasContent()) {
            return;
        }
        this.emitBlanks();
        this.out.push({
            indent: this.indent,
            code: this.parts.join(''),
            comment: this.comment ?? undefined,
        });
        this.parts = [];
        this.comment = null;
        this.justClosed = false;
        this.semiPending = false;
    }
    emitBlanks() {
        if (this.pendingBlank > 0 && this.out.length > 0) {
            for (let k = 0; k < this.pendingBlank; k++) {
                this.out.push({ indent: 0, code: '' });
            }
        }
        this.pendingBlank = 0;
    }
    emitComment(t) {
        if (t.kind === 'comment-block' && t.text.includes('\n')) {
            if (this.hasContent()) {
                this.flush();
            }
            this.emitBlanks();
            for (const raw of t.text.split('\n')) {
                this.out.push({ indent: 0, code: raw.replace(/^[ \t]+/, ''), raw: true });
            }
        }
        else if (this.parts.length > 0) {
            // 挂在当前行尾（`}` 后面紧跟的注释也属于这一行）
            this.comment = t.text;
            this.flush();
            this.out[this.out.length - 1].origCol = t.col;
        }
        else {
            this.emitBlanks();
            this.out.push({ indent: this.indent, code: '', comment: t.text, origCol: t.col });
        }
        this.prev2 = this.prev;
        this.prev = t;
    }
    render() {
        const unit = this.opt.indentUnit;
        const built = [];
        const groups = [];
        let curGroup = null;
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
            const fits = items.every((idx) => target + dispWidth(this.out[idx].comment) <= this.opt.maxColumn);
            items.forEach((idx, k) => {
                const cmt = this.out[idx].comment;
                if (!this.opt.alignTrailingComments || !fits) {
                    built[idx] = codes[k] + ' ' + cmt;
                }
                else {
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
function formatYan(src, opt) {
    return new Printer(src, opt).run();
}
/** 选区能否单独格式化（括号配平才行，否则调用方应退回整份文档）。 */
function canFormatFragment(src) {
    return (0, lexer_1.isBalanced)((0, lexer_1.tokenize)(src));
}
/** 所有非空行前导空白的最长公共前缀 —— 选区格式化时先剥掉、格式化后再补回。 */
function commonIndent(text) {
    const lines = text.split(/\r?\n/);
    let prefix = null;
    for (const line of lines) {
        if (line.trim() === '') {
            continue;
        }
        const m = /^[ \t]*/.exec(line);
        const lead = m ? m[0] : '';
        if (prefix === null) {
            prefix = lead;
        }
        else {
            let k = 0;
            while (k < prefix.length && k < lead.length && prefix[k] === lead[k]) {
                k++;
            }
            prefix = prefix.slice(0, k);
        }
    }
    return prefix ?? '';
}
