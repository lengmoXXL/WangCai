const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** The app loads only what init.ts lists, so a test that wants plugins writes the file first. */
exports.writeInit = (home, lists) => {
  const { workspaces = [], tabs = [] } = lists ?? { workspaces: ['terminal-agent'], tabs: ['files', 'terminal'] };
  const list = (entries) => entries.map((entry) => JSON.stringify(typeof entry === 'string' ? { id: entry } : entry)).join(', ');
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { workspaces: [${list(workspaces)}], tabs: [${list(tabs)}] };\n`);
};

exports.waitForShell = (page) => page.locator('.workspaces').waitFor();

/** A right-click on the workspace heading opens the menu of machines a workspace can be opened on. */
exports.openWorkspaceMenu = (page) => page.locator('.workspace-header').click({ button: 'right' });

/** Waits until the workspace in front has a terminal that takes input; a session id alone is not enough. */
const waitForTerminal = async (page) => {
  const id = await page.evaluate(async () => {
    const config = await window.wangcai.request('terminal-agent', 'config');
    return config.workspaces.find((workspace) => workspace.id === config.active)?.sessionId;
  });
  for (let attempt = 0; attempt < 400; attempt++) {
    const attached = await page.evaluate((session) => window.wangcai.request('terminal-agent', 'pty', { id: 'local', op: 'input', params: { session_id: session, data: '' } }).then(() => true, () => false), id);
    if (attached) return;
    await page.waitForTimeout(50);
  }
  throw new Error('the terminal never attached');
};

/** The list menu offers one entry per machine; picking the local one opens a workspace on it. */
exports.createWorkspace = async (page) => {
  await exports.openWorkspaceMenu(page);
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '本机', exact: true }).click();
  await page.locator('.terminal-pane.active .xterm-helper-textarea').waitFor();
  await waitForTerminal(page);
};
