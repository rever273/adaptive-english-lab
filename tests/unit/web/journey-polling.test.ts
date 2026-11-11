import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Exercise the hook's real effects and transport with controlled component lifetimes.
const lifecycle = vi.hoisted(() => ({ current: null as null | { values: unknown[]; cleanup: Array<() => void> } }));
vi.mock('react', () => ({
    useState: (initial: unknown) => {
        const component = lifecycle.current!;
        const index = component.values.push(initial) - 1;
        return [initial, (value: unknown) => { component.values[index] = value; }];
    },
    useEffect: (effect: () => (() => void) | void) => {
        const cleanup = effect();
        if (cleanup) lifecycle.current!.cleanup.push(cleanup);
    },
}));
import { useJourney } from '../../../apps/web/src/journey/useJourney';
import { savePreloadModel } from '../../../apps/web/src/api';

const mounted: Array<{ values: unknown[]; cleanup: Array<() => void> }> = [];
function mount() {
    const component = { values: [] as unknown[], cleanup: [] as Array<() => void> };
    lifecycle.current = component;
    useJourney();
    lifecycle.current = null;
    mounted.push(component);
    return component;
}
function unmount(component: typeof mounted[number]) {
    component.cleanup.splice(0).forEach(cleanup => cleanup());
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
});
afterEach(() => {
    mounted.splice(0).forEach(unmount);
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('measures staggered header and page requests over 45 seconds', async () => {
    const calls: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
        calls.push(Date.now());
        return new Response(JSON.stringify({ revision: calls.length }), { status: 200 });
    }));
    mount();
    await vi.advanceTimersByTimeAsync(5000);
    mount();
    await vi.advanceTimersByTimeAsync(40000);
    expect(calls).toHaveLength(5);
    expect(calls.map(time => time - calls[0]!)).toEqual([0, 5000, 15000, 30000, 45000]);
});

it('keeps successful data on errors, recovers, and stops after the final unmount', async () => {
    const fetch = vi.fn()
        .mockResolvedValueOnce(new Response('{"revision":1}'))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(new Response('{"revision":2}'));
    vi.stubGlobal('fetch', fetch);
    const header = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(header.values).toEqual([{ revision: 1 }, null]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(header.values).toEqual([{ revision: 1 }, 'Cannot reach the local English Lab server.']);
    await vi.advanceTimersByTimeAsync(15000);
    expect(header.values).toEqual([{ revision: 2 }, null]);
    unmount(header);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
});

it('does not reuse cached data on return, and keeps polling for remaining consumers', async () => {
    let revision = 0;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ revision: ++revision })));
    vi.stubGlobal('fetch', fetch);
    const header = mount();
    await vi.advanceTimersByTimeAsync(5000);
    const page = mount();
    expect(page.values).toEqual([null, null]);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.values).toEqual([{ revision: 2 }, null]);
    unmount(page);
    await vi.advanceTimersByTimeAsync(10000);
    expect(header.values).toEqual([{ revision: 3 }, null]);
    expect(page.values).toEqual([{ revision: 2 }, null]);
    unmount(header);
    const returned = mount();
    expect(returned.values).toEqual([null, null]);
    await vi.advanceTimersByTimeAsync(0);
    expect(returned.values).toEqual([{ revision: 4 }, null]);
});

it('deduplicates simultaneous mounts through the existing transport', async () => {
    const fetch = vi.fn(async () => new Response('{"revision":1}'));
    vi.stubGlobal('fetch', fetch);
    const header = mount(), page = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(header.values).toEqual([{ revision: 1 }, null]);
    expect(page.values).toEqual(header.values);
    expect(vi.getTimerCount()).toBe(1);
});

it('ignores an old response after unmount, remount and transport mutation invalidation', async () => {
    const reads: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url === '/api/v1/journey') return new Promise<Response>(resolve => reads.push(resolve));
        if (url === '/api/v1/session') return Promise.resolve(new Response('{"csrfToken":"token"}'));
        return Promise.resolve(new Response('{"revision":1,"values":{},"defaults":{}}'));
    }));
    const old = mount();
    unmount(old);
    // A mutation clears transport inflight reads; the new request can finish first.
    await savePreloadModel(true);
    const current = mount();
    expect(reads).toHaveLength(2);
    reads[1]!(new Response('{"revision":2}'));
    await vi.advanceTimersByTimeAsync(0);
    expect(current.values).toEqual([{ revision: 2 }, null]);
    reads[0]!(new Response('{"revision":1}'));
    await vi.advanceTimersByTimeAsync(0);
    expect(current.values).toEqual([{ revision: 2 }, null]);
    expect(old.values).toEqual([null, null]);
});

it('does not let a pre-mutation read overwrite a newer response for active consumers', async () => {
    const reads: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url === '/api/v1/journey') return new Promise<Response>(resolve => reads.push(resolve));
        if (url === '/api/v1/session') return Promise.resolve(new Response('{"csrfToken":"token"}'));
        return Promise.resolve(new Response('{"revision":1,"values":{},"defaults":{}}'));
    }));
    const header = mount();
    await savePreloadModel(true);
    const page = mount();
    reads[1]!(new Response('{"revision":2}'));
    await vi.advanceTimersByTimeAsync(0);
    reads[0]!(new Response('{"revision":1}'));
    await vi.advanceTimersByTimeAsync(0);
    expect(header.values).toEqual([{ revision: 2 }, null]);
    expect(page.values).toEqual(header.values);
});
