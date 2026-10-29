import { describe } from 'node:test';
import { MemoryStore } from '../../src/store/memory.ts';
import { storeContract } from '../helpers/store-contract.ts';

describe('memory store', () => {
    storeContract(async () => new MemoryStore());
});
