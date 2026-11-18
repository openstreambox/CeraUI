/**
 * Remote access (Tailscale): functional spec against the dev backend's mock.
 *
 * The dev mock behaves like tailscaled: it starts off, turning it on leaves a
 * device without a login ("needs a key"), a pasted key joins it as `ceralive`,
 * a key containing "expired" is refused, and "forget" logs it out again.
 *
 * One test walks the whole owner flow in order, because every step depends on
 * the device state the previous one left. It starts by switching remote access
 * off, so a retry or a reused worker backend begins from the same place.
 * DOM and ARIA assertions only; no screenshots (PLAYBOOK.md).
 */
import { expect, type Page } from '@playwright/test';

import { test } from './fixtures/index.js';
import { openDialog } from './helpers/aria.js';
import { SettingsPage } from './pages/settings.js';

const DIALOG = 'Remote access';
const KEY = 'tskey-auth-kE2E0000CNTRL-0123456789abcdef';

function dialog(page: Page) {
	return page.getByRole('dialog', { name: DIALOG });
}

async function openRemoteAccess(page: Page): Promise<void> {
	await openDialog(page, page.getByTestId('settings-entry-remoteAccess'), DIALOG);
}

async function expectState(page: Page, state: string, label: string): Promise<void> {
	await expect(dialog(page).getByTestId('remote-access-status')).toHaveAttribute('data-state', state);
	await expect(dialog(page).getByTestId('remote-access-state')).toHaveText(label);
}

test.describe('Remote access', () => {
	test('the entry sits next to SSH in Settings', async ({ authedPage: page }) => {
		await new SettingsPage(page).open();
		const entry = page.getByTestId('settings-entry-remoteAccess');
		await expect(entry).toBeVisible();
		await expect(entry).toContainText('Reach this device from anywhere over Tailscale');
		await expect(page.getByTestId('settings-entry-ssh').locator('xpath=following-sibling::*[1]')).toHaveAttribute(
			'data-testid',
			'settings-entry-remoteAccess',
		);
	});

	test('off, on, join with a key, forget, off again', async ({ authedPage: page }) => {
		await new SettingsPage(page).open();
		await openRemoteAccess(page);
		const d = dialog(page);
		const toggle = d.getByTestId('remote-access-switch');

		// Start from off, whatever an earlier attempt left behind.
		if ((await toggle.getAttribute('aria-checked')) === 'true') await toggle.click();
		await expectState(page, 'off', 'Off');
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await expect(d.getByTestId('remote-access-body')).toContainText('Tailscale is stopped');
		await expect(d.getByTestId('remote-access-join')).toHaveCount(0);

		// On: the daemon runs, but this device has no login yet.
		await toggle.click();
		await expectState(page, 'needs_key', 'Needs a key');
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		const keyField = d.getByLabel('Auth key');
		await expect(keyField).toHaveAttribute('type', 'password');
		const join = d.getByRole('button', { name: 'Join network' });

		// Text that is not a key never reaches the device.
		await keyField.fill('--advertise-exit-node');
		await expect(join).toBeDisabled();

		// A refused key says so plainly and leaves the device waiting for a key.
		await keyField.fill(`tskey-auth-expired-${'0'.repeat(16)}`);
		await join.click();
		await expect(page.getByText("Couldn't join. The key may be used up, expired or mistyped.")).toBeVisible();
		await expectState(page, 'needs_key', 'Needs a key');
		await expect(keyField).toHaveValue('');

		// A good key joins, and the field is empty again.
		await keyField.fill(KEY);
		await join.click();
		await expectState(page, 'connected', 'Connected');
		await expect(d.getByTestId('remote-access-hostname')).toHaveText('Connected as ceralive');
		await expect(d).toContainText('Address in your network: 100.64.0.7');
		await expect(d.getByTestId('remote-access-join')).toHaveCount(0);
		// The key is gone from the page once it has been sent.
		expect(await page.content()).not.toContain(KEY);

		// No login link or QR code, in any state this flow passes through.
		await expect(d.locator('a[href]')).toHaveCount(0);

		// Forget takes two clicks; "Keep it" backs out.
		await d.getByRole('button', { name: 'Forget this device' }).click();
		await d.getByRole('button', { name: 'Keep it' }).click();
		await expectState(page, 'connected', 'Connected');
		await d.getByRole('button', { name: 'Forget this device' }).click();
		await d.getByRole('button', { name: 'Yes, forget it' }).click();
		await expectState(page, 'needs_key', 'Needs a key');
		await expect(d.getByRole('button', { name: 'Forget this device' })).toHaveCount(0);

		// Off again: the owner's switch.
		await toggle.click();
		await expectState(page, 'off', 'Off');
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
	});
});
