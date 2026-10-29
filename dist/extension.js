"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const formatter_1 = require("./formatter");
const YAN = { language: 'yan' };
function readOptions(doc, options) {
    const cfg = vscode.workspace.getConfiguration('yan.format', doc.uri);
    return {
        // 缩进跟随编辑器设置（想给 Yan 单独设就在 settings.json 里写 "[yan]": {...}）
        indentUnit: options.insertSpaces ? ' '.repeat(Math.max(1, options.tabSize)) : '\t',
        maxBlankLines: cfg.get('maxBlankLines', 1),
        alignTrailingComments: cfg.get('alignTrailingComments', true),
        maxColumn: cfg.get('maxColumn', 100),
        keepSingleLineBlocks: cfg.get('keepSingleLineBlocks', false),
        eol: doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
    };
}
function wholeDocRange(doc) {
    const last = doc.lineAt(doc.lineCount - 1);
    return new vscode.Range(new vscode.Position(0, 0), last.range.end);
}
/** 格式化结果的末尾换行要与原文一致，否则每次格式化都会在文件尾部多出/吃掉一个换行 */
function trimToMatchSource(formatted, source, eol) {
    if (/\n$/.test(source)) {
        return formatted;
    }
    return formatted.endsWith(eol) ? formatted.slice(0, -eol.length) : formatted;
}
function stripIndent(text, base) {
    if (base === '') {
        return text;
    }
    return text
        .split(/\r?\n/)
        .map((line) => (line.startsWith(base) ? line.slice(base.length) : line.replace(/^[ \t]+/, '')))
        .join('\n');
}
class YanFormattingProvider {
    provideDocumentFormattingEdits(doc, options) {
        const opt = readOptions(doc, options);
        const source = doc.getText();
        const formatted = (0, formatter_1.formatYan)(source, opt);
        const text = trimToMatchSource(formatted, source, opt.eol);
        if (text === source) {
            return [];
        }
        return [vscode.TextEdit.replace(wholeDocRange(doc), text)];
    }
    provideDocumentRangeFormattingEdits(doc, range, options) {
        const opt = readOptions(doc, options);
        const source = doc.getText();
        // 选区扩展到整行：末尾恰好落在下一行行首时回退一行，免得多带一个空行
        let endLine = range.end.line;
        if (endLine > range.start.line && range.end.character === 0) {
            endLine -= 1;
        }
        const range2 = new vscode.Range(new vscode.Position(range.start.line, 0), doc.lineAt(endLine).range.end);
        const fragment = doc.getText(range2);
        // 括号不配平说明选区切在块中间，整段重排反而会错，退回整份文档
        if (!(0, formatter_1.canFormatFragment)(fragment)) {
            const text = trimToMatchSource((0, formatter_1.formatYan)(source, opt), source, opt.eol);
            return [vscode.TextEdit.replace(wholeDocRange(doc), text)];
        }
        const base = (0, formatter_1.commonIndent)(fragment);
        const formatted = (0, formatter_1.formatYan)(stripIndent(fragment, base), opt);
        const restored = formatted
            .split(opt.eol)
            .map((line) => (line === '' ? line : base + line))
            .join(opt.eol);
        return [vscode.TextEdit.replace(range2, trimToMatchSource(restored, fragment, opt.eol))];
    }
}
function activate(context) {
    const provider = new YanFormattingProvider();
    context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(YAN, provider), vscode.languages.registerDocumentRangeFormattingEditProvider(YAN, provider));
}
function deactivate() {
    // 无资源需要释放
}
