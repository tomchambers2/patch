// The Settings pages, in nav order (design/settings-redesign). Each has its
// own address, /settings/<id>.

export type SettingsPageId =
  | 'usage'
  | 'agent'
  | 'mcp'
  | 'memories'
  | 'manager'
  | 'goals'
  | 'voice'
  | 'hooks'
  | 'jobs'
  | 'hosts'
  | 'keys'
  | 'devices'
  | 'updates'
  | 'account';

export const SETTINGS_PAGES: { id: SettingsPageId; title: string; group: string }[] = [
  { id: 'usage', title: 'Usage', group: 'Agents' },
  { id: 'agent', title: 'Agent', group: 'Agents' },
  { id: 'mcp', title: 'MCP', group: 'Agents' },
  { id: 'memories', title: 'Memories', group: 'Agents' },
  { id: 'manager', title: 'Manager', group: 'Agents' },
  { id: 'goals', title: 'Goals', group: 'Agents' },
  { id: 'voice', title: 'Voice', group: 'Agents' },
  { id: 'hooks', title: 'Hooks', group: 'Agents' },
  { id: 'jobs', title: 'Jobs', group: 'Agents' },
  { id: 'hosts', title: 'Hosts', group: 'Setup' },
  { id: 'keys', title: 'Keys', group: 'Setup' },
  { id: 'devices', title: 'Devices', group: 'Setup' },
  { id: 'updates', title: 'Updates', group: 'System' },
  { id: 'account', title: 'Account', group: 'System' },
];

/** The page `/settings` itself shows beside the nav on a wide screen. */
export const DEFAULT_SETTINGS_PAGE: SettingsPageId = 'usage';
