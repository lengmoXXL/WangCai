// What a command that reaches the agent runs with: the bin directory the agent is installed in, and
// the home a development profile keeps its state in, which the agent reads the same way the app does.
export function agentCommand(command: string) {
  const home = process.env.WANGCAI_HOME;
  const exportHome = home ? `export WANGCAI_HOME='${home.replace(/'/g, String.raw`'\''`)}'; ` : '';
  return `${exportHome}export PATH="$HOME/.local/bin:$PATH"; ${command}`;
}
