import { useEffect, useState } from 'react';
import * as api from '../api';

type Result = { data: api.JourneyData } | { error: string };
const subscribers = new Set<(result: Result) => void>();
let timer: number | undefined;
let readVersion = 0;

// Share only the polling clock, not cached data. Every mount still requests fresh data.
function load() {
    const version = ++readVersion;
    void api.fetchJourney().then(
        data => publish(version, { data }),
        e => publish(version, { error: e instanceof Error ? e.message : 'Could not load journey' }),
    );
}

function publish(version: number, result: Result) {
    if (version === readVersion) subscribers.forEach(subscriber => subscriber(result));
}

function subscribe(subscriber: (result: Result) => void) {
    subscribers.add(subscriber);
    if (timer === undefined) timer = window.setInterval(load, 15000);
    load();
    return () => {
        subscribers.delete(subscriber);
        if (!subscribers.size) {
            window.clearInterval(timer);
            timer = undefined;
            ++readVersion; // Discard results from a previous subscription lifetime.
        }
    };
}

export function useJourney() {
    const [data, setData] = useState<api.JourneyData | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        return subscribe(result => {
            if ('data' in result) {
                setData(result.data);
                setError(null);
            } else {
                setError(result.error);
            }
        });
    }, []);
    return { data, error };
}
