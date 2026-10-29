"use strict";
/**
 * Yan 词法器 —— 只服务于编辑器（高亮之外的格式化功能）。
 *
 * 它比编译器的 lexer（selfhost/lexv.yan）更宽松：遇到不认识的东西也不报错，
 * 因为格式化器必须能在「代码写了一半、语法还不成立」的时候照常工作。
 * 字符串、字符字面量与注释整体成 token，因此内部的 { } [ ] 不会干扰括号配对。
 *
 * 与 yan 0.11 对齐的几处细节：
 *   · 字符字面量 'a' / '\n' / '\x41' / '\u{4E2D}'，与生命周期 'a 靠「有没有闭合引号」区分
 *   · 块注释**可以嵌套**（SPEC §1.7 C1）
 *   · `::` `=>` `.` `..` `..=` 各自是独立 token，格式化器靠它决定间距
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenize = tokenize;
exports.matchBrace = matchBrace;
exports.isBalanced = isBalanced;
// 长的排在前面，保证 `<<=` 不会被当成 `<<` 再当成 `<`
const OPS = [
    '<<=', '>>=', '..=', '->', '=>',
    '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '::',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '..',
    '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~',
    '(', ')', '{', '}', '[', ']', ',', ';', ':', '.',
];
const RE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const RE_NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9]+)?)(?:i8|i16|i32|i64|u8|u16|u32|u64|f32|f64)?/;
const RE_SPACE = /^[ \t\r\n]+/;
const RE_LINE_COMMENT = /^\/\/[^\n]*/;
const RE_CHAR = /^'(?:\\(?:[ntr0\\"']|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\})|[^'\\\n])'/;
const RE_LIFETIME = /^'[A-Za-z_][A-Za-z0-9_]*/;
const RE_STRING_CLOSED = /^"(?:[^"\\]|\\[\s\S])*"/;
const RE_STRING_OPEN = /^"[^\n]*/;
const RE_AMP_MUT = /^&mut(?![A-Za-z0-9_])/;
function tokenize(src) {
    const toks = [];
    let pos = 0;
    let line = 0;
    let lineStart = 0;
    // 消费掉一段源码，顺带维护行号与「当前行起始偏移」
    const eat = (text) => {
        const nlAt = text.lastIndexOf('\n');
        if (nlAt >= 0) {
            line += countNewlines(text);
            lineStart = pos + nlAt + 1;
        }
        pos += text.length;
    };
    while (pos < src.length) {
        const rest = src.slice(pos);
        const sp = RE_SPACE.exec(rest);
        if (sp) {
            eat(sp[0]);
            continue;
        }
        const lc = RE_LINE_COMMENT.exec(rest);
        if (lc) {
            toks.push(mk('comment-line', lc[0], pos, line, lineStart));
            eat(lc[0]);
            continue;
        }
        // 块注释可以嵌套：手工扫描，数到深度 0 才是结尾；未闭合就吃到文件末
        if (rest.startsWith('/*')) {
            const end = scanBlockComment(src, pos);
            const text = src.slice(pos, end);
            toks.push(mk('comment-block', text, pos, line, lineStart));
            eat(text);
            continue;
        }
        const ch = RE_CHAR.exec(rest);
        if (ch) {
            toks.push(mk('char', ch[0], pos, line, lineStart));
            eat(ch[0]);
            continue;
        }
        const st = RE_STRING_CLOSED.exec(rest) ?? RE_STRING_OPEN.exec(rest);
        if (st) {
            toks.push(mk('string', st[0], pos, line, lineStart));
            eat(st[0]);
            continue;
        }
        const lt = RE_LIFETIME.exec(rest);
        if (lt) {
            toks.push(mk('lifetime', lt[0], pos, line, lineStart));
            eat(lt[0]);
            continue;
        }
        const am = RE_AMP_MUT.exec(rest);
        if (am) {
            toks.push(mk('op', '&mut', pos, line, lineStart));
            eat(am[0]);
            continue;
        }
        const id = RE_IDENT.exec(rest);
        if (id) {
            toks.push(mk('ident', id[0], pos, line, lineStart));
            eat(id[0]);
            continue;
        }
        const num = RE_NUMBER.exec(rest);
        if (num) {
            toks.push(mk('number', num[0], pos, line, lineStart));
            eat(num[0]);
            continue;
        }
        const op = OPS.find((o) => rest.startsWith(o));
        if (op) {
            toks.push(mk('op', op, pos, line, lineStart));
            eat(op);
            continue;
        }
        // 不认识的字符：当成一个单字符 token，保证永不死循环
        toks.push(mk('op', rest[0], pos, line, lineStart));
        eat(rest[0]);
    }
    return toks;
    function mk(kind, text, start, ln, ls) {
        return {
            kind,
            text,
            start,
            end: start + text.length,
            line: ln,
            endLine: ln + countNewlines(text),
            col: start - ls,
        };
    }
}
/** 从 pos（指向 `/*`）扫到配对的 `*\/` 之后；支持嵌套，未闭合返回 src.length。 */
function scanBlockComment(src, pos) {
    let depth = 0;
    let i = pos;
    while (i < src.length) {
        if (src.startsWith('/*', i)) {
            depth++;
            i += 2;
        }
        else if (src.startsWith('*/', i)) {
            depth--;
            i += 2;
            if (depth === 0) {
                return i;
            }
        }
        else {
            i++;
        }
    }
    return src.length;
}
function countNewlines(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\n') {
            n++;
        }
    }
    return n;
}
/** 与 t 匹配的右花括号下标（t 必须是 `{`）；找不到返回 -1。 */
function matchBrace(toks, open) {
    let depth = 0;
    for (let i = open; i < toks.length; i++) {
        const t = toks[i].text;
        if (t === '{') {
            depth++;
        }
        else if (t === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}
/** 片段是否括号配平（用于判断能不能单独格式化选区）。 */
function isBalanced(toks) {
    const stack = [];
    const pairs = { '}': '{', ')': '(', ']': '[' };
    for (const t of toks) {
        if (t.text === '{' || t.text === '(' || t.text === '[') {
            stack.push(t.text);
        }
        else if (t.text === '}' || t.text === ')' || t.text === ']') {
            if (stack.pop() !== pairs[t.text]) {
                return false;
            }
        }
    }
    return stack.length === 0;
}
