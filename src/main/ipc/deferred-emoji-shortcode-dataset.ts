import { createRequire } from 'node:module'
import type { EmojiShortcodeDataset } from '../../shared/emoji-shortcode-catalog'

// Why createRequire (same reason as linear-sdk.ts): a static import inlines the 166 KB
// shortcode dataset into out/main/index.js and JSON.parses it on every launch, while only
// worktree-name sanitization ever reads it. `emojibase-data` is a production dependency, so
// the packaged app.asar resolves this the same way it resolves any other bare require.
const requireFromMain = createRequire(__filename)

export function requireEmojiShortcodeDataset(): EmojiShortcodeDataset {
  return requireFromMain('emojibase-data/en/shortcodes/emojibase.json') as EmojiShortcodeDataset
}
