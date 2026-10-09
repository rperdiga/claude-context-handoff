export type Handoff = { path: string; prompt: string; percent: number }

declare module 'claude-code' {
  interface PluginState {
    'context-handoff': { pending: Handoff | null; isBusy: boolean; isOff: boolean }
  }
}
