/**
 * tree-sitter-grammars.d.ts
 *
 * The tree-sitter *grammar* packages don't ship TypeScript types (only the core
 * `tree-sitter` package does). These ambient declarations tell the compiler the
 * shape of each grammar module so we can import them without `any` errors.
 *
 * A "Language" is an opaque object you hand to Parser.setLanguage(); we don't
 * need its internals, so typing it loosely is fine.
 */
declare module 'tree-sitter-javascript' {
  const language: unknown;
  export = language;
}

declare module 'tree-sitter-python' {
  const language: unknown;
  export = language;
}

declare module 'tree-sitter-typescript' {
  // This grammar package exposes two languages: plain TS and TSX (JSX-aware).
  const grammars: { typescript: unknown; tsx: unknown };
  export = grammars;
}
