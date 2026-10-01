export interface Machine { id: string; name: string; host?: string }
export interface ActiveTerminal { machine: Machine; sessionId: string; workspaceId?: string }
export interface TerminalRef { machine: Machine; sessionId: string; label: string }
