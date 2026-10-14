// Backslashes and quotes would end the export early; a $ stays live so the remote shell can expand it.
const quoted = (value: string) => value.replace(/[\\`"]/g, '\\$&');

// Only a shell identifier can be exported, so the same names reach the node locally and over ssh.
export function exportableEnvironment(env: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)));
}

// What a command that reaches the agent runs with: the bin directory the agent is installed in, the home a
// development profile keeps its state in, which the agent reads the same way the app does, and the environment
// the configuration asks for.
export function agentCommand(command: string, env: Record<string, string> = {}) {
  const home = process.env.WANGCAI_HOME;
  const exportHome = home ? `export WANGCAI_HOME='${home.replace(/'/g, String.raw`'\''`)}'; ` : '';
  const exports = Object.entries(exportableEnvironment(env))
    .map(([name, value]) => `export ${name}="${quoted(value)}"; `)
    .join('');
  return `${exportHome}export PATH="$HOME/.local/bin:$PATH"; ${exports}${command}`;
}
