import { describe, expect, it } from 'bun:test';

import {
	exportsMessages,
	namespaceChunk,
	notificationKeys,
	renderCatalogMessage,
} from './notification-bundle';

describe('backend notification key extraction', () => {
	it('includes keys held in tables and constants when emitters select them dynamically', () => {
		// Given source containing several ways to spell literal notification keys
		const source = `
			const notices = { installed: { key: "notifications.updateInstalled" } };
			const recovered = 'notifications.updateSlotSyncRecovered';
			const available = \`notifications.updatesAvailableMessage\`;
			const busy = "network.os.deviceBusy";
			// "notifications.commentOnly"
			import { notificationSend } from "./notifications";
			notificationSend(notices[kind].key);
		`;
		// When deriving the production guard's requirements
		const keys = notificationKeys(source);
		// Then dynamic selection does not hide any complete literal key
		expect(keys).toEqual([
			'network.os.deviceBusy',
			'notifications.updateInstalled',
			'notifications.updateSlotSyncRecovered',
			'notifications.updatesAvailableMessage',
		]);
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: parser fixture must contain an unevaluated template expression.
	it.each(['const key = `notifications.${kind}`;', 'const key = "notifications." + kind;'])(
		'refuses an unenumerable key family when source uses %s',
		(source) => {
			// Given a family that would silently bypass literal extraction
			// When extracting its requirements, then require explicit key literals
			expect(() => notificationKeys(source)).toThrow('complete literals');
		},
	);
});

describe('notification catalog interpolation', () => {
	it('distinguishes parameter values when a translated pattern repeats a placeholder', () => {
		// Given a catalog pattern, independently of the compiled output
		const pattern = '{name}: {version}, {name}';
		// When deriving deterministic inputs and the expected rendered text
		const rendered = renderCatalogMessage(pattern);
		// Then interpolation checks both static text and parameter selection
		expect(rendered).toEqual({
			inputs: { name: '__name__', version: '__version__' },
			expected: '__name__: __version__, __name__',
		});
	});
});

// Shaped like the emitted output: a namespace barrel exports its registry as
// `messages`; an application chunk of the same natural name exports components.
const NAMESPACE =
	'import{na as e}from"./streaming.js";var t={"dialogs.save":()=>`Save`};export{t as messages};';
const APP_CHUNK = 'import{d as e}from"./AppDialog.js";function M(){}export{M as i,L as n};';

function sources(files: Readonly<Record<string, string>>): (file: string) => string {
	return (file) => {
		const source = files[file];
		if (source === undefined) throw new Error(`unexpected read of ${file}`);
		return source;
	};
}

describe('built namespace discovery', () => {
	it('distinguishes a namespace from a longer helper name while allowing hash punctuation', () => {
		expect(
			namespaceChunk(
				['network-speed-C7D7YRdk.js', 'network-XfJ-xhR_.js', 'network-XfJ-xhR_.js.map'],
				'network',
				sources({ 'network-XfJ-xhR_.js': NAMESPACE }),
			),
		).toBe('network-XfJ-xhR_.js');
	});

	it('picks the namespace when an application chunk has the same natural name', () => {
		// Given a lazy-dialog chunk that Vite named after its directory, beside the
		// `dialogs` namespace barrel; both are exactly `dialogs-[hash].js`
		const files = { 'dialogs-BLX29Km6.js': NAMESPACE, 'dialogs-CehWjeDW.js': APP_CHUNK };
		// When resolving the namespace a backend notification key would need
		const chunk = namespaceChunk(Object.keys(files).reverse(), 'dialogs', sources(files));
		// Then only the chunk exporting the message registry is chosen
		expect(chunk).toBe('dialogs-BLX29Km6.js');
	});

	it('accepts the registry export in its unminified declaration form', () => {
		expect(exportsMessages('export const messages = { "dialogs.save": () => "Save" };\n')).toBe(
			true,
		);
		expect(exportsMessages('const messages = {};\nexport { other };')).toBe(false);
		expect(exportsMessages('// export{t as messages}\nexport{t as m};')).toBe(false);
	});

	it('refuses a helper without the actual namespace', () => {
		expect(() => namespaceChunk(['network-speed-C7D7YRdk.js'], 'network', sources({}))).toThrow(
			'Expected one built network namespace, got 0',
		);
	});

	it('refuses a same-named application chunk when the namespace itself is missing', () => {
		expect(() =>
			namespaceChunk(
				['dialogs-CehWjeDW.js'],
				'dialogs',
				sources({ 'dialogs-CehWjeDW.js': APP_CHUNK }),
			),
		).toThrow('Expected one built dialogs namespace, got 0');
	});

	it('still refuses two actual namespace chunks', () => {
		expect(() =>
			namespaceChunk(
				['network-12345678.js', 'network-abcdefgh.js'],
				'network',
				sources({ 'network-12345678.js': NAMESPACE, 'network-abcdefgh.js': NAMESPACE }),
			),
		).toThrow('Expected one built network namespace, got 2');
	});
});
