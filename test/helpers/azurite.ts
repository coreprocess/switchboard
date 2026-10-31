import { randomBytes } from 'node:crypto';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { AzureTableStore } from '../../src/store/azure-tables.ts';

/** Azurite's well-known development account key. */
const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

/** Azurite (Table Storage) in a container; `store()` returns stores with a fresh table prefix each. */
export const startAzurite = async () => {
    const container: StartedTestContainer = await new GenericContainer('mcr.microsoft.com/azure-storage/azurite')
        .withCommand(['azurite-table', '--tableHost', '0.0.0.0', '--skipApiVersionCheck', '--loose'])
        .withExposedPorts(10002)
        .withWaitStrategy(Wait.forListeningPorts())
        .start();
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(10002)}/devstoreaccount1`;
    const connectionString = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${KEY};TableEndpoint=${endpoint};`;
    return {
        connectionString,
        /** A store on a table prefix; pass the same prefix to share tables between instances. */
        store: async (tablePrefix = `t${randomBytes(4).toString('hex')}`) => {
            const store = new AzureTableStore({
                endpoint: undefined,
                connectionString,
                credential: undefined,
                tablePrefix,
            });
            await store.init();
            return store;
        },
        stop: () => container.stop(),
    };
};
