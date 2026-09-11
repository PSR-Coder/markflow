// Headless smoke test for the built MarkFlow app.
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:4173';
const errors = [];
const fails = [];
const ok = (name, cond) => { console.log((cond ? '  ✔ ' : '  ✘ ') + name); if (!cond) fails.push(name); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

console.log('— boot —');
ok('CodeMirror editor mounted', await page.locator('.cm-editor').count() === 1);
ok('welcome content in editor', (await page.locator('.cm-content').innerText()).includes('Welcome to MarkFlow'));
ok('preview rendered H1', await page.locator('#preview h1').first().isVisible());
ok('KaTeX rendered (e^{iπ})', await page.locator('#preview .katex').count() > 0);
ok('Mermaid SVG rendered', await page.locator('#preview .mermaid-diagram svg, #preview .mermaid-diagram[data-error]').count() > 0);
ok('code highlighted (hljs)', await page.locator('#preview pre code span[class*="hljs"]').count() > 0);
ok('task list checkboxes rendered', await page.locator('#preview .task-list-item input[type="checkbox"]').count() >= 3);
ok('footnote section rendered', await page.locator('#preview .footnotes').count() === 1);
ok('sidebar lists Welcome doc', (await page.locator('#docList').innerText()).includes('Welcome to MarkFlow'));

console.log('— R3 sheet UI: letter bar + number gutter + corner —');
await page.locator('.table-wrap').hover();
await page.locator('.table-wrap .table-edit-btn').click();
await page.waitForTimeout(400);
ok('table editor modal opened', await page.locator('.te-grid').isVisible());
ok('letter bar shows A,B,C plus a corner cell',
  (await page.locator('.te-letter').allTextContents()).join('').trim() === 'ABC' && await page.locator('.te-corner').count() === 1);
ok('row numbers 1..5, row 1 = header', (await page.locator('.te-num').allTextContents()).join('') === '12345');
ok('header row visually distinct', await page.locator('.te-grid tr.te-hrow').count() === 1);
ok('per-cell ops clutter is gone', await page.locator('.te-ops').count() === 0);
ok('ops bar + readout exist', await page.locator('.te-bar').isVisible() && (await page.locator('.te-readout').innerText()).includes('No selection'));
ok('ops bar pinned at the TOP of the editor window', await page.evaluate(() => {
  const root = document.querySelector('.te-root');
  const bar = root.querySelector('.te-bar');
  const stage = root.querySelector('.te-stage');
  const bb = bar.getBoundingClientRect(); const sb = stage.getBoundingClientRect();
  return bb.bottom <= sb.top + 2 && getComputedStyle(bar).position === 'sticky';
}));

console.log('— R-3 selection + guarded delete via bar —');
await page.locator('.te-num[data-ri="2"]').click();
ok('readout tracks selection (Row 3)', (await page.locator('.te-readout').innerText()).includes('Row 3'));
ok('row number highlight + cells highlight', await page.locator('.te-num[data-ri="2"].te-sel').count() === 1
  && await page.locator('.te-grid td[data-r="2"].te-sel').count() === 3);
const delRow = page.locator('.te-bar button[aria-label="Delete row"]');
ok('Delete row visible in bar (no hover fishing)', await delRow.isVisible() && await delRow.isEnabled());
await delRow.click();
await page.waitForTimeout(180);
ok('row deleted via bar', await page.locator('.te-grid tbody tr').count() === 4);
await page.locator('.te-bar button[aria-label="Undo"]').click();
await page.waitForTimeout(180);
ok('undo restores the row', await page.locator('.te-grid tbody tr').count() === 5);
await page.locator('.te-bar button[aria-label="Redo"]').click();
await page.waitForTimeout(180);
ok('redo deletes it again', await page.locator('.te-grid tbody tr').count() === 4);
await page.locator('.te-num[data-ri="0"]').click();
const delHeader = page.locator('.te-bar button[aria-label="Delete row"]');
ok('header delete disabled WITH reason', await delHeader.isDisabled()
  && (await delHeader.getAttribute('title')).includes('header row is required'));
ok('no Make-header button while header selected', await page.locator('.te-bar button[aria-label="Make this row the header row"]').count() === 0);

console.log('— contextual + geometry: clipped 12% corner hotspots only —');
const moveTo = async (selector, xRatio, yRatio) => {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width * xRatio, box.y + box.height * yRatio);
};
const moveToCorner = async (selector, corner, factor = 0.5) => {
  const box = await page.locator(selector).boundingBox();
  const radius = Math.min(box.width, box.height) * 0.12;
  const x = corner.endsWith('right') ? box.x + box.width - radius * factor : box.x + radius * factor;
  const y = corner.startsWith('bottom') ? box.y + box.height - radius * factor : box.y + radius * factor;
  await page.mouse.move(x, y);
};
const moveJustOutsideCorner = async (selector, corner) => {
  await page.evaluate(({ selector: targetSelector, corner: targetCorner }) => {
    const target = document.querySelector(targetSelector);
    const rect = target.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) * 0.12;
    const clientX = targetCorner.endsWith('right') ? rect.right - radius * 1.01 : rect.left + radius * 1.01;
    const clientY = targetCorner.startsWith('bottom') ? rect.bottom - radius * 1.01 : rect.top + radius * 1.01;
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY }));
  }, { selector, corner });
};
const moveOutsideCorner = async (selector, corner) => {
  await page.evaluate(({ selector: targetSelector, corner: targetCorner }) => {
    const target = document.querySelector(targetSelector);
    const rect = target.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) * 0.12;
    const clientX = targetCorner.endsWith('right') ? rect.right + radius * 0.5 : rect.left - radius * 0.5;
    const clientY = targetCorner.startsWith('bottom') ? rect.bottom - radius * 0.5 : rect.top + radius * 0.5;
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY }));
  }, { selector, corner });
};
const noHandles = async () => await page.locator('.te-hh.on').count() === 0;
const rowNum = '.te-num[data-ri="2"]';
const colB = '.te-letter[data-ci="1"]';

for (const [name, x, y] of [
  ['row center', .5, .5], ['row top-center', .5, .01], ['row bottom-center', .5, .99],
  ['row middle-left', .01, .5], ['row top-right', .99, .01], ['row bottom-right', .99, .99],
]) {
  await moveTo(rowNum, x, y);
  ok(`${name} does not trigger Row +`, await noHandles());
}
await moveToCorner(rowNum, 'top-left');
ok('row top-left 12% hotspot shows Row +', await page.locator('.te-hh-h.on').count() === 1 && await page.locator('.te-hh-v.on').count() === 0
  && (await page.locator('.te-hh-h button').getAttribute('aria-label')) === 'Insert row above row 3');
await moveToCorner(rowNum, 'bottom-left');
ok('row bottom-left 12% hotspot shows Row +', await page.locator('.te-hh-h.on').count() === 1
  && (await page.locator('.te-hh-h button').getAttribute('aria-label')) === 'Insert row below row 3');
await moveJustOutsideCorner(rowNum, 'top-left');
ok('just outside row top-left radius hides Row +', await noHandles());
await moveToCorner(rowNum, 'bottom-left');
await moveJustOutsideCorner(rowNum, 'bottom-left');
ok('just outside row bottom-left radius hides Row +', await noHandles());
await moveToCorner(rowNum, 'top-left');
await moveOutsideCorner(rowNum, 'top-left');
ok('inside-radius point outside the row-number rectangle is hidden', await noHandles());

for (const selector of ['td[data-r="2"][data-c="0"]', 'td[data-r="2"][data-c="1"]', '.te-letter[data-ci="1"]', '.te-num[data-ri="2"] .te-grip-r']) {
  await moveTo(selector, .5, .5);
  ok(`${selector} cannot trigger Row + or Column +`, await noHandles());
}
await moveTo('.te-num[data-ri="2"] .te-grip-r', .5, .5);
ok('row resize grip has priority over contextual handles', await noHandles());
await page.locator('.te-hint').hover({ position: { x: 40, y: 4 } });
ok('outside the table hides both contextual handles', await noHandles());

for (const [name, x, y] of [
  ['column center', .5, .5], ['column top-center', .5, .01], ['column bottom-left', .01, .99],
  ['column bottom-center', .5, .99], ['column bottom-right', .99, .99],
]) {
  await moveTo(colB, x, y);
  ok(`${name} does not trigger Column +`, await noHandles());
}
await moveToCorner(colB, 'top-left');
ok('column top-left 12% hotspot shows Column +', await page.locator('.te-hh-v.on').count() === 1 && await page.locator('.te-hh-h.on').count() === 0
  && (await page.locator('.te-hh-v button').getAttribute('aria-label')) === 'Insert column before B');
await moveToCorner(colB, 'top-right');
ok('column top-right 12% hotspot shows Column +', await page.locator('.te-hh-v.on').count() === 1
  && (await page.locator('.te-hh-v button').getAttribute('aria-label')) === 'Insert column after B');
await moveToCorner('.te-letter[data-ci="2"]', 'top-right');
ok('moving from one column corner to the next updates the active boundary',
  (await page.locator('.te-hh-v button').getAttribute('aria-label')) === 'Insert column after C');
ok('contextual handles have no visible or layout guide line', await page.evaluate(() => {
  const h = document.querySelector('.te-hh-v');
  const r = h.getBoundingClientRect();
  return getComputedStyle(h).backgroundColor === 'rgba(0, 0, 0, 0)' && r.width === 0 && r.height === 0;
}));
await moveJustOutsideCorner(colB, 'top-left');
ok('just outside column top-left radius hides Column +', await noHandles());
await moveToCorner(colB, 'top-right');
await moveJustOutsideCorner(colB, 'top-right');
ok('just outside column top-right radius hides Column +', await noHandles());
await moveToCorner(colB, 'top-left');
await moveOutsideCorner(colB, 'top-left');
ok('inside-radius point outside the column-letter rectangle is hidden', await noHandles());
for (const selector of ['td[data-r="2"][data-c="1"]', '.te-num[data-ri="2"]', '.te-letter[data-ci="1"] .te-grip-c']) {
  await moveTo(selector, .5, .5);
  ok(`${selector} cannot trigger Column +`, await noHandles());
}
await moveTo('.te-letter[data-ci="1"] .te-grip-c', .5, .5);
ok('column resize grip has priority over contextual handles', await noHandles());

const shiftVal = await page.locator('td[data-r="2"][data-c="0"] input').inputValue();
await moveToCorner(rowNum, 'top-left');
await page.locator('.te-hh-h button').click();
await page.waitForTimeout(120);
ok('row top-left inserts exactly one row ABOVE row 3', await page.locator('.te-grid tbody tr').count() === 5
  && await page.locator('td[data-r="2"][data-c="0"] input').inputValue() === ''
  && await page.locator('td[data-r="3"][data-c="0"] input').inputValue() === shiftVal);
await page.locator('.te-bar button[aria-label="Undo"]').click();
await page.waitForTimeout(120);
await moveToCorner(rowNum, 'bottom-left');
await page.locator('.te-hh-h button').click();
await page.waitForTimeout(120);
ok('row bottom-left inserts exactly one row BELOW row 3', await page.locator('.te-grid tbody tr').count() === 5
  && await page.locator('td[data-r="2"][data-c="0"] input').inputValue() === shiftVal
  && await page.locator('td[data-r="3"][data-c="0"] input').inputValue() === '');
await page.locator('.te-bar button[aria-label="Undo"]').click();
await page.waitForTimeout(120);
const headerB = await page.locator('input.te-cell[data-r="0"][data-c="1"]').inputValue();
await moveToCorner(colB, 'top-left');
await page.locator('.te-hh-v button').click();
await page.waitForTimeout(120);
ok('column top-left inserts exactly one column BEFORE B', await page.locator('.te-letter').count() === 4
  && await page.locator('input.te-cell[data-r="0"][data-c="1"]').inputValue() === ''
  && await page.locator('input.te-cell[data-r="0"][data-c="2"]').inputValue() === headerB);
await page.locator('.te-bar button[aria-label="Undo"]').click();
await page.waitForTimeout(120);
await moveToCorner(colB, 'top-right');
await page.locator('.te-hh-v button').click();
await page.waitForTimeout(120);
ok('column top-right inserts exactly one column AFTER B', await page.locator('.te-letter').count() === 4
  && await page.locator('input.te-cell[data-r="0"][data-c="1"]').inputValue() === headerB
  && await page.locator('input.te-cell[data-r="0"][data-c="2"]').inputValue() === '');
await page.locator('.te-bar button[aria-label="Undo"]').click();
await page.waitForTimeout(120);
ok('row and column handles are mutually exclusive and data-cell safe', await noHandles() && await page.locator('.te-hh button').count() === 2);
await page.locator('.te-hint').hover({ position: { x: 40, y: 4 } });

console.log('— R3 bulk formatting + active state (header row) —');
await page.locator('.te-num[data-ri="0"]').click();
await page.locator('.te-bar button[aria-label="Bold"]').click();
await page.waitForTimeout(150);
const wrappedAll = await page.evaluate(() => [...document.querySelectorAll('input.te-cell[data-r="0"]')].every((i) => i.value.startsWith('**') && i.value.endsWith('**')));
ok('B bolds the whole header row', wrappedAll);
ok('Bold button shows ACTIVE for the selected row', await page.locator('.te-bar button[aria-label="Bold"].active').count() === 1);
await page.locator('.te-bar button[aria-label="Bold"]').click();
await page.waitForTimeout(150);
ok('B again unwraps (parity on selections too)', await page.evaluate(() => ![...document.querySelectorAll('input.te-cell[data-r="0"]')].some((i) => i.value.includes('**'))));

console.log('— R3 alignment is common: applies to column, live + active —');
// welcome doc column C arrives right-aligned from source — exercise apply AND toggle deterministically
await page.locator('.te-letter[data-ci="2"]').click();
await page.locator('.te-bar button[data-al="left"]').click();
await page.waitForTimeout(120);
await page.locator('.te-bar button[data-al="right"]').click();
await page.waitForTimeout(120);
ok('align right applies live to the whole column', await page.evaluate(() =>
  [...document.querySelectorAll('input.te-cell[data-c="2"]')].every((i) => i.style.textAlign === 'right')));
ok('align button shows ACTIVE', await page.locator('.te-bar button[data-al="right"].active').count() === 1);
await page.locator('.te-bar button[data-al="right"]').click();
await page.waitForTimeout(120);
ok('clicking the active align toggles back to default', await page.evaluate(() =>
  [...document.querySelectorAll('input.te-cell[data-c="2"]')].every((i) => i.style.textAlign === '')));
const headerBefore = await page.locator('input.te-cell[data-r="0"][data-c="0"]').inputValue();
await page.locator('.te-letter[data-ci="0"]').click();
await page.locator('.te-bar button[aria-label="Move column right"]').click();
await page.waitForTimeout(180);
ok('move column right works from bar', (await page.locator('input.te-cell[data-r="0"][data-c="1"]').inputValue()) === headerBefore);
await page.locator('.te-bar button[aria-label="Undo"]').click();
await page.waitForTimeout(150);
ok('undo restores column order & alignment', (await page.locator('input.te-cell[data-r="0"][data-c="0"]').inputValue()) === headerBefore
  && await page.evaluate(() => [...document.querySelectorAll('input.te-cell[data-c="2"]')].every((i) => i.style.textAlign !== 'right')));

console.log('— R3 duplicate row —');
const dupSrc = await page.locator('td[data-r="1"] input.te-cell').first().inputValue();
await page.locator('.te-num[data-ri="1"]').click();
await page.locator('.te-bar button[aria-label="Duplicate row"]').click();
await page.waitForTimeout(180);
ok('duplicate copies the row below it', await page.locator('.te-grid tbody tr').count() === 5
  && (await page.locator('td[data-r="2"] input.te-cell').first().inputValue()) === dupSrc);
await page.locator('.te-bar button[aria-label="Undo"]').click();
await page.waitForTimeout(150);

console.log('— R3 promote row to header (Move keeps the old header) —');
const oldHeader = await page.locator('input.te-cell[data-r="0"][data-c="0"]').inputValue();
const rowVal = await page.locator('input.te-cell[data-r="1"][data-c="0"]').inputValue();
await page.locator('.te-num[data-ri="1"]').click();
await page.locator('.te-bar button[aria-label="Make this row the header row"]').click();
await page.waitForTimeout(250);
ok('Replace/Move dialog opens as nested modal', await page.locator('.modal').count() === 2);
await page.locator('.te-hd-opt').nth(1).click(); // Move
await page.waitForTimeout(200);
ok('selected row became the header', (await page.locator('input.te-cell[data-r="0"][data-c="0"]').inputValue()) === rowVal);
ok('old header moved down to body row 2', (await page.locator('input.te-cell[data-r="1"][data-c="0"]').inputValue()) === oldHeader);
await page.locator('.te-bar button[aria-label="Undo"]').click();
await page.waitForTimeout(150);
ok('undo restores the header', (await page.locator('input.te-cell[data-r="0"][data-c="0"]').inputValue()) === oldHeader);

console.log('— R3 nested dialogs are Esc-safe; cell link —');
const linkCell = page.locator('td[data-r="1"][data-c="1"] input.te-cell');
await linkCell.click();
await page.locator('.te-bar button[aria-label="Link"]').click();
await page.waitForTimeout(250);
ok('link dialog opens nested (2 modals)', await page.locator('.modal').count() === 2);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok('Esc closes ONLY the link dialog — editor session survives', await page.locator('.modal').count() === 1 && await page.locator('.te-grid').isVisible());
await page.locator('.te-bar button[aria-label="Link"]').click();
await page.waitForTimeout(250);
await page.locator('#fd-url').fill('https://ex.com');
await page.locator('.modal').last().locator('.btn.primary').click();
await page.waitForTimeout(250);
ok('cell wrapped as [text](url)', /\[[^\]]+\]\(https:\/\/ex\.com\)/.test(await linkCell.inputValue()));

console.log('— R3 cell parity toggle via Ctrl+B —');
await linkCell.fill('shipped');
await page.keyboard.press('Control+b');
await page.waitForTimeout(150);
ok('Ctrl+B wraps in **', (await linkCell.inputValue()) === '**shipped**');
ok('Bold active also reflects focused cell', await page.locator('.te-bar button[aria-label="Bold"].active').count() === 1);
await page.keyboard.press('Control+b');
await page.waitForTimeout(150);
ok('Ctrl+B again unwraps', (await linkCell.inputValue()) === 'shipped');

console.log('— R3 keyboard navigation —');
await page.locator('td[data-r="1"][data-c="0"] input.te-cell').click();
await page.keyboard.press('Enter');
ok('Enter moves down one row', await page.evaluate(() => (document.activeElement)?.dataset?.r === '2'));
const lastIdx = await page.locator('.te-grid tbody tr').count() - 1;
await page.locator(`td[data-r="${lastIdx}"][data-c="2"] input.te-cell`).click();
await page.keyboard.press('Tab');
await page.waitForTimeout(180);
ok('Tab on the last cell creates a new row', await page.locator('.te-grid tbody tr').count() === lastIdx + 2);
ok('focus lands in the new row', await page.evaluate((r) => (document.activeElement)?.dataset?.r === String(r), lastIdx + 1));
await page.locator('.te-bar button[aria-label="Undo"]').click();
await page.waitForTimeout(150);

console.log('— R3 copy row as TSV (Excel round-trip) —');
await page.locator('.te-num[data-ri="1"]').click();
const tsv = await page.evaluate(() => {
  const dt = new DataTransfer();
  document.querySelector('.te-stage').dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
  return dt.getData('text/plain');
});
const expectTsv = await page.evaluate(() =>
  [...document.querySelectorAll('td[data-r="1"] input.te-cell')].map((i) => i.value).join('\t'));
ok('row copies to clipboard as TSV', tsv === expectTsv && expectTsv.split('\t').length === 3);

console.log('— R3 paste: header promotion + grid expansion —');
await page.evaluate(() => {
  const inp = document.querySelector('td[data-r="0"][data-c="0"] input.te-cell');
  const dt = new DataTransfer();
  dt.setData('text/plain', 'H1\tH2\tH3\np1\tp2\tp3\nq1\tq2\tq3');
  inp.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(250);
const headerVals = await page.evaluate(() => [...document.querySelectorAll('input.te-cell[data-r="0"]')].map((i) => i.value).slice(0, 3).join(','));
ok('pasted first row promoted to header', headerVals === 'H1,H2,H3');
await page.evaluate(() => {
  const inp = document.querySelector('td[data-r="1"][data-c="2"] input.te-cell');
  const dt = new DataTransfer();
  dt.setData('text/plain', 'x1\ty1\tz1');
  inp.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(200);
ok('paste beyond the grid expands columns', await page.locator('.te-letter').count() === 5);
await page.locator('.modal-foot .btn.ghost').click(); // Cancel — discard grid edits
await page.waitForTimeout(200);

console.log('— R3 insert-table size picker —');
await page.locator('.cm-line', { hasText: 'Three ways to work' }).first().click();
await page.waitForTimeout(150);
await page.locator('.tbtn[title^="Insert table"]').click();
await page.waitForTimeout(250);
ok('grid picker appears', await page.locator('.te-picker').isVisible());
await page.locator('.te-pick-cell[data-x="3"][data-y="2"]').click();
await page.waitForTimeout(350);
ok('picker opens prefilled editor (3 cols × header+1 row)',
  await page.locator('.te-letter').count() === 3 && await page.locator('.te-grid tbody tr').count() === 2);
await page.locator('.modal-foot .btn.ghost').click();
await page.waitForTimeout(200);

console.log('— doc formatting: parity + active states —');
await page.evaluate(() => {
  const view = document.querySelector('.cm-content');
  const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const idx = node.textContent.indexOf('Welcome to MarkFlow');
    if (idx >= 0) {
      const range = document.createRange();
      range.setStart(node, idx + 11);
      range.setEnd(node, idx + 19);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      break;
    }
  }
});
await page.keyboard.press('Control+b');
await page.waitForTimeout(250);
const srcBold = await page.locator('.cm-content').innerText();
ok('Ctrl+B wraps in **', srcBold.includes('**MarkFlow**'));
const bActive = await page.evaluate(() => [...document.querySelectorAll('.tbtn')].find((x) => (x.title || '').startsWith('Bold'))?.className || '');
ok('Bold button shows ACTIVE state over bold text', bActive.includes('active'));
await page.keyboard.press('Control+i');
await page.waitForTimeout(200);
const srcBoth = await page.locator('.cm-content').innerText();
ok('then Ctrl+I ADDS italic → ***x*** (bold NOT overwritten)', srcBoth.includes('***MarkFlow***'));
await page.locator('.tbtn[title^="Strikethrough"]').click();
await page.waitForTimeout(200);
const srcNestedStrike = await page.locator('.cm-content').innerText();
ok('main toolbar Strike appends outside existing Bold + Italic', srcNestedStrike.includes('~~***MarkFlow***~~'));

console.log('— link dialog submit —');
await page.locator('.tbtn[title^="Insert link"]').click();
await page.waitForTimeout(250);
ok('link dialog opens', await page.locator('.modal').isVisible());
await page.locator('#fd-text').fill('Example');
await page.locator('#fd-url').fill('https://example.com');
await page.locator('.modal-foot .btn.primary').click();
await page.waitForTimeout(300);
ok('dialog closes on submit', await page.locator('.modal').count() === 0);
ok('link inserted into source', (await page.locator('.cm-content').innerText()).includes('[Example](https://example.com)'));

console.log('— alt text as visible caption —');
await page.locator('.tbtn[title^="Insert image from link"]').click();
await page.waitForTimeout(250);
await page.locator('#fd-alt').fill('cute cat');
await page.locator('#fd-url').fill('https://example.com/x.png');
await page.locator('.modal-foot .btn.primary').click();
await page.waitForTimeout(600);
ok('alt renders as <figcaption> in preview', await page.locator('#preview figcaption', { hasText: 'cute cat' }).count() >= 1);

console.log('— context-aware toolbar —');
const isDisabled = async (titleStart) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll('.tbtn')].find((x) => (x.title || '').startsWith(t));
    return b ? b.disabled : null;
  }, titleStart);

await page.locator('.cm-line', { hasText: 'flowchart LR' }).first().click();
await page.waitForTimeout(250);
ok('inside code fence: Bold disabled', (await isDisabled('Bold')) === true);
ok('inside code fence: ✎ Table disabled too', (await isDisabled('Edit the table')) === true);
const titleInCode = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.tbtn')].find((x) => (x.title || '').includes('code block'));
  return b?.title || '';
});
ok('disabled tooltip explains WHY', titleInCode.includes('not available inside a code block'));

await page.locator('.cm-line', { hasText: '| Feature' }).first().click();
await page.waitForTimeout(250);
ok('inside table: H1 disabled', (await isDisabled('Heading 1')) === true);
ok('inside table: Bold still enabled', (await isDisabled('Bold')) === false);
ok('inside table: ✎ Table enabled', (await isDisabled('Edit the table')) === false);

await page.locator('.cm-line', { hasText: 'Three ways to work' }).first().click();
await page.waitForTimeout(250);
ok('plain text: H1 enabled again', (await isDisabled('Heading 1')) === false);
ok('plain text: ✎ Table now disabled', (await isDisabled('Edit the table')) === true);

console.log('— direct Excel/TSV paste into the editor —');
await page.locator('.cm-line', { hasText: 'The five-minute tour' }).first().click();
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.setData('text/plain', 'A1\tB1\nA2\tB2');
  document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(350);
const src9 = await page.locator('.cm-content').innerText();
ok('TSV paste becomes aligned markdown table', /\|\s*A1\s*\|\s*B1\s*\|/.test(src9) && src9.includes('| ---'));
ok('header row + body rows generated', /\|\s*A2\s*\|\s*B2\s*\|/.test(src9));

console.log('— contextual + positioning follows the active gutter corner —');
const featWrap = () => page.locator('.table-wrap', { has: page.locator('button[title*="Feature"]') });
await featWrap().hover();
await featWrap().locator('.table-edit-btn').click();
await page.waitForTimeout(400);
// ROW + from the number gutter's top-left corner = boundary ABOVE row 3.
let anchorBox = await page.locator('.te-num[data-ri="2"]').boundingBox();
let anchorRadius = Math.min(anchorBox.width, anchorBox.height) * 0.12;
await page.mouse.move(anchorBox.x + anchorRadius * .5, anchorBox.y + anchorRadius * .5);
ok('row top-left + straddles the LEFT border at the row top boundary', await page.evaluate(() => {
  const b = document.querySelector('.te-hh-h button').getBoundingClientRect();
  const g = document.querySelector('.te-grid').getBoundingClientRect();
  const n = document.querySelector('.te-num[data-ri="2"]').getBoundingClientRect();
  return document.querySelector('.te-hh-h').classList.contains('on')
    && !document.querySelector('.te-hh-v').classList.contains('on')
    && Math.abs(b.x + b.width / 2 - g.left) < 4
    && Math.abs(b.y + b.height / 2 - n.top) < 4
    && document.querySelector('.te-hh-h button').getAttribute('aria-label') === 'Insert row above row 3';
}));
// ROW + from the same number gutter's bottom-left corner = boundary BELOW row 3.
await page.mouse.move(anchorBox.x + anchorRadius * .5, anchorBox.y + anchorBox.height - anchorRadius * .5);
ok('row bottom-left + uses the row bottom boundary', await page.evaluate(() => {
  const b = document.querySelector('.te-hh-h button').getBoundingClientRect();
  const n = document.querySelector('.te-num[data-ri="2"]').getBoundingClientRect();
  return document.querySelector('.te-hh-h').classList.contains('on')
    && Math.abs(b.y + b.height / 2 - n.bottom) < 4
    && document.querySelector('.te-hh-h button').getAttribute('aria-label') === 'Insert row below row 3';
}));
// COLUMN + from the letter bar's top-left/top-right corners.
anchorBox = await page.locator('.te-letter[data-ci="2"]').boundingBox();
anchorRadius = Math.min(anchorBox.width, anchorBox.height) * 0.12;
await page.mouse.move(anchorBox.x + anchorRadius * .5, anchorBox.y + anchorRadius * .5);
ok('column top-left + uses the current column LEFT boundary', await page.evaluate(() => {
  const b = document.querySelector('.te-hh-v button').getBoundingClientRect();
  const l = document.querySelector('.te-letter[data-ci="2"]').getBoundingClientRect();
  return document.querySelector('.te-hh-v').classList.contains('on')
    && !document.querySelector('.te-hh-h').classList.contains('on')
    && Math.abs(b.y + b.height / 2 - l.top) < 4
    && Math.abs(b.x + b.width / 2 - l.left) < 4
    && document.querySelector('.te-hh-v button').getAttribute('aria-label') === 'Insert column before C';
}));
await page.mouse.move(anchorBox.x + anchorBox.width - anchorRadius * .5, anchorBox.y + anchorRadius * .5);
ok('column top-right + uses the current column RIGHT boundary', await page.evaluate(() => {
  const v = document.querySelector('.te-hh-v button').getBoundingClientRect();
  const l = document.querySelector('.te-letter[data-ci="2"]').getBoundingClientRect();
  return !document.querySelector('.te-hh-h').classList.contains('on')
    && document.querySelector('.te-hh-v').classList.contains('on')
    && Math.abs(v.y + v.height / 2 - l.top) < 4
    && Math.abs(v.x + v.width / 2 - l.right) < 4
    && document.querySelector('.te-hh-v button').getAttribute('aria-label') === 'Insert column after C';
}));
await page.locator('.te-hint').hover({ position: { x: 40, y: 4 } });
ok('row and column handles are mutually exclusive and hide outside the table', await page.locator('.te-hh.on').count() === 0);

console.log('— R4 window expand + column width drag —');
await page.locator('.modal .te-maxbtn[aria-label^="Expand"]').click();
await page.waitForTimeout(150);
ok('⛶ expands the editor window', await page.locator('.modal.te-max').count() === 1);
await page.locator('.modal .te-maxbtn[aria-label^="Expand"]').click();
await page.waitForTimeout(150);
ok('⛶ again restores it', await page.locator('.modal.te-max').count() === 0);
const wBefore = await page.evaluate(() => document.querySelector('td[data-c="1"]').getBoundingClientRect().width);
const grip = await page.locator('.te-letter[data-ci="1"] .te-grip-c').boundingBox();
await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
await page.mouse.down();
await page.mouse.move(grip.x + 140, grip.y + grip.height / 2, { steps: 6 });
await page.mouse.up();
const wAfter = await page.evaluate(() => document.querySelector('td[data-c="1"]').getBoundingClientRect().width);
ok('column width drags wider — editor view only (#8)', wAfter > wBefore + 60);

console.log('— R6 row-height integrity — a tall row stays ONE logical & visual row (Screenshot 3) —');
const rowsBefore = await page.locator('.te-grid tbody tr').count();
const rgrip = await page.locator('.te-num[data-ri="2"] .te-grip-r').boundingBox();
await page.mouse.move(rgrip.x + rgrip.width / 2, rgrip.y + rgrip.height - 1);
await page.mouse.down();
await page.mouse.move(rgrip.x, rgrip.y + 90, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
ok('resizing does NOT change the logical row count', (await page.locator('.te-grid tbody tr').count()) === rowsBefore);
ok('enlarged row has NO internal horizontal elements/lines (TEST 7)', await page.evaluate(() => {
  const tr = document.querySelector('tbody tr[data-r="2"]');
  const b = tr.getBoundingClientRect();
  if (b.height < 100) return false;
  const seen = new Set();
  for (let y = b.top + 3; y < b.bottom - 3; y += 4) {
    const el = document.elementFromPoint(b.x + b.width * 0.5, y);
    if (el) seen.add(el.tagName + '|' + String(el.className).split(' ')[0]);
  }
  return [...seen].every((s) => s.startsWith('TD|') || s.startsWith('INPUT|'));
}));
ok('all cells + inputs share the enlarged row height', await page.evaluate(() => {
  const tr = document.querySelector('tbody tr[data-r="2"]');
  const h = tr.getBoundingClientRect().height;
  const tds = [...tr.querySelectorAll('td')];
  return tds.every((td) => Math.abs(td.getBoundingClientRect().height - h) <= 1.5)
    && tds.every((td) => td.querySelector('input').getBoundingClientRect().height >= h - 3);
}));
const rgrip2 = await page.locator('.te-num[data-ri="2"] .te-grip-r').boundingBox(); // re-query — the grip moved with the row
await page.mouse.move(rgrip2.x + rgrip2.width / 2, rgrip2.y + rgrip2.height - 1);
await page.mouse.down();
await page.mouse.move(rgrip2.x, rgrip2.y - 60, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(250);
ok('row shrinks back cleanly (TEST 8)', await page.evaluate(() => document.querySelector('tbody tr[data-r="2"]').getBoundingClientRect().height < 80
  && document.querySelectorAll('.te-grid tbody tr').length === 5));
console.log('— R4 bulk sync semantics + empty-cell skip (#2, #9) —');
const cA = (r) => page.locator(`td[data-r="${r}"][data-c="0"] input.te-cell`);
await cA(1).fill('**x**');
await cA(2).fill('y');
await cA(3).fill('');
await cA(4).fill('z');
await page.locator('.te-letter[data-ci="0"]').click();
await page.locator('.te-bar button[aria-label="Bold"]').click();
await page.waitForTimeout(150);
ok('mixed column: Bold APPLIES to the un-bolded ones (never toggles off)',
  (await cA(1).inputValue()) === '**x**' && (await cA(2).inputValue()) === '**y**' && (await cA(4).inputValue()) === '**z**');
ok('empty cell stays EMPTY — no marker junk written (#9)', (await cA(3).inputValue()) === '');
await page.locator('.te-bar button[aria-label="Bold"]').click();
await page.waitForTimeout(150);
ok('all-bold now REMOVES from all — second click', (await cA(1).inputValue()) === 'x' && (await cA(2).inputValue()) === 'y' && (await cA(4).inputValue()) === 'z');

console.log('— R5 semantic inline formatting — nested, partial, and bulk scopes —');
const selColA = async () => { if (!(await page.locator('.te-readout').innerText()).includes('Column A')) await page.locator('.te-letter[data-ci="0"]').click(); };
const selectCellWord = async (row, word, occurrence = 0) => page.evaluate(({ row, word, occurrence }) => {
  const input = document.querySelector(`td[data-r="${row}"][data-c="0"] input.te-cell`);
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = input.value.indexOf(word, i ? start + word.length : 0);
  input.focus();
  input.setSelectionRange(start, start + word.length);
  input.dispatchEvent(new Event('select', { bubbles: true }));
}, { row, word, occurrence });
await cA(1).fill('plain **bold** and *italic* and ~~strike~~');
await selectCellWord(1, 'bold');
await page.locator('.te-bar button[aria-label="Strikethrough"]').click();
ok('partial word adds outer Strike without disturbing Bold', (await cA(1).inputValue()) === 'plain ~~**bold**~~ and *italic* and ~~strike~~');
await selectCellWord(1, 'strike');
await page.locator('.te-bar button[aria-label="Bold"]').click();
ok('partial word adds Bold inside existing Strike', (await cA(1).inputValue()).endsWith('~~**strike**~~'));

await cA(2).fill('~~***text***~~');
await selectCellWord(2, 'text');
await page.locator('.te-bar button[aria-label="Strikethrough"]').click();
ok('outer Strike removes from a nested selected word', (await cA(2).inputValue()) === '***text***');
await selectCellWord(2, 'text');
await page.locator('.te-bar button[aria-label="Strikethrough"]').click();
ok('outer Strike reapplies without duplication', (await cA(2).inputValue()) === '~~***text***~~');
await selectCellWord(2, 'text');
await page.locator('.te-bar button[aria-label="Bold"]').click();
ok('Bold removes independently from the same nested word', (await cA(2).inputValue()) === '~~*text*~~');
await selectCellWord(2, 'text');
await page.locator('.te-bar button[aria-label="Bold"]').click();
await selectCellWord(2, 'text');
await page.locator('.te-bar button[aria-label="Italic"]').click();
ok('Italic removes independently after Bold is restored', (await cA(2).inputValue()) === '~~**text**~~');
await selectCellWord(2, 'text');
await page.locator('.te-bar button[aria-label="Italic"]').click();
ok('Italic reapplies without changing Strike or Bold', (await cA(2).inputValue()) === '~~***text***~~');

await cA(3).fill('');
await cA(4).fill('*italic*');
await selColA();
await page.locator('.te-bar button[aria-label="Bold"]').click();
await page.waitForTimeout(180);
ok('bulk Bold applies to missing text while preserving internal marks',
  (await cA(3).inputValue()) === '' && (await cA(4).inputValue()) === '***italic***'
  && (await cA(1).inputValue()).includes('**plain**') && (await cA(2).inputValue()) === '~~***text***~~');
await page.locator('.te-bar button[aria-label="Bold"]').click();
await page.waitForTimeout(180);
ok('bulk second click removes Bold from every eligible text run',
  (await cA(3).inputValue()) === '' && (await cA(4).inputValue()) === '*italic*'
  && (await cA(1).inputValue()) === 'plain ~~bold~~ and *italic* and ~~strike~~'
  && (await cA(2).inputValue()) === '~~*text*~~');

await cA(1).fill('a **b** c');
await cA(2).fill('y');
await selColA();
await page.locator('.te-bar button[aria-label="Bold"]').click();
ok('bulk formatting splits existing mid-cell spans semantically',
  (await cA(1).inputValue()) === '**a** **b** **c**' && (await cA(2).inputValue()) === '**y**');
await page.locator('.te-bar button[aria-label="Bold"]').click();
ok('bulk removal clears the mark from all visible text runs',
  (await cA(1).inputValue()) === 'a b c' && (await cA(2).inputValue()) === 'y');
await cA(1).fill('raw <span>x</span> $x$ ![alt](https://x.test/a.png) and \\*escaped\\*');
await cA(1).click();
await page.evaluate(() => {
  const input = document.querySelector('td[data-r="1"][data-c="0"] input.te-cell');
  input.setSelectionRange(0, 0);
});
await page.locator('.te-bar button[aria-label="Bold"]').click();
ok('whole-cell formatting preserves HTML, math, images, and escapes',
  (await cA(1).inputValue()) === '**raw** <span>**x**</span> $x$ ![alt](https://x.test/a.png) **and** **\\*escaped\\***');
await cA(0).fill('Feature'); // column ops style the header too (Excel semantics) — restore it for later sections
await cA(1).fill('x'); await cA(2).fill('y'); await cA(3).fill(''); await cA(4).fill('z');

console.log('— R4 multi-select rows & columns (#5) —');
await page.locator('.te-num[data-ri="1"]').click();
await page.locator('.te-num[data-ri="3"]').click({ modifiers: ['Control'] });
ok('Ctrl+click adds a second row', (await page.locator('.te-readout').innerText()).includes('Rows 2, 4'));
await page.locator('.te-num[data-ri="3"]').click({ modifiers: ['Control'] });
ok('Ctrl+click again removes it', (await page.locator('.te-readout').innerText()).includes('Row 2'));
await page.locator('.te-num[data-ri="3"]').click({ modifiers: ['Shift'] });
ok('Shift+click selects a contiguous range', (await page.locator('.te-readout').innerText()).includes('Rows 2–4'));
await page.locator('.te-letter[data-ci="1"]').click();
await page.locator('.te-letter[data-ci="2"]').click({ modifiers: ['Control'] });
ok('Ctrl+click multi-selects columns', (await page.locator('.te-readout').innerText()).includes('Columns B–C'));

console.log('— R4 sort (body-only, numeric-aware) + view-only filter (#6) —');
await cA(1).fill('10'); await cA(2).fill('2'); await cA(3).fill('1'); await cA(4).fill('3');
await page.locator('.te-letter[data-ci="0"]').click();
await page.locator('.te-bar button[aria-label="Sort A to Z"]').click();
await page.waitForTimeout(200);
ok('sort A→Z is numeric-aware (1,2,3,10 — not 1,10,2,3)', (await page.evaluate(() => [1, 2, 3, 4].map((r) => document.querySelector(`td[data-r="${r}"][data-c="0"] input`).value).join(','))) === '1,2,3,10');
ok('header row never participates in sort', (await cA(0).inputValue()) === 'Feature');
await page.locator('.te-bar button[aria-label="Sort Z to A"]').click();
await page.waitForTimeout(200);
ok('sort Z→A reverses', (await page.evaluate(() => [1, 2, 3, 4].map((r) => document.querySelector(`td[data-r="${r}"][data-c="0"] input`).value).join(','))) === '10,3,2,1');
await page.locator('.te-bar button[aria-label="Filter this column"]').click();
await page.waitForTimeout(250);
await page.locator('#fd-q').fill('2');
await page.locator('.modal').last().locator('.btn.primary').click();
await page.waitForTimeout(250);
ok('filter hides non-matching body rows (view-only)', await page.evaluate(() =>
  [1, 2, 3, 4].filter((r) => document.querySelector(`tbody tr[data-r="${r}"]`).style.display !== 'none').length === 1));
ok('filter chip announces the state', await page.locator('.te-chip').isVisible());
await page.locator('.modal-foot .btn.primary').click(); // Apply with the filter STILL active
await page.waitForTimeout(500);
const srcR4 = await page.locator('.cm-content').innerText();
ok('Apply writes EVERY row — the filter never touches the document', srcR4.includes('Feature') && /\|\s*10\s*\|/.test(srcR4) && /\|\s*1\s*\|/.test(srcR4) && /\|\s*3\s*\|/.test(srcR4));

console.log('— R4 issue#10: hover button opens THE table under it —');
await page.locator('#newDocBtn').click();
await page.waitForTimeout(700);
const smallMd = '| S1 | S2 |\n| --- | --- |\n| a | b |';
const bigCols = ['Emp', 'Dept', 'Team', 'Leave', 'WFO', 'WFH', ...Array.from({ length: 30 }, (_, i) => String(i + 1))];
const bigMd = [
  '| ' + bigCols.join(' | ') + ' |',
  '| ' + bigCols.map(() => '---').join(' | ') + ' |',
  '| Raguram | ACP | Diag | 0 | 0 | 0 | ' + Array.from({ length: 30 }, () => '0').join(' | ') + ' |',
].join('\n');
await page.evaluate((md) => {
  const dt = new DataTransfer();
  dt.setData('text/plain', md);
  document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, '\n\n' + smallMd + '\n\n' + bigMd + '\n');
await page.waitForTimeout(900);
ok('two tables render in preview', await page.locator('.table-wrap').count() === 2);
ok('hover button tooltip NAMES its table', (await page.locator('.table-wrap .table-edit-btn').nth(1).getAttribute('title')).includes('Emp'));
await page.locator('.table-wrap').nth(1).hover();
await page.locator('.table-wrap .table-edit-btn').nth(1).click();
await page.waitForTimeout(500);
ok('opens the 36-column table itself — not the other one (#10)',
  await page.locator('.te-letter').count() === 36 && (await page.locator('input.te-cell[data-r="0"][data-c="1"]').inputValue()) === 'Dept');
ok('letters beyond Z render correctly (…AJ)', (await page.locator('.te-letter').last().innerText()).trim() === 'AJ');
await page.evaluate(() => { document.querySelector('.te-scroll').scrollLeft = 600; });
await page.waitForTimeout(200);
// pick a letter guaranteed visible in the scroller window after the scroll
const farC = await page.evaluate(() => {
  const sc = document.querySelector('.te-scroll');
  const g = document.querySelector('.te-grid').getBoundingClientRect();
  const mid = sc.getBoundingClientRect().left + sc.clientWidth / 2 - g.left - 40; // − gutter
  return Math.min(35, Math.max(2, Math.floor(mid / 97)));
});
const farBox = await page.evaluate((c) => { const r = document.querySelector(`.te-letter[data-ci="${c}"]`).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, farC);
const farRadius = Math.min(farBox.width, farBox.height) * 0.12;
await page.mouse.move(farBox.x + farRadius * .5, farBox.y + farRadius * .5);
ok('column "+" tracks a scrolled boundary from the letter bar (TEST 9)', await page.evaluate((c) => {
  const b = document.querySelector('.te-hh-v button').getBoundingClientRect();
  const l = document.querySelector(`.te-letter[data-ci="${c}"]`).getBoundingClientRect();
  const sc = document.querySelector('.te-scroll').getBoundingClientRect();
  return document.querySelector('.te-hh-v').classList.contains('on')
    && !document.querySelector('.te-hh-h').classList.contains('on')
    && Math.abs(b.x + b.width / 2 - l.left) < 5
    && Math.abs(b.y + b.height / 2 - l.top) < 5
    && l.left > sc.left + 30 && l.right < sc.right; // the letter itself is truly on-screen
}, farC));
// row "+" from the sticky number gutter — stays on-screen even when the grid is scrolled
const num1Box = await page.locator('.te-num[data-ri="1"]').boundingBox();
const num1Radius = Math.min(num1Box.width, num1Box.height) * 0.12;
await page.mouse.move(num1Box.x + num1Radius * .5, num1Box.y + num1Radius * .5);
ok('row circle clamps to the VISIBLE left edge when the table is scrolled — never lost off-screen', await page.evaluate(() => {
  const b = document.querySelector('.te-hh-h button').getBoundingClientRect();
  const sc = document.querySelector('.te-scroll').getBoundingClientRect();
  return document.querySelector('.te-hh-h').classList.contains('on')
    && !document.querySelector('.te-hh-v').classList.contains('on')
    && b.x + b.width / 2 >= sc.left - 2 && b.x + b.width / 2 <= sc.left + 28;
}));
await page.locator('.te-hint').hover({ position: { x: 40, y: 4 } });
await page.waitForTimeout(480);
await page.locator('.modal-foot .btn.ghost').click();
await page.waitForTimeout(200);

console.log('— modes & theme —');
await page.locator('.mode-switch button[data-mode="preview"]').click();
ok('preview mode hides editor', await page.locator('#editorPane').isHidden());
await page.locator('.mode-switch button[data-mode="split"]').click();
const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
await page.locator('#themeToggle').click();
await page.waitForTimeout(200);
const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
ok(`theme toggles (${themeBefore} → ${themeAfter})`, themeAfter !== themeBefore);

console.log('— new doc + library —');
await page.locator('#newDocBtn').click();
await page.waitForTimeout(600);
ok('new doc created in list', (await page.locator('#docList').innerText()).includes('Untitled'));
ok('search filters list', await page.locator('#docSearch').fill('welcome').then(async () => {
  const t = await page.locator('#docList').innerText();
  return t.includes('Welcome') && !t.includes('Untitled');
}));
await page.locator('#docSearch').fill('');

console.log('— export menu —');
await page.locator('#exportBtn').click();
await page.waitForTimeout(200);
ok('export menu opens with md/html/3 PDF themes', await page.locator('.menu-pop button').count() >= 5);
await page.keyboard.press('Escape');
await page.mouse.click(10, 10);

console.log('— console errors —');
const realErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('net::ERR_ABORTED'));
console.log(realErrors.length ? realErrors.join('\n') : '  (none)');
ok('zero console errors', realErrors.length === 0);

console.log('\n' + (fails.length ? `FAILED: ${fails.length} — ` + fails.join(', ') : 'ALL CHECKS PASSED'));
await browser.close();
process.exit(fails.length ? 1 : 0);
