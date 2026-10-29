# 砚 Yan · VS Code 扩展

给 `.yan` 文件提供**语法高亮**与**格式化**。就这两件事，不掺别的。
语法对齐 **yan 0.11**（规范见 [`yan-lang/docs/SPEC.md`](https://github.com/yan-lang-org/yan-lang/blob/main/docs/SPEC.md)）。

## 装

两种方式，挑一个：

### 1. 直接放进扩展目录（不打包，改完立刻生效）

```powershell
# Windows（PowerShell）
Copy-Item . "$env:USERPROFILE\.vscode\extensions\yanlang.yan-0.2.0" -Recurse

# macOS / Linux
cp -r . ~/.vscode/extensions/yanlang.yan-0.2.0
```

重启 VS Code，打开任意 `.yan` 文件即可。这种方式下 `dist/` 里的编译产物已经提交在仓库里，
**不需要跑 `npm install`**。

### 2. 打包成 .vsix

```bash
npm install
npm run package          # 产出 yan-0.2.0.vsix
```

然后在 VS Code 里 `Extensions → ··· → Install from VSIX`。

## 高亮了什么

| 类别 | 例子 |
| --- | --- |
| 声明关键字 | `fn` `let` `mut` `struct` `enum` `use` `comptime` `as` |
| 控制关键字 | `if` `else` `while` `loop` `for` `in` `match` `return` `break` `continue` `defer` |
| 内建类型 | `i8`…`i64` `u8`…`u64` `usize` `isize` `f32` `f64` `bool` `char` |
| 预置类型 | `String` `Vec` `Box` `Option` `Result` `HashMap` |
| 内建函数 | `println` `print` `len` `size_of` `align_of` `exit` |
| 构造子 | `true` `false` `Some` `None` `Ok` `Err` |
| 生命周期 | `'a`（与字符字面量 `'a'` 分开着色） |
| 字面量 | `0xFFu8` `0b1010` `0o777` `1_000` `1.5e3f64` `'中'` `'\u{4E2D}'` |
| 名字 | 函数名、类型名、`comptime NAME:` 常量名、`Color::Red` 的变体名 |
| 注释 | `//` 行注释；`/* */` 块注释，**支持嵌套** |

`comptime if` 会被高亮成「`comptime` + `if`」，跟它在语言里的身份一致：条件编译，但它是普通语法。
`impl` / `packed` 目前只是词法保留字（没有对应语法），单独标成 reserved。

## 格式化

`Shift+Alt+F`，或者开了 `editor.formatOnSave` 就保存时自动来一遍。

风格跟 `yan-lang/examples/` 下的验收程序对齐：

```yan
fn fib(n: i32) -> i32 {
    if (n < 2) {
        n
    } else {
        fib(n - 1) + fib(n - 2)
    }
}
```

要点：

- **K&R 花括号**：`fn main() {`；`} else {` / `} else if (cond) {` 不换行
- 二元运算符两侧留空格，一元（`-1` `&x` `~MASK`）紧贴操作数
- `.` `::` 两侧紧贴：`p.x` `d.0` `Color::Red` `use calc::ops`
- `=>` 两侧留空格：`Shape::Circle(r) => { ... }`
- 泛型实参的尖括号紧贴：`Vec<u8>` `Result<i32, i32>` `Vec<Vec<i32>>` `fn f<'a>(...)`
- `[` 按身份决定贴不贴：下标与位访问 `reg[7:0]` 紧贴，数组字面量 `= [1, 2]` 留空格
- 位切片内的冒号**不加**空格（`reg[GAIN_HI:GAIN_LO]`），类型标注加（`let x: i32`）
- 数组类型 `[i32; N]` 与批量字面量 `[0; 4]` 里的 `;` 不换行，语句末尾的 `;` 换行
- 长调用 / 长数组字面量拆行时，续行比语句多缩一级（不贴回左边）
- 连续空行收敛到 `maxBlankLines` 个；`}` 前面的空行删掉
- 相邻行的行尾注释对齐到同一列；**原本就对齐好的一组注释，沿用原来的那一列**，不推歪
- 一行写下的块（`if (n <= 0) { 1 } else { 2 * f(n - 1) }`）默认原样保留

### 设置

缩进跟随编辑器的 `editor.tabSize` / `editor.insertSpaces`。想单给 Yan 设一套：

```jsonc
"[yan]": {
  "editor.tabSize": 4,
  "editor.insertSpaces": true,
  "editor.formatOnSave": true
}
```

格式化器自己的开关：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `yan.format.maxBlankLines` | `1` | 最多保留几个连续空行 |
| `yan.format.alignTrailingComments` | `true` | 行尾注释对齐；关掉则一律压成一个空格 |
| `yan.format.maxColumn` | `100` | 对齐时允许达到的最大列宽，超了就放弃对齐 |
| `yan.format.keepSingleLineBlocks` | `true` | 保留源码里一行写下的块，不展开 |

## 改代码之后

```bash
npm install          # 只装 typescript 和类型定义
npm run compile      # src/*.ts → dist/*.js
```

`src/` 三个文件：`lexer.ts`（词法）、`formatter.ts`（重排）、`extension.ts`（注册 provider）。
`tools/make_icon.py` 生成 `images/icon.png`（纯标准库手写 PNG，不依赖 Pillow）。

改完记得跑自检（`node` / `npm` 都不在仓库里，用自己的环境）：

```bash
npm run verify                                    # 幂等 / token 不丢失 / 残缺代码不崩
npm run verify:full                               # 再把格式化后的代码交给 yan 编译运行，比对输出
npm install --no-save vscode-textmate vscode-oniguruma
npm run highlight                                 # 用 VS Code 同款引擎验高亮 scope
npm run highlight -- -v                           # 逐 token 打印 scope
```

`verify` 默认去 `../yan-lang` 找编译器和用例（`bin/yan.exe` + `examples/*.yan`），
也可以用 `--yan-home=<目录>` 或 `YAN_HOME` 指定；用例清单可以用 `YAN_FILES=a.yan;b.yan` 覆盖。

两条判据，缺一不可：

1. **幂等** —— `format(format(x)) === format(x)`，否则用户每按一次保存代码就抖一次；
2. **不改语义** —— 格式化前后 `yan check` 结论一致，`yan run` 的输出逐字相同。

## 已知边界

- 格式化器**不做语法分析**，只看 token 和括号层级。所以代码写一半也能格式化，
  但也意味着它不会重排表达式结构 —— 那条长 `println` 你得自己拆行。
- 只认 `{}` `[]` `()` 三种括号，且字符串、字符字面量、注释内部的括号不算数。
- 泛型尖括号靠「前面是大写类型名 / 后面是生命周期」识别，`a < b` 这种比较不受影响；
  目前语言没有用户自定义泛型，所以这个启发式够用。
- 选区格式化：选中的片段括号必须配平，配不平就退回格式化整份文档。
- 只有高亮 + 格式化，**没有** LSP（补全 / 跳转 / 诊断）。诊断现在看 `yan check`。
