import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { VIDEO_STYLES, VIDEO_STYLE_OPTIONS } from '../src/video-styles.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixedIds = ['cyberpunk', 'anime', 'photo', 'clay3d', 'infographic', 'watercolor', 'retrocomic', 'ink'];
const optionIds = ['auto', ...fixedIds, 'custom'];

test('画风目录恰有八种固定风格，元数据完整且预览指向各自的PNG', () => {
  assert.deepEqual(VIDEO_STYLES.map(style => style.id), fixedIds);
  for (const style of VIDEO_STYLES) {
    for (const field of ['label', 'prompt', 'description', 'suitableFor']) {
      assert.equal(typeof style[field], 'string', `${style.id}.${field}`);
      assert.ok(style[field].trim(), `${style.id}.${field}不能为空`);
    }
    assert.equal(style.preview, `./video-styles/${style.id}.png`);
  }
  assert.equal(new Set(VIDEO_STYLES.map(style => style.label)).size, 8);
  assert.equal(new Set(VIDEO_STYLES.map(style => style.prompt)).size, 8);
});

test('自动和自定义是独立模式，不占固定画风数量且不使用预览图', () => {
  assert.deepEqual(VIDEO_STYLE_OPTIONS.map(option => option.id), optionIds);
  assert.deepEqual(VIDEO_STYLE_OPTIONS.filter(option => fixedIds.includes(option.id)), VIDEO_STYLES);
  for (const id of ['auto', 'custom']) {
    const option = VIDEO_STYLE_OPTIONS.find(item => item.id === id);
    assert.ok(option.label.trim());
    assert.ok(!option.preview, `${id}不能冒充固定画风预览`);
  }
});

test('VideoStylePicker真实浏览器组件契约（离线、内存打包）', { timeout: 60000 }, async t => {
  // No output files, dev server, application profile or real PNGs are needed.
  // Prefer Playwright's existing browser; use installed Chrome if absent.
  const bundled = await build({
    stdin: {
      resolveDir: root,
      loader: 'jsx',
      contents: `import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {flushSync} from 'react-dom';
        import VideoStylePicker from './src/VideoStylePicker.jsx';
        const root = createRoot(document.getElementById('root'));
        window.renderPicker = (props = {}) => {
          window.styleChanges = [];
          flushSync(() => root.render(<VideoStylePicker
            onChange={id => window.styleChanges.push(id)} {...props}/>));
        };
        window.renderPicker();`,
    },
    bundle: true,
    write: false,
    outdir: 'video-style-picker-memory',
    platform: 'browser',
    format: 'iife',
    define: {
      'process.env.NODE_ENV': '"development"',
      'import.meta.env.BASE_URL': '"./"',
    },
  });
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }),
    args: ['--disable-background-networking'],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const rendererErrors = [];
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.setContent('<!doctype html><meta charset="utf-8"><form><div id="root"></div></form>');
  await page.evaluate(() => {
    window.formSubmissions = 0;
    document.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      window.formSubmissions++;
    });
  });
  for (const file of bundled.outputFiles) {
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text });
    if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text });
  }
  const button = id => page.getByRole('button', {
    name: VIDEO_STYLE_OPTIONS.find(option => option.id === id).label,
    exact: true,
  });
  const render = props => page.evaluate(props => window.renderPicker(props), props);
  const changes = () => page.evaluate(() => window.styleChanges);
  async function assertSelection(id) {
    assert.equal(await page.locator('button[aria-pressed="true"]').count(), 1);
    for (const optionId of optionIds) {
      assert.equal(await button(optionId).getAttribute('aria-pressed'), String(optionId === id), optionId);
    }
  }

  await t.test('默认选中auto；八张图片与目录一致；特殊模式无图', async () => {
    assert.equal(await page.getByRole('button').count(), 10);
    await assertSelection('auto');
    assert.deepEqual(await page.locator('img').evaluateAll(images => images.map(image => image.getAttribute('src'))),
      fixedIds.map(id => `./video-styles/${id}.png`));
    for (const style of VIDEO_STYLES) {
      const image = button(style.id).locator('img');
      assert.equal(await image.count(), 1);
      assert.equal(await image.getAttribute('alt'), `${style.label}画风示例`);
      assert.ok((await button(style.id).innerText()).includes(style.description));
      assert.ok((await button(style.id).innerText()).includes(style.suitableFor));
    }
    for (const id of ['auto', 'custom']) assert.equal(await button(id).locator('img').count(), 0);
  });

  await t.test('每种模式点击恰回调一次id；受控value在父级更新前保持原选中', async () => {
    await render({ value: 'auto' });
    for (const [index, id] of optionIds.entries()) {
      await button(id).click();
      assert.deepEqual(await changes(), optionIds.slice(0, index + 1));
      await assertSelection('auto');
    }
    for (const id of optionIds) {
      await render({ value: id });
      await assertSelection(id);
      assert.deepEqual(await changes(), [], '父级更新value不应触发onChange');
    }
  });

  await t.test('disabled禁用所有模式并阻止回调，重新启用后可以选择', async () => {
    await render({ value: 'clay3d', disabled: true });
    await assertSelection('clay3d');
    for (const id of optionIds) {
      assert.equal(await button(id).isDisabled(), true, id);
      // Native DOM activation is suppressed by disabled, without Playwright
      // waiting for an intentionally disabled control to become enabled.
      await button(id).evaluate(element => element.click());
    }
    assert.deepEqual(await changes(), []);
    await assertSelection('clay3d');
    await render({ value: 'clay3d', disabled: false });
    for (const id of optionIds) assert.equal(await button(id).isEnabled(), true, id);
    await button('anime').click();
    assert.deepEqual(await changes(), ['anime']);
    await assertSelection('clay3d');
    await render({ value: 'anime' });
    await assertSelection('anime');
  });

  await t.test('键盘Enter和空格可以选择，按钮不提交宿主表单', async () => {
    await render({ value: 'auto' });
    await button('watercolor').focus();
    await page.keyboard.press('Enter');
    await button('custom').focus();
    await page.keyboard.press('Space');
    assert.deepEqual(await changes(), ['watercolor', 'custom']);
    assert.equal(await page.evaluate(() => window.formSubmissions), 0);
    await assertSelection('auto');
  });

  await t.test('onChange省略时所有模式仍可安全点击', async () => {
    await page.evaluate(() => window.renderPicker({ value: 'auto', onChange: undefined }));
    for (const id of optionIds) await button(id).click();
    await assertSelection('auto');
    assert.deepEqual(await changes(), []);
    assert.deepEqual(rendererErrors, []);
  });

  await t.test('窄屏与宽屏卡片均不溢出，选中项有可见标记与不同背景', async () => {
    await render({ value: 'ink' });
    assert.ok((await button('ink').innerText()).includes('✓ 已选'));
    const background = id => button(id).evaluate(element => getComputedStyle(element).backgroundColor);
    assert.notEqual(await background('ink'), await background('photo'));
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 1200 });
      const layout = await page.locator('.video-style-picker').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return {
          overflows: element.scrollWidth > element.clientWidth,
          cardsFit: [...element.querySelectorAll('button')].every(button => {
            const card = button.getBoundingClientRect();
            return card.width > 0 && card.height > 0 && card.left >= bounds.left - 1 && card.right <= bounds.right + 1;
          }),
        };
      });
      assert.equal(layout.overflows, false, `${width}px不应横向溢出`);
      assert.equal(layout.cardsFit, true, `${width}px所有卡片应留在组件内`);
    }
  });
});
