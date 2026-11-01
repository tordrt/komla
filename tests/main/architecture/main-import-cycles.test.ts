import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, normalize, relative } from 'path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const MAIN_ROOT = join(__dirname, '../../../src/main');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !entry.endsWith('.d.ts') ? [path] : [];
  });
}

/** What a declaration's module specifier is, when importing it runs that module's code. */
function valueImportSpecifier(statement: ts.Statement): string | undefined {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause?.isTypeOnly) return undefined;
    const bindings = clause?.namedBindings;
    const onlyTypes =
      !clause?.name &&
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly);
    return onlyTypes ? undefined : (statement.moduleSpecifier as ts.StringLiteral).text;
  }
  if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
    const clause = statement.exportClause;
    const onlyTypes =
      clause &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly);
    return onlyTypes ? undefined : (statement.moduleSpecifier as ts.StringLiteral).text;
  }
  return undefined;
}

function valueImportGraph(): Map<string, string[]> {
  const files = new Set(sourceFiles(MAIN_ROOT));
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest);
    const imports = source.statements.flatMap((statement) => {
      const specifier = valueImportSpecifier(statement);
      if (!specifier?.startsWith('.')) return [];
      const base = normalize(join(dirname(file), specifier));
      const target = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((candidate) =>
        files.has(candidate)
      );
      return target ? [target] : [];
    });
    graph.set(file, imports);
  }
  return graph;
}

/** Groups of modules that import each other, directly or not (Tarjan's algorithm). */
function importCycles(graph: Map<string, string[]>): string[][] {
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (file: string): void => {
    indexes.set(file, indexes.size);
    lowLinks.set(file, indexes.get(file)!);
    stack.push(file);
    onStack.add(file);
    for (const target of graph.get(file) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(file, Math.min(lowLinks.get(file)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(file, Math.min(lowLinks.get(file)!, indexes.get(target)!));
      }
    }
    if (lowLinks.get(file) !== indexes.get(file)) return;
    const group: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      group.push(member);
    } while (member !== file);
    if (group.length > 1) cycles.push(group.map((path) => relative(MAIN_ROOT, path)).sort());
  };
  for (const file of graph.keys()) if (!indexes.has(file)) visit(file);
  return cycles;
}

describe('main process imports', () => {
  // Singletons are built while their modules load, so a module in a cycle can run before what it
  // imports exists, and which one does depends on the order modules are first imported.
  it('has no value-import cycles', () => {
    expect(importCycles(valueImportGraph())).toEqual([]);
  });
});
