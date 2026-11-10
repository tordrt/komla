import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const MAIN_ROOT = join(__dirname, '../../../src/main');
const INDEX = join(MAIN_ROOT, 'index.ts');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !entry.endsWith('.d.ts') ? [path] : [];
  });
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
}

function descendants(node: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (child: ts.Node): void => {
    found.push(child);
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return found;
}

/** The `app.on(...)` and `app.once(...)` calls in a file that listen for the app quitting. */
function quitListeners(source: ts.SourceFile): ts.CallExpression[] {
  return descendants(source).filter((node): node is ts.CallExpression => {
    if (!ts.isCallExpression(node) || !/^app\.(on|once)$/.test(node.expression.getText())) {
      return false;
    }
    const [event] = node.arguments;
    return ts.isStringLiteral(event) && ['before-quit', 'will-quit', 'quit'].includes(event.text);
  });
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const found = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && candidate.name.getText() === name
  );
  return found?.initializer;
}

describe('the quit sequence', () => {
  const index = parse(INDEX);

  // A teardown in a listener of its own runs outside the phases, in no order with them.
  it('is the only thing in the main process that listens for the app quitting', () => {
    const listeners = sourceFiles(MAIN_ROOT).flatMap((file) =>
      quitListeners(parse(file)).map(
        (call) => `${relative(MAIN_ROOT, file)}: ${(call.arguments[0] as ts.StringLiteral).text}`
      )
    );

    expect(listeners).toEqual(['index.ts: before-quit']);
  });

  it('is all that the before-quit listener runs', () => {
    const [listener] = quitListeners(index);
    const calls = descendants(listener.arguments[1])
      .filter(ts.isCallExpression)
      .map((call) => call.expression.getText());

    expect(calls.toSorted()).toEqual([
      'event.preventDefault',
      'quitSequence.request',
      'quitSequence.state',
    ]);
  });

  it('is made once, from the one list of phases', () => {
    const sequences = descendants(index).filter(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && node.expression.getText() === 'createQuitSequence'
    );
    expect(sequences).toHaveLength(1);
    const options = sequences[0].arguments[0] as ts.ObjectLiteralExpression;
    expect(property(options, 'phases')?.getText()).toBe('QUIT_PHASES');

    const lists = descendants(index).filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && node.name.getText() === 'QUIT_PHASES'
    );
    expect(lists).toHaveLength(1);
    // Written out in place, so the whole order can be read there.
    const phases = lists[0].initializer;
    expect(phases && ts.isArrayLiteralExpression(phases)).toBe(true);
    const names = (phases as ts.ArrayLiteralExpression).elements.map((phase) => {
      expect(ts.isObjectLiteralExpression(phase)).toBe(true);
      const name = property(phase as ts.ObjectLiteralExpression, 'name');
      expect(name && ts.isStringLiteral(name)).toBe(true);
      return (name as ts.StringLiteral).text;
    });
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });
});
