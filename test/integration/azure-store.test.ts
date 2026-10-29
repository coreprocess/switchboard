import { after, before, describe } from 'node:test';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { AzureTableStore } from '../../src/store/azure-tables.ts';
import { storeContract } from '../helpers/store-contract.ts';

/** Azurite's well-known development account key. */
const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

describe('Azure Table Storage store (Azurite)', () => {
    let container: StartedTestContainer;
    let store: AzureTableStore;

    before(async () => {
        container = await new GenericContainer('mcr.microsoft.com/azure-storage/azurite')
            .withCommand(['azurite-table', '--tableHost', '0.0.0.0', '--skipApiVersionCheck', '--loose'])
            .withExposedPorts(10002)
            .withWaitStrategy(Wait.forListeningPorts())
            .start();
        const endpoint = `http://${container.getHost()}:${container.getMappedPort(10002)}/devstoreaccount1`;
        store = new AzureTableStore({
            endpoint: undefined,
            connectionString: `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${KEY};TableEndpoint=${endpoint};`,
            credential: undefined,
        });
        await store.init();
        // init is idempotent
        await store.init();
    });

    after(async () => {
        await container?.stop();
    });

    storeContract(async () => store);
});
