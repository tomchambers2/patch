// controlTokens — strip internal `[[…]]` control markers from message text
// before it is shown in a transcript bubble or a sidebar preview.
//
// The host's dev/SDK layer recognises bracketed control markers in a prompt
// ([[edit]], [[permission]], [[tool]], [[bash-permission]]) and turns them into
// their intended UI affordance (a file-edit tool call, a permission card, …).
// They are CONTROL tokens, not content — they
// must never leak into the rendered chat transcript as literal user/assistant
// text (spec/14: such tokens are "either suppressed or transformed into their
// intended UI affordance"). G2-d1.
//
// We strip ANY `[[word]]` token (not just the known set) so a future marker
// can't regress this, then collapse the whitespace the removal leaves behind.

const CONTROL_TOKEN_RE = /\[\[[a-z][a-z0-9_-]*\]\]/gi;

export function stripControlTokens(text: string): string {
  if (!text.includes('[[')) return text;
  return (
    text
      .replace(CONTROL_TOKEN_RE, '')
      // Collapse the doubled spaces / dangling whitespace the removal leaves
      // (e.g. "please [[edit]] the file" → "please  the file" → "please the file").
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([.,;:!?])/g, '$1')
      .replace(/^[ \t]+|[ \t]+$/gm, '')
      .trim()
  );
}
