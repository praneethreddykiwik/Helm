// R175: shared check for the owner's Desktop paste copies (APPLY-*.sql next to the repo on the owner's Mac).
// CI has no Desktop, so the check never runs there. On the Mac, iCloud "Optimise Mac storage" can offload a
// file to a dataless placeholder: stat() still reports the real size but no blocks are on disk, and reading it
// blocks on an iCloud download (the tests then hung or failed). Such a placeholder is SKIPPED, not failed.
// A file that IS on disk must still match the repo byte for byte (the owner pastes it), as before.
import { existsSync, readFileSync, statSync } from "node:fs";

// true when the path is an offloaded iCloud placeholder (size > 0, nothing stored locally)
export function isOffloaded(file) {
  try { const s = statSync(file); return s.size > 0 && s.blocks === 0; } catch (_) { return false; }
}

// "missing" | "offloaded" | "checked" - throws (via assert) only when a local copy differs from the repo text
export function checkOwnerFile(file, expected, assert, label = "owner paste file = repo APPLY") {
  if (!existsSync(file)) return "missing";
  if (isOffloaded(file)) return "offloaded";
  assert.equal(readFileSync(file, "utf8"), expected, label);
  return "checked";
}
