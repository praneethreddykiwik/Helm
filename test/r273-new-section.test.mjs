// R273 (owner, 28 Nov 2026): Tasks & Crew > Add & assign lost its "new section" box in the R192 redesign; it is back as
// "+ New section" (a new checklist section / department, saved to the studio checklist with its first task).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const H = fs.readFileSync("public/ops.html", "utf8"), C = fs.readFileSync("public/ops-board.css", "utf8");
test("the New section box is in the What step", () => {
  assert.match(H, /id="catNew" hidden><input class="tc-inp" id="catNewIn" maxlength="60"/);
  assert.match(H, /id="catNewOk">Add section</); assert.match(H, /id="catNewX">Cancel</);
});
test("+ New section chip only for people who can assign tasks, and never a data-c chip", () => {
  assert.match(H, /canEditOps\?`<button type="button" class="tc-opt tc-opt-new" id="catNewBtn"/);
  assert.doesNotMatch(H, /tc-opt-new" data-c/);
  assert.match(H, /host\.querySelectorAll\("button\[data-c\]"\)/);
});
test("a new section is picked at once, duplicates pick the existing one, it is saved with its first task", () => {
  assert.match(H, /const same=CATS\.find\(c=>c\.toLowerCase\(\)===name\.toLowerCase\(\)\)/);
  assert.match(H, /if\(!same\) CATS\.push\(name\);/);
  assert.match(H, /activeCat=same\|\|name;/);
  assert.match(H, /\.slice\(0,60\)/);
  assert.match(H, /await BPStore\.ops\.addTemplate\(cat,title\)/);
});
test("style", () => { assert.match(C, /\.tc-opt-new\{border-style:dashed/); });
test("the name box really hides (.tc-inline is display:flex)", () => { assert.match(C, /#catNew\[hidden\]\{display:none\}/); });
