// Augments react-native-markdown-display's own .d.ts, which is missing two
// real, top-level exports (checked against the pinned 7.0.2 source
// directly): `styles` and `removeTextStyleProps` — both part of the
// library's own index.js `export {...}` block, just omitted here.
//
// NOT fixed here (TS declaration merging can't override an existing class
// constructor's arity — attempted, silently lost to the original): the
// `.d.ts`'s `AstRenderer` constructor is declared as `(renderRules,
// style?)`, two params, but the real class takes eight — see
// ChatMarkdown.tsx's own comment for the local cast that works around this,
// and around `parser`'s declared renderer-param type also not matching
// `AstRenderer.render`'s real one.
// The `import` below is load-bearing and otherwise pointless: without SOME
// import/export at the top, TS treats this file as a script, and the
// `declare module` below becomes a wholesale AMBIENT replacement of the
// library's real .d.ts (dropping every export it doesn't repeat) instead of
// an augmentation merged with it.
import 'react-native-markdown-display';

declare module 'react-native-markdown-display' {
  export const styles: Record<string, object>;
  export function removeTextStyleProps(style: object): object;
}
