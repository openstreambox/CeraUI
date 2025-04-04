import type { Component } from 'svelte';

import Advanced from '../../main/tabs/Advanced.svelte';
import General from '../../main/tabs/General.svelte';
import Network from '../../main/tabs/Network.svelte';
import Streaming from '../../main/tabs/Streaming.svelte';

export type NavElements = {
  [key: string]: {
    label: string;
    component: Component;
  };
};
export const navElements: NavElements = {
  general: { label: 'general', component: General },
  wifi: { label: 'network', component: Network },
  settings: { label: 'streaming', component: Streaming },
  advanced: { label: 'advanced', component: Advanced },
};

const navElementsEntries = Object.entries(navElements);

export const defaultNavElement = {
  [navElementsEntries[0][0]]: {
    label: navElementsEntries[0][1].label,
    component: navElementsEntries[0][1].component,
  },
};

export const siteName = 'CeraUI for BELABOX©';
