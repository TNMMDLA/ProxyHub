import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const sourceRoot = join(process.cwd(), 'apps', 'web', 'src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)
        ? [path]
        : [];
  });
}

describe('localized UI source policy', () => {
  const files = sourceFiles(sourceRoot);

  it('does not add literal PageHeader or Modal titles and descriptions', () => {
    const violations = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const matches = [
        ...source.matchAll(/<(?:PageHeader|Modal)[\s\S]{0,240}?\b(?:title|description)="[^"]+"/gu),
      ];
      return matches.map((match) => `${file}:${match[0]}`);
    });
    expect(violations).toEqual([]);
  });

  it('does not render raw HTML or translate by mutating the DOM', () => {
    const violations = files.filter((file) =>
      /dangerouslySetInnerHTML|\.innerHTML\s*=|document\.body\.innerText/gu.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(violations).toEqual([]);
  });

  it('keeps language persistence centralized', () => {
    const writers = files.filter((file) =>
      /localStorage\.setItem\(\s*['"]proxyhub\.locale/gu.test(readFileSync(file, 'utf8')),
    );
    expect(writers).toEqual([]);
  });

  it('does not leave prose-like literals in JSX text or accessibility attributes', () => {
    const allowedLiterals = new Set([
      'ProxyHub',
      '⌘K',
      '© 2026 ProxyHub · MIT License',
      '24H',
      '7D',
      '30D',
      'Xray',
      'Xray Core',
      'ms',
      's',
      'VLESS · Reality · Vision',
      'https://rules.example.com/list',
      'DOMAIN_SUFFIX,example.com',
      'Mihomo / Clash',
      'sing-box',
      'Raw VLESS URIs',
      'ETag',
    ]);
    const violations: string[] = [];

    for (const file of files.filter((path) => path.endsWith('.tsx'))) {
      const source = readFileSync(file, 'utf8');
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const inspect = (node: ts.Node): void => {
        let literal: string | null = null;
        if (ts.isJsxText(node)) literal = node.text.replace(/\s+/gu, ' ').trim();
        if (
          ts.isJsxAttribute(node) &&
          ts.isIdentifier(node.name) &&
          ['aria-label', 'placeholder', 'title'].includes(node.name.text) &&
          node.initializer &&
          ts.isStringLiteral(node.initializer)
        ) {
          literal = node.initializer.text.trim();
        }
        if (literal && /[A-Za-z\u4e00-\u9fff]/u.test(literal) && !allowedLiterals.has(literal)) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push(`${file}:${String(position.line + 1)}:${literal}`);
        }
        ts.forEachChild(node, inspect);
      };
      inspect(sourceFile);
    }

    expect(violations).toEqual([]);
  });
});
