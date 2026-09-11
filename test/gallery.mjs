import { chromium } from 'playwright-core';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// force dark
await page.addInitScript(() => localStorage.setItem('mf-theme', 'dark'));
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2600);
// select the Welcome doc
await page.locator('.doc-item:has-text("Welcome to MarkFlow")').first().click();
await page.waitForTimeout(2200);
await page.screenshot({ path: 'test/gallery-dark-welcome.png' });

// open the table editor on the feature table
await page.locator('.table-wrap').first().hover();
await page.locator('.table-wrap .table-edit-btn').first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'test/gallery-table-editor.png' });

console.log('gallery saved');
await browser.close();
