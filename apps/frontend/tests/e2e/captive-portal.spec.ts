import { expect, test } from './fixtures/index.js';
import { navigateTo } from './helpers/index.js';

for (const width of [390, 1280]) {
 test(`sign-in window explains local admission at ${width}px`, async ({ authedPage: page }) => {
  await page.setViewportSize({width, height: 900});
  await navigateTo(page, 'network');
  const card = page.getByRole('region', {name: 'Sign the box in'});
  await expect(card.getByRole('heading', {name: 'Sign the box in'})).toBeVisible();
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
