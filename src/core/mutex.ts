/**
 * Serializes async work per key: tasks for the same key run one after another, tasks for different keys run
 * concurrently. Switchboard runs as a single replica, so an in-process lock is enough.
 */
export class KeyedMutex {
    readonly #tails = new Map<string, Promise<void>>();

    async run<T>(key: string, task: () => Promise<T>): Promise<T> {
        const previous = this.#tails.get(key) ?? Promise.resolve();
        let release: () => void = () => undefined;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => current);
        this.#tails.set(key, tail);
        await previous;
        try {
            return await task();
        } finally {
            release();
            if (this.#tails.get(key) === tail) this.#tails.delete(key);
        }
    }
}
