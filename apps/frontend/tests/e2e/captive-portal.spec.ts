import { expect, test } from './fixtures/index.js';
import { navigateTo } from './helpers/index.js';

for (const width of [390, 1280]) {
 test(`sign-in window explains local admission at ${width}px`, async ({ authedPage: page }) => {
  await page.setViewportSize({width, height: 900});
  await navigateTo(page, 'settings');
  const gate = page.getByRole('switch', {name: 'Wi-Fi sign-in (experimental)'});
  if (await gate.getAttribute('aria-checked') !== 'false') await gate.click();
  await expect(gate).toHaveAttribute('aria-checked', 'false');
  await navigateTo(page, 'network');
  await expect(page.getByRole('region', {name: 'Sign the box in'})).toHaveCount(0);
  await navigateTo(page, 'settings');
  await page.getByRole('switch', {name: 'Wi-Fi sign-in (experimental)'}).click();
  await expect(page.getByRole('switch', {name: 'Wi-Fi sign-in (experimental)'})).toHaveAttribute('aria-checked', 'true');
  await navigateTo(page, 'network');
  const card = page.getByRole('region', {name: 'Sign the box in'});
  await expect(card.getByRole('heading', {name: 'Sign the box in'})).toBeVisible();
  await expect(card.getByText(/temporarily pause VPN, Private Relay or secure DNS/)).toBeVisible();
  const choice = card.getByRole('combobox');
  const values = await choice.locator('option').evaluateAll(options => options.map(o => (o as HTMLOptionElement).value).filter(Boolean));
  expect(values.length).toBeGreaterThan(0);
  await choice.selectOption(values[0]);
  await card.getByRole('button', {name: "Open the hotel's page"}).click();
  // Mock mode refuses host routing rather than pretending to sign a radio in.
  await expect(card.getByRole('status')).toContainText("Join the box's own Wi-Fi");
  await expect(card).toContainText('The sign-in window closes after ten minutes');
 });
}
