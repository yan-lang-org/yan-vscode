/**
 * Yan 词法器 —— 只服务于编辑器（高亮之外的格式化功能）。
 *
 * 它比编译器的 lexer（yanlang/lexer.py）更宽松：遇到不认识的东西也不报错，
 * 因为格式化器必须能在「代码写了一半、语法还不成立」的时候照常工作。
 * 字符串与注释整体成 token，因此内部的 { } [ ] 不会干扰括号配对。
 */

export type TokKind = 'ident' | 'number' | 'string' | 'op' | 'comment-line' | 'comment-block';

export interface Tok {
  kind: TokKind;
  text: string;
  start: number;
  end: number;
  line: number;
  endLine: number;
  /** 行内起始列（0 起），格式化器靠它保留原有的行尾注释对齐 */
  col: number;
}

// 长的排在前面，保证 `<<=` 不会被当成 `<<` 再当成 `<`
const OPS: string[] = [
  '<<=', '>>=', '..=', '->',
  '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '..',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~',
  '(', ')', '{', '}', '[', ']', ',', ';', ':',
];

const RE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const RE_NUMBER =
  /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9]+)?)(?:i8|i16|i32|i64|u8|u16|u32|u64|f32|f64)?/;
const RE_SPACE = /^[ \t\r\n]+/;
const RE_LINE_COMMENT = /^\/\/[^\n]*/;
const RE_BLOCK_COMMENT = /^\/\*[\s\S]*?(?:\*\/|$)/;
const RE_STRING_CLOSED = /^"(?:[^"\\]|\\[\s\S])*"/;
const RE_STRING_OPEN = /^"[^\n]*/;
const RE_AMP_MUT = /^&mut(?![A-Za-z0-9_])/;

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let pos = 0;
  let line = 0;
  let lineStart = 0;

  // 消费掉一段源码，顺带维护行号与「当前行起始偏移」
  const eat = (text: string): void => {
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

    const bc = RE_BLOCK_COMMENT.exec(rest);
    if (bc) {
      toks.push(mk('comment-block', bc[0], pos, line, lineStart));
      eat(bc[0]);
      continue;
    }

    const st = RE_STRING_CLOSED.exec(rest) ?? RE_STRING_OPEN.exec(rest);
    if (st) {
      toks.push(mk('string', st[0], pos, line, lineStart));
      eat(st[0]);
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

  function mk(kind: TokKind, text: string, start: number, ln: number, ls: number): Tok {
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

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') {
      n++;
    }
  }
  return n;
}

/** 与 t 匹配的右花括号下标（t 必须是 `{`）；找不到返回 -1。 */
export function matchBrace(toks: Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const t = toks[i].text;
    if (t === '{') {
      depth++;
    } else if (t === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** 片段是否括号配平（用于判断能不能单独格式化选区）。 */
export function isBalanced(toks: Tok[]): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
  for (const t of toks) {
    if (t.text === '{' || t.text === '(' || t.text === '[') {
      stack.push(t.text);
    } else if (t.text === '}' || t.text === ')' || t.text === ']') {
      if (stack.pop() !== pairs[t.text]) {
        return false;
      }
    }
  }
  return stack.length === 0;
}
