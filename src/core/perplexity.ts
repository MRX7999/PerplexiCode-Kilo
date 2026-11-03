import { PerplexityTransport } from '../agent/transport';
import { CapabilityFetcher } from '../api/capabilityFetcher';
import { setRuntimeModelCatalog } from '../api/modelCatalog';
import { ModelFetcher } from '../api/modelFetcher';
import { RotationEngine } from '../api/rotationEngine';
import { AccountManager } from '../storage/accountManager';
import { cliStores } from './nodeStores';

/**
 * Pluggable transport #1 (default): the Perplexity web session of your Pro/Max subscription,
 * with the extension's account rotation, follow-up threads and recovery chain. The accounts live in
 * ~/.perplexicode (shared by `pcode` and the extension's "Share Accounts with CLI" command).
 */
export async function createPerplexityBackend(options: { refreshCapabilities?: boolean; log?: (line: string) => void } = {}) {
  const stores = cliStores();
  // AccountManager only uses get/update and get/store/delete; the file stores implement them.
  const accountManager = new AccountManager(stores.state as never, stores.secrets as never);
  await accountManager.initialize();
  const rotationEngine = new RotationEngine();
  const capabilityFetcher = new CapabilityFetcher();
  const modelFetcher = new ModelFetcher();
  setRuntimeModelCatalog(modelFetcher.getFallbackModels());
  if (options.refreshCapabilities && accountManager.getAccounts().length > 0) {
    try {
      await withTimeout(capabilityFetcher.refreshAccounts(accountManager.getAccounts(), false), 15000);
      await accountManager.saveMetas();
      const account = rotationEngine.selectAccount(accountManager.getAccounts());
      if (account) {
        setRuntimeModelCatalog(await withTimeout(modelFetcher.getModels(account), 15000));
      }
    } catch (error) {
      options.log?.(`Model/plan refresh skipped: ${(error as Error).message}`);
    }
  }
  const transport = new PerplexityTransport(accountManager, rotationEngine, capabilityFetcher);
  return { transport, accountManager, rotationEngine, capabilityFetcher, modelFetcher, stores };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
