import { test, expect } from '@playwright/test';
import {
  PREFERENCES,
  reportHost,
  setClaudeSettings,
  settingsUrl,
  stubSettingsApi,
  wsSent,
} from './settingsHarness.js';

// Real-browser e2e for Claude Code's settings.json (Settings → Agent → Layers)
// — a shared setting, one text for every host plus an override per OS — and a
// host's memory entries (Settings → Memories) and settings.json drift
// (Settings → Hosts): spec/02 § Claude Code settings, spec/01 § Settings.
const AGENT = settingsUrl('agent');
const MEMORIES = settingsUrl('memories');

const FEEDBACK = {
  project: 'portfolio',
  file: 'feedback_tests.md',
  name: 'feedback_tests',
  description: 'write real tests, not manual clicking',
  memoryType: 'feedback',
  body: 'Write real tests.',
};

const claudeSettings = (shared: string) => ({
  claudeSettings: { shared, darwin: '', linux: '' },
});

/** Open the shared settings.json editor on the Agent page, holding `json`. */
async function openEditor(page: import('@playwright/test').Page, json: string): Promise<void> {
  await stubSettingsApi(page, { preferences: claudeSettings(json) });
  await page.goto(AGENT);
  await page.getByTestId('claude-settings-shared-edit').click();
  await expect(page.getByTestId('claude-settings-shared-json')).toBeVisible();
}

test.describe('Settings → Agent / Memories / Hosts → Claude Code settings', () => {
  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page);
  });

  test('the shared settings.json and each OS override are there with no host involved', async ({
    page,
  }) => {
    await page.goto(AGENT);
    await expect(page.getByTestId('claude-settings-shared')).toContainText('None');
    await expect(page.getByTestId('claude-settings-darwin')).toBeVisible();
    await expect(page.getByTestId('claude-settings-linux')).toBeVisible();
    // Memories are a machine's own, and say when it has not sent them.
    await page.getByTestId('settings-nav-memories').click();
    await expect(page.getByTestId('host-d1-memory-unreported')).toBeVisible();
  });

  test('shows the shared settings.json and a host’s memory entries', async ({ page }) => {
    await openEditor(page, '{"model":"opus"}');
    await expect(page.getByTestId('claude-settings-shared-json')).toHaveValue('{"model":"opus"}');
    await page.getByTestId('settings-nav-memories').click();
    await setClaudeSettings(page, [FEEDBACK]);
    const entry = page.getByTestId('host-d1-memory-portfolio-feedback_tests.md');
    await expect(entry).toContainText('feedback_tests');
    await expect(page.getByTestId('memory-rendered')).toHaveText('Write real tests.');
  });

  test('saving writes the shared setting to the server and closes on its answer', async ({
    page,
  }) => {
    const server = await stubSettingsApi(page, { preferences: claudeSettings('{"model":"opus"}') });
    await page.goto(AGENT);
    await page.getByTestId('claude-settings-shared-edit').click();
    await page.getByTestId('claude-settings-shared-json').fill('{"model":"sonnet"}');
    await page.getByTestId('claude-settings-shared-save').click();
    await expect(page.getByTestId('claude-settings-shared-json')).toHaveCount(0);
    expect(server.patches).toContainEqual({
      claudeSettings: {
        ...(PREFERENCES['claudeSettings'] as object),
        shared: '{"model":"sonnet"}',
      },
    });
    // Nothing went to any one host.
    expect(await wsSent(page)).toEqual([]);
  });

  test('a host’s settings.json changed on the machine shows on Hosts, to keep or discard', async ({
    page,
  }) => {
    const server = await stubSettingsApi(page);
    await page.goto(settingsUrl('hosts'));
    await reportHost(page, { platform: 'linux' });
    await setClaudeSettings(page, [], { drift: '{"model":"sonnet"}' });
    const drift = page.getByTestId('host-d1-claude-drift');
    await expect(drift).toContainText('"model":"sonnet"');
    await page.getByTestId('host-d1-claude-drift-keep-os').click();
    await expect
      .poll(() => server.writes.map((w) => w.path))
      .toContain('/api/settings/claude/adopt');
    expect(server.writes.find((w) => w.path === '/api/settings/claude/adopt')?.body).toEqual({
      daemonId: 'd1',
      target: 'linux',
    });
    await page.getByTestId('host-d1-claude-drift-discard').click();
    await expect
      .poll(async () => await wsSent(page))
      .toContainEqual({ type: 'host.claude_settings_discard', daemonId: 'd1' });
  });

  test('removing a memory entry asks, then sends host.claude_memory_delete naming it', async ({
    page,
  }) => {
    await page.goto(MEMORIES);
    await setClaudeSettings(page, [FEEDBACK]);
    await page.getByTestId('host-d1-memory-portfolio-feedback_tests.md-remove').click();
    await expect(page.getByTestId('confirm-modal')).toContainText('feedback_tests');
    await page.getByTestId('confirm-ok').click();
    await expect.poll(async () => (await wsSent(page)).length).toBeGreaterThan(0);
    expect(await wsSent(page)).toContainEqual({
      type: 'host.claude_memory_delete',
      daemonId: 'd1',
      project: 'portfolio',
      file: 'feedback_tests.md',
    });
  });

  test('says there are no memory entries rather than showing an empty list', async ({ page }) => {
    await page.goto(MEMORIES);
    await setClaudeSettings(page, []);
    await expect(page.getByTestId('host-d1-memory-empty')).toBeVisible();
  });

  // The reported bug is specifically the EMPTY file: `.claude-settings-json`
  // had no CSS rule at all, so with no content the textarea collapsed to zero
  // height with no border and the subsection read as a heading plus an orphan
  // Save button. Measured in a real browser — jsdom has no cascade, so only
  // this can catch it.
  test.describe('with an empty settings.json', () => {
    test.beforeEach(async ({ page }) => {
      await openEditor(page, '');
    });

    test('the editor is still a visible box several lines tall', async ({ page }) => {
      const box = await page.getByTestId('claude-settings-shared-json').evaluate((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          value: (el as HTMLTextAreaElement).value,
          height: r.height,
          width: r.width,
          lineHeight: parseFloat(cs.lineHeight),
          fontFamily: cs.fontFamily,
          borderTopWidth: parseFloat(cs.borderTopWidth),
          borderBottomWidth: parseFloat(cs.borderBottomWidth),
          borderStyle: cs.borderTopStyle,
          borderColor: cs.borderTopColor,
          paddingLeft: parseFloat(cs.paddingLeft),
          paddingTop: parseFloat(cs.paddingTop),
          resize: cs.resize,
        };
      });
      // The exact reported case: nothing in it.
      expect(box.value).toBe('');
      // …and it is nonetheless a real, aimable box.
      expect(box.height).toBeGreaterThanOrEqual(96);
      expect(box.width).toBeGreaterThanOrEqual(200);
      // Several rows of JSON fit without scrolling.
      expect(box.height).toBeGreaterThanOrEqual(box.lineHeight * 5);
      // With a drawn border on every side…
      expect(box.borderTopWidth).toBeGreaterThanOrEqual(1);
      expect(box.borderBottomWidth).toBeGreaterThanOrEqual(1);
      expect(box.borderStyle).toBe('solid');
      expect(box.borderColor).not.toBe('rgba(0, 0, 0, 0)');
      // …text inset from it, monospace for JSON, and draggable taller.
      expect(box.paddingLeft).toBeGreaterThanOrEqual(4);
      expect(box.paddingTop).toBeGreaterThanOrEqual(4);
      expect(box.fontFamily).toContain('JetBrains Mono');
      expect(box.resize).toBe('vertical');
    });

    test('the empty editor names what it holds with a placeholder', async ({ page }) => {
      const json = page.getByTestId('claude-settings-shared-json');
      await expect(json).toHaveValue('');
      await expect(json).toHaveAttribute('placeholder', '{}');
    });

    test('Save sits directly under the editor rather than floating orphaned', async ({ page }) => {
      const geom = await page.evaluate(() => {
        const wrap = document.querySelector('[data-testid="claude-settings-shared"]');
        const ta = document.querySelector('[data-testid="claude-settings-shared-json"]');
        const save = document.querySelector('[data-testid="claude-settings-shared-save"]');
        if (!wrap || !ta || !save) throw new Error('Claude Code settings subsection not rendered');
        const w = wrap.getBoundingClientRect();
        const t = ta.getBoundingClientRect();
        const s = save.getBoundingClientRect();
        return {
          taBottom: t.bottom,
          taLeft: t.left,
          taRight: t.right,
          saveTop: s.top,
          saveLeft: s.left,
          saveRight: s.right,
          wrapWidth: w.width,
        };
      });
      // Below the box it saves, not beside or above it.
      expect(geom.saveTop).toBeGreaterThanOrEqual(geom.taBottom);
      // …tucked against it, not adrift down the page.
      expect(geom.saveTop - geom.taBottom).toBeLessThanOrEqual(16);
      // …and aligned to the editor's right edge (the design's action row), so
      // the pair reads as one group.
      expect(Math.abs(geom.saveRight - geom.taRight)).toBeLessThanOrEqual(1);
      // The button hugs its label instead of stretching the group's width.
      expect(geom.saveLeft).toBeGreaterThan(geom.taLeft + (geom.taRight - geom.taLeft) / 2);
    });

    test('the editor is readable in the dark colour scheme too', async ({ page }) => {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const seen = await page.getByTestId('claude-settings-shared-json').evaluate((el) => {
          const cs = getComputedStyle(el);
          const parse = (c: string): [number, number, number] => {
            const n = c.match(/[\d.]+/g)?.map(Number) ?? [];
            return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
          };
          const lum = (c: string): number => {
            const [r, g, b] = parse(c).map((v) => {
              const s = v / 255;
              return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          return {
            textVsFill:
              (Math.max(lum(cs.color), lum(cs.backgroundColor)) + 0.05) /
              (Math.min(lum(cs.color), lum(cs.backgroundColor)) + 0.05),
            borderVsFill:
              (Math.max(lum(cs.borderTopColor), lum(cs.backgroundColor)) + 0.05) /
              (Math.min(lum(cs.borderTopColor), lum(cs.backgroundColor)) + 0.05),
            height: el.getBoundingClientRect().height,
          };
        });
        // Typed JSON clears AA against the fill…
        expect(seen.textVsFill, `${scheme}: text on fill`).toBeGreaterThanOrEqual(4.5);
        // …and the box's own edge is distinguishable from it.
        expect(seen.borderVsFill, `${scheme}: border on fill`).toBeGreaterThan(1.1);
        expect(seen.height, `${scheme}: height`).toBeGreaterThanOrEqual(96);
      }
    });
  });

  // spec/14 § `/settings` details → Claude Code settings: "The box is sized by
  // the file it holds: it grows with the content, up to a ceiling of half the
  // window height, past which it scrolls within itself."
  //
  // The reported bug: the editor held a fixed several-lines height whatever was
  // in it, so a populated settings.json was peered at through an 8-line slot —
  // a tiny JSON box scrolling inside the already-scrolling settings page.
  test.describe('sized by the file it holds', () => {
    // A modest settings.json — comfortably inside the cap, so it is shown whole.
    const MODEST = JSON.stringify(
      {
        model: 'opus',
        env: { PATCH_HOME: '/home/tom/.patch' },
        statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
        outputStyle: 'concise',
      },
      null,
      2,
    );
    // The size real hosts actually carry (~50 lines), which exceeds the cap.
    const REAL = JSON.stringify(
      {
        model: 'opus',
        permissions: {
          allow: Array.from({ length: 30 }, (_, i) => `Bash(tool${i}:*)`),
          deny: ['Bash(rm -rf:*)'],
        },
        env: { PATCH_HOME: '/home/tom/.patch' },
        statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
        },
      },
      null,
      2,
    );

    async function measure(page: import('@playwright/test').Page) {
      return page.getByTestId('claude-settings-shared-json').evaluate((el) => {
        const ta = el as HTMLTextAreaElement;
        return {
          lineHeight: parseFloat(getComputedStyle(ta).lineHeight),
          height: ta.getBoundingClientRect().height,
          width: ta.getBoundingClientRect().width,
          clientH: ta.clientHeight,
          scrollH: ta.scrollHeight,
          lines: ta.value.split('\n').length,
          vh: window.innerHeight,
        };
      });
    }

    test('a populated settings.json is shown whole, with no scrollbar inside the box', async ({
      page,
    }) => {
      await openEditor(page, MODEST);
      const m = await measure(page);
      // A genuinely multi-line file, not a one-liner that would pass trivially…
      expect(m.lines).toBeGreaterThan(9);
      // …every line of which is visible, with nothing behind an inner scrollbar.
      expect(m.scrollH).toBeLessThanOrEqual(m.clientH + 2);
      // The box grew to it rather than holding the old fixed 8-line slot.
      expect(m.height).toBeGreaterThan(160);
    });

    test('a real ~50-line settings.json grows to the cap instead of an 8-line slot', async ({
      page,
    }) => {
      await openEditor(page, REAL);
      const m = await measure(page);
      expect(m.lines).toBeGreaterThan(40);
      // This is the reported case: it must be a big box, not a tiny one. The
      // old fixed slot was 160px whatever the file; the cap is half the window.
      expect(m.height).toBeGreaterThanOrEqual(m.vh / 2 - 2);
      // Which is more than twice what the file used to be shown through.
      expect(m.height).toBeGreaterThan(320);
    });

    test('a very long settings.json stops growing at half the window and scrolls inside', async ({
      page,
    }) => {
      const HUGE = `{\n${Array.from({ length: 400 }, (_, i) => `  "key${i}": "value${i}"`).join(',\n')}\n}`;
      await openEditor(page, HUGE);
      const m = await measure(page);
      // Capped, so one big file cannot take the whole settings page over…
      expect(m.height).toBeLessThanOrEqual(m.vh / 2 + 2);
      // …and past the cap the box scrolls rather than clipping the rest away.
      expect(m.scrollH).toBeGreaterThan(m.clientH);
    });

    test('an empty settings.json still holds its full minimum height', async ({ page }) => {
      await openEditor(page, '');
      const m = await measure(page);
      // Growing with content must not have turned into shrinking with content:
      // the empty file still holds the editor's seven-line minimum open.
      expect(m.height).toBeGreaterThanOrEqual(m.lineHeight * 7 - 1);
      expect(m.height).toBeGreaterThanOrEqual(120);
    });

    test('the box takes the full width of the settings column', async ({ page }) => {
      await openEditor(page, REAL);
      const w = await page.evaluate(() => {
        const ta = document.querySelector(
          '[data-testid="claude-settings-shared-json"]',
        ) as HTMLElement;
        const row = document.querySelector('[data-testid="claude-settings-shared"]') as HTMLElement;
        const cs = getComputedStyle(row);
        return {
          ta: ta.getBoundingClientRect().width,
          // The row's content box: what is left inside its padding.
          group: row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        };
      });
      // Flush with its row rather than capped short of it, so indented JSON
      // lines don't wrap in a box narrower than the column it sits in.
      expect(w.ta).toBeGreaterThanOrEqual(w.group - 1);
    });
  });
});
