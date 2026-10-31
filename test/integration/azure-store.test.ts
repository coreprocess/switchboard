import { after, before, describe } from 'node:test';
import type { AzureTableStore } from '../../src/store/azure-tables.ts';
import { startAzurite } from '../helpers/azurite.ts';
import { storeContract } from '../helpers/store-contract.ts';

describe('Azure Table Storage store (Azurite)', () => {
    let azurite: Awaited<ReturnType<typeof startAzurite>>;
    let store: AzureTableStore;

    before(async () => {
        azurite = await startAzurite();
        store = await azurite.store();
        // init is idempotent
        await store.init();
    });

    after(async () => {
        await azurite?.stop();
    });

    storeContract(async () => store);
});
