import * as vscode from 'vscode';
import { canFormatFragment, commonIndent, formatYan, FormatOptions } from './formatter';

const YAN: vscode.DocumentSelector = { language: 'yan' };

function readOptions(doc: vscode.TextDocument, options: vscode.FormattingOptions): FormatOptions {
  const cfg = vscode.workspace.getConfiguration('yan.format', doc.uri);
  return {
    // 缩进跟随编辑器设置（想给 Yan 单独设就在 settings.json 里写 "[yan]": {...}）
    indentUnit: options.insertSpaces ? ' '.repeat(Math.max(1, options.tabSize)) : '\t',
    maxBlankLines: cfg.get<number>('maxBlankLines', 1),
    alignTrailingComments: cfg.get<boolean>('alignTrailingComments', true),
    maxColumn: cfg.get<number>('maxColumn', 100),
    keepSingleLineBlocks: cfg.get<boolean>('keepSingleLineBlocks', true),
    eol: doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
  };
}

function wholeDocRange(doc: vscode.TextDocument): vscode.Range {
  const last = doc.lineAt(doc.lineCount - 1);
  return new vscode.Range(new vscode.Position(0, 0), last.range.end);
}

/** 格式化结果的末尾换行要与原文一致，否则每次格式化都会在文件尾部多出/吃掉一个换行 */
function trimToMatchSource(formatted: string, source: string, eol: string): string {
  if (/\n$/.test(source)) {
    return formatted;
  }
  return formatted.endsWith(eol) ? formatted.slice(0, -eol.length) : formatted;
}

function stripIndent(text: string, base: string): string {
  if (base === '') {
    return text;
  }
  return text
    .split(/\r?\n/)
    .map((line) => (line.startsWith(base) ? line.slice(base.length) : line.replace(/^[ \t]+/, '')))
    .join('\n');
}

class YanFormattingProvider
  implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {

  provideDocumentFormattingEdits(
    doc: vscode.TextDocument,
    options: vscode.FormattingOptions,
  ): vscode.TextEdit[] {
    const opt = readOptions(doc, options);
    const source = doc.getText();
    const formatted = formatYan(source, opt);
    const text = trimToMatchSource(formatted, source, opt.eol);
    if (text === source) {
      return [];
    }
    return [vscode.TextEdit.replace(wholeDocRange(doc), text)];
  }

  provideDocumentRangeFormattingEdits(
    doc: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
  ): vscode.TextEdit[] {
    const opt = readOptions(doc, options);
    const source = doc.getText();

    // 选区扩展到整行：末尾恰好落在下一行行首时回退一行，免得多带一个空行
    let endLine = range.end.line;
    if (endLine > range.start.line && range.end.character === 0) {
      endLine -= 1;
    }
    const range2 = new vscode.Range(
      new vscode.Position(range.start.line, 0),
      doc.lineAt(endLine).range.end,
    );
    const fragment = doc.getText(range2);

    // 括号不配平说明选区切在块中间，整段重排反而会错，退回整份文档
    if (!canFormatFragment(fragment)) {
      const text = trimToMatchSource(formatYan(source, opt), source, opt.eol);
      return [vscode.TextEdit.replace(wholeDocRange(doc), text)];
    }

    const base = commonIndent(fragment);
    const formatted = formatYan(stripIndent(fragment, base), opt);
    const restored = formatted
      .split(opt.eol)
      .map((line) => (line === '' ? line : base + line))
      .join(opt.eol);

    return [vscode.TextEdit.replace(range2, trimToMatchSource(restored, fragment, opt.eol))];
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new YanFormattingProvider();
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(YAN, provider),
    vscode.languages.registerDocumentRangeFormattingEditProvider(YAN, provider),
  );
}

export function deactivate(): void {
  // 无资源需要释放
}
