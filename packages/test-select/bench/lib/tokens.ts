import ts from "typescript";

export type Range = readonly [number, number];

export interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;

/** Comments that change what a tool does with the file, kept as runtime tokens. */
const PRAGMA =
  /@vitest-environment|@vite-ignore|[#@]__PURE__|[#@]__NO_SIDE_EFFECTS__|webpackIgnore|@jsx|@refresh|"use (?:client|server|strict)"/;

export function isScript(path: string): boolean {
  return SCRIPT.test(path) && !path.endsWith(".d.ts");
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((mod) => mod.kind === kind)
  );
}

const TYPE_ONLY_MODIFIERS = new Set([
  ts.SyntaxKind.PublicKeyword,
  ts.SyntaxKind.PrivateKeyword,
  ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.ReadonlyKeyword,
  ts.SyntaxKind.OverrideKeyword,
  ts.SyntaxKind.DeclareKeyword,
]);

/** A whole node that emits no JavaScript. */
function isTypeOnlyNode(node: ts.Node, parent: ts.Node): boolean {
  if (
    ts.isTypeNode(node) &&
    !ts.isExpressionWithTypeArguments(node) &&
    !ts.isVoidExpression(parent)
  ) {
    return true;
  }
  if (ts.isTypeParameterDeclaration(node)) return true;
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return true;
  if (ts.isIndexSignatureDeclaration(node)) return true;
  if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true) return true;
  if (ts.isImportEqualsDeclaration(node) && node.isTypeOnly) return true;
  if (ts.isExportDeclaration(node) && node.isTypeOnly) return true;
  if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && node.isTypeOnly) return true;
  if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) return true;
  if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) return true;
  if (
    hasModifier(node, ts.SyntaxKind.AbstractKeyword) &&
    !ts.isClassDeclaration(node) &&
    !ts.isClassExpression(node)
  ) {
    return true;
  }
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)) &&
    node.body === undefined
  ) {
    return true;
  }
  if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === "this") return true;
  if (ts.isPropertyDeclaration(node) && hasModifier(node, ts.SyntaxKind.DeclareKeyword))
    return true;
  return false;
}

/**
 * Tokens of `node` that a type-stripping transform keeps. Type annotations take their `:` with
 * them, type argument lists their angle brackets, `x!` and `x as T` keep only `x`.
 */
function collect(node: ts.Node, file: ts.SourceFile, out: Array<Token>): void {
  const children = node.getChildren(file);
  if (children.length === 0) {
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    const start = node.getStart(file);
    // Template literals and JSX text read CRLF as LF.
    out.push({
      text: file.text.slice(start, node.end).replaceAll("\r\n", "\n"),
      start,
      end: node.end,
    });
    return;
  }
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child === undefined) continue;
    const next = children[index + 1];
    if (isTypeOnlyNode(child, node)) continue;
    if (child.kind === ts.SyntaxKind.SyntaxList && isTypeList(child, file)) {
      continue;
    }
    if (
      (child.kind === ts.SyntaxKind.ColonToken &&
        next !== undefined &&
        ts.isTypeNode(next) &&
        !ts.isConditionalExpression(node)) ||
      (child.kind === ts.SyntaxKind.LessThanToken &&
        next !== undefined &&
        next.kind === ts.SyntaxKind.SyntaxList &&
        isTypeList(next, file)) ||
      (child.kind === ts.SyntaxKind.GreaterThanToken &&
        index > 0 &&
        children[index - 1]?.kind === ts.SyntaxKind.SyntaxList &&
        isTypeList(children[index - 1] as ts.Node, file))
    ) {
      continue;
    }
    if (
      (child.kind === ts.SyntaxKind.QuestionToken ||
        child.kind === ts.SyntaxKind.ExclamationToken) &&
      (ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node))
    ) {
      continue;
    }
    if (ts.isNonNullExpression(node) && child.kind === ts.SyntaxKind.ExclamationToken) continue;
    if (
      (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) &&
      (child.kind === ts.SyntaxKind.AsKeyword || child.kind === ts.SyntaxKind.SatisfiesKeyword)
    ) {
      continue;
    }
    if (TYPE_ONLY_MODIFIERS.has(child.kind) && !ts.isParameter(node)) continue;
    if (child.kind === ts.SyntaxKind.SyntaxList && isModifierList(child)) {
      for (const modifier of child.getChildren(file)) {
        if (TYPE_ONLY_MODIFIERS.has(modifier.kind) && !ts.isParameter(node)) continue;
        collect(modifier, file, out);
      }
      continue;
    }
    collect(child, file, out);
  }
}

function isTypeList(list: ts.Node, file: ts.SourceFile): boolean {
  const items = list.getChildren(file).filter((item) => item.kind !== ts.SyntaxKind.CommaToken);
  return (
    items.length > 0 &&
    items.every((item) => ts.isTypeNode(item) || ts.isTypeParameterDeclaration(item))
  );
}

function isModifierList(list: ts.Node): boolean {
  const parent = list.parent;
  return (
    parent !== undefined &&
    ts.canHaveModifiers(parent) &&
    (ts.getModifiers(parent) ?? []).length > 0 &&
    list.pos === (ts.getModifiers(parent) ?? [])[0]?.pos
  );
}

function pragmas(text: string): Array<Token> {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, text);
  const out: Array<Token> = [];
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (
      (kind === ts.SyntaxKind.SingleLineCommentTrivia ||
        kind === ts.SyntaxKind.MultiLineCommentTrivia) &&
      PRAGMA.test(scanner.getTokenText())
    ) {
      out.push({
        text: scanner.getTokenText(),
        start: scanner.getTokenStart(),
        end: scanner.getTokenEnd(),
      });
    }
    kind = scanner.scan();
  }
  return out;
}

/** Runtime tokens of a script: no comments except pragmas, no type-only syntax. */
export function runtimeTokens(path: string, text: string): ReadonlyArray<Token> {
  const file = parse(path, text);
  const out: Array<Token> = [];
  collect(file, file, out);
  out.push(...pragmas(text));
  return out.toSorted((a, b) => a.start - b.start);
}

/** Edit script between two token sequences as index ranges `[aStart, aEnd, bStart, bEnd)`. */
export function diffTokens(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): ReadonlyArray<readonly [number, number, number, number]> {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  if (aMid.length === 0 && bMid.length === 0) return [];
  const hunks = myers(aMid, bMid);
  if (hunks === null) return [[prefix, a.length - suffix, prefix, b.length - suffix]];
  return hunks.map(
    ([as, ae, bs, be]) => [as + prefix, ae + prefix, bs + prefix, be + prefix] as const,
  );
}

const MAX_EDIT_DISTANCE = 4000;

/** Myers' O((N+M)D) diff; `null` when the edit distance exceeds the cap. */
function myers(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): Array<readonly [number, number, number, number]> | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Array<Int32Array> = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) {
        x = v[offset + k + 1] ?? 0;
      } else {
        x = (v[offset + k - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
    if (found !== -1) {
      trace.push(v.slice());
      break;
    }
  }
  if (found === -1) return null;
  const edits: Array<readonly ["del" | "ins", number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d] as Int32Array;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && (prev[offset + k - 1] ?? 0) < (prev[offset + k + 1] ?? 0))
        ? k + 1
        : k - 1;
    const prevX = prev[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x === prevX) edits.push(["ins", prevX, prevY]);
    else edits.push(["del", prevX, prevY]);
    x = prevX;
    y = prevY;
  }
  edits.reverse();
  const hunks: Array<[number, number, number, number]> = [];
  for (const [op, ex, ey] of edits) {
    const last = hunks.at(-1);
    const aEnd = op === "del" ? ex + 1 : ex;
    const bEnd = op === "ins" ? ey + 1 : ey;
    if (last !== undefined && last[1] === ex && last[3] === ey) {
      last[1] = aEnd;
      last[3] = bEnd;
    } else {
      hunks.push([ex, aEnd, ey, bEnd]);
    }
  }
  return hunks;
}

/** Innermost block, function or file containing `position`, as a range. */
function enclosingBlock(file: ts.SourceFile, position: number): Range {
  let best: Range = [0, file.text.length];
  const visit = (node: ts.Node): void => {
    if (position < node.getStart(file) || position > node.end) return;
    if (
      ts.isBlock(node) ||
      ts.isFunctionLike(node) ||
      ts.isClassLike(node) ||
      ts.isModuleBlock(node)
    ) {
      best = [node.getStart(file), node.end];
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return best;
}

export interface ChangedRanges {
  /** Runtime token changes at base positions. */
  readonly base: ReadonlyArray<Range>;
  /** Runtime token changes at head positions. */
  readonly head: ReadonlyArray<Range>;
}

/**
 * Changed runtime ranges of a script edited between base and head. A pure insertion maps, on the
 * base side, to the innermost enclosing block; a pure deletion does the same on the head side.
 * `null` text means the file is absent on that side.
 */
export function changedRanges(
  path: string,
  baseText: string | null,
  headText: string | null,
): ChangedRanges {
  if (baseText === null || headText === null) {
    return {
      base: baseText === null ? [] : [[0, baseText.length]],
      head: headText === null ? [] : [[0, headText.length]],
    };
  }
  const baseTokens = runtimeTokens(path, baseText);
  const headTokens = runtimeTokens(path, headText);
  const hunks = diffTokens(
    baseTokens.map((token) => token.text),
    headTokens.map((token) => token.text),
  );
  if (hunks.length === 0) return { base: [], head: [] };
  const baseFile = parse(path, baseText);
  const headFile = parse(path, headText);
  const base: Array<Range> = [];
  const head: Array<Range> = [];
  const span = (tokens: ReadonlyArray<Token>, start: number, end: number): Range => [
    tokens[start]?.start ?? 0,
    tokens[end - 1]?.end ?? 0,
  ];
  const point = (tokens: ReadonlyArray<Token>, index: number, text: string): number =>
    tokens[index]?.start ?? tokens[index - 1]?.end ?? text.length;
  for (const [as, ae, bs, be] of hunks) {
    base.push(
      as < ae
        ? span(baseTokens, as, ae)
        : enclosingBlock(baseFile, point(baseTokens, as, baseText)),
    );
    head.push(
      bs < be
        ? span(headTokens, bs, be)
        : enclosingBlock(headFile, point(headTokens, bs, headText)),
    );
  }
  return { base, head };
}
