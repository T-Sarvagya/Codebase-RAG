/**
 * chunker.service.ts  —  AST-AWARE CHUNKING (milestone 4)
 *
 * Splits a source file into chunks for embedding. The whole point of this
 * service is to split on *semantic boundaries* — whole functions, methods, and
 * classes — instead of blindly every-N-lines. A chunk that is exactly one
 * function embeds into a much cleaner vector than a chunk that happens to
 * contain the back half of one function and the front half of the next.
 *
 * HOW IT WORKS
 *   1. Parse the file with tree-sitter into a syntax tree (an "AST").
 *   2. Walk the tree and emit one chunk per top-level function / arrow-const,
 *      and for classes: one chunk for the class "header" (signature + fields)
 *      plus one chunk per method (named `ClassName.methodName`).
 *   3. Whatever lines are left over (imports, top-level constants, config) are
 *      captured by a fallback line-window pass so nothing is ever dropped.
 *
 * GRACEFUL DEGRADATION
 *   tree-sitter only knows the languages we loaded grammars for (TS/TSX/JS/PY).
 *   For anything else — JSON, Markdown, SQL, CSS, an unparseable file — we fall
 *   back to the simple sliding line-window chunker (`naiveChunkRange`). So the
 *   service always returns sensible chunks; AST is an upgrade, not a requirement.
 *
 * The PUBLIC INTERFACE is identical to the old naive version — same
 * `chunkFile()` signature, same `RawChunk` shape — so nothing downstream
 * (repos.service.ts, the DB, retrieval) had to change. We just fill in the
 * `symbolName` field now, which was always `null` before.
 */
import { Injectable, Logger } from '@nestjs/common';

// `import X = require(...)` is the safe way to consume these CommonJS modules
// (they use `export =`), independent of esModuleInterop settings.
import Parser = require('tree-sitter');
import JavaScript = require('tree-sitter-javascript');
import TypeScript = require('tree-sitter-typescript');
import Python = require('tree-sitter-python');

/** One chunk of a file, with the metadata we need to store + cite it later. */
export interface RawChunk {
  filePath: string; // path relative to the repo root
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  language: string | null; // inferred from the file extension (for display)
  symbolName: string | null; // function/class/method name (AST), or null (fallback)
  content: string; // the actual code text
}

@Injectable()
export class ChunkerService {
  private readonly logger = new Logger(ChunkerService.name);

  // Line-window settings for the fallback path and for splitting oversized nodes.
  private readonly WINDOW_LINES = 60;
  private readonly OVERLAP_LINES = 10;
  // A single chunk bigger than this many lines (e.g. a 400-line "god class"
  // method) gets sub-split so its embedding stays focused and within limits.
  private readonly MAX_CHUNK_LINES = 120;
  // Anonymous callbacks (route handlers, .map/.forEach, event listeners) are
  // only worth their own chunk if they're at least this many lines — otherwise
  // a trivial `arr.map(x => x * 2)` would create noise.
  private readonly MIN_CALLBACK_LINES = 3;

  // One Parser per grammar, created lazily and reused (parsing is stateful but
  // single-threaded here, so sharing is fine).
  private readonly parsers = new Map<string, Parser>();

  /** Map common file extensions to a display language label. */
  private readonly EXT_TO_LANG: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', java: 'java', go: 'go', rb: 'ruby', rs: 'rust',
    c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', json: 'json',
    md: 'markdown', sql: 'sql', sh: 'shell', yml: 'yaml', yaml: 'yaml',
    html: 'html', css: 'css',
  };

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Split one file into chunks. Returns [] for empty/whitespace-only files.
   * Tries AST chunking; falls back to line-windows for unsupported languages
   * or parse failures.
   */
  chunkFile(filePath: string, content: string): RawChunk[] {
    if (content.trim().length === 0) return [];

    const language = this.detectLanguage(filePath);
    const lines = content.split('\n');

    // Pick a grammar based on the *extension* (so .tsx uses the JSX-aware grammar).
    const parser = this.getParserForFile(filePath);

    // No grammar for this file type -> line-window fallback.
    if (!parser) return this.naiveChunkRange(filePath, lines, language, 0, lines.length - 1);

    let tree: Parser.Tree;
    try {
      tree = parser.parse(content);
    } catch (err) {
      // Parsing should rarely throw, but if it does we degrade gracefully.
      this.logger.warn(`tree-sitter failed on ${filePath}; using line-window fallback`);
      return this.naiveChunkRange(filePath, lines, language, 0, lines.length - 1);
    }

    // 1) Collect semantic-boundary chunks (functions, classes, methods).
    const family: 'py' | 'js' = language === 'python' ? 'py' : 'js';
    const defChunks: RawChunk[] = [];
    for (const child of tree.rootNode.namedChildren) {
      this.visitNode(child, { out: defChunks, lines, filePath, language, family });
    }

    // If the file had no recognisable definitions (e.g. a script of top-level
    // statements), just line-window the whole thing.
    if (defChunks.length === 0) {
      return this.naiveChunkRange(filePath, lines, language, 0, lines.length - 1);
    }

    // 2) Fill the gaps (imports / top-level code between definitions).
    const gapChunks = this.fillGaps(defChunks, filePath, language, lines);

    // 3) Sub-split any oversized chunk, then sort by line for stable order.
    const all = [...defChunks, ...gapChunks].flatMap((c) => this.splitIfTooLarge(c));
    all.sort((a, b) => a.startLine - b.startLine);
    return all;
  }

  // ===========================================================================
  // AST WALK
  // ===========================================================================

  /**
   * Decide what to do with one syntax node: emit it as a chunk, expand it
   * (classes), or recurse into it looking for definitions deeper down.
   */
  private visitNode(node: Parser.SyntaxNode, ctx: WalkCtx): void {
    // `export function foo()` / `export class Bar` (JS/TS): the real declaration
    // is wrapped in an export_statement. Use the wrapper's RANGE (so the
    // `export`/decorator lines are included) but the inner node for type+name.
    let rangeNode = node;
    let inner = node;

    if (ctx.family === 'js' && node.type === 'export_statement') {
      const decl = node.childForFieldName('declaration');
      if (decl) inner = decl;
      else return; // `export { x }` re-exports — leave for the gap-fill pass
    }
    // `@decorator\ndef foo()` (Python): decorated_definition wraps the def.
    if (ctx.family === 'py' && node.type === 'decorated_definition') {
      const def = node.childForFieldName('definition');
      if (def) inner = def;
      else return;
    }

    if (this.isFunction(inner, ctx.family)) {
      this.emitNode(rangeNode, this.nameOf(inner), ctx);
      return; // don't recurse into a function (closures stay with their parent)
    }

    if (this.isClass(inner, ctx.family)) {
      this.emitClass(rangeNode, inner, ctx);
      return;
    }

    // `const handler = (req) => {...}` — an arrow/function expression assigned
    // to a variable. Treat the whole declaration as one named chunk.
    if (ctx.family === 'js' && this.isFunctionConst(inner)) {
      const declarator = inner.namedChildren.find((c) => c.type === 'variable_declarator');
      const name = declarator?.childForFieldName('name')?.text ?? null;
      this.emitNode(rangeNode, name, ctx);
      return;
    }

    // Express route handlers, array .map/.forEach, addEventListener, etc.:
    // significant arrow/function callbacks passed as call arguments. Capturing
    // these (named by their callee) is what makes AST chunking actually useful
    // on callback-heavy JS, where most logic lives in anonymous functions.
    if (ctx.family === 'js' && this.emitCallbackArgs(node, ctx)) return;

    // Plain top-level statement / import / const — not a definition. Recurse so
    // we still find functions nested inside namespaces, blocks, IIFEs, etc.
    for (const child of node.namedChildren) this.visitNode(child, ctx);
  }

  /**
   * Find multi-line arrow/function callbacks that are passed directly as call
   * arguments (e.g. the handler in `app.get('/x', async (req, res) => {...})`)
   * and emit each as its own chunk, named after the call it belongs to. Returns
   * true if it emitted anything (so the caller stops recursing into this node).
   */
  private emitCallbackArgs(node: Parser.SyntaxNode, ctx: WalkCtx): boolean {
    // All arrow/function expressions anywhere under this statement...
    const candidates = node
      .descendantsOfType(['arrow_function', 'function_expression', 'function'])
      // ...that are a direct argument of a call: arrow -> arguments -> call_expression
      .filter(
        (fn) =>
          fn.parent?.type === 'arguments' &&
          fn.parent.parent?.type === 'call_expression',
      )
      // ...and are big enough to be worth isolating.
      .filter(
        (fn) => fn.endPosition.row - fn.startPosition.row + 1 >= this.MIN_CALLBACK_LINES,
      );

    if (candidates.length === 0) return false;

    // Keep only the OUTERMOST callbacks — drop any callback nested inside another
    // one we're already keeping (a `.map` callback inside a route handler).
    candidates.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
    const kept: Parser.SyntaxNode[] = [];
    for (const c of candidates) {
      const contained = kept.some(
        (k) => c.startIndex >= k.startIndex && c.endIndex <= k.endIndex,
      );
      if (!contained) kept.push(c);
    }

    for (const fn of kept) {
      const call = fn.parent!.parent!; // the call_expression (checked above)
      const callee = this.calleeLabel(call);
      // Grab the first string argument for context (usually a route path / event).
      const args = call.childForFieldName('arguments');
      const strArg = args?.namedChildren.find((a) => a.type === 'string')?.text;
      const name = strArg ? `${callee} ${strArg.slice(0, 30)}` : callee;
      this.pushSlice(fn.startPosition.row, fn.endPosition.row, name, ctx);
    }
    return true;
  }

  /**
   * Produce a short, readable label for the call a callback belongs to, e.g.
   * `router.get`, `app.use`, `store.on`, or just `then` / `catch` for promise
   * chains (where the receiver is itself a complex expression). Avoids dumping a
   * whole multi-line `a().then(...).catch` chain into the symbol name.
   */
  private calleeLabel(call: Parser.SyntaxNode): string {
    const fnField = call.childForFieldName('function');
    if (fnField?.type === 'member_expression') {
      const prop = fnField.childForFieldName('property')?.text ?? 'fn';
      const obj = fnField.childForFieldName('object');
      // Only prefix the receiver if it's a simple identifier (router, app, ...).
      const recv = obj && obj.type === 'identifier' ? `${obj.text}.` : '';
      return recv + prop;
    }
    // Plain identifier callee, or anything else: collapse whitespace + truncate.
    return (fnField?.text ?? 'callback').replace(/\s+/g, ' ').trim().slice(0, 30);
  }

  /** Emit one class: a "header" chunk (signature + fields) + one chunk per method. */
  private emitClass(rangeNode: Parser.SyntaxNode, classNode: Parser.SyntaxNode, ctx: WalkCtx): void {
    const className = this.nameOf(classNode) ?? 'class';
    const body = classNode.childForFieldName('body');
    const methods = body ? body.namedChildren.filter((c) => this.isMethod(c, ctx.family)) : [];

    // Small class with no methods -> emit it whole.
    if (methods.length === 0) {
      this.emitNode(rangeNode, className, ctx);
      return;
    }

    // Header = from the class start (incl. decorators/export) down to just before
    // the first method. Captures `export class X extends Y {` plus any fields.
    const headerStartRow = rangeNode.startPosition.row;
    const firstMethodRange = this.methodRange(methods[0], ctx.family);
    const headerEndRow = firstMethodRange.startPosition.row - 1;
    if (headerEndRow >= headerStartRow) {
      this.pushSlice(headerStartRow, headerEndRow, className, ctx);
    }

    // One chunk per method, named `ClassName.methodName`.
    for (const m of methods) {
      const r = this.methodRange(m, ctx.family);
      const mName = this.methodName(m, ctx.family);
      this.pushSlice(r.startPosition.row, r.endPosition.row, `${className}.${mName}`, ctx);
    }
  }

  /** Emit a chunk spanning a node's full line range. */
  private emitNode(rangeNode: Parser.SyntaxNode, name: string | null, ctx: WalkCtx): void {
    this.pushSlice(rangeNode.startPosition.row, rangeNode.endPosition.row, name, ctx);
  }

  /** Build a RawChunk from a 0-based row range and push it (skips blank slices). */
  private pushSlice(startRow: number, endRow: number, symbolName: string | null, ctx: WalkCtx): void {
    const slice = ctx.lines.slice(startRow, endRow + 1).join('\n');
    if (slice.trim().length === 0) return;
    ctx.out.push({
      filePath: ctx.filePath,
      startLine: startRow + 1, // 0-based row -> 1-based line
      endLine: endRow + 1,
      language: ctx.language,
      symbolName,
      content: slice,
    });
  }

  // ---- node classification (per language family) ----------------------------

  private isFunction(node: Parser.SyntaxNode, family: 'py' | 'js'): boolean {
    return family === 'py'
      ? node.type === 'function_definition'
      : node.type === 'function_declaration' || node.type === 'generator_function_declaration';
  }

  private isClass(node: Parser.SyntaxNode, family: 'py' | 'js'): boolean {
    return family === 'py'
      ? node.type === 'class_definition'
      : node.type === 'class_declaration' || node.type === 'abstract_class_declaration';
  }

  /** A method node inside a class body. */
  private isMethod(node: Parser.SyntaxNode, family: 'py' | 'js'): boolean {
    return family === 'py'
      ? node.type === 'function_definition' || node.type === 'decorated_definition'
      : node.type === 'method_definition';
  }

  /** `const x = () => {}` / `const x = function () {}` (JS/TS only). */
  private isFunctionConst(node: Parser.SyntaxNode): boolean {
    if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') return false;
    const declarator = node.namedChildren.find((c) => c.type === 'variable_declarator');
    const value = declarator?.childForFieldName('value');
    return (
      value != null &&
      ['arrow_function', 'function', 'function_expression'].includes(value.type)
    );
  }

  /** For a Python decorated method the real range includes the decorators. */
  private methodRange(method: Parser.SyntaxNode, family: 'py' | 'js'): Parser.SyntaxNode {
    if (family === 'py' && method.type === 'decorated_definition') return method;
    return method;
  }

  private methodName(method: Parser.SyntaxNode, family: 'py' | 'js'): string {
    if (family === 'py' && method.type === 'decorated_definition') {
      return method.childForFieldName('definition')?.childForFieldName('name')?.text ?? 'method';
    }
    return this.nameOf(method) ?? 'method';
  }

  /** The declared name of a node via its `name` field, if any. */
  private nameOf(node: Parser.SyntaxNode): string | null {
    return node.childForFieldName('name')?.text ?? null;
  }

  // ===========================================================================
  // GAP FILLING + SIZE LIMITS (shared with the fallback path)
  // ===========================================================================

  /**
   * Capture lines NOT covered by any definition chunk (imports, top-level
   * constants, comments between functions) so no code is lost. Skips blank runs
   * and punctuation-only runs (e.g. a class's dangling `}` line).
   */
  private fillGaps(
    defChunks: RawChunk[],
    filePath: string,
    language: string | null,
    lines: string[],
  ): RawChunk[] {
    const covered = new Array<boolean>(lines.length).fill(false);
    for (const c of defChunks) {
      for (let r = c.startLine - 1; r <= c.endLine - 1; r++) {
        if (r >= 0 && r < lines.length) covered[r] = true;
      }
    }

    const gaps: RawChunk[] = [];
    let r = 0;
    while (r < lines.length) {
      if (covered[r]) {
        r++;
        continue;
      }
      const start = r;
      while (r < lines.length && !covered[r]) r++;
      const end = r - 1; // inclusive uncovered run [start..end]

      const slice = lines.slice(start, end + 1).join('\n');
      if (slice.trim().length === 0) continue; // all blank
      if (/^[\s{}()[\];,]*$/.test(slice)) continue; // only brackets/punctuation

      gaps.push(...this.naiveChunkRange(filePath, lines, language, start, end));
    }
    return gaps;
  }

  /**
   * Sliding line-window chunker over a [startRow..endRow] range (0-based).
   * Used both as the whole-file fallback and to fill gaps between definitions.
   */
  private naiveChunkRange(
    filePath: string,
    lines: string[],
    language: string | null,
    startRow: number,
    endRow: number,
  ): RawChunk[] {
    const out: RawChunk[] = [];
    const step = this.WINDOW_LINES - this.OVERLAP_LINES;

    for (let s = startRow; s <= endRow; s += step) {
      const e = Math.min(s + this.WINDOW_LINES - 1, endRow);
      const slice = lines.slice(s, e + 1).join('\n');
      if (slice.trim().length > 0) {
        out.push({
          filePath,
          startLine: s + 1,
          endLine: e + 1,
          language,
          symbolName: null, // line-window chunks have no symbol
          content: slice,
        });
      }
      if (e === endRow) break;
    }
    return out;
  }

  /** Split a chunk that's longer than MAX_CHUNK_LINES into overlapping windows. */
  private splitIfTooLarge(chunk: RawChunk): RawChunk[] {
    const cl = chunk.content.split('\n');
    if (cl.length <= this.MAX_CHUNK_LINES) return [chunk];

    const out: RawChunk[] = [];
    const step = this.WINDOW_LINES - this.OVERLAP_LINES;
    for (let i = 0; i < cl.length; i += step) {
      const end = Math.min(i + this.WINDOW_LINES, cl.length);
      const slice = cl.slice(i, end).join('\n');
      if (slice.trim().length > 0) {
        out.push({
          ...chunk,
          startLine: chunk.startLine + i,
          endLine: chunk.startLine + end - 1,
          content: slice,
          // Keep the symbol so a split function still shows its name.
          symbolName: chunk.symbolName ? `${chunk.symbolName} (part ${out.length + 1})` : null,
        });
      }
      if (end === cl.length) break;
    }
    return out;
  }

  // ===========================================================================
  // PARSERS + LANGUAGE DETECTION
  // ===========================================================================

  /** Lazily create + cache a Parser for the file's extension; null if unsupported. */
  private getParserForFile(filePath: string): Parser | null {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

    // Map extension -> a cache key + the grammar object to load.
    let key: string;
    let grammar: unknown;
    if (['ts', 'mts', 'cts'].includes(ext)) {
      key = 'ts';
      grammar = TypeScript.typescript;
    } else if (ext === 'tsx') {
      key = 'tsx';
      grammar = TypeScript.tsx; // JSX-aware TS grammar
    } else if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
      key = 'js';
      grammar = JavaScript;
    } else if (ext === 'py') {
      key = 'py';
      grammar = Python;
    } else {
      return null; // unsupported -> caller uses the line-window fallback
    }

    const cached = this.parsers.get(key);
    if (cached) return cached;

    const parser = new Parser();
    // setLanguage accepts `any`; our grammar is typed `unknown`, which is
    // assignable. This is the single boundary where the opaque grammar is used.
    parser.setLanguage(grammar);
    this.parsers.set(key, parser);
    return parser;
  }

  /** Display language from extension (null if unknown). */
  private detectLanguage(filePath: string): string | null {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return this.EXT_TO_LANG[ext] ?? null;
  }
}

/** Context threaded through the recursive AST walk (keeps method signatures short). */
interface WalkCtx {
  out: RawChunk[];
  lines: string[];
  filePath: string;
  language: string | null;
  family: 'py' | 'js';
}
