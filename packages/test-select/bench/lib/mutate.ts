import ts from "typescript";

import { changedRanges, parse, runtimeTokens, type Range, type Token } from "./tokens.ts";

export type Random = () => number;

/** Mulberry32: a small seeded generator, so a seed always yields the same cases. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: Random, items: ReadonlyArray<T>): T | undefined {
  return items.length === 0 ? undefined : items[Math.floor(random() * items.length)];
}

export function shuffle<T>(random: Random, items: ReadonlyArray<T>): Array<T> {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    const a = out[index] as T;
    out[index] = out[other] as T;
    out[other] = a;
  }
  return out;
}

export interface Mutation {
  readonly operator: string;
  readonly text: string;
  /** Line of the mutated location, 1-based. */
  readonly line: number;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const BINARY_SWAPS: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.PlusToken, "-"],
  [ts.SyntaxKind.MinusToken, "+"],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "!=="],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "==="],
  [ts.SyntaxKind.EqualsEqualsToken, "!="],
  [ts.SyntaxKind.ExclamationEqualsToken, "=="],
  [ts.SyntaxKind.LessThanToken, "<="],
  [ts.SyntaxKind.LessThanEqualsToken, "<"],
  [ts.SyntaxKind.GreaterThanToken, ">="],
  [ts.SyntaxKind.GreaterThanEqualsToken, ">"],
  [ts.SyntaxKind.AmpersandAmpersandToken, "||"],
  [ts.SyntaxKind.BarBarToken, "&&"],
  [ts.SyntaxKind.QuestionQuestionToken, "||"],
]);

function isInTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return true;
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
    if (ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return true;
  }
  return false;
}

/** Candidate edits for the operators of DESIGN.md §14.4 at `node`, innermost first. */
function operatorsAt(
  node: ts.Node,
  file: ts.SourceFile,
): Array<{ readonly operator: string; readonly edit: Edit }> {
  const text = file.text;
  const out: Array<{ readonly operator: string; readonly edit: Edit }> = [];
  const span = (target: ts.Node): readonly [number, number] => [target.getStart(file), target.end];
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (isInTypePosition(current)) return out;
    if (ts.isBinaryExpression(current)) {
      const swap = BINARY_SWAPS.get(current.operatorToken.kind);
      if (swap !== undefined) {
        const [start, end] = span(current.operatorToken);
        out.push({ operator: "replace binary operator", edit: { start, end, text: swap } });
      }
    }
    if (current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword) {
      const [start, end] = span(current);
      out.push({
        operator: "flip boolean",
        edit: { start, end, text: current.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true" },
      });
    }
    if (ts.isNumericLiteral(current)) {
      const value = Number(current.text);
      if (Number.isFinite(value)) {
        const [start, end] = span(current);
        out.push({ operator: "off-by-one numeric", edit: { start, end, text: String(value + 1) } });
      }
    }
    if (
      ts.isStringLiteral(current) &&
      !ts.isImportDeclaration(current.parent) &&
      !ts.isExternalModuleReference(current.parent)
    ) {
      const [start, end] = span(current);
      out.push({
        operator: "change string",
        edit: { start, end, text: JSON.stringify(`${current.text}_mutant`) },
      });
    }
    if (
      (ts.isIfStatement(current) ||
        ts.isWhileStatement(current) ||
        ts.isConditionalExpression(current)) &&
      current !== node
    ) {
      const condition = ts.isConditionalExpression(current)
        ? current.condition
        : current.expression;
      const [start, end] = span(condition);
      out.push({
        operator: "negate condition",
        edit: { start, end, text: `!(${text.slice(start, end)})` },
      });
    }
    if (ts.isReturnStatement(current) && current.expression !== undefined) {
      const [start, end] = span(current.expression);
      out.push({ operator: "replace return value", edit: { start, end, text: "undefined" } });
    }
    if (ts.isAwaitExpression(current)) {
      const [start] = span(current);
      out.push({
        operator: "drop await",
        edit: { start, end: current.expression.getStart(file), text: "" },
      });
    }
    if (current.parent !== undefined && ts.isArrayLiteralExpression(current.parent)) {
      const [start, end] = span(current);
      const after = text.slice(end).match(/^\s*,/)?.[0].length ?? 0;
      out.push({ operator: "remove array element", edit: { start, end: end + after, text: "" } });
    }
    if (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) {
      const [start, end] = span(current);
      const after = text.slice(end).match(/^\s*,/)?.[0].length ?? 0;
      out.push({ operator: "remove object property", edit: { start, end: end + after, text: "" } });
    }
    if (ts.isExpressionStatement(current)) {
      const [start, end] = span(current);
      out.push({ operator: "delete statement", edit: { start, end, text: "" } });
    }
    if (
      ts.isFunctionLike(current) &&
      "body" in current &&
      current.body !== undefined &&
      ts.isBlock(current.body)
    ) {
      const open = current.body.getStart(file) + 1;
      out.push({
        operator: "throw at function entry",
        edit: { start: open, end: open, text: ' throw new Error("test-select mutant");' },
      });
      break;
    }
  }
  return out;
}

export function hasSyntaxErrors(path: string, text: string): boolean {
  const result = ts.transpileModule(text, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  return (result.diagnostics ?? []).some(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
}

function tokenNode(file: ts.SourceFile, position: number): ts.Node {
  let found: ts.Node = file;
  const visit = (node: ts.Node): void => {
    if (position < node.getStart(file) || position >= node.end) return;
    found = node;
    node.getChildren(file).forEach(visit);
  };
  file.getChildren(file).forEach(visit);
  return found;
}

/**
 * Applies one operator at a runtime token chosen uniformly among those inside `within` (all
 * tokens when `within` is null). Retries other tokens until the result parses and changes runtime
 * tokens; `null` when no token qualifies.
 */
export function mutateScript(
  random: Random,
  path: string,
  text: string,
  within: ReadonlyArray<Range> | null,
  outside: ReadonlyArray<Range> | null = null,
): Mutation | null {
  const file = parse(path, text);
  const tokens = runtimeTokens(path, text).filter((token: Token) => {
    const inside =
      within === null || within.some(([start, end]) => token.start >= start && token.end <= end);
    const excluded =
      outside !== null && outside.some(([start, end]) => token.start < end && start < token.end);
    return inside && !excluded;
  });
  for (const token of shuffle(random, tokens).slice(0, 40)) {
    const candidates = operatorsAt(tokenNode(file, token.start), file);
    for (const candidate of shuffle(random, candidates).slice(0, 3)) {
      const next =
        text.slice(0, candidate.edit.start) + candidate.edit.text + text.slice(candidate.edit.end);
      if (next === text || hasSyntaxErrors(path, next)) continue;
      const changed = changedRanges(path, text, next);
      if (changed.head.length === 0 && changed.base.length === 0) continue;
      if (
        outside !== null &&
        changed.base.some(([start, end]) => outside.some(([a, b]) => start < b && a < end))
      ) {
        continue;
      }
      const line = text.slice(0, candidate.edit.start).split("\n").length;
      return { operator: candidate.operator, text: next, line };
    }
  }
  return null;
}
