export {};

declare global {
  interface Window {
    tournamentSecure?: {
      getApiKey(): Promise<string | null>;
      setApiKey(key: string | null): Promise<void>;
    };
  }
}
